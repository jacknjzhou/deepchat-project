import logger from '@shared/logger'
import fs from 'node:fs'
import path from 'node:path'

import type {
  BuiltinKnowledgeConfig,
  KnowledgeChunkMessage,
  KnowledgeFileMessage,
  KnowledgeFileResult,
  QueryResult
} from '@shared/types/knowledge'
import { nanoid } from 'nanoid'
import { RecursiveCharacterTextSplitter } from '@/lib/textsplitters'
import { sanitizeText } from '@/utils/strings'
import { getMetric, normalizeDistance } from '@/utils/vector'
import type {
  KnowledgeDatabasePort,
  KnowledgeEmbeddingPort,
  KnowledgeEventPublisher,
  KnowledgeFilePort,
  KnowledgeTaskQueuePort
} from './ports'

/**
 * 单个知识库的运行时编排：文件入库（解析→分块→嵌入→向量化）、
 * 相似度检索、文件增删查、任务暂停恢复。
 *
 * 由 KnowledgeService 按库惰性创建并缓存；数据落到注入的
 * KnowledgeDatabasePort（DuckDB 向量库），文本切分参数、嵌入模型、
 * 检索条数都来自随构造传入的 BuiltinKnowledgeConfig，可用 updateConfig
 * 热更新。
 *
 * 并发模型：所有落库写操作经 enqueueFileTask 按 fileId 串行（DuckDB 连接
 * 非线程安全，事务队列也假定串行）；跨文件的嵌入计算则交给全局
 * KnowledgeTaskQueue 并发调度，以进度回调驱动文件状态收敛。
 */
export class KnowledgeBase {
  private readonly database: KnowledgeDatabasePort
  private config: BuiltinKnowledgeConfig
  private readonly taskQueue: KnowledgeTaskQueuePort
  private readonly filePort: KnowledgeFilePort
  private readonly embeddingPort: KnowledgeEmbeddingPort
  private readonly events: KnowledgeEventPublisher
  // 文件处理进度跟踪器
  private fileProgressMap = new Map<string, { completed: number; error: number; total: number }>()
  // --- 新增：按文件队列保证 database 线程安全 ---
  /**
   * 每个文件的写操作链尾 Promise：新的写操作排在其后，保证同一文件的
   * 落库动作严格串行，避免 DuckDB 连接并发写冲突。
   */
  private fileQueueMap = new Map<string, Promise<void>>()

  /**
   * 把一个写操作追加到指定文件的串行队列末尾。
   * 单个任务失败只记日志不中断队列——后续操作（如状态更新）仍应执行；
   * 否则文件记录会卡在 processing 永远无法收敛。
   */
  private async enqueueFileTask(fileId: string, task: () => Promise<void>): Promise<void> {
    const last = this.fileQueueMap.get(fileId) ?? Promise.resolve()
    const next = last.then(task).catch((err) => {
      console.error(`[RAG] Error in queued task for file ${fileId}:`, err)
    })
    this.fileQueueMap.set(fileId, next)
    await next
  }

  constructor(
    database: KnowledgeDatabasePort,
    config: BuiltinKnowledgeConfig,
    taskQueue: KnowledgeTaskQueuePort,
    filePort: KnowledgeFilePort,
    embeddingPort: KnowledgeEmbeddingPort,
    events: KnowledgeEventPublisher
  ) {
    this.database = database
    this.config = config
    this.taskQueue = taskQueue
    this.filePort = filePort
    this.embeddingPort = embeddingPort
    this.events = events
  }

  /**
   * 获取vector数据库presenter
   */
  getDatabase(): KnowledgeDatabasePort {
    return this.database
  }

  /**
   * 热更新配置（分块参数、嵌入模型、检索条数等）。只影响之后新建的
   * 处理任务；已经在跑的分片仍按旧配置完成。
   */
  updateConfig(config: BuiltinKnowledgeConfig): void {
    this.config = config
  }

  /**
   * 添加文件入库。入库是「两段式」的：这里只做去重检查并落一条
   * processing 状态的文件记录后立即返回；解析、分块、嵌入全部在
   * processFileAsync 后台进行，进度经事件发布给前端。
   *
   * @param filePath 文件绝对路径
   * @param fileId 可选的既定 id；传入时复用记录（reAddFile 场景），
   *   缺省时生成新 id。未传且路径已存在时视为重复添加，直接返回既有
   *   记录（error 字段为空，调用方按 data 里的原状态自行过滤提示）。
   */
  async addFile(filePath: string, fileId?: string): Promise<KnowledgeFileResult> {
    try {
      if (fs.existsSync(filePath) === false) {
        throw new Error('文件不存在，请检查路径是否正确')
      }
      // 如果文件id为空，但filePath在数据库中已存在，说明是重复添加，跳过
      const existingFile = await this.database.queryFiles({
        path: filePath
      })
      if (!fileId && existingFile[0]) {
        // 直接返回文件信息，前端需要过滤
        return { data: existingFile[0] }
      }

      const mimeType = await this.filePort.getMimeType(filePath)
      // 先将文件基本信息插入数据库
      const fileMessage = {
        id: fileId ?? nanoid(),
        name: path.basename(filePath) || 'unknown',
        path: filePath,
        mimeType,
        status: 'processing',
        uploadedAt: new Date().getTime(),
        metadata: {
          size: -1, // 初始大小未知
          totalChunks: 0
        }
      } as KnowledgeFileMessage

      if (fileId) {
        await this.enqueueFileTask(fileMessage.id, async () =>
          this.database.updateFile(fileMessage)
        )
      } else {
        await this.enqueueFileTask(fileMessage.id, async () =>
          this.database.insertFile(fileMessage)
        )
      }

      this.processFileAsync(fileMessage)

      return { data: fileMessage }
    } catch (error) {
      console.error(`[RAG] Error adding file ${filePath}:`, error)
      // 向上抛出错误，以便调用者可以处理
      throw error
    }
  }

  /**
   * 后台完成文件的解析→分块→建嵌入任务全流程。
   *
   * 任何一步失败都把文件标记为 error 并附原因，绝不让异常悬空——
   * 文件记录必须收敛到终态，否则前端进度条永不结束。
   */
  // 异步处理文件读取和分片（不参与taskQueueresenter队列）
  private async processFileAsync(fileMessage: KnowledgeFileMessage): Promise<void> {
    try {
      // 1. 读取文件和获取基本信息
      const fileInfo = await this.filePort.prepareFileCompletely(
        fileMessage.path,
        fileMessage.mimeType,
        'origin'
      )

      // 2. 更新文件基本信息
      fileMessage.name = fileInfo.name
      fileMessage.metadata = {
        size: fileInfo.metadata.fileSize,
        totalChunks: 0
      }

      // 检查文件内容
      if (fileInfo.content === undefined || fileInfo.content.length === 0) {
        fileMessage.status = 'error'
        fileMessage.metadata.errorReason =
          '无法读取文件或文件内容为空，请检查文件是否损坏或格式是否受支持'
        await this.enqueueFileTask(fileMessage.id, async () =>
          this.database.updateFile(fileMessage)
        )
        this.events.publishFileUpdated(fileMessage)
        return
      }

      // 3. 分片
      //    按配置的分隔符与块大小递归切分，重叠量保证语义跨块连续；
      //    正文先清洗再切，避免不可见字符进索引。
      const chunker = new RecursiveCharacterTextSplitter({
        chunkSize: this.config.chunkSize,
        chunkOverlap: this.config.chunkOverlap,
        separators: this.config.separators
      })
      const chunks = await chunker.splitText(sanitizeText(fileInfo.content))

      // 4. 更新文件信息中的分片数量
      fileMessage.metadata.totalChunks = chunks.length
      await this.enqueueFileTask(fileMessage.id, async () => this.database.updateFile(fileMessage))

      // 5. 发送文件更新事件
      this.events.publishFileUpdated(fileMessage)

      // 6. 创建chunk记录
      const chunkMessages = chunks.map((content, index) => ({
        id: fileMessage.id + '_' + index,
        fileId: fileMessage.id,
        chunkIndex: index,
        content,
        status: 'processing'
      })) as KnowledgeChunkMessage[]

      await this.enqueueFileTask(fileMessage.id, async () =>
        this.database.insertChunks(chunkMessages)
      )

      // 7. 初始化文件进度跟踪
      this.fileProgressMap.set(fileMessage.id, { completed: 0, error: 0, total: chunks.length })

      // 8. 为每个chunk创建独立的处理任务，加入taskQueueresenter队列
      for (const chunkMsg of chunkMessages) {
        const chunkTask = {
          id: `chunk_${chunkMsg.id}`,
          payload: {
            knowledgeBaseId: this.config.id,
            fileId: fileMessage.id,
            chunkId: chunkMsg.id,
            taskType: 'chunk_processing',
            metadata: {
              content: chunkMsg.content,
              chunkIndex: chunkMsg.chunkIndex
            }
          },
          run: async ({ signal }) => this.processChunkTask(chunkMsg, signal),
          onSuccess: () => this.handleChunkCompletion(chunkMsg.id, fileMessage.id),
          onError: (error: Error) =>
            this.handleChunkError(chunkMsg.id, fileMessage.id, error.message),
          onTerminate: () => logger.info(`[RAG] Chunk processing terminated for ${chunkMsg.id}`)
        }

        this.taskQueue.addTask(chunkTask)
      }
    } catch (error) {
      console.error(`[RAG] Error in processFileAsync:`, error)
      await this.handleFileProcessingError(fileMessage.id, (error as Error).message)
    }
  }

  // 新增：处理单个chunk任务
  /**
   * 单个分块的嵌入任务体：调嵌入模型生成向量，再写入 chunk 状态与向量表。
   * 提交嵌入前检查 abort 信号——模型调用本身不可中断，但可以避免拿到
   * 结果后还做无意义的落库。AbortError 原样上抛，由任务队列归为「终止」
   * 而非「失败」。
   */
  private async processChunkTask(
    chunkMsg: KnowledgeChunkMessage,
    signal: AbortSignal
  ): Promise<void> {
    try {
      // 生成向量
      const vectors = await this.embeddingPort.getEmbeddings(
        this.config.embedding.providerId,
        this.config.embedding.modelId,
        [chunkMsg.content]
      )

      if (!vectors || vectors.length === 0) {
        throw new Error('Failed to generate embeddings')
      }

      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }

      // 事务化更新chunk和向量
      // 状态与向量必须一起落：只改状态不写向量，检索时该分块就永久缺失，
      // 而记账上却显示已完成。
      await this.enqueueFileTask(chunkMsg.fileId, async () => {
        await this.database.updateChunkStatus(chunkMsg.id, 'completed')
        await this.database.insertVector({
          vector: vectors[0],
          fileId: chunkMsg.fileId,
          chunkId: chunkMsg.id
        })
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error
      }
      console.error(`[RAG] Error processing chunk ${chunkMsg.id}:`, error)
      throw error
    }
  }

  // 处理chunk完成事件（线程安全的进度管理）
  /**
   * 分块成功回调：累加完成数并广播进度；当全部分块都有了终态
   * （完成或出错）时触发文件级收尾。进度表在收尾后移除。
   */
  private async handleChunkCompletion(_chunkId: string, fileId: string): Promise<void> {
    const progress = this.fileProgressMap.get(fileId)
    if (!progress) {
      console.warn(`[RAG] No progress tracker found for file ${fileId}`)
      return
    }
    progress.completed++

    // 更新文件进度
    this.events.publishFileProgress(fileId, progress)

    // 检查是否所有分片都完成了
    if (progress.completed + progress.error === progress.total) {
      await this.onFileFinish(fileId)
      // 清理进度跟踪器
      this.fileProgressMap.delete(fileId)
    }
  }

  /**
   * 分块失败回调：把错误写回 chunk 记录、累加错误数并广播进度。
   * 单个分块失败不拖垮文件——其余分块照常处理，文件状态照样收敛。
   */
  private async handleChunkError(
    chunkId: string,
    fileId: string,
    errorMessage: string
  ): Promise<void> {
    const progress = this.fileProgressMap.get(fileId)
    if (!progress) {
      console.warn(`[RAG] No progress tracker found for file ${fileId}`)
      return
    }

    await this.enqueueFileTask(fileId, async () =>
      this.database.updateChunkStatus(chunkId, 'error', errorMessage)
    )
    progress.error++

    // 更新文件进度
    this.events.publishFileProgress(fileId, progress)

    // 检查是否所有分片都完成了
    if (progress.completed + progress.error === progress.total) {
      await this.onFileFinish(fileId)
      // 清理进度跟踪器
      this.fileProgressMap.delete(fileId)
    }
  }

  // 文件处理完成回调
  /**
   * 全部分块都有终态后的文件级收尾：把文件状态置为 completed 并广播。
   * 此处吞掉异常：收尾失败只影响状态显示，分块数据本身已落库。
   */
  private async onFileFinish(fileId: string): Promise<void> {
    try {
      // TODO 分片错误数量
      const fileMessage = await this.database.queryFile(fileId)
      if (fileMessage) {
        fileMessage.status = 'completed'
        await this.enqueueFileTask(fileId, async () => this.database.updateFile(fileMessage))
        this.events.publishFileUpdated(fileMessage)
        logger.info(`[RAG] File processing completed for ${fileId}`)
      }
    } catch (error) {
      console.error(`[RAG] Error in onFileFinish for ${fileId}:`, error)
    }
  }

  // 处理文件处理错误
  /**
   * 后台流程（读取/分块等前置步骤）整体失败时的兜底：文件标记为 error
   * 并记录原因。吞掉异常——错误已经体现在文件状态里，再抛只会在
   * 无 await 的后台调用里变成 unhandled rejection。
   */
  private async handleFileProcessingError(fileId: string, errorMessage: string): Promise<void> {
    try {
      const fileMessage = await this.database.queryFile(fileId)
      if (fileMessage) {
        fileMessage.status = 'error'
        if (fileMessage.metadata) {
          fileMessage.metadata.errorReason = errorMessage
        }
        await this.enqueueFileTask(fileId, async () => this.database.updateFile(fileMessage))
        this.events.publishFileUpdated(fileMessage)
      }
    } catch (error) {
      console.error(`[RAG] Error handling file processing error for ${fileId}:`, error)
    }
  }

  /**
   * 删除文件及其全部分块与向量。删除前先取消队列里该文件的所有待处理
   * 嵌入任务，防止「文件已删、任务还在往里写」的竞态。失败时向上抛错。
   */
  async deleteFile(fileId: string): Promise<void> {
    try {
      // 1. 取消文件相关的所有待处理任务（使用便捷方法）
      this.taskQueue.cancelTasksByFile(fileId)

      // 2. 清理进度跟踪器
      this.fileProgressMap.delete(fileId)

      // 3. 删除文件
      await this.enqueueFileTask(fileId, async () => this.database.deleteFile(fileId))
    } catch (err) {
      console.error(
        `[RAG] Failed to delete file ${fileId} in knowledge base ${this.config.id}:`,
        err
      )
      throw err
    }
  }

  /**
   * 相似度检索：查询文本清洗后嵌入，按 HNSW 索引取 topK 近邻。
   * 距离值按库的度量归一化成统一的「越小越相似」语义再返回。
   * 嵌入模型不可用或库查询失败时向上抛错。
   */
  async similarityQuery(key: string): Promise<QueryResult[]> {
    try {
      const embedding = await this.embeddingPort.getEmbeddings(
        this.config.embedding.providerId,
        this.config.embedding.modelId,
        [sanitizeText(key)]
      )

      const queryResults = await this.database.similarityQuery(embedding[0], {
        topK: this.config.fragmentsNumber,
        metric: getMetric(this.config.normalized)
      })
      queryResults.forEach((res) => {
        res.distance = normalizeDistance(res.distance, getMetric(this.config.normalized))
      })
      return queryResults
    } catch (error) {
      console.error(`[RAG] Error during similarity query:`, error)
      throw error
    }
  }
  /**
   * 重新灌入已有文件：清空旧分块与旧向量后沿用原 fileId 重走添加流程。
   * 嵌入模型更换或分块参数调整后用于刷新索引。文件记录不存在时抛错，
   * 提示用户先重新打开知识库（记录随库关闭而不可寻址）。
   */
  async reAddFile(fileId: string): Promise<KnowledgeFileResult> {
    const file = await this.queryFile(fileId)
    if (file == null) {
      throw new Error('文件不存在，请重新打开知识库后再试')
    }
    await this.enqueueFileTask(fileId, async () => this.database.deleteChunksByFile(fileId))
    await this.enqueueFileTask(fileId, async () => this.database.deleteVectorsByFile(fileId))
    return this.addFile(file.path, fileId)
  }

  /**
   * 查询单个文件元信息；不存在返回 null，查询失败向上抛错。
   */
  async queryFile(fileId: string): Promise<KnowledgeFileMessage | null> {
    try {
      return await this.database.queryFile(fileId)
    } catch (err) {
      console.error(
        `[RAG] Failed to query file ${fileId} in knowledge base ${this.config.id}:`,
        err
      )
      throw err
    }
  }
  /**
   * 列出库内全部文件（按上传时间倒序）；查询失败向上抛错。
   */
  async listFiles(): Promise<KnowledgeFileMessage[]> {
    try {
      return await this.database.listFiles()
    } catch (err) {
      console.error(`[RAG] Failed to list files in knowledge base ${this.config.id}:`, err)
      throw err
    }
  }

  /**
   * 暂停库内所有进行中的处理：取消队列任务、清空进度缓存，并把数据库
   * 中 processing 状态的记录置为 paused，供应用关闭或用户手动暂停。
   */
  async pauseAllRunningTasks(): Promise<void> {
    this.taskQueue.cancelTasksByKnowledgeBase(this.config.id)
    this.fileProgressMap.clear()
    await this.database.pauseAllRunningTasks()
  }
  /**
   * 恢复所有暂停的分块处理：从数据库读回 paused 分块，按文件重建进度
   * 记账，再逐个重新入队。进度从零重新计数——被取消的次数已经无关紧要，
   * 剩余分块数才是「还差多少」的正确语义。
   */
  async resumeAllPausedTasks(): Promise<void> {
    // query all paused chunks
    const pausedChunkMessages = await this.database.queryChunks({ status: 'paused' })
    // count by file id
    const fileIdCountMap = new Map<string, number>()
    pausedChunkMessages.forEach((chunk) => {
      const count = fileIdCountMap.get(chunk.fileId) || 0
      fileIdCountMap.set(chunk.fileId, count + 1)
    })
    // resume file progress cache
    fileIdCountMap.forEach((count, fileId) => {
      this.fileProgressMap.set(fileId, {
        completed: 0,
        error: 0,
        total: count
      })
    })
    await this.database.resumeAllPausedTasks()
    for (const chunkMessage of pausedChunkMessages) {
      // re-add each paused chunk to the task queue
      const chunkTask = {
        id: `chunk_${chunkMessage.id}`,
        payload: {
          knowledgeBaseId: this.config.id,
          fileId: chunkMessage.fileId,
          chunkId: chunkMessage.id,
          taskType: 'chunk_processing',
          metadata: {
            content: chunkMessage.content,
            chunkIndex: chunkMessage.chunkIndex
          }
        },
        run: async ({ signal }) => this.processChunkTask(chunkMessage, signal),
        onSuccess: () => this.handleChunkCompletion(chunkMessage.id, chunkMessage.fileId),
        onError: (error: Error) =>
          this.handleChunkError(chunkMessage.id, chunkMessage.fileId, error.message),
        onTerminate: () => logger.info(`[RAG] Chunk processing terminated for ${chunkMessage.id}`)
      }
      this.taskQueue.addTask(chunkTask)
    }
  }

  /**
   * 彻底销毁：取消全部任务、等文件写队列排空后销毁底层数据库
   * （连接关闭 + 数据文件删除）。所有失败只记日志——销毁路径不允许
   * 因为单个清理步骤失败而卡住调用方。
   */
  async destroy(): Promise<void> {
    try {
      // 停止所有任务（使用便捷方法）
      this.taskQueue.cancelTasksByKnowledgeBase(this.config.id)
      // 清理所有进度跟踪器
      this.fileProgressMap.clear()
      await Promise.allSettled(this.fileQueueMap.values())
      await this.database.destroy()
    } catch (err) {
      console.error(`[RAG] Error destroying knowledge base ${this.config.id}:`, err)
    }
  }

  /**
   * 温和关闭：取消任务、暂停进行中的处理（状态落库，之后可恢复）、
   * 等文件写队列排空后关闭数据库连接。与 destroy 的区别是数据保留，
   * 重新打开后 paused 的分块可以续跑。失败只记日志，关闭路径必须走完。
   */
  async close(): Promise<void> {
    try {
      // 停止所有任务（使用便捷方法）
      this.taskQueue.cancelTasksByKnowledgeBase(this.config.id)
      // 清理所有进度跟踪器
      this.fileProgressMap.clear()
      await this.pauseAllRunningTasks()
      await Promise.allSettled(this.fileQueueMap.values())
      await this.database.close()
    } catch (err) {
      console.error(`[RAG] Error closing knowledge base ${this.config.id}:`, err)
    }
  }
}
