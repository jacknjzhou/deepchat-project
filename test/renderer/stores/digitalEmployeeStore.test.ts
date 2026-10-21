import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// test/setup.renderer.ts 全局 stub 了 pinia（defineStore 返回 {}），须还原真实实现
vi.mock('pinia', async () => vi.importActual<typeof import('pinia')>('pinia'))

import { useDigitalEmployeeStore } from '../../../src/renderer/src/stores/digitalEmployeeStore'
import type { DigitalEmployee } from '../../../src/shared/contracts/routes/digitalEmployee.routes'

vi.mock('../../../src/renderer/api/DigitalEmployeeClient', () => ({
  createDigitalEmployeeClient: () => ({
    list: vi.fn().mockResolvedValue({
      employees: [
        { id: 'finance', name: '财务', role: '财务', description: '', avatar: null, capabilities: [], greeting: null, systemPrompt: 'p', sops: [], knowledgeBaseIds: [], skillIds: [], tools: [], enabled: true, updatedAt: '2026-10-21' },
        { id: 'hr', name: '人事', role: '人事', description: '', avatar: null, capabilities: [], greeting: null, systemPrompt: 'p', sops: [], knowledgeBaseIds: [], skillIds: [], tools: [], enabled: false, updatedAt: '2026-10-21' }
      ],
      fetchedAt: '2026-10-21T00:00:00.000Z'
    }),
    get: vi.fn()
  })
}))

vi.mock('../../../src/renderer/api/ConfigClient', () => ({
  createConfigClient: () => ({
    getSetting: vi.fn().mockResolvedValue(null),
    setSetting: vi.fn().mockResolvedValue(undefined)
  })
}))

const makeEmployee = (id: string): DigitalEmployee => ({
  id, name: id, role: id, description: '', avatar: null, capabilities: [], greeting: null,
  systemPrompt: 'p', sops: [], knowledgeBaseIds: [], skillIds: [], tools: [], enabled: true,
  updatedAt: '2026-10-21'
})

describe('digitalEmployeeStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('fetchEmployees loads list and filters enabledEmployees', async () => {
    const store = useDigitalEmployeeStore()
    await store.fetchEmployees()
    expect(store.employees).toHaveLength(2)
    expect(store.enabledEmployees.map((e) => e.id)).toEqual(['finance'])
  })

  it('toggleFavorite persists and toggles', async () => {
    const store = useDigitalEmployeeStore()
    await store.toggleFavorite('finance')
    expect(store.favorites).toEqual(['finance'])
    await store.toggleFavorite('finance')
    expect(store.favorites).toEqual([])
  })

  it('bindSession records binding and employeeForSession resolves', async () => {
    const store = useDigitalEmployeeStore()
    await store.fetchEmployees()
    await store.bindSession('session-1', 'finance')
    expect(store.employeeForSession('session-1')?.id).toBe('finance')
    expect(store.employeeForSession('unknown')).toBeNull()
  })
})
