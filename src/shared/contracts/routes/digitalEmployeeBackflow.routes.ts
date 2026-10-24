import { z } from 'zod'
import { defineRouteContract } from '../common'

/**
 * 对话回流上报（D5）契约。
 *
 * renderer 掌握本轮的本地消息与工具调用，主进程掌握凭证与开关，所以由
 * renderer 把事件送上来、主进程去发。这条 route **永不抛错**：上报失败只是
 * 少一条归档，不能变成用户看得见的错误。
 *
 * 事件 id 由 renderer 生成并在重试时保持不变——服务端按单事件 id 去重，
 * 换了 id 就会重复归档。
 */

export const BackflowEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    eventId: z.string().min(1).max(200),
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    content: z.string().max(2_000_000),
    createdAt: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  }),
  z.object({
    type: z.literal('tool_call'),
    eventId: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    status: z.enum(['ok', 'error']),
    durationMs: z.number().int().nonnegative().optional(),
    errorCode: z.string().max(100).optional(),
    createdAt: z.string().optional()
  }),
  z.object({
    type: z.literal('usage'),
    eventId: z.string().min(1).max(200),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    createdAt: z.string().optional()
  })
])

export const BACKFLOW_REASONS = [
  /** 用户在设置里关了回流 */
  'DISABLED',
  /** 尚未配置 StaffDeck 连接 */
  'NOT_CONFIGURED',
  /** 本轮没有事件 */
  'EMPTY',
  /** 网络层失败，可重试 */
  'NETWORK'
] as const

export const BackflowReasonSchema = z.enum(BACKFLOW_REASONS)
export type BackflowReasonValue = z.infer<typeof BackflowReasonSchema>

export const digitalEmployeeBackflowRoute = defineRouteContract({
  name: 'digitalEmployee.backflow',
  input: z
    .object({
      employeeId: z.string().min(1).max(64),
      /** **本地**会话 id；服务端拿它作 `external_session_id`。 */
      sessionId: z.string().min(1).max(200),
      /** 会话标题，仅用于首次在服务端建会话。 */
      title: z.string().max(200).optional(),
      events: z.array(BackflowEventSchema).max(500)
    })
    .strict(),
  output: z.object({
    /**
     * 主进程是否已经**接手**这批事件：要么送达，要么落进本地队列等补发。
     *
     * 语义是「renderer 可以前进游标了」——两件事都意味着这批事件不再需要由
     * renderer 重采。`false` 时 renderer 必须保留事件、下轮重发：那是
     * 关了回流、没配连接、或事件被服务端明确拒收（重发也没用但也没法接手）。
     */
    ok: z.boolean(),
    /**
     * 未全部送达的原因码；全部送达时为 `null`。注意它**不**与 `ok` 同义：
     * `ok: true` + `reason: 'NETWORK'` 表示「已入队待补发」。
     *
     * HTTP 类失败以 `HTTP_<status>` 形式出现，因此不能收敛进枚举——枚举只覆盖
     * 本地可判定的原因。
     */
    reason: z.string().nullable().default(null),
    /** 已确认入库的事件数（含服务端判重）。 */
    delivered: z.number().int().nonnegative().default(0),
    /** 本次落进本地队列、等待退避补发的条数。 */
    queued: z.number().int().nonnegative().default(0),
    /** 此刻队列里还没发出去的事件总数；`0` 表示没有积压。 */
    pending: z.number().int().nonnegative().default(0)
  })
})

export type DigitalEmployeeBackflowResult = z.infer<typeof digitalEmployeeBackflowRoute.output>
export type BackflowEventInput = z.infer<typeof BackflowEventSchema>

/**
 * 补发队列的积压情况。
 *
 * 只读，且不暴露事件内容：renderer 需要的只是「有多少还没归档」，用于在设置页
 * 提示「暂时连不上，N 条对话会在恢复后补发」。把正文回传渲染层等于让一份完整的
 * 对话副本多待在一个完全不必要的地方。
 */
export const digitalEmployeeBackflowQueueStatusRoute = defineRouteContract({
  name: 'digitalEmployee.backflowQueueStatus',
  input: z.object({}).strict(),
  output: z.object({
    /** 还没送达的事件总数。`0` 表示没有积压。 */
    pending: z.number().int().nonnegative(),
    /** 已到重试时间、正在等下一轮补发的条数。 */
    due: z.number().int().nonnegative(),
    /** 最早一条的入队时间（毫秒时间戳）；空队列为 `null`。 */
    oldestCreatedAt: z.number().int().nonnegative().nullable()
  })
})
