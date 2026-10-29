import type { ProviderSettingsPort } from '@/provider/settings'
import type {
  MessageMetadata,
  UsageDashboardCalendarDay,
  UsageStatsBackfillStatus
} from '@shared/types/agent-interface'
import type { TapeCompactionModelCallEvent } from '@/tape/domain/compactionUsage'

import { providerDbLoader } from '@/provider/providerDbLoader'

/**
 * 用量统计工具集（usageStats）：纯函数层，负责把消息 metadata 里的 token
 * 用量规整成可入库/可聚合的形态。
 *
 * 三个关注点：
 * 1. 记录构建——buildUsageStatsRecord（聊天消息）与 buildCompactionUsageStatsRecord
 *    （压缩调用）产出用量表行；无 token 数或 provider/model 无法确定的聊天
 *    消息返回 null 跳过，绝不编造数据。
 * 2. 数值规整——normalizeUsageCounts 把缓存 token 裁剪到不超出输入总数，
 *   保证聚合时 cached + 非缓存 ≤ input 的守恒关系。
 * 3. 展示聚合——按本地日期分桶生成一年热力图日历，level 用四分位切档，
 *   让「多/少」相对于用户自己的用量分布而不是绝对值。
 * 另含回填状态（backfill status）的读取/规整/陈旧判定。
 */

/** 回填状态在 settings 里的存储键；V2 表示结构经历过一次不兼容演进。 */
export const DASHBOARD_STATS_BACKFILL_KEY = 'dashboardStatsBackfillV2'
/** running 状态超过该时长视为上次进程中断留下的悬挂状态，允许重新启动。 */
export const DASHBOARD_BACKFILL_STALE_MS = 10 * 60 * 1000

export type UsageStatsSource = 'backfill' | 'live'
export type UsageStatsCategory = 'chat' | 'compaction'

export interface UsageStatsRecordInput {
  usageId: string
  messageId: string | null
  category: UsageStatsCategory
  compactionAttemptId: string | null
  providerCallId: string | null
  providerCallSeq: number | null
  sessionId: string
  usageDate: string
  providerId: string
  modelId: string
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cachedInputTokens: number | null
  cacheWriteInputTokens: number | null
  source: UsageStatsSource
  createdAt: number
  updatedAt: number
}

export interface UsageCalendarBucket {
  date: string
  messageCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedInputTokens: number
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toNonNegativeInteger(value: unknown): number | undefined {
  const normalized = toFiniteNumber(value)
  if (normalized === undefined) {
    return undefined
  }
  return Math.max(0, Math.round(normalized))
}

function normalizeTextId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function getPercentile(sorted: number[], percentile: number): number {
  if (sorted.length === 0) {
    return 0
  }
  const index = Math.min(sorted.length - 1, Math.floor(percentile * (sorted.length - 1)))
  return sorted[index]
}

export function getDefaultUsageStatsBackfillStatus(): UsageStatsBackfillStatus {
  return {
    status: 'idle',
    startedAt: null,
    finishedAt: null,
    error: null,
    updatedAt: 0
  }
}

export function normalizeUsageStatsBackfillStatus(value: unknown): UsageStatsBackfillStatus {
  if (!value || typeof value !== 'object') {
    return getDefaultUsageStatsBackfillStatus()
  }

  const input = value as Record<string, unknown>
  const status =
    input.status === 'running' ||
    input.status === 'completed' ||
    input.status === 'failed' ||
    input.status === 'idle'
      ? input.status
      : 'idle'

  return {
    status,
    startedAt: toFiniteNumber(input.startedAt) ?? null,
    finishedAt: toFiniteNumber(input.finishedAt) ?? null,
    error: typeof input.error === 'string' ? input.error : null,
    updatedAt: toFiniteNumber(input.updatedAt) ?? 0,
    processedCount: toFiniteNumber(input.processedCount),
    durationMs: toFiniteNumber(input.durationMs)
  }
}

export function isUsageBackfillRunningStale(
  status: UsageStatsBackfillStatus,
  now = Date.now()
): boolean {
  return status.status === 'running' && now - status.updatedAt > DASHBOARD_BACKFILL_STALE_MS
}

/** 解析消息 metadata JSON；损坏/非对象一律当作空对象，不阻断统计流程。 */
export function parseMessageMetadata(raw: string | MessageMetadata): MessageMetadata {
  if (typeof raw !== 'string') {
    return raw ?? {}
  }

  try {
    const parsed = JSON.parse(raw) as MessageMetadata
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function hasUsageNumbers(metadata: MessageMetadata): boolean {
  return (
    toFiniteNumber(metadata.totalTokens) !== undefined ||
    toFiniteNumber(metadata.inputTokens) !== undefined ||
    toFiniteNumber(metadata.outputTokens) !== undefined
  )
}

/**
 * 规整 token 计数：负数/非数归零；total 缺省时用 input+output 补；
 * 缓存 token 被钳制在 input 之内（缓存写再钳在剩余输入内），保证
 * cached + cacheWrite ≤ input，聚合图表不会出现矛盾的 stacked 值。
 */
export function normalizeUsageCounts(metadata: MessageMetadata): {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
} {
  const inputTokens = toNonNegativeInteger(metadata.inputTokens) ?? 0
  const outputTokens = toNonNegativeInteger(metadata.outputTokens) ?? 0
  const totalTokens = toNonNegativeInteger(metadata.totalTokens) ?? inputTokens + outputTokens
  const rawCached = toNonNegativeInteger(metadata.cachedInputTokens) ?? 0
  const rawCacheWrite = toNonNegativeInteger(metadata.cacheWriteInputTokens) ?? 0
  const cappedCachedInputTokens = inputTokens > 0 ? Math.min(rawCached, inputTokens) : rawCached
  const remainingInputTokens = Math.max(inputTokens - cappedCachedInputTokens, 0)
  const cacheWriteInputTokens =
    inputTokens > 0 ? Math.min(rawCacheWrite, remainingInputTokens) : rawCacheWrite

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens: cappedCachedInputTokens,
    cacheWriteInputTokens
  }
}

/** 用量归到消息创建日的本地日期；跨天边界以用户本地时区为准。 */
export function getLocalDateKey(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 从消息 metadata（其次回退会话行）确定统计归属的 provider。 */
export function resolveUsageProviderId(
  metadata: MessageMetadata,
  fallbackProviderId?: string | null
): string | null {
  return normalizeTextId(metadata.provider) ?? normalizeTextId(fallbackProviderId) ?? null
}

/** 同 resolveUsageProviderId，对 model 做同样处理。 */
export function resolveUsageModelId(
  metadata: MessageMetadata,
  fallbackModelId?: string | null
): string | null {
  return normalizeTextId(metadata.model) ?? normalizeTextId(fallbackModelId) ?? null
}

/** 由聊天消息 metadata 构建用量行；无 token 数或缺 provider/model 返回 null。 */
export function buildUsageStatsRecord(params: {
  messageId: string
  sessionId: string
  createdAt: number
  updatedAt: number
  providerId: string
  modelId: string
  metadata: MessageMetadata
  source: UsageStatsSource
}): UsageStatsRecordInput | null {
  if (!hasUsageNumbers(params.metadata)) {
    return null
  }

  const usage = normalizeUsageCounts(params.metadata)
  const providerId = normalizeTextId(params.providerId)
  const modelId = normalizeTextId(params.modelId)

  if (!providerId || !modelId) {
    return null
  }

  return {
    usageId: params.messageId,
    messageId: params.messageId,
    category: 'chat',
    compactionAttemptId: null,
    providerCallId: null,
    providerCallSeq: null,
    sessionId: params.sessionId,
    usageDate: getLocalDateKey(params.createdAt),
    providerId,
    modelId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    source: params.source,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt
  }
}

/** 由压缩模型调用事件构建用量行；usageId 含 attempt+call 维度保证幂等。 */
export function buildCompactionUsageStatsRecord(params: {
  sessionId: string
  event: TapeCompactionModelCallEvent
  source: UsageStatsSource
}): UsageStatsRecordInput {
  const { event } = params
  return {
    usageId: `compaction:${params.sessionId}:${event.compactionAttemptId}:${event.providerCallId}`,
    messageId: event.compactionMessageId,
    category: 'compaction',
    compactionAttemptId: event.compactionAttemptId,
    providerCallId: event.providerCallId,
    providerCallSeq: event.callSeq,
    sessionId: params.sessionId,
    usageDate: getLocalDateKey(event.completedAt),
    providerId: event.providerId,
    modelId: event.modelId,
    inputTokens: event.usage?.inputTokens ?? null,
    outputTokens: event.usage?.outputTokens ?? null,
    totalTokens: event.usage?.totalTokens ?? null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    source: params.source,
    createdAt: event.completedAt,
    updatedAt: event.completedAt
  }
}

/** provider 展示名：优先用户配置目录，回退内置 provider 库，再回退原始 id。 */
export function getProviderLabel(
  providerCatalog: Pick<ProviderSettingsPort, 'getProviders' | 'getProviderById'>,
  providerId: string
): string {
  const provider =
    providerCatalog.getProviders().find((item) => item.id === providerId) ??
    providerCatalog.getProviderById(providerId)

  if (provider?.name?.trim()) {
    return provider.name.trim()
  }

  const dbProvider = providerDbLoader.getProvider(providerId)
  return dbProvider?.display_name || dbProvider?.name || providerId
}

/** model 展示名：查不到时用 aihibmix 目录再试一次（多渠道共享模型名）。 */
export function getModelLabel(providerId: string, modelId: string): string {
  const model =
    providerDbLoader.getModel(providerId, modelId) ?? providerDbLoader.getModel('aihubmix', modelId)
  return model?.display_name || model?.name || modelId
}

/** 生成近 N 天（默认一年）的用量日历：空天补零，level 按非零日四分位切档。 */
export function buildUsageDashboardCalendar(
  buckets: UsageCalendarBucket[],
  totalDays = 365
): UsageDashboardCalendarDay[] {
  const today = new Date()
  const startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  startDate.setDate(startDate.getDate() - (totalDays - 1))

  const bucketMap = new Map(buckets.map((item) => [item.date, item]))
  const days: UsageDashboardCalendarDay[] = []

  for (let offset = 0; offset < totalDays; offset += 1) {
    const date = new Date(startDate)
    date.setDate(startDate.getDate() + offset)
    const dateKey = getLocalDateKey(date.getTime())
    const bucket = bucketMap.get(dateKey)
    days.push({
      date: dateKey,
      messageCount: bucket?.messageCount ?? 0,
      inputTokens: bucket?.inputTokens ?? 0,
      outputTokens: bucket?.outputTokens ?? 0,
      totalTokens: bucket?.totalTokens ?? 0,
      cachedInputTokens: bucket?.cachedInputTokens ?? 0,
      level: 0
    })
  }

  const nonZeroTotals = days
    .map((item) => item.totalTokens)
    .filter((value) => value > 0)
    .sort((a, b) => a - b)

  const q1 = getPercentile(nonZeroTotals, 0.25)
  const q2 = getPercentile(nonZeroTotals, 0.5)
  const q3 = getPercentile(nonZeroTotals, 0.75)

  return days.map((item) => {
    if (item.totalTokens <= 0) {
      return item
    }
    if (item.totalTokens <= q1) {
      return { ...item, level: 1 }
    }
    if (item.totalTokens <= q2) {
      return { ...item, level: 2 }
    }
    if (item.totalTokens <= q3) {
      return { ...item, level: 3 }
    }
    return { ...item, level: 4 }
  })
}
