import { flushPromises } from '@vue/test-utils'
import { toRaw } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDocumentsStore } from '@/stores/documents'
import type { DocumentRecord } from '@shared/documents'

// The renderer setup mocks a lightweight pinia without setActivePinia; restore the real one.
vi.mock('pinia', async () => vi.importActual<typeof import('pinia')>('pinia'))

// handleTaskUpdated triggers loadReimbursementTree() without an explicit client,
// which resolves to documentsApi from '@api/documentTasks'; mock it here.
const defaultApi = vi.hoisted(() => ({
  reimbursementTree: vi.fn(async () => ({ tree: [], unassigned: [], summary: [] })),
  stats: vi.fn(async () => ({ stats: [] })),
  listDocuments: vi.fn(async () => ({ documents: [], total: 0 }))
}))
vi.mock('@api/documentTasks', () => ({ documentsApi: defaultApi }))

const minimalConfig = {
  version: 1 as const,
  categories: [
    { id: 'cat-a', name: '会议费', requiredMaterials: [], linkedTypeKeys: [], sortOrder: 1 }
  ],
  personFieldKeys: ['buyer_name'],
  dateFieldKeys: ['invoice_date'],
  amountFieldKeys: ['total_amount'],
  dateGrouping: 'month' as const
}

function makeFakeClient() {
  return {
    reimbursementGetConfig: vi.fn(async () => ({ config: minimalConfig })),
    reimbursementSetConfig: vi.fn(async (config: unknown) => ({ config })),
    reimbursementTree: vi.fn(async () => ({ tree: [], unassigned: [], summary: [] })),
    reimbursementSetOverride: vi.fn(async () => ({ document: null })),
    reimbursementSetGroupOverride: vi.fn(async () => ({ document: null })),
    reimbursementExport: vi.fn(async () => ({ canceled: true }))
  }
}

// Minimal archive row: the reimbursement set actions only match rows by id.
const archiveRecord = (id: string, overrides: Partial<DocumentRecord> = {}): DocumentRecord =>
  ({
    id,
    reimbursementOverride: null,
    reimbursementGroupOverride: null,
    ...overrides
  }) as DocumentRecord

describe('documents store reimbursement actions', () => {
  it('loads and saves config', async () => {
    setActivePinia(createPinia())
    const store = useDocumentsStore()
    const client = makeFakeClient()
    const config = await store.loadReimbursementConfig(client as never)
    expect(config.categories.length).toBe(1)
    expect(store.reimbursementConfig).toEqual(minimalConfig)
    const saved = await store.saveReimbursementConfig(config, client as never)
    expect(saved).toEqual(config)
    expect(client.reimbursementSetConfig).toHaveBeenCalledWith(config)
    expect(store.reimbursementConfig).toEqual(config)
  })

  it('loads tree with archive filter and refreshes after override', async () => {
    setActivePinia(createPinia())
    const store = useDocumentsStore()
    const client = makeFakeClient()
    store.archiveFilter.status = 'confirmed'
    store.archiveFilter.dateFrom = 100
    store.archiveFilter.dateTo = 200
    await store.loadReimbursementTree(client as never)
    expect(client.reimbursementTree).toHaveBeenCalledWith({
      status: 'confirmed',
      dateFrom: 100,
      dateTo: 200
    })
    expect(store.reimbursementTree).toEqual({ tree: [], unassigned: [], summary: [] })
    expect(store.reimbursementIsLoading).toBe(false)
    await store.setReimbursementOverride('doc-1', 'cat-a', client as never)
    expect(client.reimbursementSetOverride).toHaveBeenCalledWith('doc-1', 'cat-a')
    expect(client.reimbursementTree).toHaveBeenCalledTimes(2)
  })

  it('setReimbursementGroupOverride invokes client and reloads tree', async () => {
    setActivePinia(createPinia())
    const store = useDocumentsStore()
    const client = makeFakeClient()
    await store.loadReimbursementTree(client as never)
    await store.setReimbursementGroupOverride('doc-1', 'grp-a', client as never)
    expect(client.reimbursementSetGroupOverride).toHaveBeenCalledWith('doc-1', 'grp-a')
    expect(client.reimbursementTree).toHaveBeenCalledTimes(2)
  })

  it('setReimbursementGroupOverride(null) clears grouping', async () => {
    setActivePinia(createPinia())
    const store = useDocumentsStore()
    const client = makeFakeClient()
    await store.setReimbursementGroupOverride('doc-1', null, client as never)
    expect(client.reimbursementSetGroupOverride).toHaveBeenCalledWith('doc-1', null)
    expect(client.reimbursementTree).toHaveBeenCalledTimes(1)
  })

  it('setReimbursementOverride returns the record and replaces the archive row in place', async () => {
    setActivePinia(createPinia())
    const store = useDocumentsStore()
    const client = makeFakeClient()
    const other = archiveRecord('doc-1')
    const stale = archiveRecord('doc-2')
    const updated = archiveRecord('doc-2', { reimbursementOverride: 'cat-a' })
    client.reimbursementSetOverride.mockResolvedValueOnce({ document: updated })
    store.archiveDocuments.push(other, stale)
    const result = await store.setReimbursementOverride('doc-2', 'cat-a', client as never)
    expect(result).toBe(updated)
    expect(store.archiveDocuments).toHaveLength(2)
    expect(toRaw(store.archiveDocuments[0])).toBe(other)
    expect(toRaw(store.archiveDocuments[1])).toBe(updated)
  })

  it('setReimbursementGroupOverride returns the record and replaces the archive row in place', async () => {
    setActivePinia(createPinia())
    const store = useDocumentsStore()
    const client = makeFakeClient()
    const other = archiveRecord('doc-1')
    const stale = archiveRecord('doc-2')
    const updated = archiveRecord('doc-2', { reimbursementGroupOverride: 'grp-1' })
    client.reimbursementSetGroupOverride.mockResolvedValueOnce({ document: updated })
    store.archiveDocuments.push(other, stale)
    const result = await store.setReimbursementGroupOverride('doc-2', 'grp-1', client as never)
    expect(result).toBe(updated)
    expect(store.archiveDocuments).toHaveLength(2)
    expect(toRaw(store.archiveDocuments[0])).toBe(other)
    expect(toRaw(store.archiveDocuments[1])).toBe(updated)
  })

  it('reimbursement set actions never insert rows absent from archiveDocuments', async () => {
    setActivePinia(createPinia())
    const store = useDocumentsStore()
    const client = makeFakeClient()
    const other = archiveRecord('doc-1')
    client.reimbursementSetOverride.mockResolvedValueOnce({
      document: archiveRecord('doc-x', { reimbursementOverride: 'cat-a' })
    })
    client.reimbursementSetGroupOverride.mockResolvedValueOnce({
      document: archiveRecord('doc-x', { reimbursementGroupOverride: 'grp-1' })
    })
    store.archiveDocuments.push(other)
    const overrideResult = await store.setReimbursementOverride('doc-x', 'cat-a', client as never)
    const groupResult = await store.setReimbursementGroupOverride('doc-x', 'grp-1', client as never)
    expect(overrideResult?.id).toBe('doc-x')
    expect(groupResult?.id).toBe('doc-x')
    expect(store.archiveDocuments).toEqual([other])
  })

  it('exportReimbursementPackage passes the archive filter through', async () => {
    setActivePinia(createPinia())
    const store = useDocumentsStore()
    const client = makeFakeClient()
    store.archiveFilter.status = 'confirmed'
    store.archiveFilter.dateFrom = 100
    store.archiveFilter.dateTo = 200
    const result = await store.exportReimbursementPackage(client as never)
    expect(client.reimbursementExport).toHaveBeenCalledWith({
      status: 'confirmed',
      dateFrom: 100,
      dateTo: 200
    })
    expect(result).toEqual({ canceled: true })
  })

  it('sets load error key when tree request fails', async () => {
    setActivePinia(createPinia())
    const store = useDocumentsStore()
    const client = makeFakeClient()
    client.reimbursementTree.mockRejectedValueOnce(new Error('boom'))
    await store.loadReimbursementTree(client as never)
    expect(store.reimbursementLoadError).toBe('settings.documents.reimbursement.loadFailed')
    expect(store.reimbursementIsLoading).toBe(false)
  })

  it('loadReimbursementTree drops stale responses and keeps the latest tree', async () => {
    setActivePinia(createPinia())
    const store = useDocumentsStore()
    const client = makeFakeClient()
    let resolveSlow!: (value: unknown) => void
    client.reimbursementTree.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSlow = resolve
        })
    )
    client.reimbursementTree.mockResolvedValueOnce({
      tree: [{ total: 1 }],
      unassigned: [],
      summary: []
    })
    const stale = store.loadReimbursementTree(client as never)
    const fresh = store.loadReimbursementTree(client as never)
    await fresh
    resolveSlow({ tree: [{ total: 99 }], unassigned: [], summary: [] })
    await stale
    expect(store.reimbursementTree).toEqual({ tree: [{ total: 1 }], unassigned: [], summary: [] })
    expect(store.reimbursementIsLoading).toBe(false)
    expect(store.reimbursementLoadError).toBe(null)
  })

  it('refreshes the reimbursement tree once on batch completion when already loaded', async () => {
    vi.useFakeTimers()
    try {
      setActivePinia(createPinia())
      const store = useDocumentsStore()
      const client = makeFakeClient()
      await store.loadReimbursementTree(client as never)
      expect(client.reimbursementTree).toHaveBeenCalledTimes(1)
      store.handleTaskUpdated({ id: 't1', status: 'done' } as never)
      store.handleTaskUpdated({ id: 't2', status: 'done' } as never)
      await vi.advanceTimersByTimeAsync(300)
      await flushPromises()
      expect(defaultApi.reimbursementTree).toHaveBeenCalledTimes(1)
      expect(store.reimbursementTree).toEqual({ tree: [], unassigned: [], summary: [] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not load the reimbursement tree on task completion when never loaded', async () => {
    vi.useFakeTimers()
    try {
      setActivePinia(createPinia())
      const store = useDocumentsStore()
      store.handleTaskUpdated({ id: 't2', status: 'done' } as never)
      await vi.advanceTimersByTimeAsync(300)
      await flushPromises()
      expect(defaultApi.reimbursementTree).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
