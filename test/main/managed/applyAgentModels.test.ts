import { describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import { applyManagedAgentModels } from '@/managed/applyAgentModels'
import type { ManagedConfigPayload, ManagedProvider } from '@/managed/types'

const provider = (id: string, key = id): ManagedProvider => ({
  id,
  key,
  name: key,
  apiType: 'new-api',
  baseProviderId: 'new-api',
  instanceLabel: key,
  baseUrl: 'https://gw',
  apiKey: 'sk',
  enabled: true
})

const config = (overrides: Partial<ManagedConfigPayload> = {}): ManagedConfigPayload => ({
  version: 1,
  providers: [provider('managed-a'), provider('managed-b')],
  defaultProviderId: 'managed-a',
  agentModels: null,
  documents: null,
  ...overrides
})

const createLookup = (byProvider: Record<string, string[]>) => ({
  listModelIds: vi.fn(async (providerId: string) => byProvider[providerId] ?? [])
})

const createAgentSettings = (initial: Record<string, unknown> = {}) => {
  let current = { ...initial }
  return {
    getCurrent: () => current,
    api: {
      getDeepChatAgentConfig: vi.fn(async () => ({ ...current })),
      updateDeepChatAgent: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
        current = { ...current, ...patch }
        return current
      })
    }
  }
}

const createStore = (applied: Record<string, unknown> = {}) => {
  let stored = { ...applied }
  return {
    getApplied: () => stored,
    api: {
      readAgentModelApplied: () => stored as never,
      writeAgentModelApplied: (next: Record<string, unknown>) => {
        stored = next
      }
    }
  }
}

describe('applyManagedAgentModels', () => {
  it('selects the managed provider whose model list contains the id', async () => {
    const agent = createAgentSettings()
    const store = createStore()
    const lookup = createLookup({
      'managed-a': ['other-model'],
      'managed-b': ['deepseek-v3', 'gpt-4o']
    })
    await applyManagedAgentModels(
      config({ agentModels: { chat: 'deepseek-v3' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.api.updateDeepChatAgent).toHaveBeenCalledWith('deepchat', {
      defaultModelPreset: { providerId: 'managed-b', modelId: 'deepseek-v3' }
    })
  })

  it('prefers the anchor provider when several offer the same id', async () => {
    const agent = createAgentSettings()
    const store = createStore()
    const lookup = createLookup({
      'managed-a': ['deepseek-v3'],
      'managed-b': ['deepseek-v3']
    })
    await applyManagedAgentModels(
      config({ agentModels: { chat: 'deepseek-v3' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.api.updateDeepChatAgent).toHaveBeenCalledWith('deepchat', {
      defaultModelPreset: { providerId: 'managed-a', modelId: 'deepseek-v3' }
    })
  })

  it('falls back to provider order when the anchor does not offer the id', async () => {
    const agent = createAgentSettings()
    const store = createStore()
    const lookup = createLookup({ 'managed-a': ['nope'], 'managed-b': ['deepseek-v3'] })
    await applyManagedAgentModels(
      config({ agentModels: { chat: 'deepseek-v3' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.api.updateDeepChatAgent).toHaveBeenCalledWith('deepchat', {
      defaultModelPreset: { providerId: 'managed-b', modelId: 'deepseek-v3' }
    })
  })

  it('overwrites an existing user value on the first sync for that key', async () => {
    const userPick = { providerId: 'my-newapi', modelId: 'my-model' }
    const agent = createAgentSettings({ defaultModelPreset: userPick })
    const store = createStore()
    const lookup = createLookup({ 'managed-a': ['deepseek-v3'], 'managed-b': [] })
    await applyManagedAgentModels(
      config({ agentModels: { chat: 'deepseek-v3' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.getCurrent().defaultModelPreset).toEqual({
      providerId: 'managed-a',
      modelId: 'deepseek-v3'
    })
    expect(store.getApplied().chat).toEqual({ providerId: 'managed-a', modelId: 'deepseek-v3' })
  })

  it('skips ids no managed provider offers and keeps the user value', async () => {
    const userPick = { providerId: 'my-newapi', modelId: 'my-model' }
    const agent = createAgentSettings({ visionModel: userPick })
    const store = createStore()
    const lookup = createLookup({ 'managed-a': [], 'managed-b': [] })
    const result = await applyManagedAgentModels(
      config({ agentModels: { vision: 'ghost-model' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.api.updateDeepChatAgent).not.toHaveBeenCalled()
    expect(agent.getCurrent().visionModel).toEqual(userPick)
    expect(result.warnings.some((w) => w.includes('ghost-model'))).toBe(true)
  })

  it('follows a new managed value when the user has not changed it', async () => {
    const agent = createAgentSettings({
      defaultModelPreset: { providerId: 'managed-a', modelId: 'old' }
    })
    const store = createStore({ chat: { providerId: 'managed-a', modelId: 'old' } })
    const lookup = createLookup({ 'managed-a': ['new'], 'managed-b': [] })
    await applyManagedAgentModels(
      config({ agentModels: { chat: 'new' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.getCurrent().defaultModelPreset).toEqual({
      providerId: 'managed-a',
      modelId: 'new'
    })
  })

  it('keeps the user value when it differs from the last applied managed value', async () => {
    const userPick = { providerId: 'my-newapi', modelId: 'my-model' }
    const agent = createAgentSettings({ visionModel: userPick })
    const store = createStore({ vision: { providerId: 'managed-a', modelId: 'v1' } })
    const lookup = createLookup({ 'managed-a': ['v2'], 'managed-b': [] })
    await applyManagedAgentModels(
      config({ agentModels: { vision: 'v2' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.getCurrent().visionModel).toEqual(userPick)
    // applied 记录的是「上一次写入的托管值」，用户值从不写入，因此仍保留原托管值。
    expect(store.getApplied().vision).toEqual({ providerId: 'managed-a', modelId: 'v1' })
  })

  it('keeps the user value across consecutive syncs', async () => {
    const userPick = { providerId: 'my-newapi', modelId: 'my-model' }
    const agent = createAgentSettings({ visionModel: userPick })
    const store = createStore({ vision: { providerId: 'managed-a', modelId: 'v1' } })
    const lookup = createLookup({ 'managed-a': ['v2'], 'managed-b': [] })

    await applyManagedAgentModels(
      config({ agentModels: { vision: 'v2' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    await applyManagedAgentModels(
      config({ agentModels: { vision: 'v2' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )

    expect(agent.getCurrent().visionModel).toEqual(userPick)
  })

  it('preserves other fields on the model object when following a new managed value', async () => {
    const agent = createAgentSettings({
      defaultModelPreset: { providerId: 'managed-a', modelId: 'old', temperature: 0.3 }
    })
    const store = createStore({ chat: { providerId: 'managed-a', modelId: 'old' } })
    const lookup = createLookup({ 'managed-a': ['new'], 'managed-b': [] })
    await applyManagedAgentModels(
      config({ agentModels: { chat: 'new' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.getCurrent().defaultModelPreset).toEqual({
      providerId: 'managed-a',
      modelId: 'new',
      temperature: 0.3
    })
  })

  it('keeps going when one provider fails to list its models', async () => {
    const agent = createAgentSettings()
    const store = createStore()
    const lookup = {
      listModelIds: vi.fn(async (providerId: string) => {
        if (providerId === 'managed-a') throw new Error('boom')
        return ['deepseek-v3']
      })
    }
    const result = await applyManagedAgentModels(
      config({ agentModels: { chat: 'deepseek-v3' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.api.updateDeepChatAgent).toHaveBeenCalledWith('deepchat', {
      defaultModelPreset: { providerId: 'managed-b', modelId: 'deepseek-v3' }
    })
    expect(result.warnings.some((w) => w.includes('managed-a'))).toBe(true)
  })

  it('does nothing when the payload has no agentModels', async () => {
    const agent = createAgentSettings()
    const store = createStore()
    const lookup = createLookup({ 'managed-a': ['m1'] })
    const result = await applyManagedAgentModels(
      config({ agentModels: null }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.api.updateDeepChatAgent).not.toHaveBeenCalled()
    expect(lookup.listModelIds).not.toHaveBeenCalled()
    expect(result.applied).toEqual({})
  })

  it('does nothing when there is no managed provider to match against', async () => {
    const agent = createAgentSettings()
    const store = createStore()
    const lookup = createLookup({})
    const result = await applyManagedAgentModels(
      config({ providers: [], defaultProviderId: null, agentModels: { chat: 'm1' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.api.updateDeepChatAgent).not.toHaveBeenCalled()
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})
