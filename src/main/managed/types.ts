import { z } from 'zod'
import { type NewApiEndpointType } from '@shared/model'

const PROVIDER_KEY_PATTERN = /^[A-Za-z0-9._-]+$/

export const ManagedProviderSpecSchema = z.object({
  key: z.string().regex(PROVIDER_KEY_PATTERN),
  name: z.string().min(1),
  apiType: z.string().min(1),
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  enabled: z.boolean().optional(),
  instanceLabel: z.string().min(1).optional()
})

export const ManagedModelRefSchema = z.object({
  providerKey: z.string().regex(PROVIDER_KEY_PATTERN),
  modelId: z.string().min(1),
  // 宽松接收任意字符串，非法值由客户端在规范化阶段丢弃并记录 warning
  endpointType: z.string().optional()
})

export const ManagedDocumentsSchema = z.object({
  // 模型 ref 只做形状外层的宽松接收；字段级校验与逐条丢弃由客户端 normalizeModelRef 负责
  textModel: z.unknown().nullish(),
  visionModel: z.unknown().nullish(),
  concurrency: z.number().nullish(),
  temperature: z.number().nullish(),
  maxTokens: z.number().nullish()
})

/** 只下发模型 id 字符串；归属 provider 由 defaultProviderKey / providers[0] 决定 */
export const ManagedAgentModelsSchema = z.object({
  chat: z.string().nullish(),
  assistant: z.string().nullish(),
  vision: z.string().nullish(),
  imageGeneration: z.string().nullish()
})

export const ManagedConfigPayloadSchema = z.object({
  version: z.number().int().positive(),
  defaultProviderKey: z.string().min(1).optional(),
  // 逐项用 ManagedProviderSpecSchema 校验，坏条目单独丢弃而非整包失败
  providers: z.array(z.unknown()),
  agentModels: ManagedAgentModelsSchema.nullish(),
  documents: ManagedDocumentsSchema.nullish()
})

export type ManagedProviderSpec = z.infer<typeof ManagedProviderSpecSchema>

/** 规范化后的托管服务商（已解析出本地 id 与 baseProviderId） */
export interface ManagedProvider {
  /** 本地 provider id，形如 managed-corp-gw */
  id: string
  /** 服务端业务 key，用于回显与排障 */
  key: string
  name: string
  /** 供应商类型，如 new-api */
  apiType: string
  /** 该供应商类型对应的内置 provider id，用于多实例归属 */
  baseProviderId: string | null
  instanceLabel: string
  baseUrl: string
  apiKey: string
  enabled: boolean
}

export interface ManagedModelRef {
  providerId: string
  modelId: string
  /** 仅 new-api 等聚合网关需要；缺省由客户端按实时模型列表推断 */
  endpointType?: NewApiEndpointType
}

export interface ManagedDocumentsConfig {
  textModel: ManagedModelRef | null
  visionModel: ManagedModelRef | null
  concurrency: number | null
  temperature: number | null
  maxTokens: number | null
}

export const AGENT_MODEL_KEYS = ['chat', 'assistant', 'vision', 'imageGeneration'] as const

export type AgentModelKey = (typeof AGENT_MODEL_KEYS)[number]

/** 托管模型键 → 内置 Agent 配置字段名 */
export const MANAGED_AGENT_MODEL_FIELDS: Record<AgentModelKey, string> = {
  chat: 'defaultModelPreset',
  assistant: 'assistantModel',
  vision: 'visionModel',
  imageGeneration: 'imageGenerationModel'
}

/** 下发来的 agent 模型 id（未解析 provider，靠模型列表匹配确定归属） */
export type ManagedAgentModelIds = Partial<Record<AgentModelKey, string>>

/** 匹配落地后的 agent 模型值（已确定 providerId） */
export type ManagedAgentModels = Record<AgentModelKey, ManagedModelRef | null>

export interface ManagedConfigPayload {
  version: number
  providers: ManagedProvider[]
  /**
   * agentModels 匹配时的优先级锚点（由下发的 defaultProviderKey 解析出的本地 provider id）；
   * null 表示缺省用 providers[0]
   */
  defaultProviderId: string | null
  /** 下发的 agent 模型 id；未命中的 id 在应用阶段被跳过 */
  agentModels: ManagedAgentModelIds | null
  documents: ManagedDocumentsConfig | null
}

export interface ManagedConfigMeta {
  fetchedAt: number
  username: string
  endpoint: string
}

export type SyncStatus = 'applied' | 'absent' | 'denied' | 'unavailable' | 'skipped'

export interface SyncResult {
  status: SyncStatus
  config: ManagedConfigPayload | null
  /** 逐条丢弃原因（provider 形状非法 / 未知 apiType / 模型 ref 非法 / 未知 providerKey 等），用于日志 */
  warnings: string[]
}

export const MANAGED_PROVIDER_ID_PREFIX = 'managed-'

export function toLocalProviderId(key: string): string {
  return `${MANAGED_PROVIDER_ID_PREFIX}${key.replace(/[^A-Za-z0-9._-]/g, '-')}`
}

export function clampManagedConcurrency(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(10, Math.max(1, Math.round(value)))
}
