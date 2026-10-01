import { fetchManagedConfig, type ManagedDeviceInfo } from './client'
import { applyManagedConfig, type ManagedProviderWriter } from './apply'
import type { ManagedConfigStore } from './store'
import type { SyncResult } from './types'

export { MANAGED_SETTINGS_KEYS, createManagedConfigStore } from './store'
export { toLocalProviderId } from './types'
export type { ManagedConfigPayload, ManagedConfigMeta, SyncStatus, SyncResult } from './types'

export interface SyncManagedConfigOptions {
  endpoint: string
  device: ManagedDeviceInfo
  store: ManagedConfigStore
  writer: ManagedProviderWriter
  knownProviderTypes: readonly string[]
  builtinIdByApiType: Record<string, string>
  clientVersion?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * 启动时的托管配置同步：拉取 → 缓存 → 应用。
 * 拉取失败保留缓存；服务端明确「无配置/拒绝」则清除托管态。
 */
export async function syncManagedConfig(options: SyncManagedConfigOptions): Promise<SyncResult> {
  const { endpoint, device, store, writer } = options

  if (!endpoint) {
    return { status: 'skipped', config: store.readConfig(), warnings: [] }
  }

  const result = await fetchManagedConfig({
    endpoint,
    device,
    knownProviderTypes: options.knownProviderTypes,
    builtinIdByApiType: options.builtinIdByApiType,
    ...(options.clientVersion ? { clientVersion: options.clientVersion } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  })

  if (result.status === 'unavailable') {
    const cached = store.readConfig()
    if (cached) {
      // 缓存存在：重新应用一次，覆盖被清空或被改动过的托管实例
      const ids = await applyManagedConfig(cached, writer)
      store.writeProviderIds(ids)
    }
    return { status: 'unavailable', config: cached, warnings: result.warnings }
  }

  if (result.status === 'absent' || result.status === 'denied') {
    // 服务端明确「无配置/拒绝」：连同此前写入的托管痕迹一并清除。
    // 务必先读取托管 provider id（清除会把它清空），再逐个 best-effort 删除：
    // 单个失败不阻断其余，失败 id 记入 warnings；最后才清除托管态。
    const previousIds = store.readProviderIds()
    const warnings = [...result.warnings]
    for (const id of previousIds) {
      try {
        await writer.removeProvider(id)
      } catch (error) {
        warnings.push(`failed to remove managed provider ${id}: ${String(error)}`)
      }
    }
    store.writeConfig(null)
    store.writeProviderIds([])
    store.writeMeta(null)
    return { status: result.status, config: null, warnings }
  }

  const config = result.config
  if (!config) {
    return { status: 'unavailable', config: store.readConfig(), warnings: result.warnings }
  }

  const ids = await applyManagedConfig(config, writer)
  store.writeConfig(config)
  store.writeProviderIds(ids)
  store.writeMeta({ fetchedAt: Date.now(), username: device.username, endpoint })
  return { status: 'applied', config, warnings: result.warnings }
}
