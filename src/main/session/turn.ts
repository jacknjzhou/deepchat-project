import { toAppSessionId } from '@/agent/shared/agentSessionIds'
import { normalizeSendMessageInput } from '@/agent/shared/agentSessionNormalization'
import type {
  AttachmentFallbackPolicy,
  ChatMessageRecord,
  MessageStartResult,
  PendingSessionInputRecord,
  SendMessageInput,
  SessionCompactionSnapshot,
  SessionCompactionState,
  SessionContextOccupancySnapshot,
  ToolInteractionResponse,
  ToolInteractionResult
} from '@shared/types/agent-interface'
import type {
  SessionAssignmentWorkdirPort,
  SessionInitialTurnInput,
  SessionInitialTurnPort,
  SessionTurnPort,
  SessionTurnProjectionPort,
  SessionTurnRuntimePort,
  SessionTurnStorePort,
  SessionTurnTranscriptPort
} from './contracts'

export interface SessionTurnDependencies {
  sessions: SessionTurnStorePort
  runtime: SessionTurnRuntimePort
  transcript: SessionTurnTranscriptPort
  workdir: SessionAssignmentWorkdirPort
  projection: SessionTurnProjectionPort
}

/** 「用户取消」与真实失败的区分；取消需沿原错误上抛给回收逻辑。 */
function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
}

/**
 * 会话轮次（turn）模块：覆盖一条消息从发出到响应结束的整条链路。
 *
 * 五类操作：
 * 1. 发送——startInitialTurn（建会话时的首轮）与 sendMessage（常规发送）；
 * 2. 运行中干预——steerActiveTurn 向正在生成的轮次注入新指令；
 * 3. 待发队列——排队/编辑/排序/转 steering/删除，以及断线后的队列恢复与重试；
 * 4. 消息维护——重试、删除、编辑、清空会话消息；
 * 5. 上下文管理——压缩快照/手动压缩、占用统计，以及工具交互（权限询问等）的
 *    应答与关闭。
 *
 * 所有写操作都经 runWithSessionOperationGate 串行化，防止同会话操作交错；
 * ACP 会话没有压缩/占用等深运行时能力，对应接口返回固定空值或显式报错。
 * 草稿会话在首次被接受（发送/排队）时转正：摘掉 draft 标记并用首条消息定标题。
 */
export class SessionTurn implements SessionTurnPort, SessionInitialTurnPort {
  constructor(private readonly dependencies: SessionTurnDependencies) {}

  /**
   * 建会话后启动首轮生成。空内容（无文本无附件）直接跳过。
   *
   * Office Agent（deepchat）路径同步等待发送结果；附件准备不通过时返回
   * needs_user_action 让 UI 给出「重试/去图重发」选项，而不是让整个建会话
   * 失败。ACP 路径 fire-and-forget：外部 agent 的首轮结果不走本地回执。
   * 失败吞掉并返回 undefined——首轮失败不该回滚已创建的会话；只有用户
   * 取消（abort）才向上抛，由 lifecycle 决定是否回收。
   */
  async startInitialTurn(input: SessionInitialTurnInput): Promise<MessageStartResult | undefined> {
    const content = input.content
    if (!content.text.trim() && (content.files?.length ?? 0) === 0) return undefined
    input.signal?.throwIfAborted()

    try {
      const runtime = this.dependencies.runtime.resolveSession(toAppSessionId(input.sessionId))
      let result: MessageStartResult = { requestId: null, messageId: null }
      if (runtime.kind === 'deepchat') {
        try {
          result = await runtime.send({
            content,
            context: {
              projectDir: input.projectDir,
              ...(input.signal ? { signal: input.signal } : {})
            },
            queue: { source: 'send', projectDir: input.projectDir }
          })
        } catch (error) {
          if (isAbortError(error, input.signal)) throw error
          if ((content.files?.length ?? 0) === 0) throw error
          // 仅带附件的首轮失败降级为「需用户处理」：会话保留，让用户选择
          // 重试或去掉图片内容再发。
          console.error('[SessionTurn] initial attachment acceptance failed:', error)
          return {
            requestId: null,
            messageId: null,
            attachmentPreparation: {
              status: 'needs_user_action',
              issues: [],
              suggestedActions: ['retry', 'send_without_image_content']
            }
          }
        }
        if (result.attachmentPreparation?.status === 'needs_user_action') {
          return result
        }
      } else {
        // ACP 首轮不等结果：外部 agent 进程自行推进，失败仅记录。
        void runtime
          .send({
            content,
            context: {
              projectDir: input.projectDir,
              ...(input.signal ? { signal: input.signal } : {})
            },
            queue: { source: 'send', projectDir: input.projectDir }
          })
          .catch((error) => {
            console.error('[SessionTurn] initial send failed:', error)
          })
      }
      // 首轮已发出后安排异步标题生成（用初始标题做防覆盖基准）。
      this.dependencies.projection.scheduleTitleGeneration({
        sessionId: input.sessionId,
        initialTitle: input.initialTitle,
        fallbackProviderId: input.fallbackProviderId,
        fallbackModelId: input.fallbackModelId
      })
      return result
    } catch (error) {
      if (isAbortError(error, input.signal)) throw error
      console.error('[SessionTurn] initial send failed:', error)
      return undefined
    }
  }

  /** 常规发送入口：进会话操作门后执行门内流程。 */
  async sendMessage(
    sessionId: string,
    content: string | SendMessageInput,
    options?: { maxProviderRounds?: number; signal?: AbortSignal }
  ): Promise<MessageStartResult> {
    return await this.dependencies.workdir.runWithSessionOperationGate(
      sessionId,
      async () => await this.sendMessageUnderSessionGate(sessionId, content, options)
    )
  }

  /**
   * 门内的常规发送：校验工作目录（ACP 会话必须有）并同步 ACP 侧目录后
   * 交给运行时。附件需用户处理时直接返回，不转正草稿。发送被接受后才
   * 转正草稿会话——转正意味着会话在列表中可见，接受前失败应当无声消失。
   * 非草稿且原本无消息的会话同样安排标题生成。
   */
  private async sendMessageUnderSessionGate(
    sessionId: string,
    content: string | SendMessageInput,
    options?: { maxProviderRounds?: number; signal?: AbortSignal }
  ): Promise<MessageStartResult> {
    let session = this.requireSession(sessionId)
    const wasDraft = session.isDraft
    const normalizedInput = normalizeSendMessageInput(content)

    const runtime = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
    const state = await runtime.snapshot()
    const hadMessages = await this.dependencies.transcript.hasMessages(sessionId)
    // ACP 会话要求绑定工作目录；先校验再同步，避免目录漂移后消息发错位置。
    const providerId = this.resolveProviderId(runtime.kind, state?.providerId)
    this.dependencies.workdir.assertAcpSessionHasWorkdir(providerId, session.projectDir ?? null)
    await this.dependencies.workdir.syncAcpSessionWorkdir(
      providerId,
      sessionId,
      session.agentId,
      session.projectDir ?? null
    )
    const result = await runtime.send({
      content: normalizedInput,
      context: {
        projectDir: session.projectDir ?? null,
        maxProviderRounds: options?.maxProviderRounds,
        ...(options?.signal ? { signal: options.signal } : {})
      },
      queue: {
        source: 'send',
        projectDir: session.projectDir ?? null
      }
    })
    // 附件未通过准备：草稿保持草稿，由用户决定下一步。
    if (result.attachmentPreparation?.status === 'needs_user_action') {
      return result
    }
    const acceptedSession = this.requireSession(sessionId)
    if (acceptedSession.isDraft) {
      this.promoteDraft(sessionId, normalizedInput)
      session = this.requireSession(sessionId)
    } else {
      session = acceptedSession
    }
    if (!hadMessages && !wasDraft) {
      this.dependencies.projection.scheduleTitleGeneration({
        sessionId,
        initialTitle: session.title,
        fallbackProviderId: providerId,
        fallbackModelId: state?.modelId ?? ''
      })
    }
    return result
  }

  /** 向正在生成的轮次追加指令（steering），不结束当前轮。门内执行。 */
  async steerActiveTurn(
    sessionId: string,
    content: string | SendMessageInput,
    options?: { signal?: AbortSignal }
  ): Promise<MessageStartResult> {
    return await this.dependencies.workdir.runWithSessionOperationGate(
      sessionId,
      async () => await this.steerActiveTurnUnderSessionGate(sessionId, content, options)
    )
  }

  private async steerActiveTurnUnderSessionGate(
    sessionId: string,
    content: string | SendMessageInput,
    options?: { signal?: AbortSignal }
  ): Promise<MessageStartResult> {
    const session = this.requireSession(sessionId)
    const normalizedInput = normalizeSendMessageInput(content)

    const runtime = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
    const state = await runtime.snapshot()
    const providerId = this.resolveProviderId(runtime.kind, state?.providerId)
    this.dependencies.workdir.assertAcpSessionHasWorkdir(providerId, session.projectDir ?? null)
    await this.dependencies.workdir.syncAcpSessionWorkdir(
      providerId,
      sessionId,
      session.agentId,
      session.projectDir ?? null
    )
    const result = options?.signal
      ? await runtime.pending.steerActiveTurn(normalizedInput, { signal: options.signal })
      : await runtime.pending.steerActiveTurn(normalizedInput)
    if (result.attachmentPreparation?.status === 'needs_user_action') {
      return result
    }
    const acceptedSession = this.requireSession(sessionId)
    if (acceptedSession.isDraft) {
      this.promoteDraft(sessionId, normalizedInput)
    }
    return result
  }

  /** 列出该会话排队中的待发输入；会话不存在视为空列表。 */
  async listPendingInputs(sessionId: string): Promise<PendingSessionInputRecord[]> {
    if (!this.dependencies.sessions.get(sessionId)) return []
    return await this.dependencies.runtime.resolveSession(toAppSessionId(sessionId)).pending.list()
  }

  /** 排队输入的断点续跑是否可用；仅 Office Agent 会话支持。 */
  async isPendingQueueResumeAvailable(sessionId: string): Promise<boolean> {
    if (!this.dependencies.sessions.get(sessionId)) return false
    const runtime = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
    return runtime.kind === 'deepchat' && (await runtime.isPendingQueueResumeAvailable())
  }

  /** 恢复中断前排队中的输入继续执行；仅 Office Agent 会话支持。 */
  async resumePendingQueue(sessionId: string): Promise<boolean> {
    return await this.dependencies.workdir.runWithSessionOperationGate(sessionId, async () => {
      this.requireSession(sessionId)
      const runtime = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
      if (runtime.kind !== 'deepchat') {
        throw new Error('Pending queue resume is only available for Office Agent sessions.')
      }
      return await runtime.resumePendingQueue()
    })
  }

  /** 重试队列中某条失败/被阻塞的输入。 */
  async retryPendingQueueInput(
    sessionId: string,
    itemId: string
  ): Promise<{ accepted: boolean; started: boolean }> {
    return await this.dependencies.workdir.runWithSessionOperationGate(sessionId, async () => {
      this.requireSession(sessionId)
      const runtime = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
      if (runtime.kind !== 'deepchat') {
        throw new Error('Pending queue retry is only available for Office Agent sessions.')
      }
      return await runtime.retryPendingQueueInput(itemId)
    })
  }

  /** 把一条输入加入待发队列；草稿会话先转正再排队。 */
  async queuePendingInput(
    sessionId: string,
    content: string | SendMessageInput
  ): Promise<PendingSessionInputRecord> {
    return await this.dependencies.workdir.runWithSessionOperationGate(
      sessionId,
      async () => await this.queuePendingInputUnderSessionGate(sessionId, content)
    )
  }

  private async queuePendingInputUnderSessionGate(
    sessionId: string,
    content: string | SendMessageInput
  ): Promise<PendingSessionInputRecord> {
    let session = this.requireSession(sessionId)
    const normalizedInput = normalizeSendMessageInput(content)
    if (session.isDraft) {
      this.promoteDraft(sessionId, normalizedInput)
      session = this.dependencies.sessions.get(sessionId) ?? session
    }

    const runtime = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
    const state = await runtime.snapshot()
    const providerId = this.resolveProviderId(runtime.kind, state?.providerId)
    this.dependencies.workdir.assertAcpSessionHasWorkdir(providerId, session.projectDir ?? null)
    await this.dependencies.workdir.syncAcpSessionWorkdir(
      providerId,
      sessionId,
      session.agentId,
      session.projectDir ?? null
    )
    return await runtime.pending.queue(normalizedInput, {
      source: 'queue',
      projectDir: session.projectDir ?? null
    })
  }

  /** 编辑一条排队中的输入内容。 */
  async updateQueuedInput(
    sessionId: string,
    itemId: string,
    content: string | SendMessageInput
  ): Promise<PendingSessionInputRecord> {
    this.requireSession(sessionId)
    return await this.dependencies.runtime
      .resolveSession(toAppSessionId(sessionId))
      .pending.update(itemId, normalizeSendMessageInput(content))
  }

  /** 调整排队顺序，返回调整后的完整队列。 */
  async moveQueuedInput(
    sessionId: string,
    itemId: string,
    toIndex: number
  ): Promise<PendingSessionInputRecord[]> {
    this.requireSession(sessionId)
    return await this.dependencies.runtime
      .resolveSession(toAppSessionId(sessionId))
      .pending.move(itemId, toIndex)
  }

  /** 旧接口名：把排队输入转为对当前轮的 steering，实现同 steerPendingInput。 */
  async convertPendingInputToSteer(
    sessionId: string,
    itemId: string
  ): Promise<PendingSessionInputRecord> {
    return await this.steerPendingInput(sessionId, itemId)
  }

  /** 把排队输入转为 steering：当前轮跑到合适时机会吸收这条内容。 */
  async steerPendingInput(sessionId: string, itemId: string): Promise<PendingSessionInputRecord> {
    this.requireSession(sessionId)
    return await this.dependencies.runtime
      .resolveSession(toAppSessionId(sessionId))
      .pending.steer(itemId)
  }

  /** 处理被附件问题阻塞的排队输入：重试或去掉图片内容后放行。 */
  async resolveBlockedPendingInput(
    sessionId: string,
    itemId: string,
    action: 'retry' | 'send_without_image_content'
  ): Promise<PendingSessionInputRecord> {
    this.requireSession(sessionId)
    return await this.dependencies.runtime
      .resolveSession(toAppSessionId(sessionId))
      .pending.resolveBlocked(itemId, action)
  }

  /** 删除一条排队输入。 */
  async deletePendingInput(sessionId: string, itemId: string): Promise<void> {
    this.requireSession(sessionId)
    await this.dependencies.runtime.resolveSession(toAppSessionId(sessionId)).pending.delete(itemId)
  }

  /** 重发历史中的某条消息：从该处截断后续历史并重新生成。 */
  async retryMessage(
    sessionId: string,
    messageId: string,
    options?: { attachmentFallbackPolicy?: AttachmentFallbackPolicy }
  ): Promise<MessageStartResult> {
    return await this.dependencies.workdir.runWithSessionOperationGate(
      sessionId,
      async () => await this.retryMessageUnderSessionGate(sessionId, messageId, options)
    )
  }

  /**
   * 门内的重试实现。两种截断时机：
   * - ACP：发送前先截断（外部 agent 会在发送时重建用户消息，不截断会残留
   *   一份旧拷贝）。
   * - Office Agent：截断挂到 beforeHistoryPreparation 回调，由运行时在历史
   *   准备阶段执行——先截断再发送会让中间状态暴露给并发读者。
   * attachmentFallbackPolicy 允许本次重试改变附件降级策略。
   */
  private async retryMessageUnderSessionGate(
    sessionId: string,
    messageId: string,
    options?: { attachmentFallbackPolicy?: AttachmentFallbackPolicy }
  ): Promise<MessageStartResult> {
    this.requireSession(sessionId)
    const runtime = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
    const prepared = await this.dependencies.transcript.prepareRetryMessage(sessionId, messageId)
    if (runtime.kind === 'acp') {
      // ACP re-creates the user message on send, so truncate from the source
      // user message (inclusive) to avoid a stale duplicate.
      this.dependencies.transcript.commitRetryMessage(sessionId, prepared.sourceOrderSeq)
      return await runtime.send({
        content: prepared.content,
        context: { projectDir: prepared.projectDir, emitRefreshBeforeStream: true }
      })
    }
    const retryContent = options?.attachmentFallbackPolicy
      ? {
          ...prepared.content,
          attachmentFallbackPolicy: options.attachmentFallbackPolicy
        }
      : prepared.content
    return await runtime.send({
      content: retryContent,
      context: {
        projectDir: prepared.projectDir,
        emitRefreshBeforeStream: true,
        preserveResolvedRepresentations: true,
        ...(prepared.sourceMessageId ? { preStreamAnchorMessageId: prepared.sourceMessageId } : {}),
        beforeHistoryPreparation: () =>
          this.dependencies.transcript.commitRetryMessage(sessionId, prepared.retryFromOrderSeq)
      }
    })
  }

  /** 删除单条消息；生成中的会话先取消，避免删掉正在写入的记录。 */
  async deleteMessage(sessionId: string, messageId: string): Promise<void> {
    this.requireSession(sessionId)
    await this.dependencies.runtime.resolveSession(toAppSessionId(sessionId)).cancel()
    await this.dependencies.transcript.deleteMessage(sessionId, messageId)
  }

  /** 修改历史中用户消息的文本内容（不触发重新生成）。 */
  async editUserMessage(
    sessionId: string,
    messageId: string,
    text: string
  ): Promise<ChatMessageRecord> {
    this.requireSession(sessionId)
    return await this.dependencies.transcript.editUserMessage(sessionId, messageId, text)
  }

  /** 上下文压缩状态快照；ACP 会话无压缩概念，返回固定空快照。 */
  async getSessionCompactionSnapshot(sessionId: string): Promise<SessionCompactionSnapshot> {
    this.requireSession(sessionId)
    const runtime = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
    if (runtime.kind === 'acp') {
      return {
        state: {
          status: 'idle',
          cursorOrderSeq: 1,
          summaryUpdatedAt: null,
          boundaryReason: null
        },
        emitSeq: 0,
        latestAnchorEntryId: null
      }
    }
    return await runtime.compaction.getSnapshot()
  }

  /** 上下文窗口占用统计；ACP 会话拿不到该数据，标记 unavailable。 */
  async getSessionContextOccupancy(sessionId: string): Promise<SessionContextOccupancySnapshot> {
    this.requireSession(sessionId)
    const runtime = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
    if (runtime.kind === 'acp') {
      return {
        freshness: 'unavailable',
        source: null,
        occupiedTokens: null,
        contextWindowTokens: null,
        requestSeq: null,
        manifestEntryId: null,
        providerAttemptEntryId: null,
        measuredAt: null
      }
    }
    return await runtime.getContextOccupancy()
  }

  /** 手动触发上下文压缩；仅 Office Agent 会话支持（ACP 由外部 agent 管理）。 */
  async compactSession(
    sessionId: string
  ): Promise<{ compacted: boolean; state: SessionCompactionState }> {
    const session = this.requireSession(sessionId)
    const runtime = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
    if (runtime.kind === 'acp') {
      throw new Error(`Agent ${session.agentId} does not support manual compaction.`)
    }
    if ((await runtime.snapshot())?.providerId === 'acp') {
      throw new Error('Manual compaction is only available for Office Agent sessions.')
    }
    return await runtime.compaction.compact()
  }

  /** 清空会话全部消息；同样先取消生成再清，完成后广播更新。 */
  async clearSessionMessages(sessionId: string): Promise<void> {
    this.requireSession(sessionId)
    await this.dependencies.runtime.resolveSession(toAppSessionId(sessionId)).cancel()
    await this.dependencies.transcript.clearMessages(sessionId)
    this.dependencies.projection.notify({ sessionIds: [sessionId], reason: 'updated' })
  }

  /** 取消当前生成；会话不存在时静默返回。 */
  async cancelGeneration(sessionId: string): Promise<void> {
    if (!this.dependencies.sessions.get(sessionId)) return
    await this.dependencies.runtime.resolveSession(toAppSessionId(sessionId)).cancel()
  }

  /** 应答运行中的工具交互（如权限询问），推进被挂起的轮次。 */
  async respondToolInteraction(
    sessionId: string,
    messageId: string,
    toolCallId: string,
    response: ToolInteractionResponse
  ): Promise<ToolInteractionResult> {
    this.requireSession(sessionId)
    return await this.dependencies.runtime
      .resolveSession(toAppSessionId(sessionId))
      .toolInteractions.respond(messageId, toolCallId, response)
  }

  /** 关闭（忽略）一个工具交互卡片；返回是否确实存在并已关闭。 */
  async dismissToolInteraction(
    sessionId: string,
    messageId: string,
    toolCallId: string
  ): Promise<boolean> {
    this.requireSession(sessionId)
    return await this.dependencies.runtime
      .resolveSession(toAppSessionId(sessionId))
      .toolInteractions.dismiss(messageId, toolCallId)
  }

  /** 草稿转正：摘掉 draft 标记并用首条输入前 50 字做标题，广播更新。 */
  private promoteDraft(sessionId: string, input: SendMessageInput): void {
    const title = input.text.trim().slice(0, 50) || 'New Chat'
    this.dependencies.sessions.update(sessionId, { isDraft: false, title })
    this.dependencies.projection.notify({ sessionIds: [sessionId], reason: 'updated' })
  }

  private requireSession(sessionId: string) {
    const session = this.dependencies.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    return session
  }

  /** ACP 直连会话的 providerId 缺省为 'acp'（快照里可能尚未写入）。 */
  private resolveProviderId(kind: 'deepchat' | 'acp', providerId?: string): string {
    return providerId || (kind === 'acp' ? 'acp' : '')
  }
}
