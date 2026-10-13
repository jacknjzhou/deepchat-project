import type Database from 'better-sqlite3-multiple-ciphers'
import { BaseTable } from '@/data/baseTable'

export interface FileDedupeRow {
  content_hash: string
  file_name: string
  file_path: string
  source: string
  task_id: string
  document_id: string | null
  created_at: number
}

export interface FileDedupeInsertInput {
  contentHash: string
  fileName: string
  filePath: string
  source: string
  taskId: string
  now: number
}

export class FileDedupeTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'documents_file_dedupe')
  }

  getCreateTableSQL(): string {
    return `
      CREATE TABLE IF NOT EXISTS documents_file_dedupe (
        content_hash TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        source TEXT NOT NULL,
        task_id TEXT NOT NULL,
        document_id TEXT,
        created_at INTEGER NOT NULL
      )
    `
  }

  getLatestVersion(): number {
    return 1
  }

  getMigrationSQL(_version: number): string | null {
    return null
  }

  findByHashes(hashes: string[]): Map<string, string> {
    const result = new Map<string, string>()
    if (hashes.length === 0) return result
    const placeholders = hashes.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT content_hash, file_name FROM documents_file_dedupe WHERE content_hash IN (${placeholders})`
      )
      .all(...hashes) as Array<{ content_hash: string; file_name: string }>
    for (const row of rows) result.set(row.content_hash, row.file_name)
    return result
  }

  insertAll(inputs: FileDedupeInsertInput[]): void {
    if (inputs.length === 0) return
    const stmt = this.db.prepare(
      `INSERT INTO documents_file_dedupe (content_hash, file_name, file_path, source, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    this.db.transaction(() => {
      for (const input of inputs) {
        stmt.run(
          input.contentHash,
          input.fileName,
          input.filePath,
          input.source,
          input.taskId,
          input.now
        )
      }
    })()
  }

  deleteByTask(taskId: string): void {
    this.db.prepare('DELETE FROM documents_file_dedupe WHERE task_id = ?').run(taskId)
  }

  bindDocument(taskId: string, documentId: string): number {
    return this.db
      .prepare('UPDATE documents_file_dedupe SET document_id = ? WHERE task_id = ?')
      .run(documentId, taskId).changes
  }

  deleteByDocument(documentId: string): void {
    this.db.prepare('DELETE FROM documents_file_dedupe WHERE document_id = ?').run(documentId)
  }
}
