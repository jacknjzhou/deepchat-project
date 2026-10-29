import logger from '@shared/logger'
import fs from 'node:fs'
import path from 'node:path'

import { DuckDBConnection, DuckDBInstance, arrayValue } from '@duckdb/node-api'
import type {
  KnowledgeIndexOptions,
  KnowledgeQueryOptions,
  KnowledgeVectorInsert,
  KnowledgeFileMessage,
  KnowledgeChunkMessage,
  KnowledgeTaskStatus,
  QueryResult
} from '@shared/types/knowledge'
import type { KnowledgeDatabasePort } from '../ports'

import { nanoid } from 'nanoid'
import { app } from 'electron'

/**
 * 基于 DuckDB + VSS 扩展的向量数据库实现（KnowledgeDatabasePort）。
 *
 * 单个知识库对应一个数据库文件，内含四张表：file（文件元信息）、
 * chunk（文本分块）、vector（定长向量 + HNSW 近似最近邻索引）、
 * metadata（版本与迁移记账）。文件/分块/向量的写操作经内部事务队列
 * 串行执行；相似度检索走 VSS 的 HNSW 索引。
 *
 * 崩溃恢复：异常退出留下的 WAL 会让 VSS 的持久化 HNSW 索引无法直接
 * 加载，open() 前会先经内存实例 ATTACH 并 checkpoint 修复。打开时还会
 * 清理孤儿向量/分块，并把 processing 状态的记录统一置为 paused。
 */
const runtimeBasePath = path
  .join(app.getAppPath(), 'runtime')
  .replace('app.asar', 'app.asar.unpacked')
const extensionDir = path.join(runtimeBasePath, 'duckdb', 'extensions')
const extensionSuffix = '.duckdb_extension'

// 数据库版本常量
const CURRENT_DB_VERSION = 1
const DB_VERSION_KEY = 'db_version'

// 迁移接口定义
/**
 * 每个迁移只负责一个版本步进，up 必须幂等可重试；
 * down 可选，仅在需要回滚的场景实现。
 */
interface DatabaseMigration {
  version: number
  description: string
  up: (database: KnowledgeDatabase) => Promise<void>
  down?: (database: KnowledgeDatabase) => Promise<void>
}

// 数据库迁移定义
const MIGRATIONS: DatabaseMigration[] = [
  {
    version: 1,
    description: 'Initial database schema',
    up: async (_database: KnowledgeDatabase) => {
      // 初始版本的迁移在 initialize 方法中已经处理
      logger.info('[DuckDB Migration] Applied initial schema (v1)')
    }
  }
  // 未来的迁移示例：
  // {
  //   version: 2,
  //   description: 'Add file size and hash columns',
  //   up: async (database: KnowledgeDatabase) => {
  //     await database.safeRun('ALTER TABLE file ADD COLUMN file_size BIGINT;')
  //     await database.safeRun('ALTER TABLE file ADD COLUMN file_hash VARCHAR;')
  //     await database.safeRun('CREATE INDEX IF NOT EXISTS idx_file_hash ON file (file_hash);')
  //   },
  //   down: async (database: KnowledgeDatabase) => {
  //     await database.safeRun('ALTER TABLE file DROP COLUMN file_size;')
  //     await database.safeRun('ALTER TABLE file DROP COLUMN file_hash;')
  //   }
  // }
]

export class KnowledgeDatabase implements KnowledgeDatabasePort {
  private dbInstance!: DuckDBInstance
  private connection!: DuckDBConnection

  private readonly dbPath: string

  // 四张表的表名。vector 存嵌入向量，file 存文件元信息，chunk 存分块
  // 正文与状态，metadata 存数据库版本号等记账键值。
  private readonly vectorTable = 'vector'
  private readonly fileTable = 'file'
  private readonly chunkTable = 'chunk'
  private readonly metadataTable = 'metadata'

  constructor(dbPath: string) {
    this.dbPath = dbPath
  }

  /**
   * 全新建库：创建数据库文件、加载 VSS 扩展、建四张表与 HNSW 索引，
   * 并写入初始版本号。文件已存在时直接抛错——初始化只允许发生在
   * 空路径上，已有库必须走 open()。初始化失败时尽力关闭已打开的连接。
   *
   * @param dimensions 向量维度，必须与嵌入模型输出一致，建表后不可变更
   */
  async initialize(dimensions: number, opts?: KnowledgeIndexOptions): Promise<void> {
    try {
      logger.info(`[DuckDB] Initializing DuckDB database at ${this.dbPath}`)
      if (fs.existsSync(this.dbPath)) {
        console.error(`[DuckDB] Database ${this.dbPath} already exists`)
        throw new Error('Database already exists, cannot initialize again.')
      }
      logger.info(`[DuckDB] connect to db`)
      await this.create()
      logger.info(`[DuckDB] load vss extension`)
      await this.installAndLoadExtension('vss', async () => {
        await this.safeRun(`SET hnsw_enable_experimental_persistence = true;`)
      })
      logger.info(`[DuckDB] create metadata table`)
      await this.initMetadataTable()
      logger.info(`[DuckDB] create file table`)
      await this.initFileTable()
      logger.info(`[DuckDB] create chunk table`)
      await this.initChunkTable()
      logger.info(`[DuckDB] create vector table`)
      await this.initVectorTable(dimensions)
      logger.info(`[DuckDB] create vector index`)
      await this.initTableIndex(opts)
      logger.info(`[DuckDB] set initial database version`)
      await this.setDatabaseVersion(CURRENT_DB_VERSION)
    } catch (error) {
      console.error('[DuckDB] initialization failed:', error)
      this.close()
    }
  }

  /**
   * 打开已存在的数据库：先处理崩溃残留（WAL 修复），再连接、跑迁移、
   * 清孤儿数据、把上次中断的任务置为 paused。数据库文件不存在时抛错。
   */
  async open(): Promise<void> {
    if (!fs.existsSync(this.dbPath)) {
      console.error(`[DuckDB] Database ${this.dbPath} does not exist`)
      throw new Error('Database does not exist, please initialize first.')
    }

    if (await this.hasWal()) {
      try {
        await this.repairIndex()
      } catch (error) {
        // TODO 数据库已无法修复，提示用户重建
        // WAL 修复失败说明文件已损坏到无法附加的程度，只能让上层引导重建。
        console.error('[DuckDB] Error opening database:', error)
        throw new Error('Failed to open database, please check the logs for details.')
      }
    }

    // 清理任何残留的事务队列
    // 上次实例若异常退出，本实例是新对象、队列必为空；这里防御旧实例
    // 复用（同进程 close 后再 open）时把待写操作带进新会话。
    if (this.transactionQueue.length > 0) {
      this.transactionQueue = []
    }

    logger.info(`[DuckDB] connect to db`)
    await this.connect()
    logger.info(`[DuckDB] load vss extension`)
    await this.installAndLoadExtension('vss', async () => {
      await this.safeRun(`SET hnsw_enable_experimental_persistence = true;`)
    })
    logger.info(`[DuckDB] check and run database migrations`)
    await this.runMigrations()
    logger.info(`[DuckDB] clear dirty data`)
    await this.clearDirtyData()
    logger.info(`[DuckDB] paused all running tasks`)
    await this.pauseAllRunningTasks()
  }

  /**
   * 关闭数据库：先等正在执行的事务收尾，再拒绝掉队列里排不上的操作
   * （调用方拿到明确的「closing」错误而不是永久挂起），最后释放连接。
   * WAL 由 DuckDB 在关闭时自动 checkpoint，无需显式执行。
   * 所有关闭期错误只记日志——关闭必须走完，不留半开的句柄。
   */
  async close(): Promise<void> {
    try {
      // 等待当前事务处理完成
      if (this.isProcessingTransaction && this.currentTransactionPromise) {
        try {
          await this.currentTransactionPromise
        } catch (error) {
          console.warn('[DuckDB] Error waiting for transaction to complete during close:', error)
        }
      }

      // 清理任何剩余的事务队列
      if (this.transactionQueue.length > 0) {
        const remainingOperations = [...this.transactionQueue]
        this.transactionQueue = []
        const error = new Error('Database is closing, operations cancelled')
        for (const { reject } of remainingOperations) {
          reject(error)
        }
      }

      // CLOSE 时不需要显式执行 CHECKPOINT，因为 DuckDB 会自动处理 WAL 文件
      // await this.safeRun('CHECKPOINT;')

      if (this.connection) {
        this.connection.closeSync()
      }
      if (this.dbInstance) {
        this.dbInstance.closeSync()
      }
      logger.info('[DuckDB] DuckDB connection closed')
    } catch (err) {
      console.error('[DuckDB] close error', err)
    }
  }

  /**
   * 销毁数据库：关闭连接后把数据库文件与 WAL 文件一并从磁盘删除。
   * 删除失败只记日志——文件残留由下次 delete/重建兜底清理。
   */
  async destroy(): Promise<void> {
    await this.close()
    // 删除数据库文件
    try {
      if (fs.existsSync(this.dbPath)) {
        fs.rmSync(this.dbPath, { recursive: true })
      }
      if (fs.existsSync(this.dbPath + '.wal')) {
        fs.rmSync(this.dbPath + '.wal', { recursive: true })
      }
      logger.info(`[DuckDB] Database at ${this.dbPath} destroyed.`)
    } catch (err) {
      console.error(`[DuckDB] Error destroying database at ${this.dbPath}:`, err)
    }
  }

  // ==================== KnowledgeDatabasePort 接口实现 ====================

  /**
   * 插入一条文件元信息记录（processing 初始态）。metadata 以 JSON
   * 字符串落库；记录不存在时行为由主键约束决定（重复插入会报错）。
   */
  async insertFile(file: KnowledgeFileMessage): Promise<void> {
    const sql = `
        INSERT INTO ${this.fileTable} (id, name, path, mime_type, status, uploaded_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?);
      `
    await this.executeInTransaction(async () => {
      await this.safeRun(sql, [
        file.id,
        file.name,
        file.path,
        file.mimeType,
        file.status,
        String(file.uploadedAt),
        JSON.stringify(file.metadata)
      ])
    })
  }

  /**
   * 全量更新文件记录（按 id 定位）。状态流转（processing/completed/
   * error/paused）都走这里；记录不存在时 UPDATE 静默无操作。
   */
  async updateFile(file: KnowledgeFileMessage): Promise<void> {
    const sql = `
        UPDATE ${this.fileTable}
        SET name = ?, path = ?, mime_type = ?, status = ?, uploaded_at = ?, metadata = ?
        WHERE id = ?;
      `
    await this.executeInTransaction(async () => {
      await this.safeRun(sql, [
        file.name,
        file.path,
        file.mimeType,
        file.status,
        String(file.uploadedAt),
        JSON.stringify(file.metadata),
        file.id
      ])
    })
  }

  async queryFile(id: string): Promise<KnowledgeFileMessage | null> {
    const sql = `SELECT * FROM ${this.fileTable} WHERE id = ?;`
    try {
      const reader = await this.connection.runAndReadAll(sql, [id])
      const rows = reader.getRowObjectsJson()
      if (rows.length === 0) return null
      const row = rows[0]
      return this.toKnowledgeFileMessage(row)
    } catch (err) {
      console.error('[DuckDB] queryFile error', sql, id, err)
      throw err
    }
  }

  /**
   * 按条件查询文件记录：条件为空时返回全表（按上传时间倒序）。
   * 驼峰键自动映射到蛇形列名；查不到返回空数组。
   */
  async queryFiles(where: Partial<KnowledgeFileMessage>): Promise<KnowledgeFileMessage[]> {
    const camelToSnake = (key: string) =>
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

    const entries = Object.entries(where).filter(([, value]) => value !== undefined)

    let sql = `SELECT * FROM ${this.fileTable}`
    const params: any[] = []

    if (entries.length > 0) {
      const conditions = entries.map(([key]) => `${camelToSnake(key)} = ?`).join(' AND ')
      sql += ` WHERE ${conditions}`
      params.push(...entries.map(([, value]) => value))
    }

    sql += ` ORDER BY uploaded_at DESC;`

    try {
      const reader = await this.connection.runAndReadAll(sql, params)
      const rows = reader.getRowObjectsJson()
      return rows.map((row) => this.toKnowledgeFileMessage(row))
    } catch (err) {
      console.error('[DuckDB] queryFiles error', sql, params, err)
      throw err
    }
  }

  async listFiles(): Promise<KnowledgeFileMessage[]> {
    const sql = `SELECT * FROM ${this.fileTable} ORDER BY uploaded_at DESC;`
    try {
      const reader = await this.connection.runAndReadAll(sql)
      const rows = reader.getRowObjectsJson()
      return rows.map((row) => this.toKnowledgeFileMessage(row))
    } catch (err) {
      console.error('[DuckDB] listFiles error', sql, err)
      throw err
    }
  }

  /**
   * 删除文件及其级联数据：先删分块与向量（子表），最后删文件记录。
   * 整体包在一个事务里，任何一步失败全部回滚，不留半删状态。
   */
  async deleteFile(id: string): Promise<void> {
    await this.executeInTransaction(async () => {
      await this.safeRun(`DELETE FROM ${this.chunkTable} WHERE file_id = ?;`, [id])
      await this.safeRun(`DELETE FROM ${this.vectorTable} WHERE file_id = ?;`, [id])
      await this.safeRun(`DELETE FROM ${this.fileTable} WHERE id = ?;`, [id])
    })
  }

  /**
   * 批量插入分块记录（初始 processing 态）。空数组直接返回，避免
   * 拼出 VALUES 为空的非法 SQL。
   */
  async insertChunks(chunks: KnowledgeChunkMessage[]): Promise<void> {
    if (!chunks.length) return
    const valuesSql = chunks.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')
    const sql = `INSERT INTO ${this.chunkTable} (id, file_id, chunk_index, content, status, error) VALUES ${valuesSql};`
    const params: any[] = []
    for (const chunk of chunks) {
      params.push(
        chunk.id,
        chunk.fileId,
        chunk.chunkIndex,
        chunk.content,
        chunk.status,
        chunk.error ?? ''
      )
    }
    await this.executeInTransaction(async () => {
      await this.safeRun(sql, params)
    })
  }

  /**
   * 更新单个分块的处理状态（completed/error/paused），error 可附原因。
   * 注意此处只改状态不写向量——向量由嵌入任务在状态更新前一并写入。
   */
  async updateChunkStatus(
    chunkId: string,
    status: KnowledgeTaskStatus,
    error?: string
  ): Promise<void> {
    await this.executeInTransaction(async () => {
      await this.safeRun(`UPDATE ${this.chunkTable} SET status = ?, error = ? WHERE id = ?;`, [
        status,
        error ?? '',
        chunkId
      ])
    })
  }

  /**
   * 按条件查询分块（如按状态取 paused 分块做恢复）。条件为空返回全表；
   * 驼峰键自动映射蛇形列名。
   */
  async queryChunks(where: Partial<KnowledgeChunkMessage>): Promise<KnowledgeChunkMessage[]> {
    const camelToSnake = (key: string) =>
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

    const entries = Object.entries(where).filter(([, value]) => value !== undefined)

    let sql = `SELECT * FROM ${this.chunkTable}`
    const params: any[] = []

    if (entries.length > 0) {
      const conditions = entries.map(([key]) => `${camelToSnake(key)} = ?`).join(' AND ')
      sql += ` WHERE ${conditions}`
      params.push(...entries.map(([, value]) => value))
    }

    try {
      const reader = await this.connection.runAndReadAll(sql, params)
      const rows = reader.getRowObjectsJson()
      return rows.map((row) => this.toKnowledgeChunkMessage(row))
    } catch (err) {
      console.error('[DuckDB] queryChunks error', sql, params, err)
      throw err
    }
  }

  async deleteChunksByFile(fileId: string): Promise<void> {
    await this.executeInTransaction(async () => {
      await this.safeRun(`DELETE FROM ${this.chunkTable} WHERE file_id = ?;`, [fileId])
    })
  }

  /**
   * 插入单条向量。先校验目标文件存在——文件记录缺失时向量会成为
   * 永远检索不到归属的孤儿，宁可在这里失败让嵌入任务记为 error。
   */
  async insertVector(opts: KnowledgeVectorInsert): Promise<void> {
    // 查询文件是否存在
    const file = await this.queryFile(opts.fileId)
    if (!file) {
      throw new Error(`File with ID ${opts.fileId} does not exist`)
    }
    const vec = arrayValue(Array.from(opts.vector))
    await this.executeInTransaction(async () => {
      await this.safeRun(
        `INSERT INTO ${this.vectorTable} (id, embedding, file_id, chunk_id)
         VALUES (?, ?::FLOAT[], ?, ?);`,
        [nanoid(), vec, opts.fileId, opts.chunkId]
      )
    })
  }

  /**
   * 批量插入向量。空数组直接返回；单条事务保证整批原子落库。
   */
  async insertVectors(records: KnowledgeVectorInsert[]): Promise<void> {
    if (!records.length) return
    // 构造批量插入 SQL
    const valuesSql = records.map(() => '(?, ?::FLOAT[], ?, ?)').join(', ')
    const sql = `INSERT INTO ${this.vectorTable} (id, embedding, file_id, chunk_id) VALUES ${valuesSql};`
    const params: any[] = []
    for (const r of records) {
      params.push(nanoid())
      params.push(arrayValue(Array.from(r.vector)))
      params.push(r.fileId)
      params.push(r.chunkId)
    }
    await this.executeInTransaction(async () => {
      await this.safeRun(sql, params)
    })
  }

  /**
   * 相似度检索：按度量选择距离函数，对向量表做近邻排序取 topK，
   * 联查分块正文与文件名/路径填充结果元信息。结果按距离升序（越小
   * 越相似）；向量维度与建库时不一致会由 DuckDB 抛错。
   *
   * @param vector 查询向量，维度必须与建库时的 dimensions 一致
   */
  async similarityQuery(vector: number[], options: KnowledgeQueryOptions): Promise<QueryResult[]> {
    const k = options.topK
    // 三种度量的距离语义不同（L2/余弦/内积），但都满足「升序即最相似」，
    // 上层 normalizeDistance 负责把不同度量折算到统一可比较的语义。
    const fn =
      options.metric === 'ip'
        ? 'array_negative_inner_product'
        : options.metric === 'cosine'
          ? 'array_cosine_distance'
          : 'array_distance'
    const sql = `
      SELECT t.id as id, ${fn}(embedding, ?) AS distance, t1.content as content, t2.name as name, t2.path as path
      FROM ${this.vectorTable} t
      LEFT JOIN ${this.chunkTable} t1 ON t1.id = t.chunk_id
      LEFT JOIN ${this.fileTable} t2 ON t2.id = t.file_id
      ORDER BY distance
      LIMIT ?;
    `
    const embParam = arrayValue(Array.from(vector))
    const paramsArr: any[] = [embParam]
    if (options.threshold != null) {
      paramsArr.push(options.threshold)
    }
    paramsArr.push(k)
    try {
      const reader = await this.connection.runAndReadAll(sql, paramsArr)
      const rows = reader.getRowObjectsJson()
      return rows.map((r: any) => ({
        id: r.id,
        distance: r.distance,
        metadata: {
          from: r.name,
          filePath: r.path,
          content: r.content
        }
      }))
    } catch (err) {
      console.error('[DuckDB] similarityQuery error', sql, paramsArr, err)
      throw err
    }
  }

  /**
   * 删除指定文件的所有向量（重灌文件前清旧索引用）。
   */
  async deleteVectorsByFile(fileId: string): Promise<void> {
    await this.executeInTransaction(async () => {
      await this.safeRun(`DELETE FROM ${this.vectorTable} WHERE file_id = ?;`, [fileId])
    })
  }

  // ==================== 转换工具 ====================

  /** 行对象 → 文件元信息：蛇形列名折回驼峰，metadata 还原为对象。 */
  private toKnowledgeFileMessage(o: any): KnowledgeFileMessage {
    return {
      id: o.id,
      name: o.name,
      path: o.path,
      mimeType: o.mime_type,
      status: o.status,
      uploadedAt: Number(o.uploaded_at),
      metadata: typeof o.metadata === 'string' ? JSON.parse(o.metadata) : o.metadata
    }
  }

  /** 行对象 → 分块消息：蛇形列名折回驼峰。 */
  private toKnowledgeChunkMessage(o: any): KnowledgeChunkMessage {
    return {
      id: o.id,
      fileId: o.file_id,
      chunkIndex: o.chunk_index,
      content: o.content,
      status: o.status,
      error: o.error
    }
  }

  // ==================== 事务管理 ====================
  // 待执行操作的 FIFO 队列：DuckDB 同一连接不支持并发事务，所有写操作
  // 必须排在这里串行执行；带时间戳便于把排队过久的操作判超时。
  private transactionQueue: Array<{
    operation: () => Promise<any>
    resolve: (value: any) => void
    reject: (error: any) => void
    timestamp: number // 添加时间戳用于超时检测
  }> = []

  private isProcessingTransaction = false
  private currentTransactionPromise: Promise<void> | null = null
  private readonly TRANSACTION_TIMEOUT = 30000 // 30秒超时

  /**
   * 将操作添加到事务队列中，确保所有数据库操作串行执行
   *
   * 入队即返回 Promise，真正执行由 processTransactionQueue 驱动；
   * 超时或事务回滚都会 reject，调用方以抛错形式感知。
   */
  private async executeInTransaction<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.transactionQueue.push({
        operation,
        resolve,
        reject,
        timestamp: Date.now()
      })

      // 如果当前没有正在处理事务，则开始处理队列
      if (!this.isProcessingTransaction) {
        this.processTransactionQueue()
      }
    })
  }

  /**
   * 处理事务队列，确保所有操作串行执行
   *
   * 把队列中当时已积压的操作合入一个 BEGIN/COMMIT 批次：单个事务覆盖
   * 多个操作，既减少 DuckDB 的事务开销，也让「整批操作」具备原子性。
   * 批内单个操作失败会回滚整批——即使已成功的操作也会被 reject，
   * 因为它们的数据并未真正提交。排队超过 TRANSACTION_TIMEOUT 的操作
   * 直接判超时拒绝，防止关闭阶段调用方无限等待。
   */
  private async processTransactionQueue(): Promise<void> {
    if (this.isProcessingTransaction || this.transactionQueue.length === 0) {
      return
    }

    this.isProcessingTransaction = true

    // 创建当前事务 Promise，供 close 方法等待
    this.currentTransactionPromise = (async () => {
      try {
        // 开始事务
        await this.safeRun('BEGIN TRANSACTION;')

        // 处理队列中的所有操作
        const operations = [...this.transactionQueue]
        this.transactionQueue = []

        // 检查是否有超时的操作
        const now = Date.now()
        const timeoutOps = operations.filter((op) => now - op.timestamp > this.TRANSACTION_TIMEOUT)

        if (timeoutOps.length > 0) {
          console.warn(`[DuckDB] Found ${timeoutOps.length} timeout operations, rejecting them`)
          const timeoutError = new Error('Transaction operation timeout')
          for (const { reject } of timeoutOps) {
            reject(timeoutError)
          }
        }

        // 只处理未超时的操作
        const validOperations = operations.filter(
          (op) => now - op.timestamp <= this.TRANSACTION_TIMEOUT
        )

        if (validOperations.length === 0) {
          return // 没有有效操作需要处理
        }

        const results: any[] = []
        let hasError = false
        let errorToThrow: any = null

        for (const { operation, resolve, reject } of validOperations) {
          try {
            const result = await operation()
            results.push({ success: true, result, resolve, reject })
          } catch (error) {
            results.push({ success: false, error, resolve, reject })
            hasError = true
            if (!errorToThrow) {
              errorToThrow = error
            }
          }
        }

        if (hasError) {
          // 如果有错误，回滚事务
          // 整批回滚后，成功操作也一并 reject：调用方必须知道写入未生效。
          await this.safeRun('ROLLBACK;')

          // 拒绝所有操作
          for (const { success, error, reject } of results) {
            if (success) {
              reject(errorToThrow) // 即使成功的操作也要因为事务回滚而失败
            } else {
              reject(error)
            }
          }
        } else {
          // 如果没有错误，提交事务
          await this.safeRun('COMMIT;')

          // 解析所有操作
          for (const { result, resolve } of results) {
            resolve(result)
          }
        }
      } catch (error) {
        // 处理事务操作本身的错误
        console.error('[DuckDB] Transaction processing error:', error)

        try {
          await this.safeRun('ROLLBACK;')
        } catch (rollbackError) {
          console.error('[DuckDB] Rollback error:', rollbackError)
        }

        // 拒绝所有队列中的操作
        for (const { reject } of this.transactionQueue) {
          reject(error)
        }
        this.transactionQueue = []
      } finally {
        this.isProcessingTransaction = false
        this.currentTransactionPromise = null

        // 如果队列中还有新的操作，继续处理
        if (this.transactionQueue.length > 0) {
          // 使用 setImmediate 避免递归调用栈过深
          // 处理期间新入队的操作交给下一轮事件循环，让出主线程。
          setImmediate(() => this.processTransactionQueue())
        }
      }
    })()

    await this.currentTransactionPromise
  }

  /**
   * 直接执行 SQL（带可选参数），连接缺失时自动重建。失败记日志后
   * 原样上抛，由上层事务机制决定回滚。
   */
  private async safeRun(sql: string, params?: any[]): Promise<any> {
    try {
      if (!this.connection) await this.create()
      if (params) {
        return await this.connection.run(sql, params)
      } else {
        return await this.connection.run(sql)
      }
    } catch (err) {
      console.error('[DuckDB] sql error', sql, params, err)
      throw err
    }
  }

  /**
   * 暂停全部进行中任务：把 processing 状态的文件/分块批量置为 paused。
   * 用于应用关闭前的状态落盘——重启后由 resume 流程按记录续跑。
   */
  async pauseAllRunningTasks(): Promise<void> {
    // paused chunk
    await this.executeInTransaction(async () => {
      await this.safeRun(
        `UPDATE ${this.chunkTable} SET status = 'paused' WHERE status = 'processing';`
      )
    })
    // paused file
    await this.executeInTransaction(async () => {
      await this.safeRun(
        `UPDATE ${this.fileTable} SET status = 'paused' WHERE status = 'processing';`
      )
    })
  }

  /**
   * 恢复全部暂停任务：把 paused 状态的记录批量置回 processing。
   * 只改状态记账，真正的重新入队由 KnowledgeBase 层驱动。
   */
  async resumeAllPausedTasks(): Promise<void> {
    // resumed chunk
    await this.executeInTransaction(async () => {
      await this.safeRun(
        `UPDATE ${this.chunkTable} SET status = 'processing' WHERE status = 'paused';`
      )
    })
    // resumed file
    await this.executeInTransaction(async () => {
      await this.safeRun(
        `UPDATE ${this.fileTable} SET status = 'processing' WHERE status = 'paused';`
      )
    })
  }

  // ==================== 初始化相关 ====================

  /** 新建 DuckDB 实例并打开连接（用于全新初始化路径）。 */
  private async create() {
    this.dbInstance = await DuckDBInstance.create(this.dbPath)
    this.connection = await this.dbInstance.connect()
    logger.info(`[DuckDB] Connected to DuckDB at ${this.dbPath}`)
  }

  /** 打开既有数据库的连接（与 create 逻辑一致，语义上区分初始化/打开）。 */
  private async connect() {
    this.dbInstance = await DuckDBInstance.create(this.dbPath)
    this.connection = await this.dbInstance.connect()
    logger.info(`[DuckDB] Connected to DuckDB at ${this.dbPath}`)
  }

  /**
   * 通过 memory 附加 DuckDB 数据库并修复索引问题
   *
   * - 正常关闭链接时会自动checkpoint，但异常关闭软件（崩溃， kill）无法触发
   * - 连接时如果存在wal文件会自动checkpoint，但由于使用了vss插件，自动checkpoint会失败导致无法连接
   * - 必须先通过内存安装并加载vss插件，附加到本地数据库，再执行checkpoint
   */
  private async repairIndex(): Promise<void> {
    const ins = await DuckDBInstance.create(':memory:')
    const conn = await ins.connect()

    // load vss
    const extensionPath = path.join(extensionDir, `vss${extensionSuffix}`)
    if (fs.existsSync(extensionPath)) {
      const escapedPath = extensionPath.replace(/\\/g, '\\\\')
      logger.info(`[DuckDB] LOAD VSS extension from ${escapedPath}`)
      await conn.run(`LOAD '${escapedPath}';`)
    } else {
      logger.info('[DuckDB] LOAD VSS extension online')
      await conn.run(`INSTALL vss;`)
      await conn.run(`LOAD vss;`)
    }
    await conn.run(`SET hnsw_enable_experimental_persistence = true;`)

    // attach to the existing database
    // ATTACH 即触发 WAL 回放与 checkpoint；随后立刻断开，把修复好的
    // 数据库留给主连接正常加载。
    await conn.run(`ATTACH DATABASE '${this.dbPath}' AS db;`)
    // await conn.run(`CHECKPOINT;`)

    // close
    conn.closeSync()
    ins.closeSync()
  }

  /**
   * 安装并加载 DuckDB 扩展：优先用随应用打包的本地文件（离线可用），
   * 找不到才在线 INSTALL 兜底。afterRun 供加载后执行依赖扩展的配置。
   */
  /** 安装并加载 VSS 扩展 */
  private async installAndLoadExtension(
    name: string,
    afterRun?: () => Promise<void>
  ): Promise<void> {
    const extensionPath = path.join(extensionDir, `${name}${extensionSuffix}`)
    if (fs.existsSync(extensionPath)) {
      const escapedPath = extensionPath.replace(/\\/g, '\\\\')
      logger.info(`[DuckDB] LOAD ${name} extension from ${escapedPath}`)
      await this.safeRun(`LOAD '${escapedPath}';`)
    } else {
      logger.info(`[DuckDB] LOAD ${name} extension online`)
      await this.safeRun(`INSTALL ${name};`)
      await this.safeRun(`LOAD ${name};`)
    }
    if (afterRun instanceof Function) await afterRun()
  }

  /** 创建文件元数据表 */
  private async initFileTable(): Promise<void> {
    await this.safeRun(
      `CREATE TABLE IF NOT EXISTS ${this.fileTable} (
        id VARCHAR PRIMARY KEY,
        name VARCHAR,
        path VARCHAR,
        mime_type VARCHAR,
        status VARCHAR,
        uploaded_at BIGINT,
        metadata JSON
      );`
    )
  }

  /** 创建chunks表 */
  private async initChunkTable(): Promise<void> {
    await this.safeRun(
      `CREATE TABLE IF NOT EXISTS ${this.chunkTable} (
        id VARCHAR PRIMARY KEY,
        file_id VARCHAR,
        content TEXT,
        status VARCHAR,
        chunk_index INTEGER,
        error VARCHAR
      );`
    )
  }

  /** 创建定长向量表 */
  private async initVectorTable(dimensions: number): Promise<void> {
    await this.safeRun(
      `CREATE TABLE IF NOT EXISTS ${this.vectorTable} (
         id VARCHAR PRIMARY KEY,
         embedding FLOAT[${dimensions}],
         file_id VARCHAR,
         chunk_id VARCHAR
       );`
    )
  }

  /** 创建索引 */
  private async initTableIndex(opts?: KnowledgeIndexOptions): Promise<void> {
    // file
    await this.safeRun(
      `CREATE INDEX IF NOT EXISTS idx_${this.fileTable}_file_id ON ${this.fileTable} (id);`
    )
    await this.safeRun(
      `CREATE INDEX IF NOT EXISTS idx_${this.fileTable}_file_status ON ${this.fileTable} (status);`
    )
    await this.safeRun(
      `CREATE INDEX IF NOT EXISTS idx_${this.fileTable}_file_path ON ${this.fileTable} (path);`
    )
    // chunk
    await this.safeRun(
      `CREATE INDEX IF NOT EXISTS idx_${this.chunkTable}_chunk_id ON ${this.chunkTable} (id);`
    )
    await this.safeRun(
      `CREATE INDEX IF NOT EXISTS idx_${this.chunkTable}_file_id ON ${this.chunkTable} (file_id);`
    )
    await this.safeRun(
      `CREATE INDEX IF NOT EXISTS idx_${this.chunkTable}_status ON ${this.chunkTable} (status);`
    )
    // vector
    // HNSW 近似最近邻索引的三个参数：度量决定「相似」的算法语义，
    // M 与 ef_construction 是建图精度/速度权衡，建好后不可再改。
    const metric = opts?.metric || 'cosine' // 支持 'l2sq' | 'cosine' | 'ip'
    const M = opts?.M || 16
    const efConstruction = opts?.efConstruction || 200
    const sql = `CREATE INDEX IF NOT EXISTS idx_${this.vectorTable}_emb
     ON ${this.vectorTable}
     USING HNSW (embedding)
     WITH (
       metric='${metric}',
       M=${M},
       ef_construction=${efConstruction}
     );`
    await this.safeRun(sql)
    await this.safeRun(
      `CREATE INDEX IF NOT EXISTS idx_${this.vectorTable}_file_id ON ${this.vectorTable} (file_id);`
    )
    await this.safeRun(
      `CREATE INDEX IF NOT EXISTS idx_${this.vectorTable}_chunk_id ON ${this.vectorTable} (chunk_id);`
    )
  }

  /**
   * 清理异常任务引入的脏数据
   *
   * 异常退出可能留下「文件记录已删、向量/分块还在」的孤儿行——删除
   * 操作没来得及提交或分级删除被中断。打开时统一按外键关系反查清扫，
   * 防止孤儿向量进入检索结果后取不到正文。
   */
  private async clearDirtyData(): Promise<void> {
    // 清理向量表中没有对应文件的向量
    await this.safeRun(`
      DELETE FROM ${this.vectorTable}
      WHERE file_id NOT IN (SELECT id FROM ${this.fileTable});
    `)

    // 清理chunks表中没有对应文件的分块
    await this.safeRun(`
      DELETE FROM ${this.chunkTable}
      WHERE file_id NOT IN (SELECT id FROM ${this.fileTable});
    `)
  }

  /**
   * 检查是否存在 WAL 文件
   * @returns 是否存在 WAL 文件
   */
  private async hasWal(): Promise<boolean> {
    const walPath = this.dbPath + '.wal'
    return fs.existsSync(walPath)
  }

  // ==================== 数据库版本控制和迁移 ====================

  /**
   * 初始化元数据表
   */
  private async initMetadataTable(): Promise<void> {
    await this.safeRun(
      `CREATE TABLE IF NOT EXISTS ${this.metadataTable} (
        key VARCHAR PRIMARY KEY,
        value VARCHAR
      );`
    )
  }

  /**
   * 运行数据库迁移
   *
   * 以 metadata 表里的版本号为基线，依序执行其后所有版本的 up。
   * 版本号高于当前支持版本（如用户降级了应用）时跳过迁移但不报错——
   * 向后兼容缺失只记警告，库照常打开。单个迁移失败即中止并上抛。
   */
  private async runMigrations(): Promise<void> {
    // 确保元数据表存在
    await this.initMetadataTable()

    const currentVersion = await this.getDatabaseVersion()
    logger.info(`[DuckDB] Current database version: ${currentVersion}`)
    logger.info(`[DuckDB] Target database version: ${CURRENT_DB_VERSION}`)

    if (currentVersion === CURRENT_DB_VERSION) {
      logger.info('[DuckDB] Database is up to date, no migrations needed')
      return
    }

    if (currentVersion > CURRENT_DB_VERSION) {
      console.warn(
        `[DuckDB] Database version (${currentVersion}) is newer than supported version (${CURRENT_DB_VERSION})`
      )
      return
    }

    // 执行从当前版本到目标版本的所有迁移
    const migrationsToRun = MIGRATIONS.filter(
      (m) => m.version > currentVersion && m.version <= CURRENT_DB_VERSION
    )

    if (migrationsToRun.length === 0) {
      logger.info('[DuckDB] No migrations found to run')
      return
    }

    logger.info(`[DuckDB] Running ${migrationsToRun.length} migrations...`)

    // 按版本号排序执行迁移
    migrationsToRun.sort((a, b) => a.version - b.version)

    for (const migration of migrationsToRun) {
      logger.info(`[DuckDB] Running migration v${migration.version}: ${migration.description}`)

      try {
        await this.executeInTransaction(async () => {
          await migration.up(this)
        })
        await this.setDatabaseVersion(migration.version)

        logger.info(`[DuckDB] Migration v${migration.version} completed successfully`)
      } catch (error) {
        console.error(`[DuckDB] Migration v${migration.version} failed:`, error)
        throw new Error(`Database migration v${migration.version} failed: ${error}`)
      }
    }

    logger.info(
      `[DuckDB] All migrations completed successfully. Database updated to version ${CURRENT_DB_VERSION}`
    )
  }

  /**
   * 获取数据库元数据信息
   * 读取失败（如表不存在）降级为空对象，调用方按「无元数据」处理。
   */
  async getDatabaseMetadata(): Promise<Record<string, any>> {
    try {
      const sql = `SELECT key, value FROM ${this.metadataTable};`
      const reader = await this.connection.runAndReadAll(sql)
      const rows = reader.getRowObjectsJson()

      const metadata: Record<string, any> = {}
      for (const row of rows) {
        const key = typeof row.key === 'string' ? row.key : String(row.key)
        metadata[key] = row.value
      }
      return metadata
    } catch (error) {
      console.error('[DuckDB] Error getting database metadata:', error)
      return {}
    }
  }

  /**
   * 设置数据库元数据
   */
  async setDatabaseMetadata(key: string, value: string): Promise<void> {
    const sql = `
      INSERT OR REPLACE INTO ${this.metadataTable} (key, value)
      VALUES (?, ?);
    `
    await this.executeInTransaction(async () => {
      await this.safeRun(sql, [key, value])
    })
  }
  /**
   * 获取数据库版本
   */
  private async getDatabaseVersion(): Promise<number> {
    try {
      const metadata = await this.getDatabaseMetadata()
      const version = metadata[DB_VERSION_KEY]
      return version ? parseInt(typeof version === 'string' ? version : String(version), 10) : 0
    } catch (error) {
      // 如果元数据表不存在，说明是旧版本数据库
      // 迁移基线取 0：从最初的 schema 开始补齐，绝不因版本信息缺失
      // 而跳过迁移。
      console.warn('[DuckDB] Cannot get database version, assuming version 0:', error)
      return 0
    }
  }

  /**
   * 设置数据库版本
   */
  private async setDatabaseVersion(version: number): Promise<void> {
    await this.setDatabaseMetadata(DB_VERSION_KEY, String(version))
  }
}
