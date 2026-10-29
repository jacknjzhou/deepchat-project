import type {
  BuiltinKnowledgeConfig,
  FileValidationResult,
  KnowledgeChunkMessage,
  KnowledgeFileMessage,
  KnowledgeIndexOptions,
  KnowledgeQueryOptions,
  KnowledgeTaskQueueStatus,
  KnowledgeTaskStatus,
  KnowledgeVectorInsert,
  QueryResult
} from '@shared/types/knowledge'

/**
 * 知识库模块的端口（依赖倒置接口）集合。
 *
 * KnowledgeService / KnowledgeBase 只依赖这里声明的抽象端口，不直接
 * import 文件解析、嵌入模型、对话框、事件总线等具体实现——主进程装配
 * 层负责提供实现，测试则可注入桩。各端口的实现方见各接口注释。
 */

/**
 * 一个待执行的背景任务（目前只有分块嵌入）。
 *
 * payload 里必须带 knowledgeBaseId 与 fileId：队列的取消/统计能力都
 * 按这两个维度过滤。run 收到的 AbortSignal 由队列持有，任务应在合适
 * 的检查点响应取消。
 */
export type KnowledgeTask = {
  id: string
  payload: {
    knowledgeBaseId: string
    fileId: string
    [key: string]: unknown
  }
  run: (context: { signal: AbortSignal }) => Promise<void>
  /** 任务正常跑完且未被取消时回调。 */
  onSuccess?: () => void
  /** 任务抛出非取消异常时回调，附错误对象。 */
  onError?: (error: Error) => void
  /** 任务被取消（AbortError 或完成后发现信号已中止）时回调。 */
  onTerminate?: () => void
}

/** 背景任务队列的抽象：入队、按库/文件取消、状态查询与销毁。 */
export interface KnowledgeTaskQueuePort {
  addTask(task: KnowledgeTask): void
  cancelTasksByKnowledgeBase(knowledgeBaseId: string): void
  cancelTasksByFile(fileId: string): void
  getStatus(): KnowledgeTaskQueueStatus
  destroy(): void
}

/**
 * 向量数据库的抽象：文件/分块/向量三层数据的存取与检索。
 *
 * 实现方为 KnowledgeDatabase（DuckDB + VSS）。所有写方法经内部事务
 * 串行执行；查询方法失败会抛错，按 id 找不到的查询返回 null 或空数组。
 */
export interface KnowledgeDatabasePort {
  /** 新建库：建文件/分块/向量/元数据四张表与 HNSW 索引；路径已存在时抛错。 */
  initialize(dimensions: number, opts?: KnowledgeIndexOptions): Promise<void>
  /** 打开既有库：修复 WAL 残留、跑迁移、清孤儿数据；文件不存在时抛错。 */
  open(): Promise<void>
  /** 关闭连接并释放句柄，数据保留。 */
  close(): Promise<void>
  /** 关闭并从磁盘删除数据库文件（含 WAL），不可恢复。 */
  destroy(): Promise<void>
  /** 插入单条向量；目标文件不存在时抛错。 */
  insertVector(opts: KnowledgeVectorInsert): Promise<void>
  /** 批量插入向量；空数组直接返回。 */
  insertVectors(records: KnowledgeVectorInsert[]): Promise<void>
  /** 近似最近邻检索，返回按距离升序的 topK 结果（含正文与来源信息）。 */
  similarityQuery(vector: number[], options: KnowledgeQueryOptions): Promise<QueryResult[]>
  /** 删除指定文件的全部向量。 */
  deleteVectorsByFile(id: string): Promise<void>
  /** 插入文件元信息记录（重复 id 会因主键约束抛错）。 */
  insertFile(file: KnowledgeFileMessage): Promise<void>
  /** 按 id 全量更新文件记录；记录不存在时静默无操作。 */
  updateFile(file: KnowledgeFileMessage): Promise<void>
  /** 按 id 查询单个文件；不存在返回 null。 */
  queryFile(id: string): Promise<KnowledgeFileMessage | null>
  /** 按条件查询文件（条件对象为空返回全表，按上传时间倒序）。 */
  queryFiles(where: Partial<KnowledgeFileMessage>): Promise<KnowledgeFileMessage[]>
  /** 列出全部文件。 */
  listFiles(): Promise<KnowledgeFileMessage[]>
  /** 级联删除文件及其全部分块与向量，事务保证原子性。 */
  deleteFile(id: string): Promise<void>
  /** 批量插入分块记录；空数组直接返回。 */
  insertChunks(chunks: KnowledgeChunkMessage[]): Promise<void>
  /** 更新单个分块的处理状态，可附错误原因。 */
  updateChunkStatus(chunkId: string, status: KnowledgeTaskStatus, error?: string): Promise<void>
  /** 按条件查询分块（如按状态取 paused 分块）。 */
  queryChunks(where: Partial<KnowledgeChunkMessage>): Promise<KnowledgeChunkMessage[]>
  /** 删除指定文件的全部分块。 */
  deleteChunksByFile(fileId: string): Promise<void>
  /** 把所有 processing 状态的文件/分块批量置为 paused。 */
  pauseAllRunningTasks(): Promise<void>
  /** 把所有 paused 状态的记录批量置回 processing。 */
  resumeAllPausedTasks(): Promise<void>
}

/** 配置读取端口：由设置存储适配，供服务按库 id 取回运行配置。 */
export interface KnowledgeConfigPort {
  getKnowledgeConfigs(): BuiltinKnowledgeConfig[]
}

/** 文件处理端口：MIME 探测、正文抽取、入库前校验与扩展名清单。 */
export interface KnowledgeFilePort {
  /** 探测文件 MIME 类型；无法识别时由实现方决定返回值语义。 */
  getMimeType(filePath: string): Promise<string>
  /**
   * 完整准备一份文件供索引：读取并抽取正文。
   * @param contentType 'origin' 取原始正文，'llm-friendly' 取面向模型的
   *   转写版本；正文不可读时 content 为 undefined（调用方按空内容处理）。
   */
  prepareFileCompletely(
    filePath: string,
    mimeType?: string,
    contentType?: null | 'origin' | 'llm-friendly'
  ): Promise<{
    name: string
    content?: string
    metadata: { fileSize: number }
  }>
  validateFileForKnowledgeBase(filePath: string): Promise<FileValidationResult>
  /** 返回知识库支持的文件扩展名（不带点号），供上传入口过滤与提示。 */
  getSupportedExtensions(): string[]
}

/** 嵌入模型端口：把一批文本转为等长的向量。失败时抛错由调用方处理。 */
export interface KnowledgeEmbeddingPort {
  /**
   * 生成文本向量。
   * @param providerId 嵌入服务商 id（与知识库配置绑定）
   * @param modelId 模型 id
   * @param texts 待嵌入文本批次
   * @param signal 可选中止信号，供取消进行中的嵌入调用
   * @returns 与 texts 等长且顺序一一对应的向量数组
   */
  getEmbeddings(
    providerId: string,
    modelId: string,
    texts: string[],
    signal?: AbortSignal
  ): Promise<number[][]>
}

/**
 * 对话框端口：主进程弹窗（如退出前任务未完成的确认）。
 * @returns 被点击按钮的 key；超时未点击由实现方决定返回语义
 */
export interface KnowledgeDialogPort {
  showDialog(request: {
    title: string
    description?: string
    i18n?: boolean
    icon?: { icon: string; class: string }
    buttons?: Array<{ key: string; label: string; default?: boolean }>
    timeout?: number
  }): Promise<string>
}

/** 事件发布端口：把文件状态/进度变化推给渲染端。实现方为事件总线。 */
export interface KnowledgeEventPublisher {
  /** 文件记录（状态、元信息）发生变化时广播整条记录。 */
  publishFileUpdated(file: KnowledgeFileMessage): void
  /** 分块进度变化时按文件广播计数（完成/出错/总数）。 */
  publishFileProgress(
    fileId: string,
    progress: { completed: number; error: number; total: number }
  ): void
}

/**
 * KnowledgeService 的依赖装配清单：装配层按此注入各端口实现与
 * 存储根目录；测试注入桩即可完整构造服务。
 */
export type KnowledgeServiceDeps = {
  config: KnowledgeConfigPort
  /** 知识库数据的存储根目录（库文件建在其下的 KnowledgeBase/ 子目录）。 */
  storageRoot: string
  files: KnowledgeFilePort
  dialog: KnowledgeDialogPort
  embeddings: KnowledgeEmbeddingPort
  events: KnowledgeEventPublisher
}
