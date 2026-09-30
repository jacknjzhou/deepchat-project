import {
  AGENT_MODEL_KEYS,
  MANAGED_AGENT_MODEL_FIELDS,
  type ManagedAgentModels,
  type ManagedConfigPayload,
  type ManagedModelRef
} from './types'

export interface ManagedAgentSettingsWriter {
  getDeepChatAgentConfig(agentId: string): Promise<Record<string, unknown> | null>
  updateDeepChatAgent(agentId: string, patch: Record<string, unknown>): Promise<unknown>
}

export interface ManagedAgentAppliedStore {
  readAgentModelApplied(): Partial<ManagedAgentModels>
  writeAgentModelApplied(applied: Partial<ManagedAgentModels>): void
}

/** 读取某 provider 当前可用的模型 id 列表（调用方接 providerSettings.getProviderModels） */
export interface ManagedProviderModelLookup {
  listModelIds(providerId: string): string[] | Promise<string[]>
}

export interface ApplyManagedAgentModelsResult {
  applied: Partial<ManagedAgentModels>
  warnings: string[]
}

function sameRef(a: unknown, b: unknown): boolean {
  if (!a || !b) return false
  const left = a as { providerId?: unknown; modelId?: unknown }
  const right = b as { providerId?: unknown; modelId?: unknown }
  return left.providerId === right.providerId && left.modelId === right.modelId
}

/** 匹配优先级：锚点 provider 最前，其余按下发顺序 */
function orderedProviderIds(config: ManagedConfigPayload): string[] {
  const ids = config.providers.map((provider) => provider.id)
  const anchor = config.defaultProviderId
  if (!anchor || !ids.includes(anchor)) return ids
  return [anchor, ...ids.filter((id) => id !== anchor)]
}

/**
 * 按「模型列表匹配 + 默认值跟随、用户优先」把托管模型默认值写入内置 Agent 配置。
 * 匹配不到的 id 被跳过并记入 warnings，保持用户当前值。
 */
export async function applyManagedAgentModels(
  config: ManagedConfigPayload,
  agentSettings: ManagedAgentSettingsWriter,
  store: ManagedAgentAppliedStore,
  lookup: ManagedProviderModelLookup,
  agentId: string
): Promise<ApplyManagedAgentModelsResult> {
  const desiredIds = config.agentModels
  const warnings: string[] = []
  if (!desiredIds) {
    return { applied: store.readAgentModelApplied(), warnings }
  }

  const order = orderedProviderIds(config)
  const modelIdsByProvider = new Map<string, Set<string>>()
  for (const providerId of order) {
    modelIdsByProvider.set(providerId, new Set(await lookup.listModelIds(providerId)))
  }

  const resolved: ManagedAgentModels = {
    chat: null,
    assistant: null,
    vision: null,
    imageGeneration: null
  }
  for (const key of AGENT_MODEL_KEYS) {
    const modelId = desiredIds[key]
    if (!modelId) continue
    const providerId = order.find((id) => modelIdsByProvider.get(id)?.has(modelId))
    if (!providerId) {
      warnings.push(
        `agentModels.${key}: model id not offered by any managed provider, skipped: ${modelId}`
      )
      continue
    }
    resolved[key] = { providerId, modelId }
  }

  const current = (await agentSettings.getDeepChatAgentConfig(agentId)) ?? {}
  const applied: Partial<ManagedAgentModels> = { ...store.readAgentModelApplied() }
  const patch: Record<string, unknown> = {}

  for (const key of AGENT_MODEL_KEYS) {
    const target = resolved[key]
    if (!target) continue

    const field = MANAGED_AGENT_MODEL_FIELDS[key]
    const currentValue = current[field]
    const lastApplied = applied[key]

    if (!currentValue || sameRef(currentValue, lastApplied)) {
      patch[field] = target
      applied[key] = target
    } else {
      applied[key] = currentValue as ManagedModelRef
    }
  }

  if (Object.keys(patch).length > 0) {
    await agentSettings.updateDeepChatAgent(agentId, patch)
  }
  store.writeAgentModelApplied(applied)
  return { applied, warnings }
}
