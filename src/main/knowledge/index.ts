import logger from '@shared/logger'
import fs from 'node:fs'
import path from 'node:path'

import type {
  BuiltinKnowledgeConfig,
  FileValidationResult,
  KnowledgeFileMessage,
  KnowledgeFileResult,
  KnowledgeServicePort,
  QueryResult
} from '@shared/types/knowledge'
import { KnowledgeDatabase } from './database/knowledgeDatabase'
import { KnowledgeBase } from './knowledgeBase'
import { KnowledgeTaskQueue } from './taskQueue'
import { getMetric } from '@/utils/vector'
import { DIALOG_WARN } from '@shared/dialog'
import {
  RecursiveCharacterTextSplitter,
  SupportedTextSplitterLanguages,
  type SupportedTextSplitterLanguage
} from '@/lib/textsplitters'
import { isBuiltinKnowledgeSupported } from './support'
import type { KnowledgeEventPublisher, KnowledgeServiceDeps } from './ports'

/**
 * 内置知识库服务门面（KnowledgeServicePort 的主进程实现）。
 *
 * 上游：routes.ts 把 IPC 路由转发到这里；digital-employee 的知识同步也直接调用。
 * 下游：KnowledgeDatabase（DuckDB 向量存储）、KnowledgeBase（单库的文件/分片/检索
 * 编排）、KnowledgeTaskQueue（嵌入任务的并发调度），以及由 ports 注入的文件解析、
 * 嵌入模型、配置存储、事件发布等能力。
 *
 * 职责：管理知识库全生命周期（建/改/删/开关）、文件进出库、相似度检索，
 * 并在配置变更时把差异落到实际实例上。所有实例按库 id 缓存，惰性创建。
 */

/**
 * 比对前后两份知识库配置，产出需要落地的三类差异。
 *
 * 「更新」的判据是 JSON 串行化后的深度相等：配置对象里嵌着 chunkSize、embedding
 * 等多层字段，逐字段比较既繁琐又容易漏，序列化比对在配置体量下足够快。
 */
function diffKnowledgeConfigs(
  previous: BuiltinKnowledgeConfig[],
  current: BuiltinKnowledgeConfig[]
) {
  const previousById = new Map(previous.map((config) => [config.id, config]))
  const currentIds = new Set(current.map((config) => config.id))
  return {
    added: current.filter((config) => !previousById.has(config.id)),
    deleted: previous.filter((config) => !currentIds.has(config.id)),
    updated: current.filter((config) => {
      const oldConfig = previousById.get(config.id)
      return oldConfig !== undefined && JSON.stringify(config) !== JSON.stringify(oldConfig)
    })
  }
}

export class KnowledgeService implements KnowledgeServicePort {
  /**
   * 知识库存储目录
   */
  private readonly storageDir

  private readonly configPort: KnowledgeServiceDeps['config']

  /**
   * File presenter for validation operations
   */
  private readonly filePort: KnowledgeServiceDeps['files']
  private readonly dialogPort: KnowledgeServiceDeps['dialog']
  private readonly embeddingPort: KnowledgeServiceDeps['embeddings']
  private readonly events: KnowledgeEventPublisher

  /**
   * 全局任务调度器
   */
  private readonly taskQueue: KnowledgeTaskQueue

  /**
   * 缓存 RAG 应用实例
   */
  private readonly knowledgeBases: Map<string, KnowledgeBase>
  /**
   * 进行中的建库 Promise 表：并发请求同一库时共享同一个初始化过程，
   * 避免对同一个 DuckDB 文件重复建连接/建表。初始化完成后从表中移除。
   */
  private readonly knowledgeBaseInitializations: Map<string, Promise<KnowledgeBase>>

  /**
   * 上一份已知的知识库配置快照，用于下次配置同步时做增量 diff。
   */
  private knowledgeConfigSnapshot: BuiltinKnowledgeConfig[]

  constructor(deps: KnowledgeServiceDeps) {
    logger.info('[RAG] Initializing Built-in Knowledge Service')
    this.configPort = deps.config
    this.filePort = deps.files
    this.dialogPort = deps.dialog
    this.embeddingPort = deps.embeddings
    this.events = deps.events
    this.storageDir = path.join(deps.storageRoot, 'KnowledgeBase')
    this.taskQueue = new KnowledgeTaskQueue()
    this.knowledgeBases = new Map()
    this.knowledgeBaseInitializations = new Map()
    this.knowledgeConfigSnapshot = this.configPort.getKnowledgeConfigs() ?? []

    this.initStorageDir()
  }

  /**
   * 初始化知识库存储目录
   */
  private initStorageDir = (): void => {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true })
    }
  }

  /**
   * 把设置层最新的知识库配置同步到运行中的实例。
   *
   * 与配置快照做 diff 后分三类处理：删除的库直接销毁（连同磁盘数据），
   * 更新的库热更新配置或按 enabled 开关启停。新增的库不做任何事——实例
   * 是惰性创建的，首次被文件操作寻址时才真正初始化。先删后更的顺序保证
   * 同一 id 不会在删除途中又被更新路径触碰。
   */
  async syncConfigChanges(): Promise<void> {
    const configs = this.configPort.getKnowledgeConfigs() ?? []
    const diffs = diffKnowledgeConfigs(this.knowledgeConfigSnapshot, configs)
    this.knowledgeConfigSnapshot = configs

    if (diffs.deleted.length > 0) {
      await Promise.all(diffs.deleted.map((config) => this.delete(config.id)))
    }

    if (diffs.added.length > 0) {
      diffs.added.forEach((config) => {
        logger.info(`[RAG] New knowledge config added: ${config.id}`)
      })
    }

    if (diffs.updated.length > 0) {
      await Promise.all(
        diffs.updated.map((config) => {
          logger.info(`[RAG] Knowledge config updated: ${config.id}`)
          return this.update(config)
        })
      )
    }
  }

  isSupported = async (): Promise<boolean> => {
    return isBuiltinKnowledgeSupported()
  }

  /**
   * Create a knowledge base (initialize RAG application)
   * @param config Knowledge base configuration
   */
  create = async (config: BuiltinKnowledgeConfig): Promise<void> => {
    await this.createKnowledgeBase(config)
  }

  /**
   * Update a knowledge base configuration
   *
   * 更新知识库配置（不入库新数据，只调整运行中实例的参数或开关）。
   *
   * 三种时序都要正确处理：实例已缓存 → 直接热更；初始化还在途中 → 等
   * 它落定后再热更（期间该库还不可用，更新不会丢）；配置把库禁用 →
   * 关闭实例，下次启用时按新配置惰性重建。
   *
   * @param config Knowledge base configuration
   */
  update = async (config: BuiltinKnowledgeConfig): Promise<void> => {
    if (config.enabled) {
      // 如果启用且缓存中存在，则更新配置
      const rag = this.getKnowledgeBase(config.id)
      if (rag) {
        rag.updateConfig(config)
        return
      }

      const initializingRag = await this.knowledgeBaseInitializations
        .get(config.id)
        ?.catch(() => undefined)
      if (initializingRag) {
        initializingRag.updateConfig(config)
      }
    } else {
      // 如果禁用且缓存中存在，关闭实例
      await this.closeKnowledgeBaseIfExists(config.id)
    }
  }

  /**
   * Delete a knowledge base (remove local storage)
   * @param id Knowledge base ID
   */
  delete = async (id: string): Promise<void> => {
    try {
      const initializingRag = await this.knowledgeBaseInitializations
        .get(id)
        ?.catch(() => undefined)
      this.knowledgeBaseInitializations.delete(id)
      const cachedRag = this.getKnowledgeBase(id)
      const rag = cachedRag ?? initializingRag

      if (rag) {
        await rag.destroy()
        return
      }

      // 没有可寻址实例（从未打开或已关闭）时直接清磁盘：数据库文件连同
      // WAL 一起删，防止残留文件让下次建库撞上「already exists」。
      const dbPath = path.join(this.storageDir, id)
      if (fs.existsSync(dbPath)) {
        fs.rmSync(dbPath, { recursive: true })
      }
      if (fs.existsSync(dbPath + '.wal')) {
        fs.rmSync(dbPath + '.wal', { recursive: true })
      }
    } finally {
      this.knowledgeBases.delete(id)
      this.knowledgeBaseInitializations.delete(id)
    }
  }

  /**
   * 创建 RAG 应用实例
   * @param params BuiltinKnowledgeConfig
   * @returns KnowledgeBase
   */
  private createKnowledgeBase = async (config: BuiltinKnowledgeConfig): Promise<KnowledgeBase> => {
    const cachedRag = this.getKnowledgeBase(config.id)
    if (cachedRag) {
      cachedRag.updateConfig(config)
      return cachedRag
    }

    const initializingRag = this.knowledgeBaseInitializations.get(config.id)
    if (initializingRag) {
      const rag = await initializingRag
      rag.updateConfig(config)
      return rag
    }

    const initTask = (async () => {
      const db = await this.openKnowledgeDatabase(config.id, config.dimensions, config.normalized)
      try {
        const rag = new KnowledgeBase(
          db,
          config,
          this.taskQueue,
          this.filePort,
          this.embeddingPort,
          this.events
        )
        this.knowledgeBases.set(config.id, rag)
        return rag
      } catch (e) {
        // 建实例失败必须显式关掉刚打开的数据库连接，否则 DuckDB 文件
        // 被句柄占着，下一次创建会失败。
        try {
          await db.close()
        } catch (closeError) {
          console.error(
            '[RAG] Failed to close vector database after knowledge base error:',
            closeError
          )
        }
        throw e
      }
    })()

    this.knowledgeBaseInitializations.set(config.id, initTask)

    try {
      return await initTask
    } finally {
      if (this.knowledgeBaseInitializations.get(config.id) === initTask) {
        this.knowledgeBaseInitializations.delete(config.id)
      }
    }
  }

  /**
   * 获取知识库实例
   * @param id 知识库 ID
   * @returns 知识库实例
   */
  private getKnowledgeBase = (id: string): KnowledgeBase | null => {
    if (this.knowledgeBases.has(id)) {
      return this.knowledgeBases.get(id) as KnowledgeBase
    }
    return null
  }

  /**
   * 获取 RAG 应用实例
   * @param id 知识库 ID
   */
  private getOrCreateKnowledgeBase = async (id: string): Promise<KnowledgeBase> => {
    // 缓存命中直接返回
    if (this.knowledgeBases.has(id)) {
      return this.knowledgeBases.get(id) as KnowledgeBase
    }
    // 获取配置
    const configs = this.configPort.getKnowledgeConfigs()
    const config = configs.find((cfg) => cfg.id === id)
    if (!config) {
      // 配置不存在说明库已被删除（或 id 非法）：向上抛错让调用方感知，
      // 而不是静默返回一个空结果。
      throw new Error(`Knowledge config not found for id: ${id}`)
    }

    return await this.createKnowledgeBase(config)
  }

  /**
   * 关闭 RAG 应用实例
   * @param id 知识库 ID
   * @returns void
   */
  private closeKnowledgeBaseIfExists = async (id: string): Promise<void> => {
    const initializingRag = await this.knowledgeBaseInitializations.get(id)?.catch(() => undefined)
    const rag = this.getKnowledgeBase(id) ?? initializingRag
    try {
      if (rag) {
        await rag.close()
      }
    } finally {
      this.knowledgeBases.delete(id)
    }
  }

  /**
   * 获取向量数据库实例
   * @param id 知识库 ID
   * @param dimensions 向量维度
   * @returns
   */
  private openKnowledgeDatabase = async (
    id: string,
    dimensions: number,
    normalized: boolean
  ): Promise<KnowledgeDatabase> => {
    const dbPath = path.join(this.storageDir, id)
    if (fs.existsSync(dbPath)) {
      const db = new KnowledgeDatabase(dbPath)
      await db.open()
      return db
    }
    // 如果数据库不存在，则初始化
    // 库文件不在磁盘上则走全新初始化：维度取自嵌入模型配置，归一化与否
    // 决定 HNSW 索引的度量（余弦 vs 内积），两者绑定后不再变更。
    const db = new KnowledgeDatabase(dbPath)
    await db.initialize(dimensions, {
      metric: getMetric(normalized)
    })
    return db
  }

  /**
   * 向知识库添加文件。文件入库是异步的：先落文件记录（processing 状态）
   * 立即返回，分片与嵌入在后台进行，进度经事件发布。失败时返回带 error
   * 的结果而不是抛错，方便路由层直接透传给渲染端。
   */
  async addFile(id: string, filePath: string): Promise<KnowledgeFileResult> {
    try {
      const rag = await this.getOrCreateKnowledgeBase(id)
      return await rag.addFile(filePath)
    } catch (err) {
      return {
        error: `添加文件失败: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  /**
   * 从知识库删除文件：级联清除分块、向量与文件记录。
   */
  async deleteFile(id: string, fileId: string): Promise<void> {
    const rag = await this.getOrCreateKnowledgeBase(id)
    await rag.deleteFile(fileId)
  }

  /**
   * 重新灌入一个已存在的文件：清掉旧分块与旧向量后按原 fileId 重走
   * 添加流程。用于嵌入模型更换或分块参数调整后的重建。失败时返回带
   * error 的结果而不是抛错。
   */
  async reAddFile(id: string, fileId: string): Promise<KnowledgeFileResult> {
    try {
      const rag = await this.getOrCreateKnowledgeBase(id)
      return await rag.reAddFile(fileId)
    } catch (err) {
      return {
        error: `重新添加文件失败: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  /**
   * 查询单个文件的元信息（含处理状态与分块统计）；不存在返回 null。
   */
  async queryFile(id: string, fileId: string): Promise<KnowledgeFileMessage | null> {
    const rag = await this.getOrCreateKnowledgeBase(id)
    return await rag.queryFile(fileId)
  }

  /**
   * 列出知识库中全部文件（按上传时间倒序）。
   */
  async listFiles(id: string): Promise<KnowledgeFileMessage[]> {
    const rag = await this.getOrCreateKnowledgeBase(id)
    return await rag.listFiles()
  }

  /**
   * 关闭所有知识库实例（含仍在初始化中的），释放 DuckDB 连接。
   * 用于应用退出前的清理；数据保留在磁盘上，之后可重新打开。
   * 各库的 close 自身会吞错，这里用 Promise.all 保证逐个关闭不被单个失败中断。
   */
  async closeAll(): Promise<void> {
    const initializingRags = await Promise.allSettled(this.knowledgeBaseInitializations.values())
    const stores = new Set<KnowledgeBase>(this.knowledgeBases.values())

    for (const result of initializingRags) {
      if (result.status === 'fulfilled') {
        stores.add(result.value)
      }
    }

    await Promise.all(Array.from(stores).map((rag) => rag.close()))
    this.knowledgeBases.clear()
    this.knowledgeBaseInitializations.clear()
  }

  /**
   * 退出前确认：任务队列里还有未完成的嵌入任务时弹窗询问用户是否放弃。
   * 无任务直接放行；超时（10 秒）视为取消。返回 true 表示可以安全退出。
   *
   * @returns return true if user confirmed to destroy knowledge, otherwise false
   */
  async confirmShutdown(): Promise<boolean> {
    const status = this.taskQueue.getStatus()
    if (status.totalTasks === 0) {
      return true
    }
    const choice = await this.dialogPort.showDialog({
      title: 'settings.knowledgeBase.dialog.beforequit.title',
      description: 'settings.knowledgeBase.dialog.beforequit.description',
      icon: DIALOG_WARN,
      buttons: [
        { key: 'cancel', label: 'settings.knowledgeBase.dialog.beforequit.cancel' },
        { key: 'confirm', label: 'settings.knowledgeBase.dialog.beforequit.confirm', default: true }
      ],
      timeout: 10000,
      i18n: true
    })
    return choice === 'confirm'
  }

  /**
   * 彻底销毁：关闭全部实例并终止任务队列。与 closeAll 的区别是任务队列
   * 也被清空，用于删除库或应用关闭时的最终清理。
   */
  async destroy(): Promise<void> {
    await this.closeAll()
    this.taskQueue.destroy()
  }

  /**
   * 相似度检索：把查询文本嵌入后按库配置的 topK 取最近邻片段。
   */
  async similarityQuery(id: string, key: string): Promise<QueryResult[]> {
    const rag = await this.getOrCreateKnowledgeBase(id)
    return await rag.similarityQuery(key)
  }

  /**
   * 获取知识库任务队列状态
   *
   * 返回队列的总量/运行中/排队中统计，供设置页展示与退出确认。
   */
  async getTaskQueueStatus() {
    return this.taskQueue.getStatus()
  }

  /**
   * 暂停该库所有进行中的分片处理：取消队列任务、清进度缓存，
   * 并把数据库里 processing 状态的记录改为 paused，便于之后断点续跑。
   */
  async pauseAllRunningTasks(id: string): Promise<void> {
    const rag = await this.getOrCreateKnowledgeBase(id)
    await rag.pauseAllRunningTasks()
  }

  /**
   * 恢复该库所有暂停的分片处理：从数据库读回 paused 分块、重建进度
   * 跟踪后重新入队，处理从中断处继续。
   */
  async resumeAllPausedTasks(id: string): Promise<void> {
    const rag = await this.getOrCreateKnowledgeBase(id)
    await rag.resumeAllPausedTasks()
  }

  /**
   * 列出前端可选的文本分块语言（langchain 文本切分器支持的语种）。
   */
  async getSupportedLanguages(): Promise<string[]> {
    return [...SupportedTextSplitterLanguages]
  }

  /**
   * 通用分隔符兜底集：未知语言取不到专用分隔符时按段落→句子→字符的
   * 粒度逐级切分。
   */
  separators: string[] = ['\n\n', '\n', ' ', '']

  /**
   * 获取某种语言的分块分隔符；语言不受支持时降级为通用分隔符集，
   * 不抛错——分块参数获取失败不该阻塞添加文件流程。
   */
  async getSeparatorsForLanguage(language: string): Promise<string[]> {
    try {
      return RecursiveCharacterTextSplitter.getSeparatorsForLanguage(
        language as SupportedTextSplitterLanguage
      )
    } catch {
      return this.separators
    }
  }

  /**
   * Validates if a file is supported for knowledge base processing
   *
   * 校验文件能否进入知识库处理（类型/扩展名/内容可读性）。
   * 校验器抛错也降级为 isSupported=false 的结果，并附带支持的扩展名
   * 列表供前端提示；绝不把异常抛给路由层。
   *
   * @param filePath Path to the file to validate
   * @returns FileValidationResult with validation details
   */
  async validateFile(filePath: string): Promise<FileValidationResult> {
    try {
      logger.info(`[RAG] Validating file for knowledge base: ${filePath}`)
      const result = await this.filePort.validateFileForKnowledgeBase(filePath)

      if (!result.isSupported) {
        console.warn(`[RAG] File validation failed for ${filePath}: ${result.error}`)
      } else {
        logger.info(
          `[RAG] File validation successful for ${filePath}, MIME type: ${result.mimeType}`
        )
      }

      return result
    } catch (error) {
      const errorMessage = `File validation error: ${error instanceof Error ? error.message : 'Unknown error'}`
      console.error(`[RAG] ${errorMessage}`, error)

      return {
        isSupported: false,
        error: errorMessage,
        // 校验器本身故障时仍给前端一份兜底扩展名列表，避免提示为空。
        suggestedExtensions: await this.getSupportedFileExtensions()
      }
    }
  }

  /**
   * Gets all supported file extensions for knowledge base processing
   * @returns Array of supported file extensions (without dots)
   */
  async getSupportedFileExtensions(): Promise<string[]> {
    try {
      logger.info('[RAG] Getting supported file extensions')
      const extensions = this.filePort.getSupportedExtensions()
      logger.info(`[RAG] Retrieved ${extensions.length} supported extensions`)
      return extensions
    } catch (error) {
      const errorMessage = `Error getting supported extensions: ${error instanceof Error ? error.message : 'Unknown error'}`
      console.error(`[RAG] ${errorMessage}`, error)

      // Return fallback extensions if service fails
      // 文件服务不可用时的静态兜底列表：让「上传」入口不至于完全不可用，
      // 只是校验精度退化为纯扩展名过滤。
      const fallbackExtensions = [
        'txt',
        'md',
        'markdown',
        'pdf',
        'docx',
        'pptx',
        'xlsx',
        'csv',
        'json',
        'yaml',
        'yml',
        'xml',
        'js',
        'ts',
        'py',
        'java',
        'cpp',
        'c',
        'h',
        'css',
        'html'
      ].sort()

      console.warn(`[RAG] Using fallback extensions: ${fallbackExtensions.join(', ')}`)
      return fallbackExtensions
    }
  }
}
