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
})
