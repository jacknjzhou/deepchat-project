import { nanoid } from 'nanoid'
import type {
  AttachmentPreparationSummary,
  PendingSessionInputRecord,
  PendingSessionInputState,
  SendMessageInput
} from '@shared/types/agent-interface'
import type { SessionDatabase } from './database'
import type { DeepChatPendingInputRow } from '@/session/data/tables/deepchatPendingInputs'
import {
  AttachmentPreparationSummarySchema,
  SendMessageInputSchema
} from '@shared/contracts/common'
import { normalizeAttachmentResolvedRepresentation } from '@shared/utils/attachmentRepresentation'

type InlineItem = NonNullable<SendMessageInput['inlineItems']>[number]

/** 合并多条 steer 输入时，后段 inline 引用（@提及等）要按文本拼接点平移。 */
function shiftInlineItems(
  inlineItems: SendMessageInput['inlineItems'],
  offset: number
): InlineItem[] {
  if (!Array.isArray(inlineItems) || inlineItems.length === 0) {
    return []
  }

  return inlineItems.map((item) => ({
    ...item,
    offset: Math.max(0, item.offset + offset)
  }))
}

/**
 * 待发输入的底层存储（pendingInputStore）：直接读写 deepchatPendingInputs 表，
 * 只做行级状态迁移与编解码，不做跨模块协调（那是 pendingInputs 门面的职责）。
 *
 * 表中一行是一条输入：mode 区分 queue/steer，state 是生命周期
 * （pending → claimed → consumed；queue 可进入 blocked），payload_json 存
 * 原始发送内容，message_ids_json 记录落库关联的用户消息。
 * 两个编码细节值得注意：
 * - retry_required 不是独立 state，而是 blocked + retry_required_at 的组合，
 *   读侧经 getRowState 还原，写侧落库时映射回 blocked；
 * - payload 读取走 zod 校验，坏数据降级为纯文本而不是让整条队列不可用。
 */
export class SessionPendingInputStore {
  private readonly database: SessionDatabase

  constructor(database: SessionDatabase) {
    this.database = database
  }

  runInTransaction<T>(operation: () => T): T {
    return this.database.getDatabase().transaction(operation)() as T
  }

  /** 列出会话的待发输入；已认领（claimed）的不对 UI 展示——它们已在生成中。 */
  listPendingInputs(sessionId: string): PendingSessionInputRecord[] {
    return this.database.deepchatPendingInputsTable
      .listActiveBySession(sessionId)
      .filter((row) => row.state !== 'claimed')
      .map((row) => this.toRecord(row))
  }

  /** 全库扫描活跃输入（重启恢复用）；所属会话已被删除的行跳过。 */
  listActiveInputs(): PendingSessionInputRecord[] {
    return this.database.deepchatPendingInputsTable
      .listActive()
      .filter((row) => Boolean(this.database.deepchatSessionsTable.get(row.session_id)))
      .map((row) => this.toRecord(row))
  }

  countActive(sessionId: string): number {
    return this.database.deepchatPendingInputsTable.countActiveBySession(sessionId)
  }

  countActiveQueue(sessionId: string): number {
    return this.database.deepchatPendingInputsTable
      .listActiveBySession(sessionId)
      .filter((row) => row.mode === 'queue').length
  }

  getInput(itemId: string): PendingSessionInputRecord | null {
    const row = this.database.deepchatPendingInputsTable.get(itemId)
    return row ? this.toRecord(row) : null
  }

  /**
   * 取会话当前唯一的已认领输入。一个会话同一时刻只应有一个认领项——
   * 出现多个说明状态机被破坏，直接报错暴露而不是静默取第一条。
   */
  getClaimedInput(sessionId: string): PendingSessionInputRecord | null {
    const rows = this.database.deepchatPendingInputsTable
      .listActiveBySession(sessionId)
      .filter((row) => row.state === 'claimed')
    if (rows.length > 1) {
      throw new Error(`Session ${sessionId} has multiple claimed pending inputs.`)
    }
    return rows[0] ? this.toRecord(rows[0]) : null
  }

  createQueueInput(sessionId: string, input: SendMessageInput): PendingSessionInputRecord {
    return this.createQueueInputWithState(sessionId, input, 'pending')
  }

  /** 新建排队输入；retry_required 状态在行上落成 blocked + 时间戳组合。 */
  createQueueInputWithState(
    sessionId: string,
    input: SendMessageInput,
    state: PendingSessionInputState
  ): PendingSessionInputRecord {
    const id = nanoid()
    const nextQueueOrder = this.getNextQueueOrder(sessionId)
    const now = Date.now()
    const claimedAt = state === 'claimed' ? now : null
    const retryRequiredAt = state === 'retry_required' ? now : null
    this.database.deepchatPendingInputsTable.insert({
      id,
      sessionId,
      mode: 'queue',
      state: state === 'retry_required' ? 'blocked' : state,
      payloadJson: JSON.stringify(input),
      retryRequiredAt,
      queueOrder: nextQueueOrder,
      claimedAt
    })
    const row = this.database.deepchatPendingInputsTable.get(id)
    if (!row) {
      throw new Error(`Failed to create pending input ${id}`)
    }
    return this.toRecord(row)
  }

  /** 新建 steer 输入；创建时就绑定其已落库的用户消息 id。 */
  createSteerInput(
    sessionId: string,
    input: SendMessageInput,
    messageId: string
  ): PendingSessionInputRecord {
    const id = nanoid()
    this.database.deepchatPendingInputsTable.insert({
      id,
      sessionId,
      mode: 'steer',
      state: 'pending',
      payloadJson: JSON.stringify(input),
      messageIdsJson: JSON.stringify([messageId]),
      queueOrder: null,
      claimedAt: null
    })
    const row = this.database.deepchatPendingInputsTable.get(id)
    if (!row) {
      throw new Error(`Failed to create steer input ${id}`)
    }
    return this.toRecord(row)
  }

  /**
   * 把新插话并入一条未读 steer 输入：文本按空行拼接、文件/技能去重合并、
   * inline 引用按拼接点平移，并把新用户消息追加进关联列表。
   */
  appendSteerInput(
    itemId: string,
    input: SendMessageInput,
    messageId: string
  ): PendingSessionInputRecord {
    const row = this.requireRow(itemId)
    if (row.mode !== 'steer') {
      throw new Error(`Pending input ${itemId} is not a steer item.`)
    }
    if (row.state !== 'pending') {
      throw new Error(`Pending steer item ${itemId} is not editable.`)
    }

    const existing = this.decodePayload(row)
    const next = input
    const existingText = existing.text.trim()
    const nextText = next.text.trim()
    const separator = existingText && nextText ? '\n\n' : ''
    const text = [existingText, nextText].filter(Boolean).join(separator)
    const nextOffset = existingText.length + separator.length
    const files = [...(existing.files ?? []), ...(next.files ?? [])].filter(Boolean)
    const activeSkills = Array.from(
      new Set([...(existing.activeSkills ?? []), ...(next.activeSkills ?? [])])
    )
    const inlineItems = [
      ...(existing.inlineItems ?? []),
      ...shiftInlineItems(next.inlineItems, nextOffset)
    ]
    const attachmentFallbackPolicy =
      next.attachmentFallbackPolicy ?? existing.attachmentFallbackPolicy
    this.database.deepchatPendingInputsTable.update(itemId, {
      payload_json: JSON.stringify({
        text,
        files,
        search: existing.search === true || next.search === true,
        ...(activeSkills.length > 0 ? { activeSkills } : {}),
        ...(inlineItems.length > 0 ? { inlineItems } : {}),
        ...(attachmentFallbackPolicy ? { attachmentFallbackPolicy } : {})
      }),
      message_ids_json: JSON.stringify([...this.decodeMessageIds(row), messageId])
    })
    return this.toRecord(this.requireRow(itemId, row.session_id))
  }

  linkSteerMessage(itemId: string, messageId: string): PendingSessionInputRecord {
    const row = this.requireRow(itemId)
    if (row.mode !== 'steer' || row.state !== 'pending') {
      throw new Error(`Pending input ${itemId} is not an open steer item.`)
    }
    this.database.deepchatPendingInputsTable.update(itemId, {
      message_ids_json: JSON.stringify([...this.decodeMessageIds(row), messageId])
    })
    return this.toRecord(this.requireRow(itemId, row.session_id))
  }

  linkClaimedQueueMessage(itemId: string, messageId: string): PendingSessionInputRecord {
    const row = this.requireRow(itemId)
    if (row.mode !== 'queue' || row.state !== 'claimed') {
      throw new Error(`Pending input ${itemId} is not a claimed queue item.`)
    }
    const messageIds = this.decodeMessageIds(row)
    if (messageIds.length > 0 && (messageIds.length !== 1 || messageIds[0] !== messageId)) {
      throw new Error(`Claimed queue item ${itemId} already links another message.`)
    }
    if (messageIds.length === 0) {
      this.database.deepchatPendingInputsTable.update(itemId, {
        message_ids_json: JSON.stringify([messageId])
      })
    }
    return this.toRecord(this.requireRow(itemId, row.session_id))
  }

  /** 编辑排队输入：blocked/retry_required 的编辑视为用户修正，一并清回 pending。 */
  updateQueueInput(itemId: string, input: SendMessageInput): PendingSessionInputRecord {
    const row = this.requireRow(itemId)
    if (row.mode !== 'queue') {
      throw new Error(`Pending input ${itemId} is not a queue item.`)
    }
    const state = this.getRowState(row)
    if (state !== 'pending' && state !== 'blocked' && state !== 'retry_required') {
      throw new Error(`Pending queue item ${itemId} is not editable.`)
    }
    this.database.deepchatPendingInputsTable.update(itemId, {
      payload_json: JSON.stringify(input),
      ...(state !== 'pending'
        ? {
            state: 'pending' as const,
            blocking_json: null,
            retry_required_at: null,
            claimed_at: null
          }
        : {})
    })
    return this.toRecord(this.requireRow(itemId, row.session_id))
  }

  /** 队列重排：只在等待中的输入里移动，重排后全量重写 queue_order。 */
  moveQueueInput(sessionId: string, itemId: string, toIndex: number): PendingSessionInputRecord[] {
    const queueRows = this.getWaitingQueueRows(sessionId)
    const fromIndex = queueRows.findIndex((row) => row.id === itemId)
    if (fromIndex === -1) {
      throw new Error(`Pending queue item not found: ${itemId}`)
    }
    if (queueRows[0] && this.isRetryRequiredRow(queueRows[0])) {
      throw new Error('Retry or edit the released queue input before reordering the queue.')
    }

    const clampedIndex = Math.max(0, Math.min(toIndex, queueRows.length - 1))
    if (fromIndex === clampedIndex) {
      return this.listPendingInputs(sessionId)
    }

    const [moved] = queueRows.splice(fromIndex, 1)
    queueRows.splice(clampedIndex, 0, moved)
    this.resequenceQueueRows(sessionId, queueRows)

    return this.listPendingInputs(sessionId)
  }

  /** queue ↔ steer 双向转换；转换后都要重排队列补上空出的序号。 */
  convertQueueInputToSteer(itemId: string): PendingSessionInputRecord {
    const row = this.requireRow(itemId)
    if (row.mode !== 'queue') {
      throw new Error(`Pending input ${itemId} is not a queue item.`)
    }
    if (row.state !== 'pending') {
      throw new Error(`Pending queue item ${itemId} is not steerable.`)
    }
    this.database.deepchatPendingInputsTable.update(itemId, {
      mode: 'steer',
      queue_order: null
    })
    this.resequenceQueue(row.session_id)
    return this.toRecord(this.requireRow(itemId, row.session_id))
  }

  convertSteerInputToQueue(itemId: string): PendingSessionInputRecord {
    const row = this.requireRow(itemId)
    if (row.mode !== 'steer') {
      throw new Error(`Pending input ${itemId} is not a steer item.`)
    }
    this.database.deepchatPendingInputsTable.update(itemId, {
      mode: 'queue',
      queue_order: this.getNextQueueOrder(row.session_id)
    })
    this.resequenceQueue(row.session_id)
    return this.toRecord(this.requireRow(itemId, row.session_id))
  }

  deleteInput(itemId: string): void {
    const row = this.requireRow(itemId)
    this.database.deepchatPendingInputsTable.delete(itemId)
    if (row.mode === 'queue') {
      this.resequenceQueue(row.session_id)
    }
  }

  getNextPendingQueueInput(sessionId: string): PendingSessionInputRecord | null {
    const row = this.getWaitingQueueRows(sessionId)[0]
    return row?.state === 'pending' ? this.toRecord(row) : null
  }

  getNextPendingSteerInput(sessionId: string): PendingSessionInputRecord | null {
    const row = this.getWaitingSteerRows(sessionId)[0]
    return row?.state === 'pending' ? this.toRecord(row) : null
  }

  hasBlockingInput(sessionId: string): boolean {
    return this.database.deepchatPendingInputsTable
      .listActiveBySession(sessionId)
      .some((row) => row.state === 'blocked' && !this.isRetryRequiredRow(row))
  }

  hasClaimedInput(sessionId: string): boolean {
    return this.database.deepchatPendingInputsTable
      .listActiveBySession(sessionId)
      .some((row) => row.state === 'claimed')
  }

  claimQueueInput(itemId: string): PendingSessionInputRecord {
    const row = this.requireRow(itemId)
    if (row.mode !== 'queue') {
      throw new Error(`Pending input ${itemId} is not a queue item.`)
    }
    if (row.state !== 'pending') {
      throw new Error(`Pending queue item ${itemId} is not claimable.`)
    }

    this.database.deepchatPendingInputsTable.update(itemId, {
      state: 'claimed',
      claimed_at: Date.now()
    })
    return this.toRecord(this.requireRow(itemId, row.session_id))
  }

  claimSteerInput(
    itemId: string,
    options: { claimedAt: number; assistantMessageId: string }
  ): PendingSessionInputRecord {
    const row = this.requireRow(itemId)
    if (row.mode !== 'steer') {
      throw new Error(`Pending input ${itemId} is not a steer item.`)
    }
    if (row.state !== 'pending') {
      throw new Error(`Pending steer item ${itemId} is not claimable.`)
    }

    this.database.deepchatPendingInputsTable.update(itemId, {
      state: 'claimed',
      claimed_at: options.claimedAt,
      assistant_message_id: options.assistantMessageId
    })
    return this.toRecord(this.requireRow(itemId, row.session_id))
  }

  releaseClaimedQueueInput(itemId: string): PendingSessionInputRecord {
    return this.releaseClaimedQueueInputTo(itemId, 'pending')
  }

  releaseClaimedQueueInputForRetry(itemId: string): PendingSessionInputRecord {
    return this.releaseClaimedQueueInputTo(itemId, 'retry_required')
  }

  retryReleasedQueueInput(itemId: string): PendingSessionInputRecord {
    const row = this.requireRow(itemId)
    if (row.mode !== 'queue') {
      throw new Error(`Pending input ${itemId} is not a queue item.`)
    }
    if (!this.isRetryRequiredRow(row)) {
      throw new Error(`Pending queue item ${itemId} does not require retry.`)
    }

    this.database.deepchatPendingInputsTable.update(itemId, {
      state: 'pending',
      claimed_at: null,
      blocking_json: null,
      retry_required_at: null
    })
    return this.toRecord(this.requireRow(itemId, row.session_id))
  }

  releaseClaimedInput(
    itemId: string,
    existingRow?: DeepChatPendingInputRow
  ): PendingSessionInputRecord {
    const row = existingRow ?? this.requireRow(itemId)
    if (row.state !== 'claimed') {
      return this.toRecord(row)
    }

    this.database.deepchatPendingInputsTable.update(itemId, {
      state: 'pending',
      claimed_at: null,
      blocking_json: null
    })
    return this.toRecord(this.requireRow(itemId, row.session_id))
  }

  /** queue 输入被消费 = 直接删行（没有保留价值）；steer 消费则保留 consumed 痕迹。 */
  consumeQueueInput(itemId: string): void {
    this.deleteInput(itemId)
  }

  consumeSteerInput(itemId: string): void {
    const row = this.requireRow(itemId)
    if (row.mode !== 'steer') {
      throw new Error(`Pending input ${itemId} is not a steer item.`)
    }
    this.database.deepchatPendingInputsTable.update(itemId, {
      state: 'consumed',
      consumed_at: Date.now()
    })
  }

  blockClaimedInput(
    itemId: string,
    blocking: AttachmentPreparationSummary
  ): PendingSessionInputRecord {
    const row = this.requireRow(itemId)
    if (row.state !== 'claimed') {
      throw new Error(`Pending input ${itemId} is not claimed.`)
    }
    const bodyFreeBlocking = AttachmentPreparationSummarySchema.parse(blocking)
    this.database.deepchatPendingInputsTable.update(itemId, {
      state: 'blocked',
      blocking_json: JSON.stringify(bodyFreeBlocking),
      retry_required_at: null,
      claimed_at: null
    })
    return this.toRecord(this.requireRow(itemId, row.session_id))
  }

  retryBlockedInput(itemId: string): PendingSessionInputRecord {
    const row = this.requireRow(itemId)
    if (row.state !== 'blocked' || this.isRetryRequiredRow(row)) {
      throw new Error(`Pending input ${itemId} is not blocked.`)
    }
    this.database.deepchatPendingInputsTable.update(itemId, {
      state: 'pending',
      blocking_json: null,
      retry_required_at: null,
      claimed_at: null
    })
    return this.toRecord(this.requireRow(itemId, row.session_id))
  }

  degradeBlockedInput(itemId: string): PendingSessionInputRecord {
    const row = this.requireRow(itemId)
    if (row.state !== 'blocked' || this.isRetryRequiredRow(row)) {
      throw new Error(`Pending input ${itemId} is not blocked.`)
    }
    const payload = this.decodePayload(row)
    this.database.deepchatPendingInputsTable.update(itemId, {
      state: 'pending',
      payload_json: JSON.stringify({
        ...payload,
        attachmentFallbackPolicy: 'send_without_image_content'
      }),
      blocking_json: null,
      retry_required_at: null,
      claimed_at: null
    })
    return this.toRecord(this.requireRow(itemId, row.session_id))
  }

  deleteBySession(sessionId: string): void {
    this.database.deepchatPendingInputsTable.deleteBySession(sessionId)
  }

  private getNextQueueOrder(sessionId: string): number {
    const queueRows = this.getQueueRows(sessionId)
    if (queueRows.length === 0) {
      return 1
    }
    return Math.max(...queueRows.map((row) => row.queue_order ?? 0)) + 1
  }

  private getQueueRows(sessionId: string): DeepChatPendingInputRow[] {
    return this.database.deepchatPendingInputsTable
      .listBySession(sessionId)
      .filter((row) => row.mode === 'queue')
      .sort((left, right) => {
        const leftQueueOrder = left.queue_order ?? Number.MAX_SAFE_INTEGER
        const rightQueueOrder = right.queue_order ?? Number.MAX_SAFE_INTEGER

        if (leftQueueOrder !== rightQueueOrder) {
          return leftQueueOrder - rightQueueOrder
        }

        return left.created_at - right.created_at
      })
  }

  private getWaitingQueueRows(sessionId: string): DeepChatPendingInputRow[] {
    return this.getQueueRows(sessionId).filter((row) => this.isWaitingQueueRow(row))
  }

  private getSteerRows(sessionId: string): DeepChatPendingInputRow[] {
    return this.database.deepchatPendingInputsTable
      .listActiveBySession(sessionId)
      .filter((row) => row.mode === 'steer')
      .sort((left, right) => left.created_at - right.created_at)
  }

  private getWaitingSteerRows(sessionId: string): DeepChatPendingInputRow[] {
    return this.getSteerRows(sessionId).filter(
      (row) => row.state === 'pending' || row.state === 'blocked'
    )
  }

  private resequenceQueue(sessionId: string): void {
    this.resequenceQueueRows(sessionId, this.getWaitingQueueRows(sessionId))
  }

  /**
   * 重排等待中的队列行：非等待行（认领中等）占住原位，等待行按新顺序
   * 依次填入剩余位置，最终所有行拿到 1..n 的连续序号。
   */
  private resequenceQueueRows(sessionId: string, waitingRows: DeepChatPendingInputRow[]): void {
    let waitingIndex = 0
    const orderedRows = this.getQueueRows(sessionId)
      .filter((row) => row.state !== 'consumed')
      .map((row) => (this.isWaitingQueueRow(row) ? (waitingRows[waitingIndex++] ?? row) : row))

    orderedRows.forEach((row, index) => {
      this.database.deepchatPendingInputsTable.update(row.id, {
        queue_order: index + 1
      })
    })
  }

  /** 认领排队输入的公共实现：state 回落为 pending 或 retry_required 两种之一。 */
  private releaseClaimedQueueInputTo(
    itemId: string,
    state: 'pending' | 'retry_required'
  ): PendingSessionInputRecord {
    const row = this.requireRow(itemId)
    if (row.mode !== 'queue') {
      throw new Error(`Pending input ${itemId} is not a queue item.`)
    }
    if (row.state !== 'claimed') {
      return this.toRecord(row)
    }

    const retryRequiredAt = state === 'retry_required' ? Date.now() : null
    this.database.deepchatPendingInputsTable.update(itemId, {
      state: state === 'retry_required' ? 'blocked' : state,
      claimed_at: null,
      blocking_json: null,
      retry_required_at: retryRequiredAt,
      message_ids_json: '[]'
    })
    return this.toRecord(this.requireRow(itemId, row.session_id))
  }

  private requireRow(itemId: string, expectedSessionId?: string): DeepChatPendingInputRow {
    const row = this.database.deepchatPendingInputsTable.get(itemId)
    if (!row) {
      throw new Error(`Pending input not found: ${itemId}`)
    }
    if (expectedSessionId && row.session_id !== expectedSessionId) {
      throw new Error(`Pending input ${itemId} does not belong to session ${expectedSessionId}`)
    }
    return row
  }

  private toRecord(row: DeepChatPendingInputRow): PendingSessionInputRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      mode: row.mode,
      state: this.getRowState(row),
      payload: this.decodePayload(row),
      messageIds: this.decodeMessageIds(row),
      assistantMessageId: row.assistant_message_id,
      blocking: this.decodeBlocking(row),
      queueOrder: row.queue_order,
      claimedAt: row.claimed_at,
      consumedAt: row.consumed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private getRowState(row: DeepChatPendingInputRow): PendingSessionInputState {
    return this.isRetryRequiredRow(row) ? 'retry_required' : row.state
  }

  private isRetryRequiredRow(row: DeepChatPendingInputRow): boolean {
    return (
      row.state === 'retry_required' || (row.state === 'blocked' && row.retry_required_at != null)
    )
  }

  private isWaitingQueueRow(row: DeepChatPendingInputRow): boolean {
    return row.state === 'pending' || row.state === 'blocked' || row.state === 'retry_required'
  }

  /** payload 解码：JSON 损坏或 schema 不符都降级为纯文本输入，只记错误。 */
  private decodePayload(row: DeepChatPendingInputRow): SendMessageInput {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.payload_json)
    } catch (error) {
      console.error(
        `[DeepChatPendingInputStore] Invalid pending input payload JSON: ${row.id}`,
        error
      )
      return { text: row.payload_json, files: [] }
    }

    const result = SendMessageInputSchema.safeParse(parsed)
    if (!result.success) {
      console.error(
        `[DeepChatPendingInputStore] Invalid pending input payload shape: ${row.id}`,
        result.error
      )
      return { text: row.payload_json, files: [] }
    }

    const data: SendMessageInput = {
      ...result.data,
      search: result.data.search === true
    }
    const rawFiles = Array.isArray((parsed as { files?: unknown }).files)
      ? ((parsed as { files: unknown[] }).files ?? [])
      : []
    const files = data.files?.map((file, index) => {
      const rawFile = rawFiles[index]
      const resolved =
        rawFile && typeof rawFile === 'object' && !Array.isArray(rawFile)
          ? normalizeAttachmentResolvedRepresentation(
              (rawFile as Record<string, unknown>).resolvedRepresentation
            )
          : undefined
      return resolved ? { ...file, resolvedRepresentation: resolved } : file
    })
    return files ? { ...data, files } : data
  }

  private decodeBlocking(row: DeepChatPendingInputRow): AttachmentPreparationSummary | null {
    if (!row.blocking_json) return null
    try {
      const parsed = AttachmentPreparationSummarySchema.safeParse(JSON.parse(row.blocking_json))
      if (parsed.success) return parsed.data
    } catch {
      // Fall through to a body-free recovery result for corrupt derived queue metadata.
    }
    return {
      status: 'needs_user_action',
      issues: [],
      suggestedActions: ['retry', 'send_without_image_content']
    }
  }

  private decodeMessageIds(row: DeepChatPendingInputRow): string[] {
    try {
      const parsed = JSON.parse(row.message_ids_json) as unknown
      return Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string' && value.length > 0)
        : []
    } catch {
      return []
    }
  }
}
