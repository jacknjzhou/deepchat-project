import { describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import { applyManagedConfig } from '@/managed/apply'
import type { ManagedConfigPayload } from '@/managed/types'

const payload = (overrides: Partial<ManagedConfigPayload> = {}): ManagedConfigPayload => ({
  version: 1,
  providers: [
    {
      id: 'managed-corp-gw',
      key: 'corp-gw',
      name: '企业网关',
      apiType: 'new-api',
      baseProviderId: 'new-api',
      instanceLabel: '企业网关',
      baseUrl: 'https://gw.corp.example.com',
      apiKey: 'sk-x',
      enabled: true
    }
  ],
  defaultProviderId: 'managed-corp-gw',
  agentModels: null,
  documents: null,
  ...overrides
})

const createSettings = (existing: Array<Record<string, unknown>> = []) => {
  const store = [...existing]
  return {
    store,
    getProviders: vi.fn(() => store.map((p) => ({ ...p }))),
    setProvider: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const index = store.findIndex((p) => p.id === id)
      if (index >= 0) store[index] = { ...store[index], ...patch }
      else store.push({ id, ...patch })
    })
  }
}

describe('applyManagedConfig', () => {
  it('inserts a managed instance carrying baseProviderId and instanceLabel', async () => {
    const settings = createSettings()
    const ids = await applyManagedConfig(payload(), settings as never)
    expect(ids).toEqual(['managed-corp-gw'])
    expect(settings.setProvider).toHaveBeenCalledWith(
      'managed-corp-gw',
      expect.objectContaining({
        apiType: 'new-api',
        baseProviderId: 'new-api',
        instanceLabel: '企业网关',
        baseUrl: 'https://gw.corp.example.com',
        apiKey: 'sk-x',
        enable: true,
        custom: false
      })
    )
  })

  it('overwrites an existing managed instance (idempotent refresh)', async () => {
    const settings = createSettings([
      { id: 'managed-corp-gw', name: 'Old', baseUrl: 'https://old', apiKey: 'sk-old' }
    ])
    await applyManagedConfig(payload(), settings as never)
    const entry = settings.store.find((p) => p.id === 'managed-corp-gw') as Record<string, unknown>
    expect(entry.baseUrl).toBe('https://gw.corp.example.com')
    expect(entry.apiKey).toBe('sk-x')
  })

  it('does not touch the builtin new-api entry', async () => {
    const settings = createSettings([
      {
        id: 'new-api',
        name: 'New API',
        apiType: 'new-api',
        baseUrl: 'https://www.newapi.ai',
        apiKey: '',
        enable: false
      }
    ])
    await applyManagedConfig(payload(), settings as never)
    const builtin = settings.store.find((p) => p.id === 'new-api') as Record<string, unknown>
    expect(builtin.apiKey).toBe('')
    expect(builtin.enable).toBe(false)
    expect(settings.store).toHaveLength(2)
  })

  it('does not touch user providers', async () => {
    const settings = createSettings([
      { id: 'my-newapi', name: 'My Gateway', apiType: 'new-api', apiKey: 'sk-mine' }
    ])
    await applyManagedConfig(payload(), settings as never)
    const entry = settings.store.find((p) => p.id === 'my-newapi') as Record<string, unknown>
    expect(entry.apiKey).toBe('sk-mine')
  })

  it('writes enabled=false for disabled managed providers', async () => {
    const settings = createSettings()
    await applyManagedConfig(
      payload({ providers: [{ ...payload().providers[0], enabled: false }] }),
      settings as never
    )
    const entry = settings.store.find((p) => p.id === 'managed-corp-gw') as Record<string, unknown>
    expect(entry.enable).toBe(false)
  })
})
