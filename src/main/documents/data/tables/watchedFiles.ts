import type Database from 'better-sqlite3-multiple-ciphers'
import { BaseTable } from '@/data/baseTable'

export interface WatchedFileRow {
  path: string
  mtime_ms: number
  status: string
  task_id: string
  processed_at: number
}

export interface WatchedFileUpsertInput {
  path: string
  mtimeMs: number
  taskId: string
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
        task_id TEXT NOT NULL,
        processed_at INTEGER NOT NULL
      )
    `
  }

  getLatestVersion(): number {
    return 1
  }

  getMigrationSQL(_version: number): string | null {
    return null
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
           status = excluded.status, task_id = excluded.task_id, processed_at = excluded.processed_at`
      )
      .run(input.path, input.mtimeMs, input.taskId, input.now ?? Date.now())
  }
}
