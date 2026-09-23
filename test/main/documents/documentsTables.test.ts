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
const DocumentsDatabase = databaseModule?.DocumentsDatabase
const DocumentsRepository = repositoryModule?.DocumentsRepository
const seedPresetTemplates = seedModule?.seedPresetTemplates
const DatabaseCtor = Database!
const DocumentTemplatesTableCtor = DocumentTemplatesTable!
const DocumentsTableCtor = DocumentsTable!
const DocumentTasksTableCtor = DocumentTasksTable!
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
const describeIfSeed = modulesReady && seedPresetTemplates ? describe : describe.skip

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
  it('seeds all 10 preset templates idempotently', () => {
    const db = new DatabaseCtor(':memory:')
    new DocumentTemplatesTableCtor(db).createTable()
    const database = new DocumentsDatabaseCtor({ getDatabase: () => db })
    const count1 = seedPresetTemplates!(database, { now: 100 })
    expect(count1).toBe(10)
    const templates = database.documentTemplatesTable.list()
    const typeKeys = templates.map((t) => t.type_key).sort()
    expect(typeKeys).toEqual(
      [
        'catering_receipt',
        'contract',
        'contract_supplement',
        'hotel_receipt',
        'invoice_general',
        'invoice_special',
        'lease_contract',
        'payment_screenshot',
        'purchase_order',
        'travel_itinerary'
      ].sort()
    )
    const invoice = templates.find((t) => t.type_key === 'invoice_special')!
    const fields = JSON.parse(invoice.fields_json) as Array<{
      key: string
      valueType: string
      order: number
      required: boolean
    }>
    expect(fields[0]).toMatchObject({ key: 'invoice_code', valueType: 'text', order: 1 })
    expect(fields.find((f) => f.key === 'line_items')?.valueType).toBe('array')
    const lineItems = fields.find((f) => f.key === 'line_items')
    expect(lineItems?.required).toBe(false)
    expect(invoice.is_builtin).toBe(1)
    expect(invoice.category).toBe('发票类')

    const count2 = seedPresetTemplates!(database, { now: 200 })
    expect(count2).toBe(0)
    expect(database.documentTemplatesTable.list().every((t) => t.created_at === 100)).toBe(true)
    db.close()
  })
})
