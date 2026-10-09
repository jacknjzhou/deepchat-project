import type { SettingsStore } from '../config/settingsStore'
import type { ManagedAgentModels, ManagedConfigMeta, ManagedConfigPayload } from './types'

export const MANAGED_SETTINGS_KEYS = {
  config: 'managed.config',
  meta: 'managed.meta',
  providerIds: 'managed.providerIds',
  agentModelApplied: 'managed.agentModelApplied'
} as const

export interface ManagedConfigStore {
  readConfig(): ManagedConfigPayload | null
  writeConfig(config: ManagedConfigPayload | null): void
  readMeta(): ManagedConfigMeta | null
  writeMeta(meta: ManagedConfigMeta | null): void
  readProviderIds(): string[]
  writeProviderIds(ids: string[]): void
  /** 上一次写入内置 Agent 的托管模型值，用于判定「用户是否改过」 */
  readAgentModelApplied(): Partial<ManagedAgentModels>
  writeAgentModelApplied(applied: Partial<ManagedAgentModels>): void
}

export function createManagedConfigStore(settings: SettingsStore): ManagedConfigStore {
  return {
    readConfig: () =>
      settings.get<ManagedConfigPayload | null>(MANAGED_SETTINGS_KEYS.config) ?? null,
    writeConfig: (config) => settings.set(MANAGED_SETTINGS_KEYS.config, config),
    readMeta: () => settings.get<ManagedConfigMeta | null>(MANAGED_SETTINGS_KEYS.meta) ?? null,
    writeMeta: (meta) => settings.set(MANAGED_SETTINGS_KEYS.meta, meta),
    readProviderIds: () => settings.get<string[]>(MANAGED_SETTINGS_KEYS.providerIds) ?? [],
    writeProviderIds: (ids) => settings.set(MANAGED_SETTINGS_KEYS.providerIds, ids),
    readAgentModelApplied: () =>
      settings.get<Partial<ManagedAgentModels>>(MANAGED_SETTINGS_KEYS.agentModelApplied) ?? {},
    writeAgentModelApplied: (applied) =>
      settings.set(MANAGED_SETTINGS_KEYS.agentModelApplied, applied)
  }
}
