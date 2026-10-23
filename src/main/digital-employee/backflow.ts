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
 * 建会话是**必要前置**，不是可选项。`events:batch` 要求 session 是服务端
 * `ChatSession` 的行，且该凭证在 `ExternalSessionBinding` 里拥有它；本地执行的
 * 会话从未建过远端记录，直接发事件必然 404。所以第一次上报先按
 * `external_session_id` 把远端会话建出来（服务端按此键幂等，重复调用返回同一行），
 * 之后用返回的服务端 id 发事件。远端 id 缓存在内存里，避免每轮多一次往返；
 * 缓存命中的 id 若被服务端 404（会话被清理），丢掉缓存重建一次。
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

export interface StaffdeckConnection {
  baseUrl: string
  apiKey: string
  externalUserId: string
}

export interface StaffdeckBackflowDeps {
  getConnection: () => StaffdeckConnection | null
  /** 隐私开关。返回 false 时一条事件都不发。 */
  isEnabled: () => boolean
  fetchImpl: typeof fetch
  /** 单次请求最多带多少条事件。默认 50。 */
  batchSize?: number
  timeoutMs?: number
}

export interface FlushInput {
  employeeId: string
  /** **本地**会话 id。服务端拿它作 `external_session_id`，不是服务端 session id。 */
  sessionId: string
  /** 会话标题，仅在首次建远端会话时使用。 */
  title?: string
  events: readonly BackflowEvent[]
}

export interface StaffdeckBackflow {
  flush(input: FlushInput): Promise<BackflowResult>
  /** 配置变更时丢弃服务端会话 id 缓存（旧凭证建的行不属于新凭证）。 */
  reset(): void
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
  /**
   * 本地会话 id → 服务端会话 id。
   *
   * 只存内存：它是可以随时重建的派生数据，而落盘会让「服务端换了库」这种情况
   * 变成一堆指向不存在的会话的陈旧 id。重建的代价只是一次幂等的建会话请求。
   */
  const remoteSessionIds = new Map<string, string>()

  return {
    async flush({ employeeId, sessionId, title, events }) {
      // Order matters: privacy first, then configuration, then work. Asking
      // whether we are configured before whether the user allowed reporting
      // would leak a request-shaped decision into a consent question.
      if (!deps.isEnabled()) return { ok: false, reason: 'DISABLED', delivered: 0 }
      const connection = deps.getConnection()
      if (!connection) return { ok: false, reason: 'NOT_CONFIGURED', delivered: 0 }
      if (events.length === 0) return { ok: false, reason: 'EMPTY', delivered: 0 }

      const base = normalizeBaseUrl(connection.baseUrl)
      const sessionUrl = (remoteSessionId: string): string =>
        `${base}/api/v1/agents/${encodeURIComponent(employeeId)}` +
        `/sessions/${encodeURIComponent(remoteSessionId)}/events:batch`

      const resolved = await resolveRemoteSessionId({
        base,
        connection,
        employeeId,
        sessionId,
        title
      })
      if (!resolved.ok) return { ok: false, reason: resolved.reason, delivered: 0 }
      let remoteSessionId = resolved.id

      let delivered = 0
      for (const part of chunk(events, batchSize)) {
        const outcome = await sendPart(sessionUrl(remoteSessionId), connection.apiKey, part, timeoutMs)
        if (outcome.ok) {
          delivered += part.length
          continue
        }

        if (outcome.reason === 'HTTP_404') {
          // 缓存的 id 指向一个已经不存在的会话（服务端清理过、或换了库）。
          // 清掉缓存重建一次，仍失败就如实回报，不再无限重试。
          remoteSessionIds.delete(sessionId)
          const rebuilt = await resolveRemoteSessionId({
            base,
            connection,
            employeeId,
            sessionId,
            title,
            forceRefresh: true
          })
          if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason, delivered }
          remoteSessionIds.set(sessionId, rebuilt.id)
          remoteSessionId = rebuilt.id
          const retried = await sendPart(
            sessionUrl(remoteSessionId),
            connection.apiKey,
            part,
            timeoutMs
          )
          if (!retried.ok) return { ok: false, reason: retried.reason, delivered }
          delivered += part.length
          continue
        }

        // Stop rather than skip: a delivered hole is indistinguishable from a
        // lost chunk, so the caller must be able to resend from here.
        return { ok: false, reason: outcome.reason, delivered }
      }

      return { ok: true, reason: null, delivered }
    },

    reset() {
      remoteSessionIds.clear()
    }
  }

  /**
   * 拿到这个本地会话对应的服务端会话 id。
   *
   * `POST /agents/{id}/sessions` 按 `(credential_id, external_session_id)` upsert，
   * 同一本地会话重复调用只会拿回同一行，所以这里可以放心地在缓存缺失时重试。
   */
  async function resolveRemoteSessionId(input: {
    base: string
    connection: StaffdeckConnection
    employeeId: string
    sessionId: string
    title?: string
    forceRefresh?: boolean
  }): Promise<{ ok: true; id: string } | { ok: false; reason: BackflowReason }> {
    if (!input.forceRefresh) {
      const cached = remoteSessionIds.get(input.sessionId)
      if (cached) return { ok: true, id: cached }
    }

    const url = `${input.base}/api/v1/agents/${encodeURIComponent(input.employeeId)}/sessions`
    try {
      const response = await deps.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.connection.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          external_session_id: input.sessionId,
          external_user_id: input.connection.externalUserId,
          ...(input.title ? { title: input.title } : {}),
          metadata: { source: 'deepchat' }
        }),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!response.ok) {
        return { ok: false, reason: `HTTP_${response.status}` as BackflowReason }
      }
      const body: unknown = await response.json().catch(() => null)
      const id =
        body && typeof body === 'object' && typeof (body as { id?: unknown }).id === 'string'
          ? (body as { id: string }).id
          : ''
      if (!id) {
        // 没有 id 就无法定位事件端点。按不可重试的客户端错误处理，
        // 与「服务端返回了畸形响应」是同一类问题。
        return { ok: false, reason: 'NETWORK' }
      }
      remoteSessionIds.set(input.sessionId, id)
      return { ok: true, id }
    } catch {
      return { ok: false, reason: 'NETWORK' }
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
