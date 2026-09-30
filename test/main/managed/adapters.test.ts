import { describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import { createManagedAgentSettingsWriter, createManagedProviderWriter } from '@/managed/adapters'
import type { ProviderSettings } from '@/provider/settings'
import type { AgentSettings } from '@/agent/settings'

const createProviderSettings = (existingId?: string) => {
  const updateProviderAtomic = vi.fn()
  const addProviderAtomic = vi.fn()
  const settings = {
    getProviderById: vi.fn((id: string) => (id === existingId ? { id } : undefined)),
    updateProviderAtomic,
    addProviderAtomic
  } as unknown as ProviderSettings
  return { settings, updateProviderAtomic, addProviderAtomic }
}

describe('createManagedProviderWriter', () => {
  it('updates the target provider when the id already exists', async () => {
    const { settings, updateProviderAtomic, addProviderAtomic } =
      createProviderSettings('managed-a')
    const writer = createManagedProviderWriter(settings)
    const patch = { id: 'managed-a', name: 'A' }

    await writer.setProvider('managed-a', patch)

    expect(updateProviderAtomic).toHaveBeenCalledWith('managed-a', patch)
    expect(addProviderAtomic).not.toHaveBeenCalled()
  })

  it('adds the target provider when the id does not exist', async () => {
    const { settings, updateProviderAtomic, addProviderAtomic } = createProviderSettings()
    const writer = createManagedProviderWriter(settings)
    const patch = { id: 'managed-b', name: 'B' }

    await writer.setProvider('managed-b', patch)

    expect(addProviderAtomic).toHaveBeenCalledWith(patch)
    expect(updateProviderAtomic).not.toHaveBeenCalled()
  })
})

const createAgentSettings = (config: Record<string, unknown> | null) => {
  const updateDeepChatAgent = vi.fn(async () => null)
  const settings = {
    getDeepChatAgentConfig: vi.fn(async () => config),
    updateDeepChatAgent
  } as unknown as AgentSettings
  return { settings, updateDeepChatAgent }
}

describe('createManagedAgentSettingsWriter', () => {
  it('returns null when the agent config is absent', async () => {
    const { settings } = createAgentSettings(null)
    const writer = createManagedAgentSettingsWriter(settings)

    await expect(writer.getDeepChatAgentConfig('deepchat')).resolves.toBeNull()
  })

  it('returns the agent config when present', async () => {
    const config = { chatModel: { providerId: 'p', modelId: 'm' } }
    const { settings } = createAgentSettings(config)
    const writer = createManagedAgentSettingsWriter(settings)

    await expect(writer.getDeepChatAgentConfig('deepchat')).resolves.toEqual(config)
  })

  it('wraps the flat patch as { config } when updating the agent', async () => {
    const { settings, updateDeepChatAgent } = createAgentSettings({})
    const writer = createManagedAgentSettingsWriter(settings)
    const patch = { chatModel: { providerId: 'p', modelId: 'm' } }

    await writer.updateDeepChatAgent('deepchat', patch)

    expect(updateDeepChatAgent).toHaveBeenCalledWith('deepchat', { config: patch })
  })
})
