import { describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import { resolveDocumentsModelSettings } from '@/documents/modelSettings'
import type { ManagedConfigPayload } from '@/managed/types'

const userSettings = {
  textModel: { providerId: 'openai', modelId: 'gpt-4o-mini' },
  visionModel: { providerId: 'openai', modelId: 'gpt-4o' },
  concurrency: 6,
  temperature: 0.7,
  maxTokens: 1024
}

const managed: ManagedConfigPayload = {
  version: 1,
  providers: [],
  defaultProviderId: null,
  agentModels: null,
  documents: {
    textModel: {
      providerId: 'managed-corp-gw',
      modelId: 'deepseek-v3',
      endpointType: 'openai'
    },
    visionModel: { providerId: 'managed-corp-gw', modelId: 'corp-vision' },
    concurrency: 4,
    temperature: null,
    maxTokens: null
  }
}

describe('resolveDocumentsModelSettings', () => {
  it('uses user settings when nothing is managed', () => {
    expect(resolveDocumentsModelSettings(userSettings, null)).toEqual(userSettings)
  })

  it('managed models win and keep endpointType', () => {
    const resolved = resolveDocumentsModelSettings(userSettings, managed)
    expect(resolved.textModel).toEqual({
      providerId: 'managed-corp-gw',
      modelId: 'deepseek-v3',
      endpointType: 'openai'
    })
    expect(resolved.visionModel).toEqual({
      providerId: 'managed-corp-gw',
      modelId: 'corp-vision'
    })
  })

  it('managed concurrency and params win; null means provider default', () => {
    const resolved = resolveDocumentsModelSettings(userSettings, managed)
    expect(resolved.concurrency).toBe(4)
    expect(resolved.temperature).toBeNull()
    expect(resolved.maxTokens).toBeNull()
  })

  it('falls back per field when the managed field is null', () => {
    const partial: ManagedConfigPayload = {
      ...managed,
      documents: { ...managed.documents!, concurrency: null, temperature: 0.2 }
    }
    const resolved = resolveDocumentsModelSettings(userSettings, partial)
    expect(resolved.concurrency).toBe(6)
    expect(resolved.temperature).toBe(0.2)
  })

  it('keeps user value when the managed documents section is absent', () => {
    const resolved = resolveDocumentsModelSettings(userSettings, { ...managed, documents: null })
    expect(resolved).toEqual(userSettings)
  })

  it('falls back to the user model when the managed ref is null', () => {
    const partial: ManagedConfigPayload = {
      ...managed,
      documents: { ...managed.documents!, textModel: null }
    }
    const resolved = resolveDocumentsModelSettings(userSettings, partial)
    expect(resolved.textModel).toEqual(userSettings.textModel)
  })
})
