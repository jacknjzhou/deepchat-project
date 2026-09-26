import type Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'node:crypto'
import { BaseTable } from '@/data/baseTable'

export interface DocumentTaskRow {
  id: string
  batch_id: string
  file_path: string
  file_name: string
  template_id: string
  source: string
  status: string
  type_key: string | null
  document_id: string | null
  error: string | null
  created_at: number
  updated_at: number
}

export interface DocumentTaskInsertInput {
  batchId: string
  filePath: string
  fileName: string
  templateId: string
  source?: 'chat' | 'manual'
  now?: number
}

export interface DocumentTaskUpdateInput {
  status: 'pending' | 'running' | 'done' | 'failed'
  templateId?: string
  typeKey?: string | null
  documentId?: string | null
  error?: string | null
  now?: number
}

export class DocumentTasksTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'document_tasks')
  }

  getCreateTableSQL(): string {
    return `
      CREATE TABLE IF NOT EXISTS document_tasks (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        template_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('chat', 'manual')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'done', 'failed')),
        type_key TEXT,
        document_id TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_document_tasks_status
        ON document_tasks(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_document_tasks_created_at
        ON document_tasks(created_at DESC, id DESC);
    `
  }

  getLatestVersion(): number {
    return 1
  }

  getMigrationSQL(_version: number): string | null {
    return null
  }

  get(id: string): DocumentTaskRow | undefined {
    return this.db.prepare('SELECT * FROM document_tasks WHERE id = ?').get(id) as
      | DocumentTaskRow
      | undefined
  }

  insert(input: DocumentTaskInsertInput): DocumentTaskRow {
    const now = input.now ?? Date.now()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO document_tasks
           (id, batch_id, file_path, file_name, template_id, source, status, type_key, document_id, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`
      )
      .run(
        id,
        input.batchId,
        input.filePath,
        input.fileName,
        input.templateId,
        input.source ?? 'manual',
        now,
        now
      )
    return this.get(id)!
  }

  insertBatch(inputs: DocumentTaskInsertInput[]): DocumentTaskRow[] {
    return this.db.transaction(() => inputs.map((input) => this.insert(input)))()
  }

  update(id: string, input: DocumentTaskUpdateInput): DocumentTaskRow | undefined {
    const existing = this.get(id)
    if (!existing) return undefined
    const now = input.now ?? Date.now()
    this.db
      .prepare(
        `UPDATE document_tasks
         SET status = ?, template_id = ?, type_key = ?, document_id = ?, error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.status,
        input.templateId !== undefined ? input.templateId : existing.template_id,
        input.typeKey !== undefined ? input.typeKey : existing.type_key,
        input.documentId !== undefined ? input.documentId : existing.document_id,
        input.error !== undefined ? input.error : existing.error,
        now,
        id
      )
    return this.get(id)
  }

  listPending(): DocumentTaskRow[] {
    return this.db
      .prepare(
        "SELECT * FROM document_tasks WHERE status = 'pending' ORDER BY created_at ASC, id ASC"
      )
      .all() as DocumentTaskRow[]
  }

  listRecent(limit = 200): DocumentTaskRow[] {
    return this.db
      .prepare('SELECT * FROM document_tasks ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit) as DocumentTaskRow[]
  }

  markRunningAsFailed(error: string, now?: number): void {
    this.db
      .prepare(
        "UPDATE document_tasks SET status = 'failed', error = ?, updated_at = ? WHERE status = 'running'"
      )
      .run(error, now ?? Date.now())
  }

  deleteFailed(): number {
    const info = this.db.prepare("DELETE FROM document_tasks WHERE status = 'failed'").run()
    return info.changes
  }

  countBatch(batchId: string): { done: number; total: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status IN ('done', 'failed') THEN 1 ELSE 0 END) AS done
         FROM document_tasks WHERE batch_id = ?`
      )
      .get(batchId) as { total: number; done: number | null }
    return { done: row.done ?? 0, total: row.total }
  }
}
