import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getStatusMock = vi.fn()
const refreshMock = vi.fn()

// test/setup.renderer.ts 全局 mock 了 pinia，这里恢复真实实现以便使用 setActivePinia/defineStore
vi.mock('pinia', async () => vi.importActual<typeof import('pinia')>('pinia'))

vi.mock('@api/ManagedClient', () => ({
  createManagedClient: () => ({ getStatus: getStatusMock, refresh: refreshMock })
}))

import { useManagedStore } from '@/stores/managedStore'

const status = (overrides: Record<string, unknown> = {}) => ({
  managed: true,
  providerIds: ['managed-corp-gw'],
  documentsLocked: true,
  username: 'zhangsan',
  endpoint: 'https://cfg',
  fetchedAt: 1,
  documents: null,
  ...overrides
})

describe('managedStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('loads the cached status into state', async () => {
    const documents = {
      textModel: { providerId: 'managed-corp-gw', modelId: 'deepseek-v3', endpointType: 'openai' },
      visionModel: { providerId: 'managed-corp-gw', modelId: 'gpt-4o' },
      concurrency: 8,
      temperature: 0.7,
      maxTokens: 2048
    }
    getStatusMock.mockResolvedValue(status({ documents }))
    const store = useManagedStore()
    await store.load()
    expect(getStatusMock).toHaveBeenCalledTimes(1)
    expect(refreshMock).not.toHaveBeenCalled()
    expect(store.managed).toBe(true)
    expect(store.documentsLocked).toBe(true)
    expect(store.documents).toEqual(documents)
    expect(store.username).toBe('zhangsan')
    expect(store.endpoint).toBe('https://cfg')
    expect(store.loading).toBe(false)
    expect(store.isManagedProvider('managed-corp-gw')).toBe(true)
    expect(store.isManagedProvider('new-api')).toBe(false)
    expect(store.isManagedProvider('my-newapi')).toBe(false)
  })

  it('refreshes through the refresh route and updates state', async () => {
    refreshMock.mockResolvedValue(
      status({ providerIds: ['managed-other'], documentsLocked: false, managed: true })
    )
    const store = useManagedStore()
    await store.refreshConfig()
    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(getStatusMock).not.toHaveBeenCalled()
    expect(store.providerIds).toEqual(['managed-other'])
    expect(store.documentsLocked).toBe(false)
    expect(store.loading).toBe(false)
  })

  it('keeps the last known state and does not reject when the call fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    getStatusMock.mockResolvedValue(status())
    const store = useManagedStore()
    await store.load()

    refreshMock.mockRejectedValue(new Error('boom'))
    await expect(store.refreshConfig()).resolves.toBeUndefined()
    expect(store.managed).toBe(true)
    expect(store.providerIds).toEqual(['managed-corp-gw'])
    expect(store.documentsLocked).toBe(true)
    expect(store.username).toBe('zhangsan')
    expect(store.loading).toBe(false)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('stays at the defaults and does not reject when the first load fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    getStatusMock.mockRejectedValue(new Error('boom'))
    const store = useManagedStore()
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.managed).toBe(false)
    expect(store.documentsLocked).toBe(false)
    expect(store.loading).toBe(false)
    expect(errorSpy).toHaveBeenCalled()
  })
})
