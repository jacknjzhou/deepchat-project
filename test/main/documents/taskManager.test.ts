import { describe, expect, it, vi } from 'vitest'
import { RecognitionTaskManager } from '@/documents/taskManager'
import type { DocumentTask } from '@/documents/repository'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

function makeTask(overrides: Partial<DocumentTask> = {}): DocumentTask {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    batchId: 'b1',
    filePath: 'C:\\a.png',
    fileName: 'a.png',
    templateId: 'auto',
    source: 'manual',
    status: 'pending',
    typeKey: null,
    documentId: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('RecognitionTaskManager', () => {
  it('creates tasks and returns immediately, then processes to done', async () => {
    const updates: Array<{
      id: string
      status: string
      typeKey?: string | null
      documentId?: string | null
    }> = []
    const published: string[] = []
    const manager = new RecognitionTaskManager({
      repository: {
        insertTasks: (inputs) =>
          inputs.map((input, i) =>
            makeTask({ id: `t${i}`, filePath: input.filePath, fileName: input.fileName })
          ),
        updateTask: (id, input) => {
          updates.push({
            id,
            status: input.status,
            typeKey: input.typeKey,
            documentId: input.documentId
          })
          return makeTask({
            id,
            status: input.status,
            typeKey: input.typeKey ?? null,
            documentId: input.documentId ?? null
          })
        },
        listRecentTasks: () => [],
        listPendingTasks: () => [],
        markRunningTasksFailed: () => {},
        countTaskBatch: (batchId) => ({ done: 0, total: batchId === 'b1' ? 1 : 0 }),
        insertDocument: () => ({ id: 'doc-1' })
      },
      extractor: {
        extract: async () => ({
          template: { id: 'tpl1', typeKey: 'invoice_special' },
          route: 'vision',
          fields: {},
          rawOutput: '',
          durationMs: 1,
          issues: []
        })
      },
      publishTaskUpdated: ({ task }) => published.push(task.status)
    })
    const tasks = manager.submit({
      files: [{ path: 'C:\\a.png', name: 'a.png' }],
      templateId: 'auto',
      source: 'manual'
    })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.status).toBe('pending') // 立即返回
    await manager.idle()
    expect(updates.map((u) => u.status)).toEqual(['running', 'done'])
    expect(updates[1]?.typeKey).toBe('invoice_special')
    expect(updates[1]?.documentId).toBe('doc-1')
    expect(published).toEqual(['running', 'done'])
  })

  it('marks failed tasks with the error message', async () => {
    const updates: Array<{ status: string; error?: string | null }> = []
    const manager = new RecognitionTaskManager({
      repository: {
        insertTasks: (inputs) => inputs.map((input, i) => makeTask({ id: `t${i}` })),
        updateTask: (id, input) => {
          updates.push({ status: input.status, error: input.error ?? null })
          return makeTask({ id, status: input.status, error: input.error ?? null })
        },
        listRecentTasks: () => [],
        listPendingTasks: () => [],
        markRunningTasksFailed: () => {},
        countTaskBatch: () => ({ done: 1, total: 1 }),
        insertDocument: () => ({ id: 'doc-1' })
      },
      extractor: {
        extract: async () => {
          throw new Error('auto classification failed')
        }
      },
      publishTaskUpdated: () => {}
    })
    manager.submit({ files: [{ path: 'C:\\a.png' }], templateId: 'auto', source: 'manual' })
    await manager.idle()
    expect(updates.map((u) => u.status)).toEqual(['running', 'failed'])
    expect(updates[1]?.error).toBe('auto classification failed')
  })

  it('processes with bounded concurrency', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const manager = new RecognitionTaskManager({
      repository: {
        insertTasks: (inputs) => inputs.map((input, i) => makeTask({ id: `t${i}` })),
        updateTask: (id, input) => makeTask({ id, status: input.status }),
        listRecentTasks: () => [],
        listPendingTasks: () => [],
        markRunningTasksFailed: () => {},
        countTaskBatch: () => ({ done: 0, total: 4 }),
        insertDocument: () => ({ id: 'doc' })
      },
      extractor: {
        extract: async () => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 5))
          inFlight -= 1
          return {
            template: { id: 'tpl1', typeKey: 'k' },
            route: 'vision',
            fields: {},
            rawOutput: '',
            durationMs: 1,
            issues: []
          }
        }
      },
      publishTaskUpdated: () => {},
      concurrency: 2
    })
    manager.submit({
      files: [{ path: 'C:\\1' }, { path: 'C:\\2' }, { path: 'C:\\3' }, { path: 'C:\\4' }],
      templateId: 'auto',
      source: 'manual'
    })
    await manager.idle()
    expect(maxInFlight).toBe(2)
  })

  it('defaults to concurrency 4 when not specified', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const manager = new RecognitionTaskManager({
      repository: {
        insertTasks: (inputs) => inputs.map((input, i) => makeTask({ id: `t${i}` })),
        updateTask: (id, input) => makeTask({ id, status: input.status }),
        listRecentTasks: () => [],
        listPendingTasks: () => [],
        markRunningTasksFailed: () => {},
        countTaskBatch: () => ({ done: 0, total: 6 }),
        insertDocument: () => ({ id: 'doc' })
      },
      extractor: {
        extract: async () => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 5))
          inFlight -= 1
          return {
            template: { id: 'tpl1', typeKey: 'k' },
            route: 'vision',
            fields: {},
            rawOutput: '',
            durationMs: 1,
            issues: []
          }
        }
      },
      publishTaskUpdated: () => {}
    })
    manager.submit({
      files: [
        { path: 'C:\\1' },
        { path: 'C:\\2' },
        { path: 'C:\\3' },
        { path: 'C:\\4' },
        { path: 'C:\\5' },
        { path: 'C:\\6' }
      ],
      templateId: 'auto',
      source: 'manual'
    })
    // submit 同步 pump：6 个任务在默认并发 4 下恰好启动 4 个，峰值确定地等于 4（> 2）
    expect(maxInFlight).toBe(4)
    await manager.idle()
    expect(maxInFlight).toBe(4)
  })

  it('resumePending fails running tasks and re-queues pending ones', async () => {
    const stored = [
      makeTask({ id: 'running-1', status: 'running' }),
      makeTask({ id: 'pending-1', status: 'pending' })
    ]
    let markedFailed = false
    const processed: string[] = []
    const manager = new RecognitionTaskManager({
      repository: {
        insertTasks: () => [],
        updateTask: (id, input) => makeTask({ id, status: input.status }),
        listRecentTasks: () => [],
        listPendingTasks: () => stored.filter((t) => t.status === 'pending'),
        markRunningTasksFailed: () => {
          markedFailed = true
        },
        countTaskBatch: () => ({ done: 0, total: 1 }),
        insertDocument: () => ({ id: 'doc' })
      },
      extractor: {
        extract: async (input) => {
          processed.push(input.templateId)
          return {
            template: { id: 'tpl1', typeKey: 'k' },
            route: 'vision',
            fields: {},
            rawOutput: '',
            durationMs: 1,
            issues: []
          }
        }
      },
      publishTaskUpdated: () => {}
    })
    await manager.resumePending()
    await manager.idle()
    expect(markedFailed).toBe(true)
    expect(processed).toEqual(['auto'])
  })

  it('keeps processing the queue after a task fails', async () => {
    const statuses: string[] = []
    let calls = 0
    const manager = new RecognitionTaskManager({
      repository: {
        insertTasks: (inputs) => inputs.map((input, i) => makeTask({ id: `t${i}` })),
        updateTask: (id, input) => {
          statuses.push(`${id}:${input.status}`)
          return makeTask({ id, status: input.status })
        },
        listRecentTasks: () => [],
        listPendingTasks: () => [],
        markRunningTasksFailed: () => {},
        countTaskBatch: () => ({ done: 0, total: 2 }),
        insertDocument: () => ({ id: 'doc' })
      },
      extractor: {
        extract: async () => {
          calls += 1
          if (calls === 1) {
            throw new Error('first fails')
          }
          return {
            template: { id: 'tpl1', typeKey: 'k' },
            route: 'vision',
            fields: {},
            rawOutput: '',
            durationMs: 1,
            issues: []
          }
        }
      },
      publishTaskUpdated: () => {}
    })
    manager.submit({
      files: [{ path: 'C:\\1' }, { path: 'C:\\2' }],
      templateId: 'auto',
      source: 'manual'
    })
    await manager.idle()
    // 默认并发足以同步启动 t0/t1（两个 running 先入列），t0 的 rejection 续体作为先入队
    // 的微任务先于 t1 的 resolve 续体执行，因此顺序是确定的。
    expect(statuses).toEqual(['t0:running', 't1:running', 't0:failed', 't1:done'])
    expect(calls).toBe(2)
  })

  it('retryTask resets the failed row and reprocesses it in place', async () => {
    const failed = makeTask({ id: 't-fail', status: 'failed', error: 'boom' })
    const updates: Array<{
      id: string
      status: string
      typeKey?: string | null
      documentId?: string | null
      error?: string | null
    }> = []
    let insertCalls = 0
    const published: string[] = []
    const manager = new RecognitionTaskManager({
      repository: {
        insertTasks: (inputs) => {
          insertCalls += 1
          return inputs.map((input, i) =>
            makeTask({ id: `t${i}`, filePath: input.filePath, fileName: input.fileName })
          )
        },
        getTask: (id) => (id === failed.id ? failed : null),
        updateTask: (id, input) => {
          updates.push({
            id,
            status: input.status,
            typeKey: input.typeKey,
            documentId: input.documentId,
            error: input.error ?? null
          })
          return makeTask({
            id,
            status: input.status,
            typeKey: input.typeKey ?? null,
            documentId: input.documentId ?? null,
            error: input.error ?? null
          })
        },
        listRecentTasks: () => [],
        listPendingTasks: () => [],
        markRunningTasksFailed: () => {},
        countTaskBatch: () => ({ done: 0, total: 1 }),
        insertDocument: () => ({ id: 'doc-1' })
      },
      extractor: {
        extract: async () => ({
          template: { id: 'tpl1', typeKey: 'invoice_special' },
          route: 'vision',
          fields: {},
          rawOutput: '',
          durationMs: 1,
          issues: []
        })
      },
      publishTaskUpdated: ({ task }) => published.push(task.status)
    })
    const retried = manager.retryTask(failed.id)
    expect(retried?.id).toBe(failed.id)
    expect(retried?.status).toBe('pending')
    // 不新建任务行，仅重置原行
    expect(insertCalls).toBe(0)
    expect(updates[0]).toMatchObject({
      id: failed.id,
      status: 'pending',
      typeKey: null,
      documentId: null,
      error: null
    })
    await manager.idle()
    expect(updates.map((u) => u.status)).toEqual(['pending', 'running', 'done'])
    expect(published).toEqual(['pending', 'running', 'done'])
  })

  it('retryTask ignores tasks that are not failed or missing', async () => {
    const done = makeTask({ id: 't-done', status: 'done' })
    const manager = new RecognitionTaskManager({
      repository: {
        insertTasks: () => [],
        getTask: (id) => (id === done.id ? done : null),
        updateTask: () => {
          throw new Error('should not update')
        },
        listRecentTasks: () => [],
        listPendingTasks: () => [],
        markRunningTasksFailed: () => {},
        countTaskBatch: () => ({ done: 0, total: 0 }),
        insertDocument: () => ({ id: 'doc' })
      },
      extractor: {
        extract: async () => {
          throw new Error('should not extract')
        }
      },
      publishTaskUpdated: () => {}
    })
    expect(manager.retryTask(done.id)).toBeNull()
    expect(manager.retryTask('missing')).toBeNull()
  })
})
