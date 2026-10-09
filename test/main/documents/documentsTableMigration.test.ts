import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import { DocumentsTable } from '@/documents/data/tables/documents'

describe('documents table reimbursement_override migration', () => {
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

  it('migrating an old v1 table adds the column', () => {
    db.exec(`CREATE TABLE documents (
      id TEXT PRIMARY KEY, template_id TEXT NOT NULL, type_key TEXT NOT NULL,
      template_snapshot_json TEXT NOT NULL DEFAULT '{}', fields_json TEXT NOT NULL DEFAULT '{}',
      file_uris_json TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL CHECK(source IN ('chat','manual')),
      session_id TEXT, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );`)
    const table = new DocumentsTable(db)
    const sql = table.getMigrationSQL(67)
    expect(sql).toContain('reimbursement_override')
    db.exec(sql!)
    const columns = (
      db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>
    ).map((c) => c.name)
    expect(columns).toContain('reimbursement_override')
    expect(table.getLatestVersion()).toBe(67)
  })
})
