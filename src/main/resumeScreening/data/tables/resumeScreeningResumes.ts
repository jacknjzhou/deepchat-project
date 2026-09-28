import type Database from 'better-sqlite3-multiple-ciphers'
import { BaseTable } from '@/data/baseTable'

export interface ResumeScreeningResumeRow {
  id: string
  task_id: string
  file_name: string
  file_path: string
  mime_type: string | null
  size: number
  candidate_name: string | null
  raw_text: string | null
  resume_info_json: string | null
  screening_json: string | null
  interview_json: string | null
  hr_json: string | null
  score: number | null
  recommended: number | null
  status: string
  error: string | null
  created_at: number
  updated_at: number
}

// id 由调用方显式传入：简历原文文件路径为 userData/resume-screening/{taskId}/{id}.{ext}，
// 复制文件前必须先确定 id
export interface ResumeScreeningResumeInsertInput {
  id: string
  taskId: string
  fileName: string
  filePath: string
  mimeType?: string | null
  size: number
  now?: number
}

export interface ResumeScreeningResumeUpdateInput {
  status?: 'pending' | 'running' | 'done' | 'failed'
  candidateName?: string | null
  rawText?: string | null
  resumeInfoJson?: string | null
  screeningJson?: string | null
  interviewJson?: string | null
  hrJson?: string | null
  score?: number | null
  recommended?: boolean | null
  error?: string | null
  now?: number
}

export interface ResumeScreeningTaskStats {
  total: number
  succeeded: number
  failed: number
  avgScore: number | null
  recommendedCount: number
}

export class ResumeScreeningResumesTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'resume_screening_resumes')
  }

  getCreateTableSQL(): string {
    return `
      CREATE TABLE IF NOT EXISTS resume_screening_resumes (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mime_type TEXT,
        size INTEGER NOT NULL,
        candidate_name TEXT,
        raw_text TEXT,
        resume_info_json TEXT,
        screening_json TEXT,
        interview_json TEXT,
        hr_json TEXT,
        score REAL,
        recommended INTEGER,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'running', 'done', 'failed')),
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_resume_screening_resumes_task
        ON resume_screening_resumes(task_id, created_at);
    `
  }

  getLatestVersion(): number {
    return 1
  }

  getMigrationSQL(_version: number): string | null {
    return null
  }

  get(id: string): ResumeScreeningResumeRow | undefined {
    return this.db.prepare('SELECT * FROM resume_screening_resumes WHERE id = ?').get(id) as
      | ResumeScreeningResumeRow
      | undefined
  }

  insert(input: ResumeScreeningResumeInsertInput): ResumeScreeningResumeRow {
    const now = input.now ?? Date.now()
    this.db
      .prepare(
        `INSERT INTO resume_screening_resumes
           (id, task_id, file_name, file_path, mime_type, size, candidate_name, raw_text,
            resume_info_json, screening_json, interview_json, hr_json, score, recommended,
            status, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                 'pending', NULL, ?, ?)`
      )
      .run(
        input.id,
        input.taskId,
        input.fileName,
        input.filePath,
        input.mimeType ?? null,
        input.size,
        now,
        now
      )
    return this.get(input.id)!
  }

  update(
    id: string,
    input: ResumeScreeningResumeUpdateInput
  ): ResumeScreeningResumeRow | undefined {
    const existing = this.get(id)
    if (!existing) return undefined
    const now = input.now ?? Date.now()
    this.db
      .prepare(
        `UPDATE resume_screening_resumes
         SET status = ?, candidate_name = ?, raw_text = ?, resume_info_json = ?,
             screening_json = ?, interview_json = ?, hr_json = ?, score = ?, recommended = ?,
             error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.status ?? existing.status,
        input.candidateName !== undefined ? input.candidateName : existing.candidate_name,
        input.rawText !== undefined ? input.rawText : existing.raw_text,
        input.resumeInfoJson !== undefined ? input.resumeInfoJson : existing.resume_info_json,
        input.screeningJson !== undefined ? input.screeningJson : existing.screening_json,
        input.interviewJson !== undefined ? input.interviewJson : existing.interview_json,
        input.hrJson !== undefined ? input.hrJson : existing.hr_json,
        input.score !== undefined ? input.score : existing.score,
        input.recommended !== undefined
          ? input.recommended === null
            ? null
            : input.recommended
              ? 1
              : 0
          : existing.recommended,
        input.error !== undefined ? input.error : existing.error,
        now,
        id
      )
    return this.get(id)
  }

  listByTask(taskId: string): ResumeScreeningResumeRow[] {
    return this.db
      .prepare(
        'SELECT * FROM resume_screening_resumes WHERE task_id = ? ORDER BY created_at ASC, id ASC'
      )
      .all(taskId) as ResumeScreeningResumeRow[]
  }

  markUnfinishedAsFailed(taskId: string, error: string, now?: number): number {
    const info = this.db
      .prepare(
        `UPDATE resume_screening_resumes
         SET status = 'failed', error = ?, updated_at = ?
         WHERE task_id = ? AND status IN ('pending', 'running')`
      )
      .run(error, now ?? Date.now(), taskId)
    return info.changes
  }

  getTaskStats(taskId: string): ResumeScreeningTaskStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS succeeded,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                AVG(CASE WHEN status = 'done' AND score IS NOT NULL THEN score END) AS avg_score,
                SUM(CASE WHEN status = 'done' AND recommended = 1 THEN 1 ELSE 0 END) AS recommended_count
         FROM resume_screening_resumes WHERE task_id = ?`
      )
      .get(taskId) as {
      total: number
      succeeded: number | null
      failed: number | null
      avg_score: number | null
      recommended_count: number | null
    }
    return {
      total: row.total,
      succeeded: row.succeeded ?? 0,
      failed: row.failed ?? 0,
      avgScore: row.avg_score ?? null,
      recommendedCount: row.recommended_count ?? 0
    }
  }
}
