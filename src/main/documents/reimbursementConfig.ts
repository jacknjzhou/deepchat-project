import { reimbursementConfigSchema, type ReimbursementConfig } from '@shared/contracts/routes'
import type { DocumentsSettingsStore } from './modelSettings'
import presetJson from './presetReimbursementConfig.json'

export const REIMBURSEMENT_SETTINGS_KEY = 'documents.reimbursementConfig'

const DEFAULT_CONFIG: ReimbursementConfig = reimbursementConfigSchema.parse(presetJson)

export function defaultReimbursementConfig(): ReimbursementConfig {
  return structuredClone(DEFAULT_CONFIG)
}

export function normalizeReimbursementConfig(value: unknown): ReimbursementConfig | null {
  const parsed = reimbursementConfigSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** 惰性 seed：settings 键不存在或损坏时写入默认配置并返回；写入后与用户配置无异，不再被覆盖 */
export function readReimbursementConfig(store: DocumentsSettingsStore): ReimbursementConfig {
  const existing = normalizeReimbursementConfig(store.getSetting(REIMBURSEMENT_SETTINGS_KEY))
  if (existing) return existing
  const seeded = defaultReimbursementConfig()
  store.setSetting(REIMBURSEMENT_SETTINGS_KEY, seeded)
  return seeded
}

export function writeReimbursementConfig(
  store: DocumentsSettingsStore,
  config: ReimbursementConfig
): ReimbursementConfig {
  const normalized = reimbursementConfigSchema.parse(config)
  store.setSetting(REIMBURSEMENT_SETTINGS_KEY, normalized)
  return normalized
}
