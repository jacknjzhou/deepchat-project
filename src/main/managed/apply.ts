import type { ManagedConfigPayload } from './types'

export interface ManagedProviderWriter {
  setProvider(id: string, patch: Record<string, unknown>): Promise<void> | void
  removeProvider(id: string): Promise<void> | void
}

/**
 * 把托管配置写入 provider 存储（多实例模式），返回本次托管的 provider id 列表。
 * 幂等：每次启动重复调用只覆盖托管实例，不触碰内置条目与用户自建 provider。
 */
export async function applyManagedConfig(
  config: ManagedConfigPayload,
  writer: ManagedProviderWriter
): Promise<string[]> {
  for (const provider of config.providers) {
    await writer.setProvider(provider.id, {
      id: provider.id,
      name: provider.name,
      apiType: provider.apiType,
      // baseProviderId 实际总有值（apiType 必须命中内置注册表）；此处仅在异常情况下退化为沿用旧值。
      ...(provider.baseProviderId ? { baseProviderId: provider.baseProviderId } : {}),
      instanceLabel: provider.instanceLabel,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      enable: provider.enabled,
      custom: false
    })
  }
  return config.providers.map((provider) => provider.id)
}
