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
  source?: 'chat' | 'manual' | 'scheduled'
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

export interface DocumentTaskListFilter {
  status?: 'pending' | 'running' | 'done' | 'failed'
  source?: 'chat' | 'manual' | 'scheduled'
  batchId?: string
  limit: number
  offset: number
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
        source TEXT NOT NULL DEFAULT 'manual',
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
      CREATE INDEX IF NOT EXISTS idx_document_tasks_source
        ON document_tasks(source, created_at DESC);
    `
  }

  getLatestVersion(): number {
    return 2
  }

  // v2: rebuild the table to drop the source CHECK constraint (SQLite cannot alter CHECK).
  getMigrationSQL(version: number): string | null {
    if (version !== 2) return null
    return `
      CREATE TABLE document_tasks_v2 (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        template_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'done', 'failed')),
        type_key TEXT,
        document_id TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO document_tasks_v2
        (id, batch_id, file_path, file_name, template_id, source, status,
         type_key, document_id, error, created_at, updated_at)
        SELECT id, batch_id, file_path, file_name, template_id, source, status,
               type_key, document_id, error, created_at, updated_at
        FROM document_tasks;
      DROP TABLE document_tasks;
      ALTER TABLE document_tasks_v2 RENAME TO document_tasks;
      CREATE INDEX IF NOT EXISTS idx_document_tasks_status
        ON document_tasks(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_document_tasks_created_at
        ON document_tasks(created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_document_tasks_source
        ON document_tasks(source, created_at DESC);
    `
  }

  // Ensure the table is usable for scheduled sources. This table is not part of the main
  // catalog migration loop (its table version 2 sits far below the global schema_versions
  // high-water mark, so that loop can never reach version 2), and startup diagnosis/repair
  // only detects missing tables/columns, not CHECK constraint changes. Detect the legacy
  // source CHECK in the stored DDL and rebuild once; the rebuilt DDL no longer contains it,
  // which makes this idempotent. The rebuild runs in its own transaction (better-sqlite3
  // downgrades nested transactions to savepoints) so it stays atomic in any caller context.
  // A trailing idempotent index guarantee covers databases migrated before the source index
  // existed (this table sits below the global schema_versions high-water mark, so the main
  // migration loop can never add it — do not bump getLatestVersion for it).
  ensureMigrated(): void {
    if (!this.tableExists()) {
      this.db.exec(this.getCreateTableSQL())
      return
    }
    const ddl = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(this.tableName) as { sql: string | null } | undefined
    if (ddl?.sql && /CHECK\s*\(\s*source\s+IN/i.test(ddl.sql)) {
      const sql = this.getMigrationSQL(2)
      if (sql) this.db.transaction(() => this.db.exec(sql))()
    }
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_document_tasks_source ON document_tasks(source, created_at DESC)'
    )
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

  private buildFilterWhere(filter: Omit<DocumentTaskListFilter, 'limit' | 'offset'>): {
    where: string
    params: unknown[]
  } {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.status) {
      conditions.push('status = ?')
      params.push(filter.status)
    }
    if (filter.source) {
      conditions.push('source = ?')
      params.push(filter.source)
    }
    if (filter.batchId) {
      conditions.push('batch_id = ?')
      params.push(filter.batchId)
    }
    return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params }
  }

  listFiltered(filter: DocumentTaskListFilter): DocumentTaskRow[] {
    const { where, params } = this.buildFilterWhere(filter)
    return this.db
      .prepare(
        `SELECT * FROM document_tasks ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, filter.limit, filter.offset) as DocumentTaskRow[]
  }

  countFiltered(filter: Omit<DocumentTaskListFilter, 'limit' | 'offset'>): number {
    const { where, params } = this.buildFilterWhere(filter)
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM document_tasks ${where}`)
      .get(...params) as { count: number }
    return row.count
  }

  listScanBatches(
    limit: number,
    offset: number
  ): Array<{ batch_id: string; started_at: number; total: number; done: number; failed: number }> {
    return this.db
      .prepare(
        `SELECT batch_id,
                MIN(created_at) AS started_at,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM document_tasks WHERE source = 'scheduled'
         GROUP BY batch_id
         ORDER BY started_at DESC, batch_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as Array<{
      batch_id: string
      started_at: number
      total: number
      done: number
      failed: number
    }>
  }

  countScanBatches(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT batch_id) AS count FROM document_tasks WHERE source = 'scheduled'`
      )
      .get() as { count: number }
    return row.count
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
