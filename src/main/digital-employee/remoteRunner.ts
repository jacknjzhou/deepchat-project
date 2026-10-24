import type { AssistantMessageBlock } from '@shared/types/agent-interface'
import {
  staffdeckAwaitingInputSchema,
  type StaffdeckAwaitingInput,
  type StaffdeckRunResult
} from '@shared/contracts/routes'
import { cloneBlocksForRenderer } from '@/session/clientMessageProjection'
import {
  StaffdeckProblemError,
  type StaffdeckFrameHandler,
  type StreamRunInput
} from './remoteClient'
import type { RemoteSessionBinding } from './remoteSessionRegistry'
import type { StaffdeckSseFrame } from './sseParser'

/**
 * 远端 run 的执行编排：SSE → blocks → 落库 + 事件。
 *
 * 不新建流式通道：正文走现有 `chat.stream.updated` 快照事件（与 echo.ts 同构），
 * 状态走 `digitalEmployee.remoteRunUpdated`，renderer 因而零改动。
 *
 * 关键语义（均由 StaffDeck 实测行为决定）：
 * - 终稿 = `run.output.delta` 累积；`run.output.completed` 不带正文
 * - `awaiting_input` 不在 SSE 里，必须终态后补查 `/runs/{id}/result`
 * - `RUN_NOT_SUCCEEDED` 是「尚未收敛」的正常信号，降级用累积文本，不判失败
 */

/** 与 echo.ts:7-8 对齐的节流间隔 */
const RENDERER_FLUSH_INTERVAL_MS = 120
const DB_FLUSH_INTERVAL_MS = 600

const CONTENT_BLOCK_ID = 'content-0'

/** 续传最多重试次数（`runs:stream` 不可重放，只能换 events 端点） */
const MAX_RESUME_ATTEMPTS = 3

export type RemoteRunPhase = 'completed' | 'awaiting_input' | 'failed' | 'cancelled'

export interface RemoteRunInput {
  sessionId: string
  employeeId: string
  input: string
  /** 本地轮次标识，参与确定性幂等键 */
  turnKey: string
}

export interface RemoteRunOutcome {
  phase: RemoteRunPhase
  /** 最终落库的正文（delta 累积或服务端 reply） */
  text: string
  runId: string | null
  messageId: string | null
  awaitingInput: StaffdeckAwaitingInput | null
  /** 便于 UI 提示的错误码；永不含服务端 detail */
  messageCode: string | null
  /** 本轮失败后已解除远端绑定，后续轮次由本地引擎接手。 */
  fellBackToLocal?: boolean
}

/** runner 需要的最小能力集合，全部以接口注入以便脱离 Electron 单测。 */
export interface StaffdeckRemoteRunnerTranscript {
  getNextOrderSeq(sessionId: string): number
  createAssistantMessage(sessionId: string, orderSeq: number): string
  updateAssistantContent(messageId: string, blocks: AssistantMessageBlock[]): void
  updateMessageStatus(messageId: string, status: 'pending' | 'sent' | 'error'): void
}

export interface StaffdeckRemoteRunnerRegistry {
  get(sessionId: string): RemoteSessionBinding | null
  set(sessionId: string, binding: RemoteSessionBinding): void
  update(sessionId: string, patch: Partial<RemoteSessionBinding>): void
  has(sessionId: string): boolean
  delete(sessionId: string): void
  listAll(): unknown[]
}

export interface StaffdeckRemoteRunnerClient {
  readonly currentRunId: string | null
  createSession(input: {
    employeeId: string
    externalSessionId: string
    title: string
    metadata?: Record<string, unknown>
  }): Promise<{ id: string }>
  streamRun(input: StreamRunInput, onFrame: StaffdeckFrameHandler): Promise<{ runId: string }>
  resumeRun(
    input: { runId: string; lastEventId: string | null },
    onFrame: StaffdeckFrameHandler
  ): Promise<void>
  getResult(runId: string): Promise<StaffdeckRunResult>
  cancelRun(runId: string): Promise<void>
}

export interface StaffdeckRemoteRunnerDeps {
  client: StaffdeckRemoteRunnerClient
  registry: StaffdeckRemoteRunnerRegistry
  transcript: StaffdeckRemoteRunnerTranscript
  publishEvent(name: string, payload: unknown): void
  rendererFlushIntervalMs?: number
  dbFlushIntervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const IN_PROGRESS_CODE = 'REMOTE_RUN_IN_PROGRESS'
const SESSION_UNAVAILABLE_CODE = 'REMOTE_SESSION_UNAVAILABLE'
const TRANSPORT_ERROR_CODE = 'REMOTE_TRANSPORT_ERROR'
const STREAM_INTERRUPTED_CODE = 'STREAM_INTERRUPTED'
const RUN_FAILED_CODE = 'RUN_FAILED'
const RUN_NOT_SUCCEEDED = 'RUN_NOT_SUCCEEDED'

interface StreamState {
  messageId: string
  sessionId: string
  text: string
  finished: boolean
  /** `run.failed` 帧体里的真实失败码；未收到失败帧时为 null。 */
  failureCode: string | null
}

export class StaffdeckRemoteRunner {
  /** 同一会话同时只允许一轮：两轮争用同一远端会话会让 blocks 互相覆盖。 */
  private readonly running = new Set<string>()

  constructor(private readonly deps: StaffdeckRemoteRunnerDeps) {}

  private get now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private get rendererInterval(): number {
    return this.deps.rendererFlushIntervalMs ?? RENDERER_FLUSH_INTERVAL_MS
  }

  private get dbInterval(): number {
    return this.deps.dbFlushIntervalMs ?? DB_FLUSH_INTERVAL_MS
  }

  /** `ChatService` 分流前调用：只读绑定表，不读 renderer 状态。 */
  handles(sessionId: string): boolean {
    return this.deps.registry.has(sessionId)
  }

  async run(input: RemoteRunInput): Promise<RemoteRunOutcome> {
    const { sessionId, employeeId } = input

    if (this.running.has(sessionId)) {
      // 不排队：第二轮明确返回失败码，调用方据此提示，不必猜「为什么没反应」。
      return this.failureOutcome(null, null, IN_PROGRESS_CODE)
    }
    this.running.add(sessionId)

    const orderSeq = this.deps.transcript.getNextOrderSeq(sessionId)
    const messageId = this.deps.transcript.createAssistantMessage(sessionId, orderSeq)
    const state: StreamState = {
      messageId,
      sessionId,
      text: '',
      finished: false,
      failureCode: null
    }

    try {
      const binding = await this.ensureBinding(sessionId, employeeId, input.input)
      if (!binding) {
        return this.failRun(state, employeeId, null, null, SESSION_UNAVAILABLE_CODE)
      }
      return await this.execute(input, binding, state)
    } catch (error) {
      // 传输层/鉴权失败也必须落库并广播，否则消息会永久停在 pending。
      return this.failRun(
        state,
        employeeId,
        this.deps.client.currentRunId,
        null,
        this.codeOf(error)
      )
    } finally {
      this.running.delete(sessionId)
    }
  }

  private async execute(
    input: RemoteRunInput,
    binding: RemoteSessionBinding,
    state: StreamState
  ): Promise<RemoteRunOutcome> {
    const flusher = this.createFlusher(state)
    let lastEventId: string | null = binding.lastEventId
    let terminalEvent: string | null = null

    this.emitPhase(input.sessionId, input.employeeId, 'started', null, null)

    const onFrame: StaffdeckFrameHandler = (frame) => {
      if (frame.id) lastEventId = frame.id
      const terminal = this.applyFrame(state, frame, flusher)
      if (terminal) terminalEvent = terminal
    }

    let runId: string
    try {
      const outcome = await this.deps.client.streamRun(
        {
          employeeId: input.employeeId,
          remoteSessionId: binding.remoteSessionId,
          runKey: `deepchat:${input.sessionId}:${input.turnKey}`,
          input: input.input
        },
        onFrame
      )
      runId = outcome.runId
    } catch (error) {
      const transportCode = this.codeOf(error)
      const inFlightRunId = this.deps.client.currentRunId

      // 断线优先续传：`runs:stream` 无法重放，只能换 `GET /runs/{id}/events`。
      if (inFlightRunId) {
        const resumed = await this.resumeWithRetry({ runId: inFlightRunId, lastEventId }, onFrame)
        if (resumed) {
          this.deps.registry.update(input.sessionId, { runId: inFlightRunId, lastEventId })
          return this.finishSuccess(input, state, inFlightRunId, flusher, 'completed', null)
        }
      }

      return this.failRun(state, input.employeeId, inFlightRunId, lastEventId, transportCode)
    }

    this.deps.registry.update(input.sessionId, { runId, lastEventId })

    if (terminalEvent === 'run.failed') {
      return this.failRun(
        state,
        input.employeeId,
        runId,
        lastEventId,
        state.failureCode ?? RUN_FAILED_CODE
      )
    }
    if (terminalEvent === 'run.cancelled') {
      return this.finishSuccess(input, state, runId, flusher, 'cancelled', null, lastEventId)
    }

    // 终态之后补查 result：awaiting_input 与 citations 只在这里（runs.py:488）。
    let result: StaffdeckRunResult | null = null
    let degradedCode: string | null = null
    try {
      result = await this.deps.client.getResult(runId)
    } catch (error) {
      if (error instanceof StaffdeckProblemError && error.code === RUN_NOT_SUCCEEDED) {
        // 尚未收敛/仍有追问：保留累积文本继续，不判失败。
        degradedCode = error.code
      } else {
        return this.failRun(state, input.employeeId, runId, lastEventId, this.codeOf(error))
      }
    }

    const awaitingInput = result?.awaiting_input
      ? staffdeckAwaitingInputSchema.parse(result.awaiting_input)
      : null
    // 服务端 reply 是权威终稿；为空时（实测 completed 不带正文）退回 delta 累积。
    const finalText = result && result.reply.trim() ? result.reply : state.text
    const phase: RemoteRunPhase = awaitingInput ? 'awaiting_input' : 'completed'

    return this.finishSuccess(
      input,
      state,
      runId,
      flusher,
      phase,
      degradedCode,
      lastEventId,
      finalText,
      awaitingInput
    )
  }

  /** 绑定缺失时先建远端会话：靠 external_session_id 拿服务端幂等的原会话。 */
  private async ensureBinding(
    sessionId: string,
    employeeId: string,
    input: string
  ): Promise<RemoteSessionBinding | null> {
    const existing = this.deps.registry.get(sessionId)
    if (existing) return existing

    try {
      const created = await this.deps.client.createSession({
        employeeId,
        externalSessionId: sessionId,
        title: input.slice(0, 80) || employeeId,
        metadata: { source: 'deepchat' }
      })
      const binding: RemoteSessionBinding = {
        remoteSessionId: created.id,
        employeeId,
        runId: null,
        lastEventId: null,
        executionMode: 'remote'
      }
      this.deps.registry.set(sessionId, binding)
      return binding
    } catch {
      // 建会话失败不写半条绑定：空 remoteSessionId 会让后续所有轮次都指向无效会话。
      return null
    }
  }

  /**
   * 返回终止事件名表示这一帧结束本轮；否则返回 null。
   *
   * `run.failed` 额外把帧体里的真实 code 记进 `state`，由 `execute` 取用：
   * 终止事件名只说「失败了」，说不出失败原因。
   */
  private applyFrame(
    state: StreamState,
    frame: StaffdeckSseFrame,
    flusher: ReturnType<StaffdeckRemoteRunner['createFlusher']>
  ): string | null {
    const name = frame.event
    if (!name) return null

    if (name === 'run.output.delta') {
      const content = readContent(frame)
      if (content) {
        state.text += content
        flusher.schedule(state.text)
      }
      return null
    }

    if (name === 'run.output.replace') {
      // 服务端当前没有产生点（runs.py:50 仅存在于映射表）。收到时按
      // 「替换累积值」处理，将来真上线也不会重复拼接。
      const content = readContent(frame)
      if (content !== null) {
        state.text = content
        flusher.schedule(state.text)
      }
      return null
    }

    if (
      name === 'run.output.completed' ||
      name === 'run.succeeded' ||
      name === 'run.failed' ||
      name === 'run.cancelled'
    ) {
      if (name === 'run.failed') state.failureCode = readFailureCode(frame)
      return name
    }

    return null
  }

  /** 成功/取消的收尾：落库终稿、标记 sent、发 completed 与相位事件。 */
  private finishSuccess(
    input: RemoteRunInput,
    state: StreamState,
    runId: string,
    flusher: ReturnType<StaffdeckRemoteRunner['createFlusher']>,
    phase: RemoteRunPhase,
    degradedCode: string | null,
    lastEventId?: string | null,
    finalText?: string,
    awaitingInput: StaffdeckAwaitingInput | null = null
  ): RemoteRunOutcome {
    const text = finalText ?? state.text
    state.text = text
    state.finished = true

    if (lastEventId !== undefined) {
      this.deps.registry.update(input.sessionId, { runId, lastEventId })
    }

    flusher.finish(text, 'success')
    this.deps.transcript.updateMessageStatus(state.messageId, 'sent')

    this.deps.publishEvent('chat.stream.completed', {
      requestId: runId,
      sessionId: input.sessionId,
      messageId: state.messageId,
      completedAt: this.now
    })
    this.emitPhase(input.sessionId, input.employeeId, phase, runId, degradedCode)

    return {
      phase,
      text,
      runId,
      messageId: state.messageId,
      awaitingInput,
      messageCode: degradedCode
    }
  }

  private createFlusher(state: StreamState): {
    schedule(text: string): void
    finish(text: string, status: 'success' | 'error'): void
  } {
    let lastRendererFlush = Number.NEGATIVE_INFINITY
    let lastDbFlush = Number.NEGATIVE_INFINITY

    const buildBlocks = (text: string, status: 'success' | 'error'): AssistantMessageBlock[] => [
      {
        id: CONTENT_BLOCK_ID,
        type: 'content',
        content: text,
        status: status === 'error' ? 'error' : 'success',
        timestamp: this.now
      }
    ]

    const publishSnapshot = (text: string, status: 'success' | 'error'): void => {
      this.deps.publishEvent('chat.stream.updated', {
        kind: 'snapshot',
        requestId: state.messageId,
        sessionId: state.sessionId,
        messageId: state.messageId,
        updatedAt: this.now,
        // cloneBlocksForRenderer 会跑 zod 校验，block 必须满足 renderer 契约。
        blocks: cloneBlocksForRenderer(buildBlocks(text, status))
      })
    }

    const schedule = (text: string): void => {
      const current = this.now
      if (current - lastRendererFlush >= this.rendererInterval) {
        lastRendererFlush = current
        publishSnapshot(text, 'success')
      }
      if (current - lastDbFlush >= this.dbInterval) {
        lastDbFlush = current
        this.deps.transcript.updateAssistantContent(state.messageId, buildBlocks(text, 'success'))
      }
    }

    const finish = (text: string, status: 'success' | 'error'): void => {
      this.deps.transcript.updateAssistantContent(state.messageId, buildBlocks(text, status))
      publishSnapshot(text, status)
    }

    return { schedule, finish }
  }

  private failRun(
    state: StreamState,
    employeeId: string,
    runId: string | null,
    lastEventId: string | null,
    messageCode: string
  ): RemoteRunOutcome {
    // 失败也保留已累积正文：半篇回答对用户仍可能有价值。
    if (!state.finished) {
      state.finished = true
      this.deps.transcript.updateAssistantContent(state.messageId, [
        {
          id: CONTENT_BLOCK_ID,
          type: 'content',
          content: state.text,
          status: 'error',
          timestamp: this.now
        }
      ])
      this.deps.transcript.updateMessageStatus(state.messageId, 'error')
    }
    if (runId && lastEventId) {
      this.deps.registry.update(state.sessionId, { runId, lastEventId })
    }

    // 先决定降级再发事件：事件里要带上结论，renderer 才不会在收到「失败」之后
    // 还要自己去问一遍「那下一轮走哪儿」。
    const fellBackToLocal = this.shouldFallBackToLocal(state.sessionId)

    this.deps.publishEvent('chat.stream.failed', {
      requestId: runId ?? state.messageId,
      sessionId: state.sessionId,
      messageId: state.messageId,
      failedAt: this.now,
      // 只放错误码，绝不拼服务端 detail（可能含内部路径）。
      error: messageCode
    })
    this.emitPhase(state.sessionId, employeeId, 'failed', runId, messageCode, fellBackToLocal)

    return { ...this.failureOutcome(runId, state.messageId, messageCode, state.text), fellBackToLocal }
  }

  /**
   * 只有 hybrid 会话可以把失败降级成本地执行。
   *
   * remote 员工不能降级：它的提示词、知识库、工具都在服务端，本地跑出来的是
   * 另一个员工，比报错更糟。绑定表里 `executionMode` 是唯一判据——它由
   * `switchToRemote` 写入 `hybrid`，由 `bind` 写入 `remote`。
   *
   * 解除绑定而不是把模式改回 local：本地的 `ChatService` 只看 `has`，
   * 表里留一条 `local` 记录等于埋一个永远不走的分支。
   */
  private shouldFallBackToLocal(sessionId: string): boolean {
    const binding = this.deps.registry.get(sessionId)
    if (!binding || binding.executionMode !== 'hybrid') return false
    this.deps.registry.delete(sessionId)
    return true
  }

  private emitPhase(
    sessionId: string,
    employeeId: string,
    phase: 'started' | 'awaiting_input' | 'completed' | 'failed' | 'cancelled',
    runId: string | null,
    messageCode: string | null,
    fallbackToLocal = false
  ): void {
    this.deps.publishEvent('digitalEmployee.remoteRunUpdated', {
      sessionId,
      employeeId,
      phase,
      ...(runId ? { runId } : {}),
      ...(messageCode ? { messageCode } : {}),
      ...(fallbackToLocal ? { fallbackToLocal: true } : {}),
      updatedAt: this.now
    })
  }

  /** 指数退避续传；全部失败返回 false，由调用方按传输失败收尾。 */
  private async resumeWithRetry(
    input: { runId: string; lastEventId: string | null },
    onFrame: StaffdeckFrameHandler
  ): Promise<boolean> {
    const sleep =
      this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

    for (let attempt = 0; attempt < MAX_RESUME_ATTEMPTS; attempt += 1) {
      try {
        await this.deps.client.resumeRun(input, onFrame)
        return true
      } catch {
        if (attempt === MAX_RESUME_ATTEMPTS - 1) return false
        await sleep(200 * 2 ** attempt)
      }
    }
    return false
  }

  private failureOutcome(
    runId: string | null,
    messageId: string | null,
    messageCode: string,
    text = ''
  ): RemoteRunOutcome {
    return {
      phase: 'failed',
      text,
      runId,
      messageId,
      awaitingInput: null,
      messageCode
    }
  }

  /** 只取结构化 code；普通 Error 归为传输失败，绝不把 message 当错误码。 */
  private codeOf(error: unknown): string {
    if (error instanceof StaffdeckProblemError) return error.code
    if (error instanceof Error && /terminal event/i.test(error.message)) {
      return STREAM_INTERRUPTED_CODE
    }
    return TRANSPORT_ERROR_CODE
  }
}

/** 从 SSE 帧的 JSON 文本里取 content；非法 JSON 返回 null。 */
function readContent(frame: StaffdeckSseFrame): string | null {
  try {
    const parsed: unknown = JSON.parse(frame.data || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>).content
      return typeof value === 'string' ? value : null
    }
    return null
  } catch {
    return null
  }
}

/**
 * 取 `run.failed` 帧体里的真实失败码。
 *
 * 服务端在 `error_occurred` 里带 `{"code", "message"}`（agent_loop.py 的
 * LLM_ERROR / HARNESS_V2_ERROR 等）。只取 `code`，`message` 可能含内部细节，
 * 一律不出本进程。缺失或非字符串时回落到通用码。
 */
function readFailureCode(frame: StaffdeckSseFrame): string {
  try {
    const parsed: unknown = JSON.parse(frame.data || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>).code
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return RUN_FAILED_CODE
  } catch {
    return RUN_FAILED_CODE
  }
}
