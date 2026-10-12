import type Database from 'better-sqlite3-multiple-ciphers'
import { BaseTable } from '@/data/baseTable'

export interface WatchedFileRow {
  path: string
  mtime_ms: number
  status: string
  task_id: string | null
  processed_at: number
}

export interface WatchedFileUpsertInput {
  path: string
  mtimeMs: number
  taskId: string | null
  now?: number
}

export class WatchedFilesTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'documents_watched_files')
  }

  getCreateTableSQL(): string {
    return `
      CREATE TABLE IF NOT EXISTS documents_watched_files (
        path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'submitted',
        task_id TEXT,
        processed_at INTEGER NOT NULL
      )
    `
  }

  getLatestVersion(): number {
    return 2
  }

  // v2: rebuild the table to relax task_id to nullable (SQLite cannot alter NOT NULL in place).
  getMigrationSQL(version: number): string | null {
    if (version !== 2) return null
    return `
      CREATE TABLE documents_watched_files_v2 (
        path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'submitted',
        task_id TEXT,
        processed_at INTEGER NOT NULL
      );
      INSERT INTO documents_watched_files_v2 (path, mtime_ms, status, task_id, processed_at)
        SELECT path, mtime_ms, status, task_id, processed_at FROM documents_watched_files;
      DROP TABLE documents_watched_files;
      ALTER TABLE documents_watched_files_v2 RENAME TO documents_watched_files;
    `
  }

  // Ensure task_id is nullable so a blocked watch entry can be recorded without a task.
  // This table is not part of the main catalog migration loop, and startup diagnosis/repair
  // only detects missing tables/columns, not constraint changes. Detect the legacy NOT NULL
  // task_id in the stored DDL and rebuild once; the rebuilt DDL no longer contains it, which
  // makes this idempotent. The rebuild runs in its own transaction (better-sqlite3 downgrades
  // nested transactions to savepoints) so it stays atomic in any caller context.
  ensureMigrated(): void {
    if (!this.tableExists()) {
      this.db.exec(this.getCreateTableSQL())
      return
    }
    const ddl = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(this.tableName) as { sql: string | null } | undefined
    if (!ddl?.sql || !/task_id\s+TEXT\s+NOT\s+NULL/i.test(ddl.sql)) return
    const sql = this.getMigrationSQL(2)
    if (sql) this.db.transaction(() => this.db.exec(sql))()
  }

  listAll(): WatchedFileRow[] {
    return this.db.prepare('SELECT * FROM documents_watched_files').all() as WatchedFileRow[]
  }

  upsert(input: WatchedFileUpsertInput): void {
    this.db
      .prepare(
        `INSERT INTO documents_watched_files (path, mtime_ms, status, task_id, processed_at)
         VALUES (?, ?, 'submitted', ?, ?)
         ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms,
           -- rediscovery means resubmission: reset status to 'submitted' and refresh the task
           status = excluded.status, task_id = excluded.task_id, processed_at = excluded.processed_at`
      )
      .run(input.path, input.mtimeMs, input.taskId, input.now ?? Date.now())
  }
}
