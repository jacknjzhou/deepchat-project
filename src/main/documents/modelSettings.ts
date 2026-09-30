import { z } from 'zod'

export interface DocumentsModelRef {
  providerId: string
  modelId: string
}

export interface DocumentsSettingsStore {
  getSetting<T>(key: string): T | undefined
  setSetting(key: string, value: unknown): void
}

export const DOCUMENTS_SETTINGS_KEYS = {
  textModel: 'documents.textModel',
  visionModel: 'documents.visionModel',
  concurrency: 'documents.concurrency',
  temperature: 'documents.temperature',
  maxTokens: 'documents.maxTokens',
  migrated: 'documents.settingsMigrated'
} as const

export const DEFAULT_DOCUMENTS_CONCURRENCY = 4

const modelRefSchema = z.object({ providerId: z.string().min(1), modelId: z.string().min(1) })

export interface DocumentsModelSettings {
  textModel: DocumentsModelRef | null
  visionModel: DocumentsModelRef | null
  concurrency: number
  temperature: number | null
  maxTokens: number | null
}

const clampConcurrency = (value: number): number => Math.min(10, Math.max(1, Math.round(value)))

const sanitizeRef = (value: unknown): DocumentsModelRef | null => {
  const parsed = modelRefSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function readDocumentsModelSettings(store: DocumentsSettingsStore): DocumentsModelSettings {
  const concurrency = store.getSetting<number>(DOCUMENTS_SETTINGS_KEYS.concurrency)
  const temperature = store.getSetting<number>(DOCUMENTS_SETTINGS_KEYS.temperature)
  const maxTokens = store.getSetting<number>(DOCUMENTS_SETTINGS_KEYS.maxTokens)
  return {
    textModel: sanitizeRef(store.getSetting(DOCUMENTS_SETTINGS_KEYS.textModel)),
    visionModel: sanitizeRef(store.getSetting(DOCUMENTS_SETTINGS_KEYS.visionModel)),
    concurrency: clampConcurrency(
      typeof concurrency === 'number' ? concurrency : DEFAULT_DOCUMENTS_CONCURRENCY
    ),
    temperature: typeof temperature === 'number' ? temperature : null,
    maxTokens: typeof maxTokens === 'number' ? maxTokens : null
  }
}

export function migrateDocumentsModelSettings(store: DocumentsSettingsStore): void {
  if (store.getSetting<boolean>(DOCUMENTS_SETTINGS_KEYS.migrated)) return
  if (!store.getSetting(DOCUMENTS_SETTINGS_KEYS.textModel)) {
    const textFallback = sanitizeRef(store.getSetting('defaultModel'))
    if (textFallback) store.setSetting(DOCUMENTS_SETTINGS_KEYS.textModel, textFallback)
  }
  if (!store.getSetting(DOCUMENTS_SETTINGS_KEYS.visionModel)) {
    const visionFallback = sanitizeRef(store.getSetting('defaultVisionModel'))
    if (visionFallback) store.setSetting(DOCUMENTS_SETTINGS_KEYS.visionModel, visionFallback)
  }
  store.setSetting(DOCUMENTS_SETTINGS_KEYS.migrated, true)
}

export type DocumentsConfigInvalidReason = 'providerMissing' | 'providerDisabled' | 'modelMissing'

export interface DocumentsProviderLike {
  id: string
  enable: boolean
}

export function validateDocumentsModelRef(
  ref: DocumentsModelRef | null,
  providers: DocumentsProviderLike[],
  getProviderModels: (providerId: string) => Array<{ id: string }>
): DocumentsConfigInvalidReason | null {
  if (!ref) return null
  const provider = providers.find((item) => item.id === ref.providerId)
  if (!provider) return 'providerMissing'
  if (!provider.enable) return 'providerDisabled'
  if (!getProviderModels(ref.providerId).some((model) => model.id === ref.modelId))
    return 'modelMissing'
  return null
}
