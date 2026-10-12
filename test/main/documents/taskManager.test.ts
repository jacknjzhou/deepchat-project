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
    const bindFileDedupeDocument = vi.fn()
    const deleteFileDedupesByTask = vi.fn()
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
        insertDocument: () => ({ id: 'doc-1' }),
        bindFileDedupeDocument,
        deleteFileDedupesByTask
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
    expect(bindFileDedupeDocument).toHaveBeenCalledWith(tasks[0]?.id, 'doc-1')
  })

  it('marks failed tasks with the error message', async () => {
    const updates: Array<{ status: string; error?: string | null }> = []
    const deleteFileDedupesByTask = vi.fn()
    const bindFileDedupeDocument = vi.fn()
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
        insertDocument: () => ({ id: 'doc-1' }),
        bindFileDedupeDocument,
        deleteFileDedupesByTask
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
    expect(deleteFileDedupesByTask).toHaveBeenCalledWith('t0')
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
        insertDocument: () => ({ id: 'doc' }),
        bindFileDedupeDocument: vi.fn(),
        deleteFileDedupesByTask: vi.fn()
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
        insertDocument: () => ({ id: 'doc' }),
        bindFileDedupeDocument: vi.fn(),
        deleteFileDedupesByTask: vi.fn()
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
        insertDocument: () => ({ id: 'doc' }),
        bindFileDedupeDocument: vi.fn(),
        deleteFileDedupesByTask: vi.fn()
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
        insertDocument: () => ({ id: 'doc' }),
        bindFileDedupeDocument: vi.fn(),
        deleteFileDedupesByTask: vi.fn()
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
        insertDocument: () => ({ id: 'doc-1' }),
        bindFileDedupeDocument: vi.fn(),
        deleteFileDedupesByTask: vi.fn()
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

  it('retryTask can override the template for the re-queued task', async () => {
    const failed = makeTask({ id: 't-fail', status: 'failed', error: 'classify failed' })
    const updates: Array<{ status: string; templateId?: string; typeKey?: string | null }> = []
    const extractedTemplates: string[] = []
    // Emulates the sqlite update contract: omitted fields keep their stored value.
    let storedTemplateId = failed.templateId
    const manager = new RecognitionTaskManager({
      repository: {
        insertTasks: () => [],
        getTask: (id) => (id === failed.id ? failed : null),
        updateTask: (id, input) => {
          if (input.templateId !== undefined) {
            storedTemplateId = input.templateId
          }
          updates.push({
            status: input.status,
            templateId: input.templateId,
            typeKey: input.typeKey
          })
          return makeTask({
            id,
            templateId: storedTemplateId,
            status: input.status,
            typeKey: input.typeKey ?? null
          })
        },
        listRecentTasks: () => [],
        listPendingTasks: () => [],
        markRunningTasksFailed: () => {},
        countTaskBatch: () => ({ done: 0, total: 1 }),
        insertDocument: () => ({ id: 'doc-1' }),
        bindFileDedupeDocument: vi.fn(),
        deleteFileDedupesByTask: vi.fn()
      },
      extractor: {
        extract: async (input) => {
          extractedTemplates.push(input.templateId)
          return {
            template: { id: input.templateId, typeKey: 'contract_purchase' },
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
    const retried = manager.retryTask(failed.id, { templateId: 'tpl-contract' })
    expect(retried?.templateId).toBe('tpl-contract')
    // 重置原行时写入新模板并清空上次的分类结果
    expect(updates[0]).toMatchObject({ status: 'pending', templateId: 'tpl-contract' })
    await manager.idle()
    // 重新识别时使用覆盖后的模板，而不是原来的 'auto'
    expect(extractedTemplates).toEqual(['tpl-contract'])
    expect(updates.at(-1)).toMatchObject({ status: 'done', typeKey: 'contract_purchase' })
  })

  it('defaults a missing templateId to the auto classifier', async () => {
    const inserted: Array<{ templateId: string; source: string }> = []
    const manager = new RecognitionTaskManager({
      repository: {
        insertTasks: (inputs) => {
          for (const input of inputs) {
            inserted.push({ templateId: input.templateId, source: input.source })
          }
          return inputs.map((input, i) =>
            makeTask({ id: `t${i}`, templateId: input.templateId, source: input.source })
          )
        },
        updateTask: (id, input) => makeTask({ id, status: input.status }),
        listRecentTasks: () => [],
        listPendingTasks: () => [],
        markRunningTasksFailed: () => {},
        countTaskBatch: () => ({ done: 0, total: 1 }),
        insertDocument: () => ({ id: 'doc' }),
        bindFileDedupeDocument: vi.fn(),
        deleteFileDedupesByTask: vi.fn()
      },
      extractor: {
        extract: async () => ({
          template: { id: 'tpl1', typeKey: 'invoice_special' },
          route: 'text',
          fields: {},
          rawOutput: '',
          durationMs: 1,
          issues: []
        })
      },
      publishTaskUpdated: () => {}
    })
    // Scheduled submissions omit templateId: it must be normalized to 'auto' before
    // the row is written, otherwise the DB binding crashes on undefined.
    manager.submit({ files: [{ path: 'C:\\a.png' }], source: 'scheduled' })
    await manager.idle()
    expect(inserted).toEqual([{ templateId: 'auto', source: 'scheduled' }])
  })

  it('archives a scheduled templateId-less task via auto classification', async () => {
    const extractedTemplateIds: string[] = []
    const insertedDocs: Array<{ templateId: string; source: string; fileUris: string[] }> = []
    // Emulates the sqlite update contract: omitted fields keep their stored value.
    const stored = new Map<string, DocumentTask>()
    const manager = new RecognitionTaskManager({
      repository: {
        insertTasks: (inputs) =>
          inputs.map((input, i) => {
            const task = makeTask({
              id: `t${i}`,
              templateId: input.templateId,
              source: input.source
            })
            stored.set(task.id, task)
            return task
          }),
        updateTask: (id, input) => {
          const existing = stored.get(id)
          const task = makeTask({
            id,
            templateId: existing?.templateId,
            source: existing?.source,
            status: input.status,
            typeKey: input.typeKey ?? null,
            documentId: input.documentId ?? null
          })
          stored.set(id, task)
          return task
        },
        listRecentTasks: () => [],
        listPendingTasks: () => [],
        markRunningTasksFailed: () => {},
        countTaskBatch: () => ({ done: 0, total: 1 }),
        insertDocument: (input) => {
          insertedDocs.push({
            templateId: input.templateId,
            source: input.source,
            fileUris: input.fileUris
          })
          return { id: 'doc-9' }
        },
        bindFileDedupeDocument: vi.fn(),
        deleteFileDedupesByTask: vi.fn()
      },
      extractor: {
        extract: async (input) => {
          extractedTemplateIds.push(input.templateId)
          return {
            template: { id: 'tpl-invoice', typeKey: 'invoice_special' },
            route: 'text',
            fields: { invoice_code: { value: '123', uncertain: false } },
            rawOutput: '',
            durationMs: 1,
            issues: []
          }
        }
      },
      publishTaskUpdated: () => {}
    })
    manager.submit({ files: [{ path: 'C:\\a.png', name: 'a.png' }], source: 'scheduled' })
    await manager.idle()
    // The run chain uses the row's templateId (already normalized to 'auto').
    expect(extractedTemplateIds).toEqual(['auto'])
    // Archiving receives the classified template and the task's source, not an
    // undefined or hardcoded value.
    expect(insertedDocs).toEqual([
      { templateId: 'tpl-invoice', source: 'scheduled', fileUris: ['C:\\a.png'] }
    ])
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
        insertDocument: () => ({ id: 'doc' }),
        bindFileDedupeDocument: vi.fn(),
        deleteFileDedupesByTask: vi.fn()
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
