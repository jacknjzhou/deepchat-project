import { describe, expect, it } from 'vitest'

const sqliteModule = await import('better-sqlite3-multiple-ciphers').catch(() => null)
const databaseModule = sqliteModule
  ? await import('@/documents/data/database').catch(() => null)
  : null
const repositoryModule = sqliteModule
  ? await import('@/documents/repository').catch(() => null)
  : null

const Database = sqliteModule?.default
const DocumentsDatabase = databaseModule?.DocumentsDatabase
const DocumentsRepository = repositoryModule?.DocumentsRepository
const DatabaseCtor = Database!
const DocumentsDatabaseCtor = DocumentsDatabase!
const DocumentsRepositoryCtor = DocumentsRepository!

let sqliteAvailable = false
if (Database) {
  try {
    const smokeDb = new DatabaseCtor(':memory:')
    smokeDb.close()
    sqliteAvailable = true
  } catch {
    sqliteAvailable = false
  }
}

const modulesReady = sqliteAvailable && Boolean(DocumentsDatabase && DocumentsRepository)

const describeIfSqlite = modulesReady ? describe : describe.skip

type SqliteDb = ReturnType<typeof DatabaseCtor>
type Repository = InstanceType<typeof DocumentsRepositoryCtor>

const makeRepo = (): { db: SqliteDb; repository: Repository } => {
  const db = new DatabaseCtor(':memory:')
  const database = new DocumentsDatabaseCtor({ getDatabase: () => db })
  return { db, repository: new DocumentsRepositoryCtor(database) }
}

describeIfSqlite('listUnifiedTasks', () => {
  it('source=chat → documents 伪任务条目（fileName 取 fileUris[0] basename，status=done，documentId=id）', () => {
    const { db, repository } = makeRepo()
    repository.insertDocument({
      templateId: 't',
      typeKey: 'invoice',
      templateSnapshot: {},
      fields: {},
      fileUris: ['C:\\scan\\话费发票.pdf'],
      source: 'chat',
      sessionId: 's',
      status: 'draft',
      now: 1000
    })
    const { tasks, total } = repository.listUnifiedTasks({ source: 'chat', limit: 10, offset: 0 })
    expect(total).toBe(1)
    expect(tasks[0]).toMatchObject({
      fileName: '话费发票.pdf',
      source: 'chat',
      status: 'done',
      documentId: tasks[0]!.id,
      filePath: 'C:\\scan\\话费发票.pdf',
      typeKey: 'invoice'
    })
    expect(tasks[0]!.templateId).toBeNull()
    expect(tasks[0]!.batchId).toBeNull()
    db.close()
  })

  it('chat fileUris 空数组 → fileName 回退 (未知文件)、filePath null', () => {
    const { db, repository } = makeRepo()
    repository.insertDocument({
      templateId: 't',
      typeKey: 'invoice',
      templateSnapshot: {},
      fields: {},
      fileUris: [],
      source: 'chat',
      sessionId: null,
      status: 'draft',
      now: 1000
    })
    const { tasks } = repository.listUnifiedTasks({ source: 'chat', limit: 10, offset: 0 })
    expect(tasks[0]!.fileName).toBe('(未知文件)')
    expect(tasks[0]!.filePath).toBeNull()
    db.close()
  })

  it('无 source → 混排归并（created_at DESC），total 为两表之和', () => {
    const { db, repository } = makeRepo()
    // insertTasks 无 now 参数（created_at=Date.now()），顺序断言用单调性校验而非具体序
    repository.insertTasks([
      {
        batchId: 'b1',
        filePath: 'C:/m.pdf',
        fileName: 'm.pdf',
        templateId: 'auto',
        source: 'manual'
      }
    ])
    repository.insertDocument({
      templateId: 't',
      typeKey: 'invoice',
      templateSnapshot: {},
      fields: {},
      fileUris: ['C:/chat.pdf'],
      source: 'chat',
      sessionId: null,
      status: 'draft'
    })
    const { tasks, total } = repository.listUnifiedTasks({ limit: 10, offset: 0 })
    expect(total).toBe(2)
    expect(tasks.map((t) => t.source).sort()).toEqual(['chat', 'manual'].sort())
    expect(tasks.map((t) => t.createdAt)).toEqual(
      [...tasks.map((t) => t.createdAt)].sort((a, b) => b - a)
    )
    db.close()
  })

  it('混排分页窗口正确（offset 跨越两表边界不重不漏）', () => {
    const { db, repository } = makeRepo()
    // 造 3 条真任务（source manual/scheduled/scheduled）+ 2 条 chat 文档，混合排序后
    // 逐页拉取（limit 2）应覆盖全部 5 条且不重复
    repository.insertTasks([
      {
        batchId: 'b1',
        filePath: 'C:/m1.pdf',
        fileName: 'm1.pdf',
        templateId: 'auto',
        source: 'manual'
      },
      {
        batchId: 'b2',
        filePath: 'C:/m2.pdf',
        fileName: 'm2.pdf',
        templateId: 'auto',
        source: 'scheduled'
      },
      {
        batchId: 'b2',
        filePath: 'C:/m3.pdf',
        fileName: 'm3.pdf',
        templateId: 'auto',
        source: 'scheduled'
      }
    ])
    repository.insertDocument({
      templateId: 't',
      typeKey: 'invoice',
      templateSnapshot: {},
      fields: {},
      fileUris: ['C:/chat1.pdf'],
      source: 'chat',
      sessionId: null,
      status: 'draft'
    })
    repository.insertDocument({
      templateId: 't',
      typeKey: 'invoice',
      templateSnapshot: {},
      fields: {},
      fileUris: ['C:/chat2.pdf'],
      source: 'chat',
      sessionId: null,
      status: 'draft'
    })
    const seen = new Set<string>()
    for (let page = 1; page <= 3; page++) {
      const { tasks } = repository.listUnifiedTasks({ limit: 2, offset: (page - 1) * 2 })
      for (const t of tasks) {
        expect(seen.has(t.id)).toBe(false)
        seen.add(t.id)
      }
    }
    expect(seen.size).toBe(5)
    db.close()
  })

  it('batchId 过滤只命中该批次真任务', () => {
    const { db, repository } = makeRepo()
    repository.insertTasks([
      {
        batchId: 'bx',
        filePath: 'C:/x.pdf',
        fileName: 'x.pdf',
        templateId: 'auto',
        source: 'scheduled'
      },
      {
        batchId: 'by',
        filePath: 'C:/y.pdf',
        fileName: 'y.pdf',
        templateId: 'auto',
        source: 'scheduled'
      }
    ])
    const { tasks, total } = repository.listUnifiedTasks({ batchId: 'bx', limit: 10, offset: 0 })
    expect(total).toBe(1)
    expect(tasks[0]!.batchId).toBe('bx')
    db.close()
  })

  it('source=chat + status=failed → 空结果（chat 恒为 done，不可达组合早退）', () => {
    const { db, repository } = makeRepo()
    repository.insertDocument({
      templateId: 't',
      typeKey: 'invoice',
      templateSnapshot: {},
      fields: {},
      fileUris: ['C:/chat.pdf'],
      source: 'chat',
      sessionId: null,
      status: 'draft',
      now: 1000
    })
    const { tasks, total } = repository.listUnifiedTasks({
      source: 'chat',
      status: 'failed',
      limit: 10,
      offset: 0
    })
    expect(tasks).toEqual([])
    expect(total).toBe(0)
    db.close()
  })

  it('混排 + status=failed → 行集与 total 均不含 chat（done）条目', () => {
    const { db, repository } = makeRepo()
    repository.insertTasks([
      {
        batchId: 'b1',
        filePath: 'C:/ok.pdf',
        fileName: 'ok.pdf',
        templateId: 'auto',
        source: 'manual'
      }
    ])
    repository.insertDocument({
      templateId: 't',
      typeKey: 'invoice',
      templateSnapshot: {},
      fields: {},
      fileUris: ['C:/chat.pdf'],
      source: 'chat',
      sessionId: null,
      status: 'draft',
      now: 1000
    })
    const { tasks, total } = repository.listUnifiedTasks({ status: 'failed', limit: 10, offset: 0 })
    expect(tasks.every((t) => t.source !== 'chat')).toBe(true)
    expect(tasks.every((t) => t.status === 'failed')).toBe(true)
    expect(total).toBe(0)
    db.close()
  })
})

describeIfSqlite('listScanBatches / countScanBatches', () => {
  it('返回批次摘要（batchId 驼峰映射、startedAt 为批内最早 created_at）', () => {
    const { db, repository } = makeRepo()
    repository.insertTasks([
      {
        batchId: 's1',
        filePath: 'C:/a.pdf',
        fileName: 'a.pdf',
        templateId: 'auto',
        source: 'scheduled'
      },
      {
        batchId: 's1',
        filePath: 'C:/b.pdf',
        fileName: 'b.pdf',
        templateId: 'auto',
        source: 'scheduled'
      }
    ])
    const batches = repository.listScanBatches(10, 0)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({ batchId: 's1', total: 2 })
    expect(repository.countScanBatches()).toBe(1)
    db.close()
  })
})
