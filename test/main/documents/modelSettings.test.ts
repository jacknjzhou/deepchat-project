import { describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import {
  DOCUMENTS_SETTINGS_KEYS,
  DEFAULT_DOCUMENTS_CONCURRENCY,
  migrateDocumentsModelSettings,
  readDocumentsModelSettings,
  validateDocumentsModelRef,
  type DocumentsSettingsStore
} from '@/documents/modelSettings'

function createStore(initial: Record<string, unknown> = {}): DocumentsSettingsStore & {
  data: Record<string, unknown>
} {
  const data: Record<string, unknown> = { ...initial }
  return {
    data,
    getSetting: <T>(key: string) => data[key] as T | undefined,
    setSetting: (key: string, value: unknown) => {
      data[key] = value
    }
  }
}

describe('readDocumentsModelSettings', () => {
  it('returns defaults when keys are absent', () => {
    const store = createStore()
    const settings = readDocumentsModelSettings(store)
    expect(settings).toEqual({
      textModel: null,
      visionModel: null,
      concurrency: DEFAULT_DOCUMENTS_CONCURRENCY,
      temperature: null,
      maxTokens: null
    })
  })

  it('reads stored values and clamps concurrency into 1-10', () => {
    const store = createStore({
      [DOCUMENTS_SETTINGS_KEYS.textModel]: { providerId: 'p1', modelId: 'm1' },
      [DOCUMENTS_SETTINGS_KEYS.visionModel]: { providerId: 'p1', modelId: 'm2' },
      [DOCUMENTS_SETTINGS_KEYS.concurrency]: 99,
      [DOCUMENTS_SETTINGS_KEYS.temperature]: 0.3,
      [DOCUMENTS_SETTINGS_KEYS.maxTokens]: 4096
    })
    const settings = readDocumentsModelSettings(store)
    expect(settings.textModel).toEqual({ providerId: 'p1', modelId: 'm1' })
    expect(settings.visionModel).toEqual({ providerId: 'p1', modelId: 'm2' })
    expect(settings.concurrency).toBe(10)
    expect(settings.temperature).toBe(0.3)
    expect(settings.maxTokens).toBe(4096)
  })

  it('drops malformed model refs', () => {
    const store = createStore({ [DOCUMENTS_SETTINGS_KEYS.textModel]: { providerId: '' } })
    expect(readDocumentsModelSettings(store).textModel).toBeNull()
  })
})

describe('migrateDocumentsModelSettings', () => {
  it('prefills from global defaults once and marks migrated', () => {
    const store = createStore({
      defaultModel: { providerId: 'g1', modelId: 'gm1' },
      defaultVisionModel: { providerId: 'g1', modelId: 'gm2' }
    })
    migrateDocumentsModelSettings(store)
    expect(store.data[DOCUMENTS_SETTINGS_KEYS.textModel]).toEqual({
      providerId: 'g1',
      modelId: 'gm1'
    })
    expect(store.data[DOCUMENTS_SETTINGS_KEYS.visionModel]).toEqual({
      providerId: 'g1',
      modelId: 'gm2'
    })
    expect(store.data[DOCUMENTS_SETTINGS_KEYS.migrated]).toBe(true)
  })

  it('does not overwrite user-cleared refs on rerun', () => {
    const store = createStore({
      [DOCUMENTS_SETTINGS_KEYS.migrated]: true,
      [DOCUMENTS_SETTINGS_KEYS.textModel]: null
    })
    migrateDocumentsModelSettings(store)
    expect(store.data[DOCUMENTS_SETTINGS_KEYS.textModel]).toBeNull()
  })

  it('marks migrated even without global defaults', () => {
    const store = createStore()
    migrateDocumentsModelSettings(store)
    expect(store.data[DOCUMENTS_SETTINGS_KEYS.migrated]).toBe(true)
  })
})

describe('validateDocumentsModelRef', () => {
  const providers = [
    { id: 'p1', enable: true },
    { id: 'p2', enable: false }
  ]
  const getProviderModels = (providerId: string) =>
    providerId === 'p1' ? [{ id: 'm1' }, { id: 'm2' }] : []

  it('returns null for valid ref', () => {
    expect(
      validateDocumentsModelRef({ providerId: 'p1', modelId: 'm1' }, providers, getProviderModels)
    ).toBeNull()
  })
  it('detects missing provider', () => {
    expect(
      validateDocumentsModelRef({ providerId: 'px', modelId: 'm1' }, providers, getProviderModels)
    ).toBe('providerMissing')
  })
  it('detects disabled provider', () => {
    expect(
      validateDocumentsModelRef({ providerId: 'p2', modelId: 'm1' }, providers, getProviderModels)
    ).toBe('providerDisabled')
  })
  it('detects missing model', () => {
    expect(
      validateDocumentsModelRef({ providerId: 'p1', modelId: 'mx' }, providers, getProviderModels)
    ).toBe('modelMissing')
  })
  it('returns null for empty ref', () => {
    expect(validateDocumentsModelRef(null, providers, getProviderModels)).toBeNull()
  })
})
