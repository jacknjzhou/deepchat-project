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

const createStore = (initial?: { config?: ManagedConfigPayload | null; ids?: string[] }) => {
  let config = initial?.config ?? null
  let meta: unknown = null
  let ids: string[] = initial?.ids ?? []
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

const createWriter = () => ({
  setProvider: vi.fn(async () => {}),
  removeProvider: vi.fn(async () => {})
})

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
      writer: createWriter() as never,
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
      writer: createWriter() as never,
      fetchImpl
    })
    expect(result.status).toBe('applied')
    expect(store.getIds()).toEqual(['managed-corp-gw'])
    expect(store.getConfig()?.providers).toHaveLength(1)
    expect(store.getMeta()).toMatchObject({ username: 'u', endpoint: 'https://cfg' })
  })

  it('does not remove providers on applied', async () => {
    const store = createStore({ ids: ['managed-corp-gw'] })
    const writer = createWriter()
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(appliedBody), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    await syncManagedConfig({
      ...baseOptions,
      store: store.store,
      writer: writer as never,
      fetchImpl
    })
    expect(writer.removeProvider).not.toHaveBeenCalled()
  })

  it('keeps cached config and managed mode when fetch is unavailable', async () => {
    const store = createStore({ config: payload })
    const result = await syncManagedConfig({
      ...baseOptions,
      store: store.store,
      writer: createWriter() as never,
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline'))
    })
    expect(result.status).toBe('unavailable')
    expect(store.getConfig()).toEqual(payload)
  })

  it('does not remove providers when the fetch is unavailable', async () => {
    const store = createStore({ config: payload, ids: ['managed-corp-gw'] })
    const writer = createWriter()
    await syncManagedConfig({
      ...baseOptions,
      store: store.store,
      writer: writer as never,
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline'))
    })
    expect(writer.removeProvider).not.toHaveBeenCalled()
  })

  it('re-applies cached config when unavailable so instances survive a wiped db', async () => {
    const store = createStore({ config: payload })
    const writer = createWriter()
    await syncManagedConfig({
      ...baseOptions,
      store: store.store,
      writer: writer as never,
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline'))
    })
    expect(writer.setProvider).toHaveBeenCalledWith(
      'managed-corp-gw',
      expect.objectContaining({ apiKey: 'sk-x', baseProviderId: 'new-api' })
    )
  })

  it('removes previously written managed providers on absent', async () => {
    const store = createStore({ config: payload, ids: ['managed-corp-gw', 'managed-other'] })
    const writer = createWriter()
    const result = await syncManagedConfig({
      ...baseOptions,
      store: store.store,
      writer: writer as never,
      fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    })
    expect(result.status).toBe('absent')
    expect(writer.removeProvider).toHaveBeenCalledTimes(2)
    expect(writer.removeProvider).toHaveBeenCalledWith('managed-corp-gw')
    expect(writer.removeProvider).toHaveBeenCalledWith('managed-other')
    expect(store.getConfig()).toBeNull()
    expect(store.getIds()).toEqual([])
    expect(store.getMeta()).toBeNull()
  })

  it('clears managed state on denied', async () => {
    const store = createStore({ config: payload, ids: ['managed-corp-gw'] })
    const writer = createWriter()
    const result = await syncManagedConfig({
      ...baseOptions,
      store: store.store,
      writer: writer as never,
      fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    })
    expect(result.status).toBe('denied')
    expect(writer.removeProvider).toHaveBeenCalledWith('managed-corp-gw')
    expect(store.getConfig()).toBeNull()
    expect(store.getIds()).toEqual([])
  })

  it('collects a warning and keeps clearing when one provider removal fails', async () => {
    const store = createStore({ config: payload, ids: ['managed-a', 'managed-b'] })
    const writer = createWriter()
    writer.removeProvider.mockImplementation(async (id: string) => {
      if (id === 'managed-a') throw new Error('boom')
    })
    const result = await syncManagedConfig({
      ...baseOptions,
      store: store.store,
      writer: writer as never,
      fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    })
    expect(writer.removeProvider).toHaveBeenCalledWith('managed-a')
    expect(writer.removeProvider).toHaveBeenCalledWith('managed-b')
    expect(result.warnings.some((w) => w.includes('managed-a'))).toBe(true)
    expect(store.getIds()).toEqual([])
  })

  it('forwards timeoutMs to the fetch request signal', async () => {
    const store = createStore()
    let observedSignal: AbortSignal | undefined
    const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      observedSignal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        )
      })
    }) as unknown as typeof fetch

    const result = await syncManagedConfig({
      ...baseOptions,
      store: store.store,
      writer: createWriter() as never,
      timeoutMs: 20,
      fetchImpl
    })

    expect(result.status).toBe('unavailable')
    expect(observedSignal?.aborted).toBe(true)
  })
})
