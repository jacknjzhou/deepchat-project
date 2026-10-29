import type {
  AttachmentPreparationSummary,
  ChatMessageRecord,
  PendingSessionInputRecord,
  PendingSessionInputState,
  SendMessageInput,
  UserMessageContent
} from '@shared/types/agent-interface'
import { SessionPendingInputStore } from './pendingInputStore'
import type { SessionTranscript } from './transcript'

/** 每会话排队输入的上限；防止用户无限堆积导致轮次启动后连跑过长。 */
const MAX_ACTIVE_PENDING_INPUTS = 5

/** 重启恢复的结论：哪些会话的队列变了、哪些排队输入被暂扣（不自动续跑）。 */
export interface PendingInputRestartRecovery {
  affectedSessionIds: Set<string>
  heldQueueInputIds: Set<string>
}

function toUserMessageContent(input: SendMessageInput): UserMessageContent {
  return {
    text: input.text,
    files: input.files ?? [],
    links: [],
    search: input.search === true,
    think: false,
    ...(input.activeSkills?.length ? { activeSkills: input.activeSkills } : {}),
    ...(input.inlineItems?.length ? { inlineItems: input.inlineItems } : {})
  }
}

/**
 * 会话待发输入的门面层（pendingInputs）：在底层存储（pendingInputStore）与
 * 消息持久化（transcript）之间协调「排队」与「steering」两类输入的完整生命周期。
 *
 * 两种模式语义不同：
 * - queue：排队等下一轮执行的输入，可编辑/排序/删除，被消费（consume）即结束；
 * - steer：对运行中轮次的插话，接受时就落成 pending 用户消息（会话事实），
 *   不可编辑删除，只能被认领（claim，同时创建 assistant 占位消息并标记
 *   已读）→ 消费（consume，落成 sent）或失败（fail → error）。
 *
 * 跨 store 与 transcript 的状态迁移全部包在事务里；每个变更后广播
 * pendingInputsChanged，涉及消息落库的再广播 messagesChanged。
 * recoverInputsAfterRestart 是启动恢复入口：按各输入的物化程度决定消费、
 * 暂扣、转排队或标记失败，绝不无声丢弃用户输入。
 */
export class SessionPendingInputs {
  constructor(
    private readonly store: SessionPendingInputStore,
    private readonly transcript: SessionTranscript,
    private readonly events: {
      publishPendingInputsChanged(sessionId: string): void
      publishMessagesChanged(sessionId: string, messages: ChatMessageRecord[]): void
    }
  ) {}

  listPendingInputs(sessionId: string): PendingSessionInputRecord[] {
    return this.store.listPendingInputs(sessionId)
  }

  /** 读取某条输入；存在但归属别的会话直接报错（防止跨会话操作）。 */
  getInput(sessionId: string, itemId: string): PendingSessionInputRecord | null {
    const record = this.store.getInput(itemId)
    if (!record) {
      return null
    }
    if (record.sessionId !== sessionId) {
      throw new Error(`Pending input ${itemId} does not belong to session ${sessionId}`)
    }
    return record
  }

  /**
   * 为已认领（claimed）的排队输入落一条用户消息并与输入绑定。
   * 这是排队输入「转正」进入会话历史的时刻；已绑定过消息的输入不允许
   * 再建，避免重试路径重复落消息。
   */
  createClaimedQueueUserMessage(
    sessionId: string,
    itemId: string,
    content: UserMessageContent
  ): string {
    return this.store.runInTransaction(() => {
      const input = this.store.getInput(itemId)
      if (
        !input ||
        input.sessionId !== sessionId ||
        input.mode !== 'queue' ||
        input.state !== 'claimed'
      ) {
        throw new Error(`Pending input ${itemId} is not a claimed queue item for ${sessionId}.`)
      }
      if (input.messageIds.length > 0) {
        throw new Error(`Claimed queue item ${itemId} already has a linked message.`)
      }

      const messageId = this.transcript.createUserMessage(
        sessionId,
        this.transcript.getNextOrderSeq(sessionId),
        content
      )
      this.store.linkClaimedQueueMessage(itemId, messageId)
      return messageId
    })
  }

  /** 排队一条新输入；超出上限直接拒绝，落库后广播。 */
  queuePendingInput(
    sessionId: string,
    input: SendMessageInput,
    options?: {
      state?: PendingSessionInputState
    }
  ): PendingSessionInputRecord {
    this.ensureWithinLimit(sessionId)
    const record = this.store.createQueueInputWithState(
      sessionId,
      input,
      options?.state ?? 'pending'
    )
    this.emitUpdated(sessionId)
    return record
  }

  /**
   * 接受一条 steer 插话：事务内落 pending 用户消息（带 steer 回执元数据）
   * 并登记/合并到 steer 输入。mergeItemId 表示把内容并入一条已有的未读
   * steer 输入（用户连续插话时合并展示）。preStreamAnchorMessageId 存在
   * 与否本身有意义（undefined = 不关心），故用 hasOwnProperty 判断。
   */
  acceptSteerMessage(
    sessionId: string,
    input: SendMessageInput,
    options?: {
      mergeItemId?: string | null
      preStreamAnchorMessageId?: string | null
    }
  ): {
    pendingInput: PendingSessionInputRecord
    message: ChatMessageRecord
    sourceMessage?: ChatMessageRecord
  } {
    const accepted = this.store.runInTransaction(() => {
      if (options?.mergeItemId) {
        const mergeTarget = this.store.getInput(options.mergeItemId)
        if (
          !mergeTarget ||
          mergeTarget.sessionId !== sessionId ||
          mergeTarget.mode !== 'steer' ||
          mergeTarget.state !== 'pending'
        ) {
          throw new Error(`Pending steer item ${options.mergeItemId} is not open.`)
        }
      }

      const sourceMessage = Object.prototype.hasOwnProperty.call(
        options ?? {},
        'preStreamAnchorMessageId'
      )
        ? this.materializePreStreamSource(sessionId, options?.preStreamAnchorMessageId ?? null)
        : undefined
      const messageId = this.transcript.createUserMessage(
        sessionId,
        this.transcript.getNextOrderSeq(sessionId),
        toUserMessageContent(input),
        {
          status: 'pending',
          metadata: {
            inputReceipt: {
              mode: 'steer',
              readAt: null
            }
          }
        }
      )
      const pendingInput = options?.mergeItemId
        ? this.store.appendSteerInput(options.mergeItemId, input, messageId)
        : this.store.createSteerInput(sessionId, input, messageId)
      const message = this.requireMessage(messageId)
      return { pendingInput, message, sourceMessage }
    })

    this.emitUpdated(sessionId)
    this.events.publishMessagesChanged(
      sessionId,
      accepted.sourceMessage ? [accepted.sourceMessage, accepted.message] : [accepted.message]
    )
    return accepted
  }

  /** 把排队输入升级为 steer：排队内容转成 pending 用户消息并改挂 steer 模式。 */
  promoteQueuedInputToSteerMessage(
    sessionId: string,
    itemId: string,
    options?: {
      preStreamAnchorMessageId?: string | null
    }
  ): {
    pendingInput: PendingSessionInputRecord
    message: ChatMessageRecord
    sourceMessage?: ChatMessageRecord
  } {
    const accepted = this.store.runInTransaction(() => {
      const queued = this.store.getInput(itemId)
      if (
        !queued ||
        queued.sessionId !== sessionId ||
        queued.mode !== 'queue' ||
        queued.state !== 'pending'
      ) {
        throw new Error(`Pending queue item ${itemId} is not steerable.`)
      }
      const sourceMessage = Object.prototype.hasOwnProperty.call(
        options ?? {},
        'preStreamAnchorMessageId'
      )
        ? this.materializePreStreamSource(sessionId, options?.preStreamAnchorMessageId ?? null)
        : undefined
      const messageId = this.transcript.createUserMessage(
        sessionId,
        this.transcript.getNextOrderSeq(sessionId),
        toUserMessageContent(queued.payload),
        {
          status: 'pending',
          metadata: {
            inputReceipt: {
              mode: 'steer',
              readAt: null
            }
          }
        }
      )
      this.store.convertQueueInputToSteer(itemId)
      const pendingInput = this.store.linkSteerMessage(itemId, messageId)
      return {
        pendingInput,
        message: this.requireMessage(messageId),
        sourceMessage
      }
    })

    this.emitUpdated(sessionId)
    this.events.publishMessagesChanged(
      sessionId,
      accepted.sourceMessage ? [accepted.sourceMessage, accepted.message] : [accepted.message]
    )
    return accepted
  }

  /** 编辑排队输入（steer 输入已落会话事实，不可编辑）。 */
  updateQueuedInput(
    sessionId: string,
    itemId: string,
    input: SendMessageInput
  ): PendingSessionInputRecord {
    this.assertQueueInput(sessionId, itemId)
    const record = this.store.updateQueueInput(itemId, input)
    this.emitUpdated(sessionId)
    return record
  }

  moveQueuedInput(sessionId: string, itemId: string, toIndex: number): PendingSessionInputRecord[] {
    const records = this.store.runInTransaction(() => {
      this.assertQueueInput(sessionId, itemId)
      return this.store.moveQueueInput(sessionId, itemId, toIndex)
    })
    this.emitUpdated(sessionId)
    return records
  }

  deletePendingInput(sessionId: string, itemId: string): void {
    this.store.runInTransaction(() => {
      this.assertDeletablePendingInput(sessionId, itemId)
      this.store.deleteInput(itemId)
    })
    this.emitUpdated(sessionId)
  }

  getNextQueuedInput(sessionId: string): PendingSessionInputRecord | null {
    return this.store.getNextPendingQueueInput(sessionId)
  }

  getNextSteerInput(sessionId: string): PendingSessionInputRecord | null {
    return this.store.getNextPendingSteerInput(sessionId)
  }

  hasPendingTurnInput(sessionId: string): boolean {
    return Boolean(this.getNextSteerInput(sessionId) ?? this.getNextQueuedInput(sessionId))
  }

  hasBlockingInput(sessionId: string): boolean {
    return this.store.hasBlockingInput(sessionId)
  }

  hasClaimedInput(sessionId: string): boolean {
    return this.store.hasClaimedInput(sessionId)
  }

  /** 认领排队输入：轮次即将消费它；认领后其它消费者不能再取。 */
  claimQueuedInput(sessionId: string, itemId: string): PendingSessionInputRecord {
    this.assertQueueInput(sessionId, itemId)
    const record = this.store.claimQueueInput(itemId)
    this.emitUpdated(sessionId)
    return record
  }

  /**
   * 认领 steer 输入：创建 assistant 占位消息、标记 linked 用户消息已读，
   * 三步一个事务。认领后输入进入「已读待消费」，运行时开始吸收其内容。
   */
  claimSteerInput(sessionId: string, itemId: string): PendingSessionInputRecord {
    this.assertSteerInput(sessionId, itemId)
    let changedMessages: ChatMessageRecord[] = []
    const record = this.store.runInTransaction(() => {
      const pendingInput = this.store.getInput(itemId)
      if (!pendingInput || pendingInput.messageIds.length === 0) {
        throw new Error(`Pending steer item ${itemId} has no linked messages.`)
      }
      if (pendingInput.assistantMessageId) {
        throw new Error(`Pending steer item ${itemId} already has an assistant message.`)
      }

      const readAt = Date.now()
      const assistantMessageId = this.transcript.createAssistantMessage(
        sessionId,
        this.transcript.getNextOrderSeq(sessionId)
      )
      const claimed = this.store.claimSteerInput(itemId, {
        claimedAt: readAt,
        assistantMessageId
      })
      changedMessages = [
        ...this.transcript.markSteerMessagesRead(claimed.messageIds, readAt),
        this.requireMessage(assistantMessageId)
      ]
      return claimed
    })
    this.emitUpdated(sessionId)
    this.events.publishMessagesChanged(sessionId, changedMessages)
    return record
  }

  /** 释放认领的排队输入回到 pending（消费方中途放弃时用）。 */
  releaseClaimedQueueInput(sessionId: string, itemId: string): PendingSessionInputRecord {
    this.assertQueueInputForSession(sessionId, itemId)
    const record = this.store.releaseClaimedQueueInput(itemId)
    this.emitUpdated(sessionId)
    return record
  }

  /** 释放为 retry_required 状态：明确标记需要用户手动重试，不自动续跑。 */
  releaseClaimedQueueInputForRetry(sessionId: string, itemId: string): PendingSessionInputRecord {
    this.assertQueueInputForSession(sessionId, itemId)
    const record = this.store.releaseClaimedQueueInputForRetry(itemId)
    this.emitUpdated(sessionId)
    return record
  }

  /** 用户确认后重试一条 retry_required 的排队输入。 */
  retryReleasedQueueInput(sessionId: string, itemId: string): PendingSessionInputRecord {
    const record = this.store.runInTransaction(() => {
      this.assertQueueInputForSession(sessionId, itemId)
      return this.store.retryReleasedQueueInput(itemId)
    })
    this.emitUpdated(sessionId)
    return record
  }

  /** 通用释放：已落用户消息或已有 assistant 消息的 steer 不可释放（消息已是事实）。 */
  releaseClaimedInput(sessionId: string, itemId: string): PendingSessionInputRecord {
    this.assertInputOwnedBySession(sessionId, itemId)
    const claimed = this.store.getInput(itemId)
    if (
      claimed?.mode === 'steer' &&
      (claimed.messageIds.length > 0 || claimed.assistantMessageId)
    ) {
      throw new Error(`Read steer input ${itemId} cannot be released.`)
    }
    const record = this.store.releaseClaimedInput(itemId)
    this.emitUpdated(sessionId)
    return record
  }

  /** 把认领中的输入标记为 blocked（附件准备未通过，等用户决定）。 */
  blockClaimedInput(
    sessionId: string,
    itemId: string,
    blocking: AttachmentPreparationSummary
  ): PendingSessionInputRecord {
    this.assertInputOwnedBySession(sessionId, itemId)
    const record = this.store.blockClaimedInput(itemId, blocking)
    this.emitUpdated(sessionId)
    return record
  }

  /** 解除 blocked：用户选择原样重试。 */
  retryBlockedInput(sessionId: string, itemId: string): PendingSessionInputRecord {
    this.assertInputOwnedBySession(sessionId, itemId)
    const record = this.store.retryBlockedInput(itemId)
    this.emitUpdated(sessionId)
    return record
  }

  /** 解除 blocked：用户选择降级（去掉图片内容）后放行。 */
  degradeBlockedInput(sessionId: string, itemId: string): PendingSessionInputRecord {
    this.assertInputOwnedBySession(sessionId, itemId)
    const record = this.store.degradeBlockedInput(itemId)
    this.emitUpdated(sessionId)
    return record
  }

  /** 消费排队输入：轮次已正式接手，队列项随之终结。 */
  consumeQueuedInput(sessionId: string, itemId: string): void {
    this.store.runInTransaction(() => {
      this.assertQueueInputForSession(sessionId, itemId)
      this.store.consumeQueueInput(itemId)
    })
    this.emitUpdated(sessionId)
  }

  /** 消费 steer 输入：linked 用户消息落成 sent（会话事实固定），队列项终结。 */
  consumeSteerInput(sessionId: string, itemId: string): void {
    this.assertSteerInputForSession(sessionId, itemId)
    let changedMessages: ChatMessageRecord[] = []
    this.store.runInTransaction(() => {
      const claimed = this.store.getInput(itemId)
      if (!claimed || claimed.state !== 'claimed') {
        throw new Error(`Pending steer item ${itemId} is not claimed.`)
      }
      changedMessages = this.transcript.settleSteerMessages(claimed.messageIds)
      this.store.consumeSteerInput(itemId)
    })
    this.emitUpdated(sessionId)
    this.events.publishMessagesChanged(sessionId, changedMessages)
  }

  /**
   * 启动恢复：上次退出时所有未终结的输入逐条对账（事务内）。
   * - 排队已认领：若用户消息已落库则视为已被消费；否则释放回 pending 暂扣，
   *   等运行时决定是否续跑（不自动执行，避免重启后突然发言）。
   * - steer 已认领且有消息：settle 成 sent（内容已被上一轮吸收）。
   * - steer 已认领但无消息：补落用户消息后统一标 error——插话对象已消失。
   * - steer blocked：转回排队（steering 时机已过）。
   * 返回受影响的会话与被暂扣的输入 id，供运行时做续跑提示。
   */
  recoverInputsAfterRestart(): PendingInputRestartRecovery {
    const affectedSessionIds = new Set<string>()
    const heldQueueInputIds = new Set<string>()
    this.store.runInTransaction(() => {
      for (const input of this.store.listActiveInputs()) {
        if (input.mode === 'queue') {
          if (input.state === 'claimed') {
            const hasMaterializedUserFact = input.messageIds.some((messageId) => {
              const message = this.transcript.getMessage(messageId)
              return message?.sessionId === input.sessionId && message.role === 'user'
            })
            if (hasMaterializedUserFact) {
              this.store.consumeQueueInput(input.id)
            } else {
              this.store.releaseClaimedQueueInput(input.id)
              heldQueueInputIds.add(input.id)
            }
            affectedSessionIds.add(input.sessionId)
          } else if (input.state !== 'retry_required') {
            heldQueueInputIds.add(input.id)
            affectedSessionIds.add(input.sessionId)
          } else {
            affectedSessionIds.add(input.sessionId)
          }
          continue
        }

        if (input.state === 'blocked') {
          this.store.convertSteerInputToQueue(input.id)
          heldQueueInputIds.add(input.id)
          affectedSessionIds.add(input.sessionId)
          continue
        }

        if (input.state === 'claimed' && input.messageIds.length > 0) {
          this.transcript.settleSteerMessages(input.messageIds)
          this.store.consumeSteerInput(input.id)
          affectedSessionIds.add(input.sessionId)
          continue
        }

        if (input.state === 'claimed') {
          this.store.releaseClaimedInput(input.id)
        }
        const messageIds = [...input.messageIds]
        if (messageIds.length === 0) {
          messageIds.push(
            this.transcript.createUserMessage(
              input.sessionId,
              this.transcript.getNextOrderSeq(input.sessionId),
              toUserMessageContent(input.payload),
              {
                status: 'pending',
                metadata: {
                  inputReceipt: {
                    mode: 'steer',
                    readAt: null
                  }
                }
              }
            )
          )
          this.store.linkSteerMessage(input.id, messageIds[0])
        }
        this.transcript.failPendingSteerMessages(messageIds)
        this.store.consumeSteerInput(input.id)
        affectedSessionIds.add(input.sessionId)
      }
    })
    for (const sessionId of affectedSessionIds) {
      this.emitUpdated(sessionId)
    }
    return {
      affectedSessionIds,
      heldQueueInputIds
    }
  }

  hasActiveInputs(sessionId: string): boolean {
    return this.store.countActive(sessionId) > 0
  }

  isAtCapacity(sessionId: string): boolean {
    return this.store.countActiveQueue(sessionId) >= MAX_ACTIVE_PENDING_INPUTS
  }

  /** 会话级清空（删除会话时调用）。 */
  deleteBySession(sessionId: string): void {
    this.store.deleteBySession(sessionId)
    this.emitUpdated(sessionId)
  }

  private ensureWithinLimit(sessionId: string): void {
    if (this.store.countActiveQueue(sessionId) >= MAX_ACTIVE_PENDING_INPUTS) {
      throw new Error('Pending input limit reached for this session.')
    }
  }

  /**
   * 确定 steer 发送前的「源头用户消息」：优先用已认领排队输入的 linked
   * 消息（没有就补落一条），否则用锚点消息。找不到任何边界时报错——
   * 没有源头就无法保证 steer 内容在历史中的位置正确。
   */
  private materializePreStreamSource(
    sessionId: string,
    anchorMessageId: string | null
  ): ChatMessageRecord | undefined {
    const anchor = anchorMessageId ? this.requireMessage(anchorMessageId) : undefined
    if (anchor && anchor.sessionId !== sessionId) {
      throw new Error(`Pre-stream message ${anchor.id} does not belong to session ${sessionId}.`)
    }

    const claimedInput = this.store.getClaimedInput(sessionId)
    if (claimedInput?.mode === 'queue') {
      const linkedMessageId = claimedInput.messageIds.at(-1)
      let sourceMessage = linkedMessageId ? this.requireMessage(linkedMessageId) : anchor
      if (sourceMessage && sourceMessage.role !== 'user') {
        sourceMessage = undefined
      }
      if (!sourceMessage) {
        const messageId = this.transcript.createUserMessage(
          sessionId,
          this.transcript.getNextOrderSeq(sessionId),
          toUserMessageContent(claimedInput.payload)
        )
        sourceMessage = this.requireMessage(messageId)
      }
      this.store.linkClaimedQueueMessage(claimedInput.id, sourceMessage.id)
      return sourceMessage
    }

    if (anchor) {
      return anchor.role === 'user' ? anchor : undefined
    }

    if (claimedInput?.mode === 'steer') return undefined

    throw new Error('Unable to identify the active pre-stream transcript boundary.')
  }

  private assertQueueInput(sessionId: string, itemId: string): void {
    const record = this.store.listPendingInputs(sessionId).find((item) => item.id === itemId)
    if (!record) {
      throw new Error(`Pending input not found: ${itemId}`)
    }
    if (record.mode !== 'queue') {
      throw new Error('Steer inputs are locked and cannot be modified.')
    }
  }

  private assertDeletablePendingInput(sessionId: string, itemId: string): void {
    const record = this.store.listPendingInputs(sessionId).find((item) => item.id === itemId)
    if (!record) {
      throw new Error(`Pending input not found: ${itemId}`)
    }
    if (record.mode !== 'queue') {
      throw new Error('Steer messages are sent conversation facts and cannot be deleted.')
    }
  }

  private assertSteerInput(sessionId: string, itemId: string): void {
    const record = this.store.listPendingInputs(sessionId).find((item) => item.id === itemId)
    if (!record) {
      throw new Error(`Pending input not found: ${itemId}`)
    }
    if (record.mode !== 'steer') {
      throw new Error('Pending input is not a steer item.')
    }
  }

  private assertInputOwnedBySession(sessionId: string, itemId: string): PendingSessionInputRecord {
    const record = this.store.getInput(itemId)
    if (!record) {
      throw new Error(`Pending input not found: ${itemId}`)
    }
    if (record.sessionId !== sessionId) {
      throw new Error(`Pending input ${itemId} does not belong to session ${sessionId}`)
    }
    return record
  }

  private assertQueueInputForSession(sessionId: string, itemId: string): void {
    const record = this.assertInputOwnedBySession(sessionId, itemId)
    if (record.mode !== 'queue') {
      throw new Error('Steer inputs are locked and cannot be modified.')
    }
  }

  private assertSteerInputForSession(sessionId: string, itemId: string): void {
    const record = this.assertInputOwnedBySession(sessionId, itemId)
    if (record.mode !== 'steer') {
      throw new Error('Pending input is not a steer item.')
    }
  }

  private emitUpdated(sessionId: string): void {
    this.events.publishPendingInputsChanged(sessionId)
  }

  private requireMessage(messageId: string): ChatMessageRecord {
    const message = this.transcript.getMessage(messageId)
    if (!message) {
      throw new Error(`Message not found: ${messageId}`)
    }
    return message
  }
}
