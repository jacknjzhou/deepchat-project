import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import { getSchemaCatalog } from '@/data/schemaCatalog'
import { DocumentsTable } from '@/documents/data/tables/documents'

describe('documents table reimbursement_override schema repair', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
  })
  afterEach(() => db.close())

  it('fresh create includes the column', () => {
    new DocumentsTable(db).createTable()
    const columns = (
      db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>
    ).map((c) => c.name)
    expect(columns).toContain('reimbursement_override')
  })

  it('registers the column as repairable in the schema catalog', () => {
    const spec = getSchemaCatalog().find((table) => table.name === 'documents')
    expect(spec).toBeDefined()
    const column = spec!.columns.find((c) => c.name === 'reimbursement_override')
    expect(column).toBeDefined()
    expect(column!.addColumnSql).toContain('reimbursement_override')
  })

  it('addColumnSql upgrades a legacy documents table', () => {
    const spec = getSchemaCatalog().find((table) => table.name === 'documents')!
    db.exec(`CREATE TABLE documents (
      id TEXT PRIMARY KEY, template_id TEXT NOT NULL, type_key TEXT NOT NULL,
      template_snapshot_json TEXT NOT NULL DEFAULT '{}', fields_json TEXT NOT NULL DEFAULT '{}',
      file_uris_json TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL CHECK(source IN ('chat','manual')),
      session_id TEXT, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );`)
    db.exec(spec.columns.find((c) => c.name === 'reimbursement_override')!.addColumnSql!)
    const columns = (
      db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>
    ).map((c) => c.name)
    expect(columns).toContain('reimbursement_override')
  })
})
