import { describe, expect, it } from 'vitest'

const sqliteModule = await import('better-sqlite3-multiple-ciphers').catch(() => null)
const tableModule = sqliteModule
  ? await import('@/documents/data/tables/documentTemplates').catch(() => null)
  : null

const Database = sqliteModule?.default
const DocumentTemplatesTable = tableModule?.DocumentTemplatesTable
const DatabaseCtor = Database!
const DocumentTemplatesTableCtor = DocumentTemplatesTable!

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

const describeIfSqlite = sqliteAvailable && DocumentTemplatesTable ? describe : describe.skip

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
