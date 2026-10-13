import { describe, expect, it, vi } from 'vitest'

const sqliteModule = await import('better-sqlite3-multiple-ciphers').catch(() => null)
const databaseModule = sqliteModule
  ? await import('@/documents/data/database').catch(() => null)
  : null
const repositoryModule = sqliteModule
  ? await import('@/documents/repository').catch(() => null)
  : null
const backfillModule = sqliteModule
  ? await import('@/documents/dedupeBackfill').catch(() => null)
  : null

const Database = sqliteModule?.default
const DocumentsDatabase = databaseModule?.DocumentsDatabase
const DocumentsRepository = repositoryModule?.DocumentsRepository
const backfillDocumentHashes = backfillModule?.backfillDocumentHashes
const backfillTaskRelativePaths = backfillModule?.backfillTaskRelativePaths

let sqliteAvailable = false
if (Database) {
  try {
    const smokeDb = new Database(':memory:')
    smokeDb.close()
    sqliteAvailable = true
  } catch {
    sqliteAvailable = false
  }
}

const modulesReady =
  sqliteAvailable && Boolean(DocumentsDatabase && DocumentsRepository && backfillDocumentHashes)

const describeIfSqlite = modulesReady ? describe : describe.skip

type SqliteDb = ReturnType<NonNullable<typeof Database>>

const createRepository = () => {
  const db: SqliteDb = new Database(':memory:')
  const repository = new DocumentsRepository!(new DocumentsDatabase!({ getDatabase: () => db }))
  return { db, repository }
}

const insertDocument = (
  repository: ReturnType<typeof createRepository>['repository'],
  input: { id?: string; fileUris: string[]; source: 'chat' | 'manual' | 'scheduled' }
) => {
  const document = repository.insertDocument({
    templateId: 'tpl-1',
    typeKey: 'contract',
    templateSnapshot: { id: 'tpl-1', typeKey: 'contract' } as Record<string, unknown>,
    fields: {},
    fileUris: input.fileUris,
    source: input.source,
    sessionId: null,
    status: 'draft',
    now: 10
  })
  return document
}

describeIfSqlite('dedupeBackfill', () => {
  it('为存量文档登记哈希行并绑定 document_id，查询命中', async () => {
    const { db, repository } = createRepository()
    const doc = insertDocument(repository, { fileUris: ['D:/t/a.pdf'], source: 'scheduled' })
    const registered = await backfillDocumentHashes!({
      listBackfillDocuments: () =>
        repository
          .listDocuments({})
          .map((d) => ({ id: d.id, fileUris: d.fileUris, source: d.source })),
      sha256File: async (path) => (path === 'D:/t/a.pdf' ? 'a'.repeat(64) : null),
      findFileDedupeNames: (hashes) => repository.findFileDedupeNames(hashes),
      insertFileDedupes: (rows) => repository.insertFileDedupes(rows),
      bindFileDedupeDocument: (taskId, documentId) =>
        repository.bindFileDedupeDocument(taskId, documentId),
      now: () => 1000
    })
    expect(registered).toBe(1)
    expect(repository.findFileDedupeNames(['a'.repeat(64)]).get('a'.repeat(64))).toBe('a.pdf')
    const rows = db
      .prepare('SELECT task_id, document_id, source FROM documents_file_dedupe')
      .all() as Array<{
      task_id: string
      document_id: string
      source: string
    }>
    expect(rows).toEqual([{ task_id: doc.id, document_id: doc.id, source: 'scheduled' }])
    // 删除文档级联清理回填行，重传同内容可再次识别
    repository.deleteDocument(doc.id)
    expect(repository.findFileDedupeNames(['a'.repeat(64)]).size).toBe(0)
    db.close()
  })

  it('重复执行幂等：已在表中的哈希不重复登记', async () => {
    const { db, repository } = createRepository()
    insertDocument(repository, { fileUris: ['D:/t/a.pdf'], source: 'manual' })
    const deps = {
      listBackfillDocuments: () =>
        repository
          .listDocuments({})
          .map((d) => ({ id: d.id, fileUris: d.fileUris, source: d.source })),
      sha256File: async (path: string) => (path === 'D:/t/a.pdf' ? 'a'.repeat(64) : null),
      findFileDedupeNames: (hashes: string[]) => repository.findFileDedupeNames(hashes),
      insertFileDedupes: (rows: Parameters<typeof repository.insertFileDedupes>[0]) =>
        repository.insertFileDedupes(rows),
      bindFileDedupeDocument: (taskId: string, documentId: string) =>
        repository.bindFileDedupeDocument(taskId, documentId),
      now: () => 1000
    }
    expect(await backfillDocumentHashes!(deps)).toBe(1)
    expect(await backfillDocumentHashes!(deps)).toBe(0)
    const count = db.prepare('SELECT COUNT(*) n FROM documents_file_dedupe').get() as { n: number }
    expect(count.n).toBe(1)
    db.close()
  })

  it('两个文档同内容仅登记首个；读取失败(null)的文件跳过', async () => {
    const { db, repository } = createRepository()
    insertDocument(repository, { fileUris: ['D:/t/a.pdf'], source: 'scheduled' })
    insertDocument(repository, { fileUris: ['D:/t/b.pdf'], source: 'scheduled' })
    insertDocument(repository, { fileUris: ['Z:/missing.pdf'], source: 'manual' })
    const registered = await backfillDocumentHashes!({
      listBackfillDocuments: () =>
        repository
          .listDocuments({})
          .map((d) => ({ id: d.id, fileUris: d.fileUris, source: d.source })),
      sha256File: async (path) =>
        path === 'D:/t/a.pdf' || path === 'D:/t/b.pdf' ? 'a'.repeat(64) : null,
      findFileDedupeNames: (hashes) => repository.findFileDedupeNames(hashes),
      insertFileDedupes: (rows) => repository.insertFileDedupes(rows),
      bindFileDedupeDocument: (taskId, documentId) =>
        repository.bindFileDedupeDocument(taskId, documentId),
      now: () => 1000
    })
    expect(registered).toBe(1)
    const count = db.prepare('SELECT COUNT(*) n FROM documents_file_dedupe').get() as { n: number }
    expect(count.n).toBe(1)
    db.close()
  })

  it('无文档或文档无 fileUris 时返回 0 且不写表', async () => {
    const { db, repository } = createRepository()
    insertDocument(repository, { fileUris: [], source: 'manual' })
    const registered = await backfillDocumentHashes!({
      listBackfillDocuments: () =>
        repository
          .listDocuments({})
          .map((d) => ({ id: d.id, fileUris: d.fileUris, source: d.source })),
      sha256File: async () => 'a'.repeat(64),
      findFileDedupeNames: (hashes) => repository.findFileDedupeNames(hashes),
      insertFileDedupes: (rows) => repository.insertFileDedupes(rows),
      bindFileDedupeDocument: (taskId, documentId) =>
        repository.bindFileDedupeDocument(taskId, documentId),
      now: () => 1000
    })
    expect(registered).toBe(0)
    const count = db.prepare('SELECT COUNT(*) n FROM documents_file_dedupe').get() as { n: number }
    expect(count.n).toBe(0)
    db.close()
  })
})

describeIfSqlite('backfillTaskRelativePaths', () => {
  it('按当前扫描目录回填 scheduled 任务的 NULL 相对路径', () => {
    const updates: Array<{ id: string; relativePath: string }> = []
    const updated = backfillTaskRelativePaths!({
      listScheduledTasksWithoutRelativePath: () => [
        { id: 't1', filePath: 'D:\\scan\\sub\\a.pdf' },
        { id: 't2', filePath: 'D:\\scan\\b.pdf' }
      ],
      getAutoWatchDir: () => 'D:\\scan',
      updateTaskRelativePath: (id: string, relativePath: string) => {
        updates.push({ id, relativePath })
      }
    })
    expect(updated).toBe(2)
    expect(updates).toEqual([
      { id: 't1', relativePath: 'sub/a.pdf' },
      { id: 't2', relativePath: 'b.pdf' }
    ])
  })

  it('目录外文件与空目录跳过（保持 NULL）', () => {
    const updateTaskRelativePath = vi.fn()
    const updated = backfillTaskRelativePaths!({
      listScheduledTasksWithoutRelativePath: () => [
        { id: 't1', filePath: 'D:\\other\\a.pdf' },
        { id: 't2', filePath: 'D:\\scan\\b.pdf' }
      ],
      getAutoWatchDir: () => 'D:\\scan',
      updateTaskRelativePath
    })
    expect(updated).toBe(1)
    expect(updateTaskRelativePath).toHaveBeenCalledTimes(1)
    expect(updateTaskRelativePath).toHaveBeenCalledWith('t2', 'b.pdf')
  })

  it('扫描目录为空时直接返回 0', () => {
    const listScheduledTasksWithoutRelativePath = vi.fn()
    const updated = backfillTaskRelativePaths!({
      listScheduledTasksWithoutRelativePath,
      getAutoWatchDir: () => '',
      updateTaskRelativePath: vi.fn()
    })
    expect(updated).toBe(0)
    expect(listScheduledTasksWithoutRelativePath).not.toHaveBeenCalled()
  })
})
