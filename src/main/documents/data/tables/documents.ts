import type Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'node:crypto'
import { BaseTable } from '@/data/baseTable'

export interface DocumentRow {
  id: string
  template_id: string
  type_key: string
  template_snapshot_json: string
  fields_json: string
  file_uris_json: string
  source: string
  session_id: string | null
  status: string
  created_at: number
  updated_at: number
}

export interface DocumentTableInsertInput {
  templateId: string
  typeKey: string
  templateSnapshot: Record<string, unknown>
  fields: Record<string, unknown>
  fileUris: string[]
  source: 'chat' | 'manual'
  sessionId: string | null
  status: 'draft' | 'confirmed'
  now?: number
}

export interface DocumentTableUpdateInput {
  fields?: Record<string, unknown>
  status?: 'draft' | 'confirmed'
  now?: number
}

export interface DocumentListFilter {
  typeKey?: string
  status?: 'draft' | 'confirmed'
  keyword?: string
  limit?: number
  offset?: number
}

const LIST_DEFAULT_LIMIT = 100

export class DocumentsTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'documents')
  }

  getCreateTableSQL(): string {
    return `
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        type_key TEXT NOT NULL,
        template_snapshot_json TEXT NOT NULL DEFAULT '{}',
        fields_json TEXT NOT NULL DEFAULT '{}',
        file_uris_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL CHECK(source IN ('chat', 'manual')),
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'confirmed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_documents_type_key_status
        ON documents(type_key, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_documents_updated_at
        ON documents(updated_at DESC, id DESC);
    `
  }

  getLatestVersion(): number {
    return 1
  }

  getMigrationSQL(_version: number): string | null {
    return null
  }

  list(filter: DocumentListFilter): DocumentRow[] {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.typeKey) {
      conditions.push('type_key = ?')
      params.push(filter.typeKey)
    }
    if (filter.status) {
      conditions.push('status = ?')
      params.push(filter.status)
    }
    if (filter.keyword) {
      conditions.push("fields_json LIKE ? ESCAPE '\\'")
      params.push(`%${filter.keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = filter.limit ?? LIST_DEFAULT_LIMIT
    const offset = filter.offset ?? 0
    return this.db
      .prepare(
        `SELECT * FROM documents ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as DocumentRow[]
  }

  get(id: string): DocumentRow | undefined {
    return this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as
      | DocumentRow
      | undefined
  }

  insert(input: DocumentTableInsertInput): DocumentRow {
    const now = input.now ?? Date.now()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO documents
           (id, template_id, type_key, template_snapshot_json, fields_json,
            file_uris_json, source, session_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.templateId,
        input.typeKey,
        JSON.stringify(input.templateSnapshot),
        JSON.stringify(input.fields),
        JSON.stringify(input.fileUris),
        input.source,
        input.sessionId,
        input.status,
        now,
        now
      )
    return this.get(id)!
  }

  updateFieldsAndStatus(id: string, input: DocumentTableUpdateInput): DocumentRow | undefined {
    const existing = this.get(id)
    if (!existing) return undefined
    const now = input.now ?? Date.now()
    const fields = input.fields ? JSON.stringify(input.fields) : existing.fields_json
    const status = input.status ?? existing.status
    this.db
      .prepare('UPDATE documents SET fields_json = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(fields, status, now, id)
    return this.get(id)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id)
  }

  countByTemplateId(templateId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM documents WHERE template_id = ?')
      .get(templateId) as { count: number }
    return row.count
  }
}
