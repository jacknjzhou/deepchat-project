/**
 * 对话回流上报。
 *
 * 本地执行的会话要归档到 StaffDeck，让管理端能看到完整对话（消息、工具调用、
 * token 用量）。设计上只有三条要点：
 *
 * - **永不抛错**：调用方在发消息的路径上。一次归档失败最多少一行记录，绝不能让
 *   用户看到「发送失败」。
 * - **按块上报，失败即停**：一次长对话的补报可能有上千条事件，单个超大请求上传慢、
 *   失败面也大。但失败后不能跳过继续发——那样调用方会看到一个洞，却分不清那是
 *   「已经发过了」还是「丢了」。
 * - **幂等交给服务端**：服务端按单事件 `event_id` 去重，客户端重发整批是正常操作，
 *   `accepted: 0` 是重试生效，不是错误。
 *
 * 建会话不在这里：`POST /agents/{id}/sessions` 本来就可按 `external_session_id`
 * 幂等复用，`StaffdeckRemoteClient.createSession` 已经在走那条路。
 */

export type BackflowEvent =
  | {
      type: 'message'
      eventId: string
      role: 'user' | 'assistant' | 'system' | 'tool'
      content: string
      createdAt?: string
      metadata?: Record<string, unknown>
    }
  | {
      type: 'tool_call'
      eventId: string
      name: string
      status: 'ok' | 'error'
      durationMs?: number
      errorCode?: string
      createdAt?: string
    }
  | {
      type: 'usage'
      eventId: string
      promptTokens: number
      completionTokens: number
      totalTokens: number
      createdAt?: string
    }

export type BackflowReason =
  | 'DISABLED'
  | 'NOT_CONFIGURED'
  | 'EMPTY'
  /** `HTTP_<status>`：服务端拒绝，可重试。 */
  | `HTTP_${number}`
  /** 网络层失败，可重试。 */
  | 'NETWORK'

export interface BackflowResult {
  ok: boolean
  /** `ok: true` 时为 `null`。 */
  reason: BackflowReason | null
  /** 已确认入库的事件数（含服务端判定为重复的）。 */
  delivered: number
}

export interface StaffdeckBackflowDeps {
  getConnection: () => { baseUrl: string; apiKey: string } | null
  /** 隐私开关。返回 false 时一条事件都不发。 */
  isEnabled: () => boolean
  fetchImpl: typeof fetch
  /** 单次请求最多带多少条事件。默认 50。 */
  batchSize?: number
  timeoutMs?: number
}

export interface FlushInput {
  employeeId: string
  /** 本地会话 id，也就是服务端的 session id（建会话时已按 external_session_id 对齐）。 */
  sessionId: string
  events: readonly BackflowEvent[]
}

export interface StaffdeckBackflow {
  flush(input: FlushInput): Promise<BackflowResult>
}

const DEFAULT_BATCH_SIZE = 50
const DEFAULT_TIMEOUT_MS = 10_000

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, '')

const toWireEvent = (event: BackflowEvent): Record<string, unknown> => {
  switch (event.type) {
    case 'message':
      return {
        type: 'message',
        event_id: event.eventId,
        role: event.role,
        content: event.content,
        ...(event.createdAt ? { created_at: event.createdAt } : {}),
        ...(event.metadata ? { metadata: event.metadata } : {})
      }
    case 'tool_call':
      return {
        type: 'tool_call',
        event_id: event.eventId,
        name: event.name,
        status: event.status,
        ...(event.durationMs === undefined ? {} : { duration_ms: event.durationMs }),
        ...(event.errorCode ? { error_code: event.errorCode } : {}),
        ...(event.createdAt ? { created_at: event.createdAt } : {})
      }
    case 'usage':
      return {
        type: 'usage',
        event_id: event.eventId,
        prompt_tokens: event.promptTokens,
        completion_tokens: event.completionTokens,
        total_tokens: event.totalTokens,
        ...(event.createdAt ? { created_at: event.createdAt } : {})
      }
  }
}

const chunk = <TValue>(items: readonly TValue[], size: number): TValue[][] => {
  const chunks: TValue[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

export function createStaffdeckBackflow(deps: StaffdeckBackflowDeps): StaffdeckBackflow {
  const batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE)
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    async flush({ employeeId, sessionId, events }) {
      // Order matters: privacy first, then configuration, then work. Asking
      // whether we are configured before whether the user allowed reporting
      // would leak a request-shaped decision into a consent question.
      if (!deps.isEnabled()) return { ok: false, reason: 'DISABLED', delivered: 0 }
      const connection = deps.getConnection()
      if (!connection) return { ok: false, reason: 'NOT_CONFIGURED', delivered: 0 }
      if (events.length === 0) return { ok: false, reason: 'EMPTY', delivered: 0 }

      const base = normalizeBaseUrl(connection.baseUrl)
      const url =
        `${base}/api/v1/agents/${encodeURIComponent(employeeId)}` +
        `/sessions/${encodeURIComponent(sessionId)}/events:batch`

      let delivered = 0
      for (const part of chunk(events, batchSize)) {
        const outcome = await sendPart(url, connection.apiKey, part, timeoutMs)
        if (!outcome.ok) {
          // Stop rather than skip: a delivered hole is indistinguishable from a
          // lost chunk, so the caller must be able to resend from here.
          return { ok: false, reason: outcome.reason, delivered }
        }
        delivered += part.length
      }

      return { ok: true, reason: null, delivered }
    }
  }

  async function sendPart(
    url: string,
    apiKey: string,
    events: readonly BackflowEvent[],
    timeout: number
  ): Promise<{ ok: true } | { ok: false; reason: BackflowReason }> {
    try {
      const response = await deps.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ events: events.map(toWireEvent) }),
        signal: AbortSignal.timeout(timeout)
      })
      if (!response.ok) {
        return { ok: false, reason: `HTTP_${response.status}` as BackflowReason }
      }
      return { ok: true }
    } catch {
      // Timeout, DNS, offline — all the same to a caller that can just retry.
      return { ok: false, reason: 'NETWORK' }
    }
  }
}
