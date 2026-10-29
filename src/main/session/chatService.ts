import type {
  ChatMessageRecord,
  MessageStartResult,
  SendMessageInput,
  SessionWithState,
  ToolInteractionResponse,
  ToolInteractionResult
} from '@shared/types/agent-interface'
import type { SessionPermissionPort } from '@/session/contracts'
import type { Scheduler } from '@/routes/scheduler'

const CHAT_LOOKUP_TIMEOUT_MS = 5_000
const CHAT_SEND_TIMEOUT_MS = 30 * 60 * 1_000
const CHAT_STOP_TIMEOUT_MS = 5_000
const CHAT_INTERACTION_TIMEOUT_MS = CHAT_SEND_TIMEOUT_MS

/** 把调用方的取消信号转发到内部 controller；返回解绑函数供 finally 清理。 */
function relayAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {}
  const abortTarget = () => target.abort()
  if (source.aborted) {
    abortTarget()
    return () => {}
  }
  source.addEventListener('abort', abortTarget, { once: true })
  return () => source.removeEventListener('abort', abortTarget)
}

export interface ChatServiceTurnPort {
  sendMessage(
    sessionId: string,
    content: string | SendMessageInput,
    options?: { signal?: AbortSignal }
  ): Promise<MessageStartResult>
  steerActiveTurn(
    sessionId: string,
    content: string | SendMessageInput,
    options?: { signal?: AbortSignal }
  ): Promise<MessageStartResult>
  cancelGeneration(sessionId: string): Promise<void>
  respondToolInteraction(
    sessionId: string,
    messageId: string,
    toolCallId: string,
    response: ToolInteractionResponse
  ): Promise<ToolInteractionResult>
  dismissToolInteraction(sessionId: string, messageId: string, toolCallId: string): Promise<boolean>
}

export interface ChatRespondToolInteractionInput {
  sessionId: string
  messageId: string
  toolCallId: string
  response: ToolInteractionResponse
}

/** 统一把 string 与结构化输入归一为 SendMessageInput，供远端端口消费。 */
export function normalizeSendMessageInput(content: string | SendMessageInput): SendMessageInput {
  return typeof content === 'string' ? { text: content } : content
}

export interface ChatServiceProjectionPort {
  getSession(sessionId: string): Promise<SessionWithState | null>
  getMessage(messageId: string): Promise<ChatMessageRecord | null>
}

/**
 * 远端（StaffDeck）轮次的执行端口。
 *
 * `handles` 只读主进程的会话绑定表：分流不能依赖 renderer 状态，
 * 否则进程重启或另一个窗口写入后分流结果会不一致。
 */
export interface ChatServiceRemoteTurnPort {
  handles(sessionId: string): boolean
  send(
    sessionId: string,
    content: SendMessageInput
  ): Promise<{
    accepted: boolean
    requestId: string | null
    messageId: string | null
  }>
}

/**
 * 会话聊天路由层（ChatService）：把渲染层的聊天动作（发送/steer/停止/工具
 * 交互）转交给 turn 层，并在外面套上超时与取消。
 *
 * 与各模块的关系：真正执行走 turn 端口（SessionTurn）；会话/消息查询走
 * projection 端口（SessionQuery）；远端（StaffDeck 托管）会话经 remoteTurn
 * 端口分流，不进本地 runtime。生成并发本身由 agent runtime 的队列/挂起
 * 机制管理，这里的 AbortController 只负责「接受阶段」的路由级取消——超时
 * 或上层信号触发时中断在途的接受过程，并尽力撤销已开始的生成。
 */
export class ChatService {
  /** 每会话一组在途 accept 的 controller；停止时统一 abort。 */
  private readonly acceptControllers = new Map<string, Set<AbortController>>()

  constructor(
    private readonly deps: {
      turn: ChatServiceTurnPort
      projection: ChatServiceProjectionPort
      sessionPermissionPort: Pick<SessionPermissionPort, 'clearSessionPermissions'>
      scheduler: Scheduler
      /** 缺省表示不启用远端分流（StatusDeck 未配置时），本地链路完全不变。 */
      remoteTurn?: ChatServiceRemoteTurnPort
    }
  ) {}

  /**
   * 发送消息。带会话查找与发送两段超时；超时即 abort 在途 accept 并尽力
   * 取消生成。accepted 反映消息是否被接受（附件需用户处理时为 false）。
   */
  async sendMessage(
    sessionId: string,
    content: string | SendMessageInput,
    options?: { signal?: AbortSignal }
  ): Promise<{
    accepted: boolean
    requestId: string | null
    messageId: string | null
    attachmentPreparation?: MessageStartResult['attachmentPreparation']
  }> {
    const controller = new AbortController()
    const removeParentAbortListener = relayAbort(options?.signal, controller)
    const controllers = this.acceptControllers.get(sessionId) ?? new Set<AbortController>()
    controllers.add(controller)
    this.acceptControllers.set(sessionId, controllers)

    try {
      const session = await this.deps.scheduler.timeout({
        task: this.deps.projection.getSession(sessionId),
        ms: CHAT_LOOKUP_TIMEOUT_MS,
        reason: `chat.sendMessage:${sessionId}:session`,
        signal: controller.signal
      })

      if (!session) {
        throw new Error(`Session not found: ${sessionId}`)
      }

      // 远端会话：整轮交给 StaffDeck 执行器，本服务不再进入 turn/runtime 路径。
      // 必须在 session 存在性校验之后分流——往不存在的会话写消息会留下孤儿记录。
      if (this.deps.remoteTurn?.handles(sessionId)) {
        return await this.deps.remoteTurn.send(sessionId, normalizeSendMessageInput(content))
      }

      const result = await this.deps.scheduler.timeout({
        task: this.deps.turn.sendMessage(sessionId, content, { signal: controller.signal }),
        ms: CHAT_SEND_TIMEOUT_MS,
        reason: `chat.sendMessage:${sessionId}`,
        signal: controller.signal
      })

      return {
        accepted: result.attachmentPreparation?.status !== 'needs_user_action',
        requestId: result.requestId,
        messageId: result.messageId,
        ...(result.attachmentPreparation
          ? { attachmentPreparation: result.attachmentPreparation }
          : {})
      }
    } catch (error) {
      // 发送超时说明运行时可能已卡住：abort 本路 accept，并尽力停掉生成。
      if (error instanceof Error && error.name === 'TimeoutError') {
        controller.abort()
        await this.bestEffortCancel(sessionId, 'send timeout')
      }
      throw error
    } finally {
      removeParentAbortListener()
      // 从在途集合移除自身；集合空了就删键，避免 Map 随会话无限增长。
      const activeControllers = this.acceptControllers.get(sessionId)
      activeControllers?.delete(controller)
      if (activeControllers?.size === 0) {
        this.acceptControllers.delete(sessionId)
      }
    }
  }

  /**
   * 向运行中的轮次插话（steer）。返回区分「已接受（附落库的用户消息）」与
   * 「未接受（附件需处理）」两种结果；接受却没落库视为内部错误。
   */
  async steerActiveTurn(
    sessionId: string,
    content: string | SendMessageInput,
    options?: { signal?: AbortSignal }
  ): Promise<
    | {
        accepted: true
        message: ChatMessageRecord
        attachmentPreparation?: MessageStartResult['attachmentPreparation']
      }
    | {
        accepted: false
        message: null
        attachmentPreparation?: MessageStartResult['attachmentPreparation']
      }
  > {
    const controller = new AbortController()
    const removeParentAbortListener = relayAbort(options?.signal, controller)
    const controllers = this.acceptControllers.get(sessionId) ?? new Set<AbortController>()
    controllers.add(controller)
    this.acceptControllers.set(sessionId, controllers)

    try {
      const session = await this.deps.scheduler.timeout({
        task: this.deps.projection.getSession(sessionId),
        ms: CHAT_LOOKUP_TIMEOUT_MS,
        reason: `chat.steerActiveTurn:${sessionId}:session`,
        signal: controller.signal
      })

      if (!session) {
        throw new Error(`Session not found: ${sessionId}`)
      }

      // 远端会话不在此分流：steer 的语义是「打断并改向正在生成的本地轮次」，
      // 远端 run 没有对应的可插话通道，静默丢进 send 会让同一段话被当成新一轮。
      const result = await this.deps.scheduler.timeout({
        task: this.deps.turn.steerActiveTurn(sessionId, content, { signal: controller.signal }),
        ms: CHAT_SEND_TIMEOUT_MS,
        reason: `chat.steerActiveTurn:${sessionId}`,
        signal: controller.signal
      })

      if (result.attachmentPreparation?.status === 'needs_user_action') {
        return {
          accepted: false,
          message: null,
          attachmentPreparation: result.attachmentPreparation
        }
      }

      if (!result.userMessage) {
        throw new Error(`Steer accepted without a persisted user message: ${sessionId}`)
      }

      return {
        accepted: true,
        message: result.userMessage,
        ...(result.attachmentPreparation
          ? { attachmentPreparation: result.attachmentPreparation }
          : {})
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        controller.abort()
        await this.bestEffortCancel(sessionId, 'steer timeout')
      }
      throw error
    } finally {
      removeParentAbortListener()
      const activeControllers = this.acceptControllers.get(sessionId)
      activeControllers?.delete(controller)
      if (activeControllers?.size === 0) {
        this.acceptControllers.delete(sessionId)
      }
    }
  }

  /**
   * 停止生成。可按 sessionId 停，也可只给 requestId（先反查消息归属的
   * 会话）。停止时同时清掉该会话的临时权限授权并取消生成；两者独立
   * allSettled，任一失败不影响另一个。stopped 表示取消是否成功。
   */
  async stopStream(input: {
    sessionId?: string
    requestId?: string
  }): Promise<{ stopped: boolean }> {
    let targetSessionId = input.sessionId ?? null

    if (!targetSessionId && input.requestId) {
      const message = await this.deps.scheduler.timeout({
        task: this.deps.projection.getMessage(input.requestId),
        ms: CHAT_LOOKUP_TIMEOUT_MS,
        reason: `chat.stopStream:${input.requestId}:message`
      })
      targetSessionId = message?.sessionId ?? null
    }

    if (!targetSessionId) {
      return { stopped: false }
    }

    // 先中断所有在途 accept，再做停止清理。
    const controllers = this.acceptControllers.get(targetSessionId)
    if (controllers) {
      for (const controller of controllers) {
        controller.abort()
      }
      this.acceptControllers.delete(targetSessionId)
    }

    let cancelFailed = false
    try {
      await this.deps.scheduler.timeout({
        task: Promise.allSettled([
          Promise.resolve().then(() =>
            this.deps.sessionPermissionPort.clearSessionPermissions(targetSessionId)
          ),
          Promise.resolve().then(() => this.deps.turn.cancelGeneration(targetSessionId))
        ]).then((results) => {
          const clearPermissionsResult = results[0]
          if (clearPermissionsResult?.status === 'rejected') {
            console.warn(
              `[ChatService] Failed to clear session permissions during stop for ${targetSessionId}:`,
              clearPermissionsResult.reason
            )
          }

          const cancelGenerationResult = results[1]
          if (cancelGenerationResult?.status === 'rejected') {
            cancelFailed = true
            console.warn(
              `[ChatService] Failed to cancel generation during stop for ${targetSessionId}:`,
              cancelGenerationResult.reason
            )
          }
        }),
        ms: CHAT_STOP_TIMEOUT_MS,
        reason: `chat.stopStream:${targetSessionId}`
      })
    } catch (error) {
      cancelFailed = true
      console.warn(`[ChatService] Stop cleanup timed out for ${targetSessionId}:`, error)
    }

    return { stopped: !cancelFailed }
  }

  /** 应答工具交互（如权限批准/拒绝）；超时上限与发送一致（交互可能挂很久）。 */
  async respondToolInteraction(input: ChatRespondToolInteractionInput): Promise<{
    accepted: true
    resumed?: boolean
    waitingForUserMessage?: boolean
    handledInline?: boolean
  }> {
    const result = await this.deps.scheduler.timeout({
      task: this.deps.turn.respondToolInteraction(
        input.sessionId,
        input.messageId,
        input.toolCallId,
        input.response
      ),
      ms: CHAT_INTERACTION_TIMEOUT_MS,
      reason: `chat.respondToolInteraction:${input.sessionId}:${input.toolCallId}`
    })

    return {
      accepted: true,
      ...result
    }
  }

  /** 关闭一个工具交互卡片。 */
  async dismissToolInteraction(input: {
    sessionId: string
    messageId: string
    toolCallId: string
  }): Promise<{ dismissed: boolean }> {
    const dismissed = await this.deps.scheduler.timeout({
      task: this.deps.turn.dismissToolInteraction(
        input.sessionId,
        input.messageId,
        input.toolCallId
      ),
      ms: CHAT_INTERACTION_TIMEOUT_MS,
      reason: `chat.dismissToolInteraction:${input.sessionId}:${input.toolCallId}`
    })

    return { dismissed }
  }

  /**
   * 超时后的尽力撤销：清临时权限 + 取消生成并行执行，任何失败只告警不抛——
   * 调用点本身已在处理超时错误，撤销失败没有更好的处置。
   */
  private async bestEffortCancel(sessionId: string, reason: string): Promise<void> {
    let cleanupResults: PromiseSettledResult<void>[]
    try {
      cleanupResults = await this.deps.scheduler.timeout({
        task: Promise.allSettled([
          Promise.resolve().then(() =>
            this.deps.sessionPermissionPort.clearSessionPermissions(sessionId)
          ),
          Promise.resolve().then(() => this.deps.turn.cancelGeneration(sessionId))
        ]),
        ms: CHAT_STOP_TIMEOUT_MS,
        reason: `chat.bestEffortCancel:${sessionId}`
      })
    } catch (error) {
      console.warn(`[ChatService] Cleanup timed out after ${reason} for ${sessionId}:`, error)
      return
    }
    const clearPermissionsResult = cleanupResults[0]
    if (clearPermissionsResult?.status === 'rejected') {
      console.warn(
        `[ChatService] Failed to clear session permissions after ${reason} for ${sessionId}:`,
        clearPermissionsResult.reason
      )
    }
    const cancelGenerationResult = cleanupResults[1]
    if (cancelGenerationResult?.status === 'rejected') {
      console.warn(
        `[ChatService] Failed to cancel generation after ${reason} for ${sessionId}:`,
        cancelGenerationResult.reason
      )
    }
  }
}
