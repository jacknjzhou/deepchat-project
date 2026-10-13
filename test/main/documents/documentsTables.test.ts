import type { DocumentTableInsertInput } from '@/documents/data/tables/documents'
import { describe, expect, it } from 'vitest'

const sqliteModule = await import('better-sqlite3-multiple-ciphers').catch(() => null)
const tableModule = sqliteModule
  ? await import('@/documents/data/tables/documentTemplates').catch(() => null)
  : null
const documentsTableModule = sqliteModule
  ? await import('@/documents/data/tables/documents').catch(() => null)
  : null
const documentTasksTableModule = sqliteModule
  ? await import('@/documents/data/tables/documentTasks').catch(() => null)
  : null
const watchedFilesTableModule = sqliteModule
  ? await import('@/documents/data/tables/watchedFiles').catch(() => null)
  : null
const fileDedupeTableModule = sqliteModule
  ? await import('@/documents/data/tables/fileDedupe').catch(() => null)
  : null
const databaseModule = sqliteModule
  ? await import('@/documents/data/database').catch(() => null)
  : null
const repositoryModule = sqliteModule
  ? await import('@/documents/repository').catch(() => null)
  : null
const seedModule = sqliteModule ? await import('@/documents/seed').catch(() => null) : null

const Database = sqliteModule?.default
const DocumentTemplatesTable = tableModule?.DocumentTemplatesTable
const DocumentsTable = documentsTableModule?.DocumentsTable
const DocumentTasksTable = documentTasksTableModule?.DocumentTasksTable
const WatchedFilesTable = watchedFilesTableModule?.WatchedFilesTable
const FileDedupeTable = fileDedupeTableModule?.FileDedupeTable
const DocumentsDatabase = databaseModule?.DocumentsDatabase
const DocumentsRepository = repositoryModule?.DocumentsRepository
const seedPresetTemplates = seedModule?.seedPresetTemplates
const DatabaseCtor = Database!
const DocumentTemplatesTableCtor = DocumentTemplatesTable!
const DocumentsTableCtor = DocumentsTable!
const DocumentTasksTableCtor = DocumentTasksTable!
const WatchedFilesTableCtor = WatchedFilesTable!
const FileDedupeTableCtor = FileDedupeTable!
const DocumentsDatabaseCtor = DocumentsDatabase!
const DocumentsRepositoryCtor = DocumentsRepository!

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
  sqliteAvailable &&
  Boolean(
    DocumentTemplatesTable &&
    DocumentsTable &&
    DocumentTasksTable &&
    DocumentsDatabase &&
    DocumentsRepository
  )

const describeIfSqlite = modulesReady ? describe : describe.skip
const describeIfWatched = modulesReady && WatchedFilesTable ? describe : describe.skip
const describeIfDedupe = modulesReady && FileDedupeTable ? describe : describe.skip
const describeIfSeed = modulesReady && seedPresetTemplates ? describe : describe.skip

type SqliteDb = ReturnType<typeof DatabaseCtor>

// Creates a legacy v1 document_tasks table whose source column is constrained to
// 'chat' | 'manual', with one existing 'manual' row (id 'id1') to exercise migrations.
const createV1Table = (db: SqliteDb) => {
  db.exec(`CREATE TABLE document_tasks (
    id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, file_path TEXT NOT NULL,
    file_name TEXT NOT NULL, template_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('chat', 'manual')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'done', 'failed')),
    type_key TEXT, document_id TEXT, error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO document_tasks VALUES ('id1','b1','p','n','tpl','manual','done',NULL,NULL,NULL,1,1)`)
}

const ddlHasSourceCheck = (db: SqliteDb, tableName = 'document_tasks') => {
  const ddl = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName) as { sql: string } | undefined
  return Boolean(ddl?.sql.includes('CHECK(source IN'))
}

// Creates a legacy v1 documents table whose source column is constrained to
// 'chat' | 'manual', with all current columns and one existing 'manual' row.
const createV1DocumentsTable = (db: SqliteDb) => {
  db.exec(`CREATE TABLE documents (
    id TEXT PRIMARY KEY, template_id TEXT NOT NULL, type_key TEXT NOT NULL,
    template_snapshot_json TEXT NOT NULL DEFAULT '{}', fields_json TEXT NOT NULL DEFAULT '{}',
    file_uris_json TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL CHECK(source IN ('chat', 'manual')),
    session_id TEXT, reimbursement_override TEXT, reimbursement_group_override TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'confirmed')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX idx_documents_type_key_status ON documents(type_key, status, updated_at DESC);
    CREATE INDEX idx_documents_updated_at ON documents(updated_at DESC, id DESC);
    INSERT INTO documents VALUES
      ('doc1','tpl','contract','{}','{}','[]','manual',NULL,NULL,NULL,'confirmed',1,1)`)
}

describeIfSqlite('DocumentTemplatesTable', () => {
  const makeDb = () => {
    const db = new DatabaseCtor(':memory:')
    new DocumentTemplatesTableCtor(db).createTable()
    return db
  }

  it('creates table and upserts a template', () => {
    const db = makeDb()
    const table = new DocumentTemplatesTableCtor(db)
    const row = table.upsert({
      typeKey: 'contract',
      name: '合同模板',
      category: '合同类',
      fields: [
        {
          key: 'party_a',
          label: '甲方名称',
          valueType: 'text',
          required: true,
          promptHint: '合同中甲方的全称',
          validation: null,
          enumOptions: null,
          order: 1
        }
      ],
      now: 1000
    })
    expect(row.type_key).toBe('contract')
    expect(row.version).toBe(1)
    const fetched = table.getByTypeKey('contract')
    expect(fetched?.id).toBe(row.id)
    db.close()
  })

  it('bumps version on update and enforces unique typeKey', () => {
    const db = makeDb()
    const table = new DocumentTemplatesTableCtor(db)
    const created = table.upsert({
      typeKey: 'k1',
      name: 'N',
      category: '自定义',
      fields: [],
      now: 1
    })
    const updated = table.upsert({
      id: created.id,
      typeKey: 'k1',
      name: 'N2',
      category: '自定义',
      fields: [],
      now: 2
    })
    expect(updated.version).toBe(2)
    expect(updated.updated_at).toBe(2)
    expect(() =>
      table.upsert({ typeKey: 'k1', name: 'X', category: '自定义', fields: [], now: 3 })
    ).toThrow()
    db.close()
  })
})

describeIfSqlite('DocumentsTable', () => {
  const makeDb = () => {
    const db = new DatabaseCtor(':memory:')
    new DocumentTemplatesTableCtor(db).createTable()
    new DocumentsTableCtor(db).createTable()
    return db
  }

  it('inserts a draft record and confirms it', () => {
    const db = makeDb()
    const table = new DocumentsTableCtor(db)
    const row = table.insert({
      templateId: 'tpl-1',
      typeKey: 'contract',
      templateSnapshot: { id: 'tpl-1', typeKey: 'contract' } as Record<string, unknown>,
      fields: { party_a: { value: '甲公司', uncertain: false } },
      fileUris: ['deepchat-file://a.png'],
      source: 'chat',
      sessionId: 's-1',
      status: 'draft',
      now: 10
    })
    expect(row.status).toBe('draft')
    const confirmed = table.updateFieldsAndStatus(row.id, {
      fields: { party_a: { value: '甲公司改', uncertain: false } },
      status: 'confirmed',
      now: 20
    })
    expect(confirmed?.status).toBe('confirmed')
    expect(confirmed?.updated_at).toBe(20)
    db.close()
  })

  it('lists with typeKey and status filters', () => {
    const db = makeDb()
    const table = new DocumentsTableCtor(db)
    table.insert({
      templateId: 't1',
      typeKey: 'contract',
      templateSnapshot: {},
      fields: {},
      fileUris: [],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 1
    })
    table.insert({
      templateId: 't2',
      typeKey: 'hotel_receipt',
      templateSnapshot: {},
      fields: {},
      fileUris: [],
      source: 'manual',
      sessionId: null,
      status: 'confirmed',
      now: 2
    })
    expect(table.list({ typeKey: 'contract' })).toHaveLength(1)
    expect(table.list({ status: 'confirmed' })).toHaveLength(1)
    expect(table.list({})).toHaveLength(2)
    db.close()
  })

  it('filters by keyword hitting fields content', () => {
    const db = makeDb()
    const table = new DocumentsTableCtor(db)
    table.insert({
      templateId: 't1',
      typeKey: 'contract',
      templateSnapshot: {},
      fields: { party_a: { value: '甲公司', uncertain: false } },
      fileUris: [],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 1
    })
    expect(table.list({ keyword: '甲公司' })).toHaveLength(1)
    expect(table.list({ keyword: '乙公司' })).toHaveLength(0)
    db.close()
  })

  it('escapes LIKE wildcards in keyword', () => {
    const db = makeDb()
    const table = new DocumentsTableCtor(db)
    table.insert({
      templateId: 't1',
      typeKey: 'contract',
      templateSnapshot: {},
      fields: { amount: { value: '100%', uncertain: false } },
      fileUris: [],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 1
    })
    expect(table.list({ keyword: '100%' })).toHaveLength(1)
    table.insert({
      templateId: 't2',
      typeKey: 'contract',
      templateSnapshot: {},
      fields: { name: { value: 'a_b', uncertain: false } },
      fileUris: [],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 2
    })
    expect(table.list({ keyword: 'a_b' })).toHaveLength(1)
    db.close()
  })

  it('escapes LIKE wildcards with strong discrimination', () => {
    const db = makeDb()
    const table = new DocumentsTableCtor(db)
    table.insert({
      templateId: 't1',
      typeKey: 'contract',
      templateSnapshot: {},
      fields: { name: { value: 'a_b', uncertain: false } },
      fileUris: [],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 1
    })
    table.insert({
      templateId: 't2',
      typeKey: 'contract',
      templateSnapshot: {},
      fields: { name: { value: 'axb', uncertain: false } },
      fileUris: [],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 2
    })
    // '_' unescaped would match 'axb' as a wildcard (2 rows); escaped matches literal 'a_b' only
    expect(table.list({ keyword: 'a_b' })).toHaveLength(1)
    db.close()
  })

  it('updates status only and keeps fields intact', () => {
    const db = makeDb()
    const table = new DocumentsTableCtor(db)
    const row = table.insert({
      templateId: 't1',
      typeKey: 'contract',
      templateSnapshot: {},
      fields: { party_a: { value: '甲公司', uncertain: false } },
      fileUris: [],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 10
    })
    const updated = table.updateFieldsAndStatus(row.id, { status: 'confirmed', now: 30 })
    expect(updated?.fields_json).toBe(row.fields_json)
    expect(updated?.status).toBe('confirmed')
    db.close()
  })

  it('updates template identity in place and keeps fileUris/source', () => {
    const db = makeDb()
    const table = new DocumentsTableCtor(db)
    const row = table.insert({
      templateId: 't1',
      typeKey: 'contract',
      templateSnapshot: { id: 't1' },
      fields: { party_a: { value: '甲公司', uncertain: false } },
      fileUris: ['deepchat-file://a.png'],
      source: 'manual',
      sessionId: null,
      status: 'confirmed',
      now: 10
    })
    const updated = table.updateFieldsAndStatus(row.id, {
      templateId: 't2',
      typeKey: 'invoice_special',
      templateSnapshot: { id: 't2' },
      fields: { invoice_code: { value: '123', uncertain: false } },
      status: 'draft',
      now: 40
    })
    expect(updated?.template_id).toBe('t2')
    expect(updated?.type_key).toBe('invoice_special')
    expect(JSON.parse(updated?.template_snapshot_json ?? '{}')).toEqual({ id: 't2' })
    expect(updated?.file_uris_json).toBe(row.file_uris_json)
    expect(updated?.source).toBe('manual')
    expect(updated?.status).toBe('draft')
    expect(updated?.updated_at).toBe(40)
    db.close()
  })

  it('setReimbursementOverride clears the group override', () => {
    const db = makeDb()
    const table = new DocumentsTableCtor(db)
    const row = table.insert({
      templateId: 't1',
      typeKey: 'contract',
      templateSnapshot: {},
      fields: {},
      fileUris: [],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 1
    })
    const grouped = table.setReimbursementGroupOverride(row.id, 'grp-a')
    expect(grouped?.reimbursement_group_override).toBe('grp-a')
    // 调整类别 = 分组从属于旧类别，必须复位
    const recategorized = table.setReimbursementOverride(row.id, 'cat-other')
    expect(recategorized?.reimbursement_override).toBe('cat-other')
    expect(recategorized?.reimbursement_group_override).toBeNull()
    db.close()
  })

  it('setReimbursementGroupOverride refreshes updated_at and rejects unknown id', () => {
    const db = makeDb()
    const table = new DocumentsTableCtor(db)
    const row = table.insert({
      templateId: 't1',
      typeKey: 'contract',
      templateSnapshot: {},
      fields: {},
      fileUris: [],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 1
    })
    const grouped = table.setReimbursementGroupOverride(row.id, 'grp-a')
    expect(grouped?.reimbursement_group_override).toBe('grp-a')
    expect(grouped?.updated_at).toBeGreaterThan(row.updated_at)
    expect(table.setReimbursementGroupOverride('missing', 'grp-a')).toBeUndefined()
    db.close()
  })
})

describeIfSqlite('documentsTable count and stats', () => {
  const makeDb = () => {
    const db = new DatabaseCtor(':memory:')
    new DocumentTemplatesTableCtor(db).createTable()
    new DocumentsTableCtor(db).createTable()
    return db
  }

  const makeDocInput = (
    overrides: Partial<DocumentTableInsertInput>
  ): DocumentTableInsertInput => ({
    templateId: 't1',
    typeKey: 'contract',
    templateSnapshot: {},
    fields: {},
    fileUris: [],
    source: 'manual',
    sessionId: null,
    status: 'draft',
    now: 1,
    ...overrides
  })

  it('counts rows matching the list filter', () => {
    const db = makeDb()
    const table = new DocumentsTableCtor(db)
    table.insert(makeDocInput({ typeKey: 'invoice_special', status: 'draft' }))
    table.insert(makeDocInput({ typeKey: 'invoice_special', status: 'confirmed' }))
    table.insert(makeDocInput({ typeKey: 'contract', status: 'draft' }))
    expect(table.count({})).toBe(3)
    expect(table.count({ typeKey: 'invoice_special' })).toBe(2)
    expect(table.count({ status: 'draft', typeKey: 'contract' })).toBe(1)
    db.close()
  })

  it('groups stats by type_key and status', () => {
    const db = makeDb()
    const table = new DocumentsTableCtor(db)
    table.insert(makeDocInput({ typeKey: 'invoice_special', status: 'draft' }))
    table.insert(makeDocInput({ typeKey: 'invoice_special', status: 'confirmed' }))
    const rows = table.statsByType({})
    expect(rows).toEqual([
      { type_key: 'invoice_special', status: 'confirmed', count: 1 },
      { type_key: 'invoice_special', status: 'draft', count: 1 }
    ])
    db.close()
  })
})

describeIfSqlite('documentTasksTable', () => {
  const makeDb = () => {
    const db = new DatabaseCtor(':memory:')
    new DocumentTasksTableCtor(db).createTable()
    return db
  }

  it('inserts pending tasks and updates lifecycle', () => {
    const db = makeDb()
    const table = new DocumentTasksTableCtor(db)
    const task = table.insert({
      batchId: 'b1',
      filePath: 'C:\\a.png',
      fileName: 'a.png',
      templateId: 'auto'
    })
    expect(task.status).toBe('pending')
    expect(task.source).toBe('manual')
    const running = table.update(task.id, { status: 'running' })
    expect(running?.status).toBe('running')
    const done = table.update(task.id, {
      status: 'done',
      typeKey: 'invoice_special',
      documentId: 'd1'
    })
    expect(done?.document_id).toBe('d1')
    const failed = table.update(task.id, { status: 'failed', error: 'boom' })
    expect(failed?.error).toBe('boom')
    expect(failed?.type_key).toBe('invoice_special')
    // retry 时手动指定模板：写入新 template_id，省略时保持原值
    const retargeted = table.update(task.id, {
      status: 'pending',
      templateId: 'tpl-contract',
      typeKey: null,
      error: null
    })
    expect(retargeted?.template_id).toBe('tpl-contract')
    const requeued = table.update(task.id, { status: 'running' })
    expect(requeued?.template_id).toBe('tpl-contract')
    db.close()
  })

  it('lists pending in order and marks running as failed', () => {
    const db = makeDb()
    const table = new DocumentTasksTableCtor(db)
    const a = table.insert({
      batchId: 'b1',
      filePath: 'C:\\a.png',
      fileName: 'a.png',
      templateId: 'auto'
    })
    const b = table.insert({
      batchId: 'b1',
      filePath: 'C:\\b.png',
      fileName: 'b.png',
      templateId: 'auto',
      now: 2
    })
    const c = table.insert({
      batchId: 'b2',
      filePath: 'C:\\c.png',
      fileName: 'c.png',
      templateId: 'auto',
      now: 3
    })
    table.update(b.id, { status: 'running' })
    table.update(c.id, { status: 'done', documentId: 'd9' })
    expect(table.listPending().map((t) => t.id)).toEqual([a.id])
    table.markRunningAsFailed('interrupted by app restart')
    expect(table.get(b.id)?.status).toBe('failed')
    expect(table.get(b.id)?.error).toBe('interrupted by app restart')
    expect(table.get(c.id)?.status).toBe('done')
    db.close()
  })

  it('counts batch progress', () => {
    const db = makeDb()
    const table = new DocumentTasksTableCtor(db)
    const a = table.insert({
      batchId: 'b1',
      filePath: 'C:\\a.png',
      fileName: 'a.png',
      templateId: 'auto'
    })
    const b = table.insert({
      batchId: 'b1',
      filePath: 'C:\\b.png',
      fileName: 'b.png',
      templateId: 'auto'
    })
    table.update(a.id, { status: 'done', documentId: 'd1' })
    table.update(b.id, { status: 'failed', error: 'x' })
    expect(table.countBatch('b1')).toEqual({ done: 2, total: 2 })
    db.close()
  })

  it('handles missing ids and batches', () => {
    const db = makeDb()
    const table = new DocumentTasksTableCtor(db)
    expect(table.countBatch('missing')).toEqual({ done: 0, total: 0 })
    expect(table.update('nonexistent', { status: 'running' })).toBeUndefined()
    db.close()
  })

  it('insert 带 relativePath 落库，缺省为 null', () => {
    const db = makeDb()
    const table = new DocumentTasksTableCtor(db)
    const withRel = table.insert({
      batchId: 'b1',
      filePath: 'D:\\scan\\sub\\a.pdf',
      fileName: 'a.pdf',
      templateId: 'auto',
      source: 'scheduled',
      relativePath: 'sub/a.pdf'
    })
    expect(withRel.relative_path).toBe('sub/a.pdf')
    const withoutRel = table.insert({
      batchId: 'b1',
      filePath: 'C:\\tmp\\b.pdf',
      fileName: 'b.pdf',
      templateId: 'auto'
    })
    expect(withoutRel.relative_path).toBeNull()
    db.close()
  })

  it('ensureMigrated 为存量库补 relative_path 列且数据保留', () => {
    const db = new DatabaseCtor(':memory:')
    // 旧版 DDL：无 relative_path 的 v2 形态（无 source CHECK）
    db.exec(`CREATE TABLE document_tasks (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, file_path TEXT NOT NULL,
      file_name TEXT NOT NULL, template_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'done', 'failed')),
      type_key TEXT, document_id TEXT, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO document_tasks VALUES ('id1','b1','p','n','tpl','scheduled','done',NULL,NULL,NULL,1,1)`)
    const table = new DocumentTasksTableCtor(db)
    table.ensureMigrated()
    const row = table.get('id1')!
    expect(row.relative_path).toBeNull()
    expect(row.file_path).toBe('p')
    db.close()
  })
})

describeIfWatched('WatchedFilesTable', () => {
  const makeDb = () => {
    const db = new DatabaseCtor(':memory:')
    new WatchedFilesTableCtor(db).createTable()
    return db
  }

  it('upsert overwrites mtime and status for the same path', () => {
    const db = makeDb()
    const table = new WatchedFilesTableCtor(db)
    table.upsert({ path: 'D:/scan/a.pdf', mtimeMs: 100, taskId: 't1', now: 1 })
    table.upsert({ path: 'D:/scan/a.pdf', mtimeMs: 200, taskId: 't2', now: 2 })
    expect(table.listAll()).toEqual([
      { path: 'D:/scan/a.pdf', mtime_ms: 200, status: 'submitted', task_id: 't2', processed_at: 2 }
    ])
    db.close()
  })

  it('accepts a null task_id and keeps upsert idempotent for the same path', () => {
    const db = makeDb()
    const table = new WatchedFilesTableCtor(db)
    table.upsert({ path: 'D:/t/dup.pdf', mtimeMs: 5, taskId: null, now: 1000 })
    expect(table.listAll()).toEqual([
      { path: 'D:/t/dup.pdf', mtime_ms: 5, status: 'submitted', task_id: null, processed_at: 1000 }
    ])
    // 同 path 再次登记：覆盖 mtime/task_id，幂等不冲突
    table.upsert({ path: 'D:/t/dup.pdf', mtimeMs: 9, taskId: 't2', now: 2000 })
    expect(table.listAll()).toEqual([
      { path: 'D:/t/dup.pdf', mtime_ms: 9, status: 'submitted', task_id: 't2', processed_at: 2000 }
    ])
    db.close()
  })

  it('ensureMigrated rebuilds a legacy NOT NULL task_id table and keeps rows', () => {
    const db = new DatabaseCtor(':memory:')
    createLegacyWatchedTable(db)
    const table = new WatchedFilesTableCtor(db)
    table.ensureMigrated()
    expect(watchedTaskIdNullable(db)).toBe(true)
    expect(table.listAll()).toEqual([
      { path: 'D:/old/a.pdf', mtime_ms: 10, status: 'submitted', task_id: 't0', processed_at: 1 }
    ])
    table.upsert({ path: 'D:/t/dup.pdf', mtimeMs: 5, taskId: null, now: 1000 })
    expect(table.listAll()).toHaveLength(2)
    // 幂等：重复执行不报错、不丢数据
    table.ensureMigrated()
    expect(table.listAll()).toHaveLength(2)
    db.close()
  })
})

// Simulates a v1 documents_watched_files table whose task_id column is NOT NULL,
// with one existing row, to exercise the nullable repair.
const createLegacyWatchedTable = (db: SqliteDb) => {
  db.exec(`CREATE TABLE documents_watched_files (
    path TEXT PRIMARY KEY,
    mtime_ms INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted',
    task_id TEXT NOT NULL,
    processed_at INTEGER NOT NULL);
  INSERT INTO documents_watched_files VALUES ('D:/old/a.pdf', 10, 'submitted', 't0', 1)`)
}

const watchedTaskIdNullable = (db: SqliteDb) => {
  const ddl = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get('documents_watched_files') as { sql: string } | undefined
  return Boolean(ddl?.sql && !/task_id\s+TEXT\s+NOT\s+NULL/i.test(ddl.sql))
}

describeIfDedupe('FileDedupeTable', () => {
  it('creates the table idempotently and registers rows', () => {
    const db = new DatabaseCtor(':memory:')
    const table = new FileDedupeTableCtor(db)
    table.createTable()
    expect(() => table.createTable()).not.toThrow()
    const row = db
      .prepare(`SELECT * FROM documents_file_dedupe WHERE content_hash = ?`)
      .get('a'.repeat(64))
    expect(row).toBeUndefined()
    db.close()
  })
})

describeIfSqlite('DocumentsRepository file dedupe', () => {
  const makeRepo = () => {
    const db = new DatabaseCtor(':memory:')
    new DocumentTemplatesTableCtor(db).createTable()
    new DocumentsTableCtor(db).createTable()
    const database = new DocumentsDatabaseCtor({ getDatabase: () => db })
    return { db, repo: new DocumentsRepositoryCtor(database) }
  }

  it('documents_file_dedupe 表幂等建表并支持登记/查询/清理/回填', () => {
    const { db, repo } = makeRepo()
    expect(() => new FileDedupeTableCtor(db).createTable()).not.toThrow()
    repo.insertFileDedupes([
      {
        contentHash: 'a'.repeat(64),
        fileName: '发票.pdf',
        filePath: 'D:/t/发票.pdf',
        source: 'scheduled',
        taskId: 'task-1',
        now: 1000
      }
    ])
    const found = repo.findFileDedupeNames(['a'.repeat(64), 'b'.repeat(64)])
    expect(found.get('a'.repeat(64))).toBe('发票.pdf')
    expect(found.has('b'.repeat(64))).toBe(false)
    repo.bindFileDedupeDocument('task-1', 'doc-1')
    repo.deleteFileDedupesByTask('task-1')
    expect(repo.findFileDedupeNames(['a'.repeat(64)]).size).toBe(0)
    db.close()
  })

  it('findFileDedupeNames handles empty input', () => {
    const { db, repo } = makeRepo()
    expect(repo.findFileDedupeNames([]).size).toBe(0)
    db.close()
  })

  it('删除文档时级联清理其哈希行，重传同内容可再次识别', () => {
    const { db, repo } = makeRepo()
    const tpl = repo.upsertTemplate({
      typeKey: 'fx',
      name: 'F',
      category: '自定义',
      fields: [],
      now: 1
    })
    const doc = repo.insertDocument({
      templateId: tpl.id,
      typeKey: 'fx',
      templateSnapshot: tpl,
      fields: {},
      fileUris: [],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 2
    })
    repo.insertFileDedupes([
      {
        contentHash: 'c'.repeat(64),
        fileName: 'a.pdf',
        filePath: 'D:/t/a.pdf',
        source: 'manual',
        taskId: 't9',
        now: 1000
      }
    ])
    repo.bindFileDedupeDocument('t9', doc.id)
    repo.deleteDocument(doc.id)
    expect(repo.findFileDedupeNames(['c'.repeat(64)]).size).toBe(0)
    db.close()
  })
})

describeIfSqlite('documentTasksTable v2 migration', () => {
  it('drops the source CHECK and preserves existing rows', () => {
    const db = new DatabaseCtor(':memory:')
    const table = new DocumentTasksTableCtor(db)
    // Simulate a v1 database whose source column is constrained to 'chat' | 'manual'.
    createV1Table(db)
    expect(table.getLatestVersion()).toBe(2)
    const sql = table.getMigrationSQL(2)
    expect(sql).not.toBeNull()
    db.exec(sql!)
    const migrated = db.prepare(`SELECT source FROM document_tasks WHERE id = 'id1'`).get() as {
      source: string
    }
    expect(migrated.source).toBe('manual')
    table.insert({
      batchId: 'b2',
      filePath: 'p2',
      fileName: 'n2',
      templateId: 'auto',
      source: 'scheduled',
      now: 5
    })
    expect(
      db.prepare(`SELECT source FROM document_tasks WHERE batch_id = 'b2'`).get()
    ).toMatchObject({ source: 'scheduled' })
    db.close()
  })
})

describeIfSqlite('documentTasksTable ensureMigrated', () => {
  it('rebuilds a legacy v1 table and keeps rows', () => {
    const db = new DatabaseCtor(':memory:')
    createV1Table(db)
    const table = new DocumentTasksTableCtor(db)
    table.ensureMigrated()
    expect(ddlHasSourceCheck(db)).toBe(false)
    expect(db.prepare(`SELECT source FROM document_tasks WHERE id = 'id1'`).get()).toMatchObject({
      source: 'manual'
    })
    db.close()
  })

  it('is idempotent on an already migrated table', () => {
    const db = new DatabaseCtor(':memory:')
    createV1Table(db)
    const table = new DocumentTasksTableCtor(db)
    table.ensureMigrated()
    table.ensureMigrated()
    expect(table.listRecent()).toHaveLength(1)
    db.close()
  })

  it('creates the table when missing', () => {
    const db = new DatabaseCtor(':memory:')
    const table = new DocumentTasksTableCtor(db)
    table.ensureMigrated()
    expect(ddlHasSourceCheck(db)).toBe(false)
    const row = table.insert({
      batchId: 'b1',
      filePath: 'p',
      fileName: 'n',
      templateId: 'auto',
      source: 'scheduled',
      now: 1
    })
    expect(row.source).toBe('scheduled')
    db.close()
  })
})

describeIfSqlite('documentsTable v2 migration', () => {
  it('drops the source CHECK and preserves existing rows', () => {
    const db = new DatabaseCtor(':memory:')
    const table = new DocumentsTableCtor(db)
    // Simulate a v1 database whose source column is constrained to 'chat' | 'manual'.
    createV1DocumentsTable(db)
    expect(table.getLatestVersion()).toBe(2)
    const sql = table.getMigrationSQL(2)
    expect(sql).not.toBeNull()
    db.exec(sql!)
    const migrated = db.prepare(`SELECT * FROM documents WHERE id = 'doc1'`).get() as {
      source: string
      status: string
      reimbursement_override: string | null
    }
    expect(migrated.source).toBe('manual')
    expect(migrated.status).toBe('confirmed')
    expect(migrated.reimbursement_override).toBeNull()
    // Scheduled rows are writable after the rebuild.
    table.insert({
      templateId: 'tpl',
      typeKey: 'contract',
      templateSnapshot: {},
      fields: {},
      fileUris: [],
      source: 'scheduled',
      sessionId: null,
      status: 'draft',
      now: 5
    })
    expect(
      db.prepare(`SELECT source FROM documents WHERE source = 'scheduled'`).get()
    ).toMatchObject({ source: 'scheduled' })
    db.close()
  })
})

describeIfSqlite('documentsTable ensureMigrated', () => {
  it('rebuilds a legacy v1 table and keeps rows', () => {
    const db = new DatabaseCtor(':memory:')
    createV1DocumentsTable(db)
    const table = new DocumentsTableCtor(db)
    table.ensureMigrated()
    expect(ddlHasSourceCheck(db, 'documents')).toBe(false)
    expect(db.prepare(`SELECT source FROM documents WHERE id = 'doc1'`).get()).toMatchObject({
      source: 'manual'
    })
    db.close()
  })

  it('is idempotent on an already migrated table', () => {
    const db = new DatabaseCtor(':memory:')
    createV1DocumentsTable(db)
    const table = new DocumentsTableCtor(db)
    table.ensureMigrated()
    table.ensureMigrated()
    expect(table.count({})).toBe(1)
    db.close()
  })

  it('creates the table when missing', () => {
    const db = new DatabaseCtor(':memory:')
    const table = new DocumentsTableCtor(db)
    table.ensureMigrated()
    expect(ddlHasSourceCheck(db, 'documents')).toBe(false)
    const row = table.insert({
      templateId: 'tpl',
      typeKey: 'contract',
      templateSnapshot: {},
      fields: {},
      fileUris: [],
      source: 'scheduled',
      sessionId: null,
      status: 'draft',
      now: 1
    })
    expect(row.source).toBe('scheduled')
    db.close()
  })
})

describeIfSqlite('DocumentsDatabase bootstrap', () => {
  it('ensures watched files and migrated tasks tables on construction', () => {
    const db = new DatabaseCtor(':memory:')
    const first = new DocumentsDatabaseCtor({ getDatabase: () => db })
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toContain('document_tasks')
    expect(tables.map((t) => t.name)).toContain('documents_watched_files')
    first.documentTasksTable.insert({
      batchId: 'b1',
      filePath: 'p',
      fileName: 'n',
      templateId: 'auto',
      source: 'scheduled',
      now: 1
    })
    const rowsAfterFirst = first.documentTasksTable.listRecent()
    expect(rowsAfterFirst).toHaveLength(1)
    // Reconstructing must not rebuild or lose data.
    new DocumentsDatabaseCtor({ getDatabase: () => db })
    expect(first.documentTasksTable.listRecent()).toEqual(rowsAfterFirst)
    db.close()
  })

  it('migrates a legacy v1 document_tasks table on construction', () => {
    const db = new DatabaseCtor(':memory:')
    createV1Table(db)
    new DocumentsDatabaseCtor({ getDatabase: () => db })
    expect(db.prepare(`SELECT source FROM document_tasks WHERE id = 'id1'`).get()).toMatchObject({
      source: 'manual'
    })
    new DocumentsDatabaseCtor({ getDatabase: () => db }).documentTasksTable.insert({
      batchId: 'b2',
      filePath: 'p2',
      fileName: 'n2',
      templateId: 'auto',
      source: 'scheduled',
      now: 5
    })
    expect(
      db.prepare(`SELECT source FROM document_tasks WHERE batch_id = 'b2'`).get()
    ).toMatchObject({ source: 'scheduled' })
    db.close()
  })

  it('migrates a legacy v1 documents table on construction', () => {
    const db = new DatabaseCtor(':memory:')
    createV1DocumentsTable(db)
    new DocumentsDatabaseCtor({ getDatabase: () => db })
    expect(ddlHasSourceCheck(db, 'documents')).toBe(false)
    expect(db.prepare(`SELECT source FROM documents WHERE id = 'doc1'`).get()).toMatchObject({
      source: 'manual'
    })
    db.close()
  })
})

describeIfSqlite('DocumentsRepository', () => {
  const makeRepo = () => {
    const db = new DatabaseCtor(':memory:')
    new DocumentTemplatesTableCtor(db).createTable()
    new DocumentsTableCtor(db).createTable()
    const database = new DocumentsDatabaseCtor({ getDatabase: () => db })
    return { db, repo: new DocumentsRepositoryCtor(database) }
  }

  it('upserts and lists templates with domain types', () => {
    const { db, repo } = makeRepo()
    const tpl = repo.upsertTemplate({
      typeKey: 'contract',
      name: '合同模板',
      category: '合同类',
      fields: [
        {
          key: 'party_a',
          label: '甲方名称',
          valueType: 'text',
          required: true,
          promptHint: '甲方全称',
          validation: null,
          enumOptions: null,
          order: 1
        }
      ],
      now: 100
    })
    expect(tpl.isBuiltin).toBe(false)
    expect(tpl.fields[0].valueType).toBe('text')
    expect(repo.listTemplates()).toHaveLength(1)
    expect(repo.getTemplate(tpl.id)?.name).toBe('合同模板')
    expect(repo.getTemplateByTypeKey('contract')?.id).toBe(tpl.id)
    db.close()
  })

  it('deleteTemplate rejects builtin and reports archive references', () => {
    const { db, repo } = makeRepo()
    const tpl = repo.upsertTemplate({
      typeKey: 'k',
      name: 'N',
      category: '自定义',
      fields: [],
      isBuiltin: true,
      now: 1
    })
    expect(() => repo.deleteTemplate(tpl.id)).toThrow(/builtin/)
    const editable = repo.upsertTemplate({
      typeKey: 'k2',
      name: 'N2',
      category: '自定义',
      fields: [],
      now: 1
    })
    repo.insertDocument({
      templateId: editable.id,
      typeKey: 'k2',
      templateSnapshot: editable,
      fields: {},
      fileUris: [],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 2
    })
    expect(repo.countDocumentsByTemplateId(editable.id)).toBe(1)
    repo.deleteTemplate(editable.id, { force: true })
    expect(repo.getTemplate(editable.id)).toBeNull()
    db.close()
  })

  it('inserts document with snapshot and updates to confirmed', () => {
    const { db, repo } = makeRepo()
    const tpl = repo.upsertTemplate({
      typeKey: 'k3',
      name: 'N3',
      category: '自定义',
      fields: [],
      now: 1
    })
    const doc = repo.insertDocument({
      templateId: tpl.id,
      typeKey: 'k3',
      templateSnapshot: tpl,
      fields: { f1: { value: 42, uncertain: true } },
      fileUris: ['deepchat-file://x.pdf'],
      source: 'chat',
      sessionId: 's1',
      status: 'draft',
      now: 5
    })
    expect(doc.templateSnapshot.id).toBe(tpl.id)
    expect(doc.fields.f1.uncertain).toBe(true)
    const updated = repo.updateDocument(doc.id, { status: 'confirmed', now: 9 })
    expect(updated?.status).toBe('confirmed')
    expect(repo.listDocuments({ typeKey: 'k3' })).toHaveLength(1)
    expect(repo.listDocuments({ keyword: '42' })).toHaveLength(1)
    db.close()
  })

  it('forkTemplate rejects unknown source and duplicate typeKey', () => {
    const { db, repo } = makeRepo()
    expect(() => repo.forkTemplate('nope', 'fx', 'F')).toThrow(/Unknown source template/)
    const source = repo.upsertTemplate({
      typeKey: 'dup',
      name: 'Dup',
      category: '自定义',
      fields: [],
      now: 1
    })
    expect(() => repo.forkTemplate(source.id, 'dup', 'F2')).toThrow(/typeKey already exists/)
    db.close()
  })

  it('forkTemplate copies source template with custom category', () => {
    const { db, repo } = makeRepo()
    const source = repo.upsertTemplate({
      typeKey: 'src',
      name: 'Source',
      category: '合同类',
      fields: [
        {
          key: 'party_a',
          label: '甲方名称',
          valueType: 'text',
          required: true,
          promptHint: '甲方全称',
          validation: null,
          enumOptions: null,
          order: 1
        }
      ],
      extractionMode: 'vision',
      promptPreset: '识别合同字段',
      now: 1
    })
    const forked = repo.forkTemplate(source.id, 'src_copy', 'Forked', 2)
    expect(forked.isBuiltin).toBe(false)
    expect(forked.builtinSourceId).toBe(source.id)
    expect(forked.category).toBe('自定义')
    expect(forked.fields).toEqual(source.fields)
    expect(forked.extractionMode).toBe('vision')
    expect(forked.promptPreset).toBe('识别合同字段')
    db.close()
  })

  it('rejects typeKey change on template update', () => {
    const { db, repo } = makeRepo()
    const tpl = repo.upsertTemplate({
      typeKey: 'k1',
      name: 'N',
      category: '自定义',
      fields: [],
      now: 1
    })
    expect(() =>
      repo.upsertTemplate({ id: tpl.id, typeKey: 'k2', name: 'N', category: '自定义', fields: [] })
    ).toThrow(/immutable/)
    db.close()
  })

  it('deleteTemplate throws on archive references without force', () => {
    const { db, repo } = makeRepo()
    const tpl = repo.upsertTemplate({
      typeKey: 'k4',
      name: 'N4',
      category: '自定义',
      fields: [],
      now: 1
    })
    repo.insertDocument({
      templateId: tpl.id,
      typeKey: 'k4',
      templateSnapshot: tpl,
      fields: {},
      fileUris: [],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 2
    })
    expect(() => repo.deleteTemplate(tpl.id)).toThrow(/archived document/)
    repo.deleteTemplate(tpl.id, { force: true })
    expect(repo.getTemplate(tpl.id)).toBeNull()
    db.close()
  })
})

describeIfSeed('seedPresetTemplates', () => {
  const makeSeedDatabase = () => {
    const db = new DatabaseCtor(':memory:')
    new DocumentTemplatesTableCtor(db).createTable()
    const database = new DocumentsDatabaseCtor({ getDatabase: () => db })
    return { db, database }
  }

  it('seeds all 21 preset templates idempotently', () => {
    const { db, database } = makeSeedDatabase()
    const count1 = seedPresetTemplates!(database, { now: 100 })
    expect(count1).toBe(21)
    const templates = database.documentTemplatesTable.list()
    const typeKeys = templates.map((t) => t.type_key).sort()
    expect(typeKeys).toEqual([
      'asset_acceptance',
      'bank_receipt',
      'catering_receipt',
      'contract',
      'contract_supplement',
      'expense_claim',
      'hotel_receipt',
      'invoice_general',
      'invoice_special',
      'lease_contract',
      'meeting_minutes',
      'nda',
      'official_incoming',
      'onboarding_offboarding',
      'payment_screenshot',
      'purchase_order',
      'quotation',
      'resume',
      'ride_hailing_itinerary',
      'tender_notice',
      'travel_itinerary'
    ])
    const invoice = templates.find((t) => t.type_key === 'invoice_special')!
    const fields = JSON.parse(invoice.fields_json) as Array<{
      key: string
      valueType: string
      order: number
      required: boolean
      validation: string | null
      enumOptions: string[] | null
    }>
    expect(fields[0]).toMatchObject({ key: 'invoice_type', valueType: 'enum', order: 1 })
    expect(fields[0].enumOptions).not.toBeNull()
    const invoiceCode = fields.find((f) => f.key === 'invoice_code')
    expect(invoiceCode?.required).toBe(false)
    expect(invoiceCode?.validation).toBe('^[0-9]{10,12}$')
    expect(fields.find((f) => f.key === 'line_items')?.valueType).toBe('array')
    const lineItems = fields.find((f) => f.key === 'line_items')
    expect(lineItems?.required).toBe(false)
    expect(invoice.is_builtin).toBe(1)
    expect(invoice.category).toBe('发票类')

    const rideHailing = templates.find((t) => t.type_key === 'ride_hailing_itinerary')!
    expect(rideHailing.category).toBe('出行票据类')
    const rideFields = JSON.parse(rideHailing.fields_json) as Array<{
      key: string
      valueType: string
    }>
    expect(rideFields.find((f) => f.key === 'trips')?.valueType).toBe('array')
    expect(rideFields.find((f) => f.key === 'employee_no')?.required).toBe(false)

    const count2 = seedPresetTemplates!(database, { now: 200 })
    expect(count2).toBe(0)
    expect(database.documentTemplatesTable.list().every((t) => t.version === 1)).toBe(true)
    expect(database.documentTemplatesTable.list().every((t) => t.created_at === 100)).toBe(true)
    db.close()
  })

  it('produces templates that satisfy the templates list route contract', async () => {
    const { db, database } = makeSeedDatabase()
    seedPresetTemplates!(database, { now: 100 })
    const { DocumentsRepository } = await import('@/documents/repository')
    const { documentTemplatesListRoute } = await import('@shared/contracts/routes')
    const repository = new DocumentsRepository(database)
    const parsed = documentTemplatesListRoute.output.parse({
      templates: repository.listTemplates()
    })
    expect(parsed.templates).toHaveLength(21)
    db.close()
  })

  it('upgrades existing builtin templates when seeded fields differ', () => {
    const { db, database } = makeSeedDatabase()
    new DocumentTemplatesTableCtor(db).upsert({
      typeKey: 'invoice_special',
      name: '增值税专用发票',
      category: '发票类',
      fields: [
        {
          key: 'invoice_code',
          label: '发票代码',
          valueType: 'text',
          required: true,
          promptHint: '发票代码',
          validation: null,
          enumOptions: null,
          order: 1
        }
      ],
      isBuiltin: true,
      now: 50
    })
    const count = seedPresetTemplates!(database, { now: 100 })
    expect(count).toBe(21)
    const upgraded = database.documentTemplatesTable.getByTypeKey('invoice_special')!
    expect(upgraded.created_at).toBe(50)
    expect(upgraded.updated_at).toBe(100)
    expect(upgraded.version).toBe(2)
    const fields = JSON.parse(upgraded.fields_json) as Array<{ key: string }>
    expect(fields[0]?.key).toBe('invoice_type')
    expect(fields.some((f) => f.key === 'invoice_code')).toBe(true)
    db.close()
  })

  it('does not overwrite user templates occupying a preset typeKey', () => {
    const { db, database } = makeSeedDatabase()
    const userFields = [
      {
        key: 'custom_field',
        label: '自定义字段',
        valueType: 'text',
        required: true,
        promptHint: null,
        validation: null,
        enumOptions: null,
        order: 1
      }
    ]
    new DocumentTemplatesTableCtor(db).upsert({
      typeKey: 'contract',
      name: '自定义合同',
      category: '自定义',
      fields: userFields,
      isBuiltin: false,
      now: 50
    })
    const count = seedPresetTemplates!(database, { now: 100 })
    expect(count).toBe(20)
    const preserved = database.documentTemplatesTable.getByTypeKey('contract')!
    expect(preserved.name).toBe('自定义合同')
    expect(preserved.is_builtin).toBe(0)
    expect(preserved.version).toBe(1)
    expect(JSON.parse(preserved.fields_json)).toEqual(userFields)
    db.close()
  })
})

describeIfSqlite('DocumentTasksTable listFiltered / scanBatches', () => {
  const makeDb = () => {
    const db = new DatabaseCtor(':memory:')
    new DocumentTasksTableCtor(db).createTable()
    return db
  }

  it('listFiltered 按 status/source/batchId 过滤且 created_at DESC 分页', () => {
    const db = makeDb()
    const table = new DocumentTasksTableCtor(db)
    const t1 = table.insert({
      batchId: 'b1',
      filePath: 'C:/a.pdf',
      fileName: 'a.pdf',
      templateId: 'auto',
      source: 'manual',
      now: 1000
    })
    table.insert({
      batchId: 'b2',
      filePath: 'C:/b.pdf',
      fileName: 'b.pdf',
      templateId: 'auto',
      source: 'scheduled',
      now: 2000
    })
    table.insert({
      batchId: 'b2',
      filePath: 'C:/c.pdf',
      fileName: 'c.pdf',
      templateId: 'auto',
      source: 'scheduled',
      now: 3000
    })
    table.update(t1.id, { status: 'done' })
    expect(
      table.listFiltered({ source: 'scheduled', limit: 10, offset: 0 }).map((r) => r.file_name)
    ).toEqual(['c.pdf', 'b.pdf'])
    expect(table.listFiltered({ status: 'done', limit: 10, offset: 0 }).map((r) => r.id)).toEqual([
      t1.id
    ])
    expect(
      table.listFiltered({ batchId: 'b2', limit: 1, offset: 0 }).map((r) => r.file_name)
    ).toEqual(['c.pdf'])
    expect(
      table.listFiltered({ batchId: 'b2', limit: 1, offset: 1 }).map((r) => r.file_name)
    ).toEqual(['b.pdf'])
    expect(table.countFiltered({ source: 'scheduled' })).toBe(2)
    expect(table.countFiltered({})).toBe(3)
    db.close()
  })

  it('listScanBatches 按批次聚合（startedAt/total/done/failed）且按 startedAt DESC 排序', () => {
    const db = makeDb()
    const table = new DocumentTasksTableCtor(db)
    table.insert({
      batchId: 'old',
      filePath: 'C:/a.pdf',
      fileName: 'a.pdf',
      templateId: 'auto',
      source: 'scheduled',
      now: 1000
    })
    table.insert({
      batchId: 'old',
      filePath: 'C:/b.pdf',
      fileName: 'b.pdf',
      templateId: 'auto',
      source: 'scheduled',
      now: 1100
    })
    table.insert({
      batchId: 'new',
      filePath: 'C:/c.pdf',
      fileName: 'c.pdf',
      templateId: 'auto',
      source: 'scheduled',
      now: 2000
    })
    table.insert({
      batchId: 'manual-mix',
      filePath: 'C:/d.pdf',
      fileName: 'd.pdf',
      templateId: 'auto',
      source: 'manual',
      now: 1500
    })
    const batches = table.listScanBatches(10, 0)
    expect(batches.map((b) => b.batch_id)).toEqual(['new', 'old'])
    expect(batches[1]).toMatchObject({ started_at: 1000, total: 2, done: 0, failed: 0 })
    expect(table.countScanBatches()).toBe(2)
    db.close()
  })

  it('source 索引由 ensureMigrated 幂等创建（存量库无 getLatestVersion 变更）', () => {
    // 存量 v1 库（含 source CHECK、无新索引）：ensureMigrated 重建后索引必须存在
    const db = new DatabaseCtor(':memory:')
    createV1Table(db)
    const table = new DocumentTasksTableCtor(db)
    table.ensureMigrated()
    table.ensureMigrated()
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_document_tasks_source'`
      )
      .get()
    expect(idx).toBeDefined()
    db.close()
  })
})

describeIfSqlite('DocumentsTable listChatAsTasks', () => {
  const makeDb = () => {
    const db = new DatabaseCtor(':memory:')
    new DocumentsTableCtor(db).createTable()
    return db
  }

  it('仅返回 source=chat 的行，created_at DESC 分页；countChatAsTasks 同口径', () => {
    const db = makeDb()
    const documents = new DocumentsTableCtor(db)
    documents.insert({
      templateId: 't',
      typeKey: 'invoice',
      templateSnapshot: {},
      fields: {},
      fileUris: ['C:/chat1.pdf'],
      source: 'chat',
      sessionId: 's1',
      status: 'draft',
      now: 1000
    })
    documents.insert({
      templateId: 't',
      typeKey: 'invoice',
      templateSnapshot: {},
      fields: {},
      fileUris: ['C:/chat2.pdf'],
      source: 'chat',
      sessionId: 's2',
      status: 'draft',
      now: 2000
    })
    documents.insert({
      templateId: 't',
      typeKey: 'invoice',
      templateSnapshot: {},
      fields: {},
      fileUris: ['C:/manual.pdf'],
      source: 'manual',
      sessionId: null,
      status: 'draft',
      now: 3000
    })
    const rows = documents.listChatAsTasks(10, 0)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.file_uris_json).toContain('chat2.pdf')
    expect(documents.countChatAsTasks()).toBe(2)
    db.close()
  })

  it('documents.source 索引由 ensureMigrated 幂等创建', () => {
    const db = new DatabaseCtor(':memory:')
    createV1DocumentsTable(db)
    const documents = new DocumentsTableCtor(db)
    documents.ensureMigrated()
    documents.ensureMigrated()
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_documents_source'`)
      .get()
    expect(idx).toBeDefined()
    db.close()
  })
})
