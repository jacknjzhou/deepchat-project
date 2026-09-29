import type Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'node:crypto'
import { BaseTable } from '@/data/baseTable'

export interface ResumeScreeningTaskRow {
  id: string
  status: string
  jd_source: string
  jd_text: string
  jd_file_name: string | null
  jd_analysis_json: string | null
  config_json: string
  provider_id: string
  model_id: string
  total: number
  succeeded: number
  failed: number
  avg_score: number | null
  recommended_count: number
  created_by_name: string
  created_by_email: string
  started_at: number | null
  finished_at: number | null
  created_at: number
  updated_at: number
}

export interface ResumeScreeningTaskInsertInput {
  jdSource: 'text' | 'file'
  jdText: string
  jdFileName?: string | null
  configJson: string
  providerId: string
  modelId: string
  total: number
  createdByName: string
  createdByEmail: string
  now?: number
}

export interface ResumeScreeningTaskUpdateInput {
  status?: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'
  jdAnalysisJson?: string | null
  succeeded?: number
  failed?: number
  avgScore?: number | null
  recommendedCount?: number
  startedAt?: number | null
  finishedAt?: number | null
  now?: number
}

export class ResumeScreeningTasksTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'resume_screening_tasks')
  }

  getCreateTableSQL(): string {
    return `
      CREATE TABLE IF NOT EXISTS resume_screening_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK(status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
        jd_source TEXT NOT NULL CHECK(jd_source IN ('text', 'file')),
        jd_text TEXT NOT NULL,
        jd_file_name TEXT,
        jd_analysis_json TEXT,
        config_json TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        total INTEGER NOT NULL,
        succeeded INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        avg_score REAL,
        recommended_count INTEGER NOT NULL DEFAULT 0,
        created_by_name TEXT NOT NULL,
        created_by_email TEXT NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_resume_screening_tasks_status
        ON resume_screening_tasks(status, created_at DESC);
    `
  }

  getLatestVersion(): number {
    return 1
  }

  getMigrationSQL(_version: number): string | null {
    return null
  }

  get(id: string): ResumeScreeningTaskRow | undefined {
    return this.db.prepare('SELECT * FROM resume_screening_tasks WHERE id = ?').get(id) as
      | ResumeScreeningTaskRow
      | undefined
  }

  insert(input: ResumeScreeningTaskInsertInput): ResumeScreeningTaskRow {
    const now = input.now ?? Date.now()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO resume_screening_tasks
           (id, status, jd_source, jd_text, jd_file_name, jd_analysis_json, config_json,
            provider_id, model_id, total, succeeded, failed, avg_score, recommended_count,
            created_by_name, created_by_email, started_at, finished_at, created_at, updated_at)
         VALUES (?, 'queued', ?, ?, ?, NULL, ?, ?, ?, ?, 0, 0, NULL, 0, ?, ?, NULL, NULL, ?, ?)`
      )
      .run(
        id,
        input.jdSource,
        input.jdText,
        input.jdFileName ?? null,
        input.configJson,
        input.providerId,
        input.modelId,
        input.total,
        input.createdByName,
        input.createdByEmail,
        now,
        now
      )
    return this.get(id)!
  }

  update(id: string, input: ResumeScreeningTaskUpdateInput): ResumeScreeningTaskRow | undefined {
    const existing = this.get(id)
    if (!existing) return undefined
    const now = input.now ?? Date.now()
    this.db
      .prepare(
        `UPDATE resume_screening_tasks
         SET status = ?, jd_analysis_json = ?, succeeded = ?, failed = ?, avg_score = ?,
             recommended_count = ?, started_at = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.status ?? existing.status,
        input.jdAnalysisJson !== undefined ? input.jdAnalysisJson : existing.jd_analysis_json,
        input.succeeded !== undefined ? input.succeeded : existing.succeeded,
        input.failed !== undefined ? input.failed : existing.failed,
        input.avgScore !== undefined ? input.avgScore : existing.avg_score,
        input.recommendedCount !== undefined ? input.recommendedCount : existing.recommended_count,
        input.startedAt !== undefined ? input.startedAt : existing.started_at,
        input.finishedAt !== undefined ? input.finishedAt : existing.finished_at,
        now,
        id
      )
    return this.get(id)
  }

  listRecent(limit = 100): ResumeScreeningTaskRow[] {
    return this.db
      .prepare('SELECT * FROM resume_screening_tasks ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit) as ResumeScreeningTaskRow[]
  }

  listActive(): ResumeScreeningTaskRow[] {
    return this.db
      .prepare(
        "SELECT * FROM resume_screening_tasks WHERE status IN ('queued', 'running') ORDER BY created_at ASC, id ASC"
      )
      .all() as ResumeScreeningTaskRow[]
  }
}
