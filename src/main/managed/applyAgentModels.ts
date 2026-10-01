import {
  AGENT_MODEL_KEYS,
  MANAGED_AGENT_MODEL_FIELDS,
  type ManagedAgentModels,
  type ManagedConfigPayload
} from './types'

/**
 * 内置 Agent 配置读写适配层。形状与真实 `AgentSettings` 不同（真实接口是
 * `updateDeepChatAgent(agentId, { config })` 的包装），这层适配由调用方（composition）负责，
 * 不要直接把真实 `AgentSettings` 传进来。
 */
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
 * 首次下发某项（applied 中尚无记录）直接写入托管值（覆盖用户已有值）；之后仅在用户未改动
 * （当前值仍等于上次写入的托管值）时跟随新的托管值；只有在我们设置之后用户又改动过，
 * 才保留用户值不再覆盖。匹配不到的 id 被跳过并记入 warnings，保持用户当前值。
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
    try {
      modelIdsByProvider.set(providerId, new Set(await lookup.listModelIds(providerId)))
    } catch (error) {
      // 单个 provider 读取模型失败不应导致整体失败：视为「无模型」并继续处理其余 provider。
      warnings.push(
        `provider ${providerId}: failed to list models, treated as offering none: ${String(error)}`
      )
    }
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

    if (!currentValue || lastApplied === undefined || sameRef(currentValue, lastApplied)) {
      // 合并写入，保留用户在同一 provider/model 上设置的其它参数（如 temperature）。
      patch[field] = { ...(currentValue as Record<string, unknown> | null | undefined), ...target }
      applied[key] = target
    }
    // 只有在我们设置之后用户又改动过（applied 已有记录，且 currentValue 与上次写入的托管值不同）：
    // 才保留用户值，且不修改 applied。
    // applied 始终记录「上一次成功写入的托管值」，否则下次同步 sameRef 会误命中而覆盖用户值。
  }

  if (Object.keys(patch).length > 0) {
    await agentSettings.updateDeepChatAgent(agentId, patch)
  }
  store.writeAgentModelApplied(applied)
  return { applied, warnings }
}

/**
 * 清除托管痕迹：把内置 Agent 中「仍等于我们上次写入的托管值」的模型默认字段置回 null，
 * 用户改过的（当前值与 applied 不同）保持不动。最后清空 applied 记录。
 * 返回实际被清除的字段 key 列表，便于日志。
 */
export async function revertManagedAgentModels(
  agentSettings: ManagedAgentSettingsWriter,
  store: ManagedAgentAppliedStore,
  agentId: string
): Promise<string[]> {
  const applied: Partial<ManagedAgentModels> = { ...store.readAgentModelApplied() }
  const current = (await agentSettings.getDeepChatAgentConfig(agentId)) ?? {}
  const patch: Record<string, unknown> = {}
  const cleared: string[] = []

  for (const key of AGENT_MODEL_KEYS) {
    const lastApplied = applied[key]
    // 没有托管写入记录：从未托管过该字段，不动。
    if (!lastApplied) continue
    const field = MANAGED_AGENT_MODEL_FIELDS[key]
    // 当前值仍等于我们写入的值，说明用户没改过，可以安全清除；否则保留用户值。
    if (!sameRef(current[field], lastApplied)) continue
    patch[field] = null
    cleared.push(key)
  }

  if (Object.keys(patch).length > 0) {
    await agentSettings.updateDeepChatAgent(agentId, patch)
  }
  store.writeAgentModelApplied({})
  return cleared
}
