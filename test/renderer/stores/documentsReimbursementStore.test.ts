import { describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDocumentsStore } from '@/stores/documents'

// The renderer setup mocks a lightweight pinia without setActivePinia; restore the real one.
vi.mock('pinia', async () => vi.importActual<typeof import('pinia')>('pinia'))

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
    reimbursementExport: vi.fn(async () => ({ canceled: true }))
  }
}

describe('documents store reimbursement actions', () => {
  it('loads and saves config', async () => {
    setActivePinia(createPinia())
    const store = useDocumentsStore()
    const client = makeFakeClient()
    const config = await store.loadReimbursementConfig(client as never)
    expect(config.categories.length).toBe(1)
    expect(store.reimbursementConfig).toEqual(minimalConfig)
    await store.saveReimbursementConfig(config, client as never)
    expect(client.reimbursementSetConfig).toHaveBeenCalled()
    expect(store.reimbursementConfig).toEqual(config)
  })

  it('loads tree with archive filter and refreshes after override', async () => {
    setActivePinia(createPinia())
    const store = useDocumentsStore()
    const client = makeFakeClient()
    await store.loadReimbursementTree(client as never)
    expect(store.reimbursementTree).toEqual({ tree: [], unassigned: [], summary: [] })
    expect(store.reimbursementIsLoading).toBe(false)
    await store.setReimbursementOverride('doc-1', 'cat-a', client as never)
    expect(client.reimbursementSetOverride).toHaveBeenCalledWith('doc-1', 'cat-a')
    expect(client.reimbursementTree).toHaveBeenCalledTimes(2)
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
})
