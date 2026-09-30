import { describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import { syncManagedConfig } from '@/managed'
import type { ManagedConfigStore } from '@/managed/store'
import type { ManagedConfigPayload } from '@/managed/types'

const payload: ManagedConfigPayload = {
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
  agentModels: { chat: 'deepseek-v3' },
  documents: {
    textModel: { providerId: 'managed-corp-gw', modelId: 'deepseek-v3', endpointType: 'openai' },
    visionModel: { providerId: 'managed-corp-gw', modelId: 'gpt-4o' },
    concurrency: 4,
    temperature: null,
    maxTokens: null
  }
}

const createStore = (initial?: { config?: ManagedConfigPayload | null }) => {
  let config = initial?.config ?? null
  let meta: unknown = null
  let ids: string[] = []
  let agentModelApplied: Record<string, unknown> = {}
  const store: ManagedConfigStore = {
    readConfig: () => config,
    writeConfig: (next) => {
      config = next
    },
    readMeta: () => meta as never,
    writeMeta: (next) => {
      meta = next
    },
    readProviderIds: () => ids,
    writeProviderIds: (next) => {
      ids = next
    },
    readAgentModelApplied: () => agentModelApplied as never,
    writeAgentModelApplied: (next) => {
      agentModelApplied = next as Record<string, unknown>
    }
  }
  return { store, getConfig: () => config, getIds: () => ids, getMeta: () => meta }
}

const baseOptions = {
  endpoint: 'https://cfg',
  device: { username: 'u', domain: 'd', hostname: 'h', sid: 's' },
  knownProviderTypes: ['new-api'],
  builtinIdByApiType: { 'new-api': 'new-api' }
}

const appliedBody = {
  version: 1,
  providers: [
    { key: 'corp-gw', name: '企业网关', apiType: 'new-api', baseUrl: 'https://gw', apiKey: 'sk-x' }
  ]
}

describe('syncManagedConfig', () => {
  it('skips entirely when no endpoint configured', async () => {
    const store = createStore()
    const fetchImpl = vi.fn()
    const result = await syncManagedConfig({
      ...baseOptions,
      endpoint: '',
      store: store.store,
      writer: { setProvider: vi.fn() } as never,
      fetchImpl
    })
    expect(result.status).toBe('skipped')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(store.getConfig()).toBeNull()
  })

  it('persists config, ids and meta on applied', async () => {
    const store = createStore()
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(appliedBody), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    const result = await syncManagedConfig({
      ...baseOptions,
      store: store.store,
      writer: { setProvider: vi.fn(async () => {}) } as never,
      fetchImpl
    })
    expect(result.status).toBe('applied')
    expect(store.getIds()).toEqual(['managed-corp-gw'])
    expect(store.getConfig()?.providers).toHaveLength(1)
    expect(store.getMeta()).toMatchObject({ username: 'u', endpoint: 'https://cfg' })
  })

  it('keeps cached config and managed mode when fetch is unavailable', async () => {
    const store = createStore({ config: payload })
    const result = await syncManagedConfig({
      ...baseOptions,
      store: store.store,
      writer: { setProvider: vi.fn(async () => {}) } as never,
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline'))
    })
    expect(result.status).toBe('unavailable')
    expect(store.getConfig()).toEqual(payload)
  })

  it('re-applies cached config when unavailable so instances survive a wiped db', async () => {
    const store = createStore({ config: payload })
    const setProvider = vi.fn(async () => {})
    await syncManagedConfig({
      ...baseOptions,
      store: store.store,
      writer: { setProvider } as never,
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline'))
    })
    expect(setProvider).toHaveBeenCalledWith(
      'managed-corp-gw',
      expect.objectContaining({ apiKey: 'sk-x', baseProviderId: 'new-api' })
    )
  })

  it('clears managed state on absent', async () => {
    const store = createStore({ config: payload })
    const result = await syncManagedConfig({
      ...baseOptions,
      store: store.store,
      writer: { setProvider: vi.fn() } as never,
      fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    })
    expect(result.status).toBe('absent')
    expect(store.getConfig()).toBeNull()
    expect(store.getIds()).toEqual([])
    expect(store.getMeta()).toBeNull()
  })

  it('clears managed state on denied', async () => {
    const store = createStore({ config: payload })
    const result = await syncManagedConfig({
      ...baseOptions,
      store: store.store,
      writer: { setProvider: vi.fn() } as never,
      fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    })
    expect(result.status).toBe('denied')
    expect(store.getConfig()).toBeNull()
  })
})
