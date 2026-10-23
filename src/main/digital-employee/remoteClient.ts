import {
  STAFFDECK_RUN_EVENT_NAMES,
  staffdeckRunEventSchema,
  staffdeckRunResultSchema,
  type StaffdeckRunEvent,
  type StaffdeckRunResult
} from '@shared/contracts/routes'
import { createSseParser, type StaffdeckSseFrame } from './sseParser'

/**
 * StaffDeck Public API v1 的 HTTP 面。
 *
 * 端点与鉴权事实（对照 StaffDeck 后端源码）：
 * - 建会话：`POST /api/v1/agents/{agent_id}/sessions`（`sessions.py:129`，scope `sessions:write`）
 * - 流式 run：`POST /api/v1/agents/{agent_id}/runs:stream`（`runs.py:427`，scope `runs:create`）
 * - 断线续传：`GET /api/v1/runs/{run_id}/events`（`runs.py:500`，scope `runs:read`）
 * - 终态结果：`GET /api/v1/runs/{run_id}/result`（`runs.py:488`）
 * - 取消：`POST /api/v1/runs/{run_id}:cancel`（`runs.py:513`，scope `runs:cancel`）
 *
 * `external_user_id` 是 body 字段（`schemas.py:139-140`），不是 header——
 * 全后端没有任何位置读取 `x-external-user-id`。
 */

const REQUEST_TIMEOUT_MS = 10_000
const STREAM_IDLE_TIMEOUT_MS = 120_000
const MAX_RESUME_ATTEMPTS = 3

const TERMINAL_EVENT_NAMES = new Set([
  'run.output.completed',
  'run.succeeded',
  'run.failed',
  'run.cancelled'
])

const KNOWN_EVENT_NAMES = new Set<string>(STAFFDECK_RUN_EVENT_NAMES)

export class StaffdeckProblemError extends Error {
  /** 服务端 detail 原文，仅供本地日志排查；不得进入 UI 事件或持久化消息。 */
  readonly detail: string

  constructor(
    readonly status: number,
    readonly code: string,
    detail = ''
  ) {
    // 刻意不把服务端 detail 拼进 message：它可能含内部路径，会被透传到 UI。
    super(`Staffdeck request failed: ${code}`)
    this.name = 'StaffdeckProblemError'
    this.detail = detail
  }
}

export interface StaffdeckRemoteClientConfig {
  baseUrl: string
  apiKey: string
  externalUserId: string
}

export interface CreateSessionInput {
  employeeId: string
  externalSessionId: string
  title: string
  metadata?: Record<string, unknown>
}

export interface StreamRunInput {
  employeeId: string
  remoteSessionId: string
  /** 确定性幂等键：同一次本地轮次重发不会在服务端产生第二个 run */
  runKey: string
  input: string
}

export interface StreamRunOutcome {
  runId: string
}

export type StaffdeckFrameHandler = (
  frame: StaffdeckSseFrame,
  event: StaffdeckRunEvent | null
) => void

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, '')

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export class StaffdeckRemoteClient {
  /** 当前在消费的 run id；`X-Run-ID` 在首帧之前就已就绪。 */
  currentRunId: string | null = null

  constructor(
    private readonly config: StaffdeckRemoteClientConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private get base(): string {
    return normalizeBaseUrl(this.config.baseUrl)
  }

  private authHeaders(): Record<string, string> {
    return {
      accept: 'application/json',
      authorization: `Bearer ${this.config.apiKey}`
    }
  }

  private async throwForResponse(response: Response): Promise<never> {
    let code = `HTTP_${response.status}`
    let detail = ''
    try {
      const body: unknown = await response.json()
      if (isRecord(body)) {
        if (typeof body.code === 'string' && body.code) code = body.code
        if (typeof body.detail === 'string') detail = body.detail
      }
    } catch {
      // problem+json 之外的响应体不可解析时保留 HTTP_<status>。
    }
    throw new StaffdeckProblemError(response.status, code, detail)
  }

  async createSession(input: CreateSessionInput): Promise<{ id: string }> {
    const url = `${this.base}/api/v1/agents/${encodeURIComponent(input.employeeId)}/sessions`
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        external_session_id: input.externalSessionId,
        external_user_id: this.config.externalUserId,
        title: input.title,
        metadata: input.metadata ?? {}
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    if (!response.ok) await this.throwForResponse(response)

    const body: unknown = await response.json().catch(() => null)
    if (!isRecord(body) || typeof body.id !== 'string' || !body.id) {
      throw new Error('[digitalEmployee] invalid session payload from StaffDeck')
    }
    return { id: body.id }
  }

  /**
   * 发起一轮流式执行。返回时流已终止（正常完成或抛出传输错误）。
   *
   * 终止条件必须包含四个事件名：`run.output.completed` 只是 trace 层的
   * `stream_end`，job 级还有 `run.succeeded` / `run.failed` / `run.cancelled`
   * （`jobs.py:385-395`），漏判会让调用方永久等待。
   */
  async streamRun(
    input: StreamRunInput,
    onFrame: StaffdeckFrameHandler
  ): Promise<StreamRunOutcome> {
    const url = `${this.base}/api/v1/agents/${encodeURIComponent(input.employeeId)}/runs:stream`
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'idempotency-key': input.runKey
      },
      body: JSON.stringify({
        input: input.input,
        session_id: input.remoteSessionId,
        external_user_id: this.config.externalUserId,
        session_mode: 'stateful',
        metadata: { source: 'deepchat' }
      }),
      signal: AbortSignal.timeout(STREAM_IDLE_TIMEOUT_MS)
    })

    if (!response.ok) await this.throwForResponse(response)

    const runId = response.headers.get('X-Run-ID')
    if (!runId) {
      // 没有 run id 就无法续传、取消或补查结果，宁可失败也不能瞎猜。
      throw new Error('[digitalEmployee] StaffDeck stream response is missing X-Run-ID')
    }
    this.currentRunId = runId

    await this.consumeStream(response, runId, onFrame)
    return { runId }
  }

  /** 断线续传：必须换 `GET /runs/{id}/events`，`runs:stream` 无法重放。 */
  async resumeRun(
    input: { runId: string; lastEventId: string | null },
    onFrame: StaffdeckFrameHandler
  ): Promise<void> {
    const url = `${this.base}/api/v1/runs/${encodeURIComponent(input.runId)}/events`
    const headers: Record<string, string> = {
      ...this.authHeaders(),
      accept: 'text/event-stream'
    }
    if (input.lastEventId) {
      // jobs.py:547-548 只接受数字 id，取 max(after, int(last_event_id))。
      headers['last-event-id'] = input.lastEventId
    }

    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(STREAM_IDLE_TIMEOUT_MS)
    })

    if (!response.ok) await this.throwForResponse(response)
    this.currentRunId = input.runId
    await this.consumeStream(response, input.runId, onFrame)
  }

  async getResult(runId: string): Promise<StaffdeckRunResult> {
    const url = `${this.base}/api/v1/runs/${encodeURIComponent(runId)}/result`
    const response = await this.fetchImpl(url, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    if (!response.ok) await this.throwForResponse(response)

    const body: unknown = await response.json().catch(() => null)
    // 服务端在 awaiting_input 场景可能缺回复正文，契约里已给默认值。
    return staffdeckRunResultSchema.parse(
      isRecord(body) ? { run_id: runId, ...body } : { run_id: runId }
    )
  }

  async cancelRun(runId: string): Promise<void> {
    const url = `${this.base}/api/v1/runs/${encodeURIComponent(runId)}:cancel`
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    // 已经不存在等价于已取消，不必让上层区分。
    if (response.status === 404) return
    if (!response.ok) await this.throwForResponse(response)
  }

  /**
   * 消费 SSE 响应体直到终止事件。
   *
   * 三个必须处理的线上细节：
   * 1. 每 15 秒一条 `: keepalive` 注释行——解析器负责跳过；
   * 2. 未知事件名不得中断流（服务端会持续新增 trace 事件）；
   * 3. 流被传输层掐断时必须抛错，不能当作「已完成」。
   */
  private async consumeStream(
    response: Response,
    runId: string,
    onFrame: StaffdeckFrameHandler
  ): Promise<void> {
    if (!response.body) {
      throw new Error('[digitalEmployee] StaffDeck stream response has no body')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const parser = createSseParser()
    let terminated = false

    try {
      while (!terminated) {
        const { done, value } = await reader.read()
        if (done) break

        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          const handled = this.handleFrame(frame, onFrame)
          if (handled.terminal) {
            terminated = true
            break
          }
        }
      }
    } finally {
      // 终止事件之后服务端还会继续发注释行，主动断开避免空转到超时。
      reader.cancel().catch(() => undefined)
    }

    if (!terminated) {
      throw new Error(`[digitalEmployee] StaffDeck stream ended before a terminal event (${runId})`)
    }
  }

  private handleFrame(
    frame: StaffdeckSseFrame,
    onFrame: StaffdeckFrameHandler
  ): { terminal: boolean } {
    if (!frame.event || !KNOWN_EVENT_NAMES.has(frame.event)) {
      // 未知事件按「忽略 + 不中断」处理，与 D1 的 schema 非严格策略一致。
      return { terminal: false }
    }

    let parsedData: Record<string, unknown> = {}
    try {
      const raw: unknown = JSON.parse(frame.data || '{}')
      parsedData = isRecord(raw) ? raw : {}
    } catch {
      // data 不是 JSON 时保留空对象，事件仍然透传，避免整条流因单帧坏掉而失败。
      parsedData = {}
    }

    const candidate = {
      id: Number(frame.id ?? 0),
      event: frame.event,
      data: parsedData
    }
    const parsed = staffdeckRunEventSchema.safeParse(candidate)
    const event = parsed.success ? parsed.data : null

    onFrame(frame, event)
    return { terminal: TERMINAL_EVENT_NAMES.has(frame.event) }
  }
}

/** 续传重试：指数退避，最多 3 次（计划里的「最多重试 3 次」约束）。 */
export async function resumeWithRetry(
  client: StaffdeckRemoteClient,
  input: { runId: string; lastEventId: string | null },
  onFrame: StaffdeckFrameHandler,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_RESUME_ATTEMPTS; attempt += 1) {
    try {
      await client.resumeRun(input, onFrame)
      return true
    } catch {
      if (attempt === MAX_RESUME_ATTEMPTS - 1) return false
      await sleep(2 ** attempt * 200)
    }
  }
  return false
}
