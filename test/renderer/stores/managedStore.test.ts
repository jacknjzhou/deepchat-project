import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getStatusMock = vi.fn()

vi.mock('pinia', async () => vi.importActual<typeof import('pinia')>('pinia'))

vi.mock('@api/ManagedClient', () => ({
  createManagedClient: () => ({ getStatus: getStatusMock, refresh: vi.fn() })
}))

import { useManagedStore } from '@/stores/managedStore'

describe('managedStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('loads status into state', async () => {
    getStatusMock.mockResolvedValue({
      managed: true,
      providerIds: ['managed-corp-gw'],
      documentsLocked: true,
      username: 'zhangsan',
      endpoint: 'https://cfg',
      fetchedAt: 1
    })
    const store = useManagedStore()
    await store.refresh()
    expect(store.managed).toBe(true)
    expect(store.documentsLocked).toBe(true)
    expect(store.isManagedProvider('managed-corp-gw')).toBe(true)
    expect(store.isManagedProvider('new-api')).toBe(false)
    expect(store.isManagedProvider('my-newapi')).toBe(false)
  })

  it('defaults to unmanaged when the call fails', async () => {
    getStatusMock.mockRejectedValue(new Error('boom'))
    const store = useManagedStore()
    await expect(store.refresh()).rejects.toThrow()
    expect(store.managed).toBe(false)
  })
})
