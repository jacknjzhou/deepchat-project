import { z } from 'zod'
import { isNewApiEndpointType, type NewApiEndpointType } from '@shared/model'
import type { ManagedConfigPayload } from '../managed/types'

export interface DocumentsModelRef {
  providerId: string
  modelId: string
  /** new-api 等聚合网关的协议端点；托管模型引用可能携带，缺省由客户端推断 */
  endpointType?: NewApiEndpointType
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

const modelRefSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  endpointType: z.string().optional()
})

export interface DocumentsModelSettings {
  textModel: DocumentsModelRef | null
  visionModel: DocumentsModelRef | null
  concurrency: number
  temperature: number | null
  maxTokens: number | null
}

const clampConcurrency = (value: number): number =>
  Number.isFinite(value)
    ? Math.min(10, Math.max(1, Math.round(value)))
    : DEFAULT_DOCUMENTS_CONCURRENCY

const sanitizeRef = (value: unknown): DocumentsModelRef | null => {
  const parsed = modelRefSchema.safeParse(value)
  if (!parsed.success) return null
  const { endpointType, ...rest } = parsed.data
  return isNewApiEndpointType(endpointType) ? { ...rest, endpointType } : rest
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

export class DocumentsModelConfigError extends Error {
  readonly reason: DocumentsConfigInvalidReason
  readonly ref: DocumentsModelRef
  constructor(reason: DocumentsConfigInvalidReason, ref: DocumentsModelRef) {
    // 稳定前缀码，渲染端 documentsTaskErrors.ts 按此映射本地化文案
    super(`[documents.${reason}:${ref.providerId}|${ref.modelId}] documents model config invalid`)
    this.name = 'DocumentsModelConfigError'
    this.reason = reason
    this.ref = ref
  }
}

/**
 * 计算 documents 生效设置：documents 段存在即视为企业锁定该功能。
 *
 * - 模型引用与并发：托管值优先，字段为 null 时回退到用户值（并发不可为 null）。
 * - temperature / maxTokens：以托管值为准，null 表示不传参、走服务商默认。
 *
 * documents 段为 null 表示企业未锁定，完全沿用用户设置。
 */
export function resolveDocumentsModelSettings<T extends DocumentsModelSettings>(
  userSettings: T,
  managed: ManagedConfigPayload | null
): T {
  const managedDocuments = managed?.documents
  if (!managedDocuments) return userSettings

  return {
    ...userSettings,
    textModel: managedDocuments.textModel ?? userSettings.textModel,
    visionModel: managedDocuments.visionModel ?? userSettings.visionModel,
    concurrency: managedDocuments.concurrency ?? userSettings.concurrency,
    temperature: managedDocuments.temperature,
    maxTokens: managedDocuments.maxTokens
  }
}
