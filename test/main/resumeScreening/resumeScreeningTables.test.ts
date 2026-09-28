import { describe, expect, it } from 'vitest'

const sqliteModule = await import('better-sqlite3-multiple-ciphers').catch(() => null)
const tasksModule = sqliteModule
  ? await import('@/resumeScreening/data/tables/resumeScreeningTasks').catch(() => null)
  : null
const resumesModule = sqliteModule
  ? await import('@/resumeScreening/data/tables/resumeScreeningResumes').catch(() => null)
  : null

const Database = sqliteModule?.default
const DatabaseCtor = Database!
const TasksTableCtor = tasksModule?.ResumeScreeningTasksTable!
const ResumesTableCtor = resumesModule?.ResumeScreeningResumesTable!

let sqliteAvailable = false
if (Database) {
  try {
    const smokeDb = new Database(':memory:')
    smokeDb.close()
    sqliteAvailable = true
  } catch {
    sqliteAvailable = false
  }
}

const describeIfSqlite = sqliteAvailable && TasksTableCtor ? describe : describe.skip
const describeIfSqliteResumes = sqliteAvailable && ResumesTableCtor ? describe : describe.skip

describeIfSqlite('ResumeScreeningTasksTable', () => {
  const makeDb = () => {
    const db = new DatabaseCtor(':memory:')
    new TasksTableCtor(db).createTable()
    return db
  }

  const makeInput = (
    overrides?: Partial<Parameters<InstanceType<typeof TasksTableCtor>['insert']>[0]>
  ) => ({
    jdSource: 'text' as const,
    jdText: '高级前端工程师',
    configJson: JSON.stringify({
      generateExplanation: true,
      includeRawText: false,
      maxConcurrency: 3
    }),
    providerId: 'openai',
    modelId: 'gpt-4o',
    total: 2,
    createdByName: '张三',
    createdByEmail: 'zhang@example.com',
    now: 1000,
    ...overrides
  })

  it('creates table and inserts a queued task', () => {
    const db = makeDb()
    const table = new TasksTableCtor(db)
    const row = table.insert(makeInput())
    expect(row.id).toBeTruthy()
    expect(row.status).toBe('queued')
    expect(row.succeeded).toBe(0)
    expect(row.failed).toBe(0)
    expect(row.recommended_count).toBe(0)
    expect(row.avg_score).toBeNull()
    expect(row.created_at).toBe(1000)
    db.close()
  })

  it('updates fields preserving unspecified ones', () => {
    const db = makeDb()
    const table = new TasksTableCtor(db)
    const created = table.insert(makeInput())
    const updated = table.update(created.id, {
      status: 'running',
      startedAt: 2000,
      jdAnalysisJson: JSON.stringify({ responsibilities: ['a'], requirements: [], preferred: [] }),
      now: 3000
    })
    expect(updated?.status).toBe('running')
    expect(updated?.started_at).toBe(2000)
    expect(updated?.jd_analysis_json).toContain('responsibilities')
    expect(updated?.total).toBe(2)
    expect(updated?.created_at).toBe(1000)
    db.close()
  })

  it('lists recent and active tasks', () => {
    const db = makeDb()
    const table = new TasksTableCtor(db)
    const a = table.insert(makeInput({ now: 100 }))
    table.insert(makeInput({ now: 200 }))
    table.update(a.id, { status: 'running' })
    expect(table.listRecent(10)).toHaveLength(2)
    expect(table.listRecent(10)[0].created_at).toBe(200)
    expect(table.listActive()).toHaveLength(2)
    expect(table.listActive()[0].id).toBe(a.id)
    db.close()
  })

  it('clears fields with explicit null and handles missing ids', () => {
    const db = makeDb()
    const table = new TasksTableCtor(db)
    const created = table.insert(makeInput())
    const withAnalysis = table.update(created.id, {
      jdAnalysisJson: JSON.stringify({ responsibilities: ['a'], requirements: [], preferred: [] }),
      avgScore: 88
    })
    expect(withAnalysis?.jd_analysis_json).toContain('responsibilities')
    expect(withAnalysis?.avg_score).toBe(88)
    const cleared = table.update(created.id, { jdAnalysisJson: null, avgScore: null })
    expect(cleared?.jd_analysis_json).toBeNull()
    expect(cleared?.avg_score).toBeNull()
    expect(cleared?.status).toBe('queued')
    expect(table.update('nonexistent', { status: 'running' })).toBeUndefined()
    db.close()
  })
})

describeIfSqliteResumes('ResumeScreeningResumesTable', () => {
  const makeDb = () => {
    const db = new DatabaseCtor(':memory:')
    new TasksTableCtor(db).createTable()
    new ResumesTableCtor(db).createTable()
    return db
  }

  const makeResumeInput = (overrides?: Record<string, unknown>) => ({
    id: 'resume-1',
    taskId: 'task-1',
    fileName: '张三.pdf',
    filePath: 'C:\\tmp\\resume-1.pdf',
    mimeType: 'application/pdf',
    size: 1024,
    now: 1000,
    ...overrides
  })

  it('inserts with explicit id and lists by task', () => {
    const db = makeDb()
    const table = new ResumesTableCtor(db)
    const row = table.insert(makeResumeInput())
    expect(row.id).toBe('resume-1')
    expect(row.status).toBe('pending')
    table.insert(makeResumeInput({ id: 'resume-2', now: 200 }))
    expect(table.listByTask('task-1')).toHaveLength(2)
    expect(table.listByTask('task-2')).toHaveLength(0)
    db.close()
  })

  it('updates report fields and boolean recommended', () => {
    const db = makeDb()
    const table = new ResumesTableCtor(db)
    table.insert(makeResumeInput())
    const updated = table.update('resume-1', {
      status: 'done',
      candidateName: '张三',
      screeningJson: JSON.stringify({
        score: 88,
        recommended: true,
        conclusion: 'ok',
        strengths: []
      }),
      score: 88,
      recommended: true,
      now: 2000
    })
    expect(updated?.status).toBe('done')
    expect(updated?.recommended).toBe(1)
    expect(updated?.score).toBe(88)
    const cleared = table.update('resume-1', { candidateName: null, score: null })
    expect(cleared?.candidate_name).toBeNull()
    expect(cleared?.score).toBeNull()
    expect(cleared?.status).toBe('done')
    expect(table.update('nonexistent', { status: 'done' })).toBeUndefined()
    db.close()
  })

  it('computes task stats and marks unfinished as failed', () => {
    const db = makeDb()
    const table = new ResumesTableCtor(db)
    table.insert(makeResumeInput({ id: 'r1' }))
    table.insert(makeResumeInput({ id: 'r2' }))
    table.insert(makeResumeInput({ id: 'r3' }))
    table.update('r1', { status: 'done', score: 80, recommended: true })
    table.update('r2', { status: 'done', score: 90, recommended: false })
    // r3 保持 pending
    const stats = table.getTaskStats('task-1')
    expect(stats.total).toBe(3)
    expect(stats.succeeded).toBe(2)
    expect(stats.failed).toBe(0)
    expect(stats.avgScore).toBe(85)
    expect(stats.recommendedCount).toBe(1)
    const changed = table.markUnfinishedAsFailed('task-1', '已取消', 3000)
    expect(changed).toBe(1)
    expect(table.get('r3')?.status).toBe('failed')
    expect(table.get('r3')?.error).toBe('已取消')
    db.close()
  })
})
