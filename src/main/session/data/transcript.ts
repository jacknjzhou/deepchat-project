import { nanoid } from 'nanoid'
import type { SessionDatabase } from './database'
import type {
  ChatMessagePageResult,
  ChatMessageRecord,
  MessageFile,
  MessageMetadata,
  MessagePageCursor,
  MessageTraceRecord,
  SessionCompactionBoundaryReason,
  UserMessageContent,
  AssistantMessageBlock
} from '@shared/types/agent-interface'
import type { SearchResult } from '@shared/types/core/search'
import logger from '@shared/logger'
import type { DeepChatMessageRow } from '@/session/data/tables/deepchatMessages'
import type { DeepChatTapeEntryRow } from '@/tape/domain/entry'
import type { DeepChatAssistantBlockRow } from '@/session/data/tables/deepchatAssistantBlocks'
import type { DeepChatUserMessageFileRow } from '@/session/data/tables/deepchatUserMessageFiles'
import type { DeepChatUserMessageLinkRow } from '@/session/data/tables/deepchatUserMessageLinks'
import type { DeepChatUserMessageRow } from '@/session/data/tables/deepchatUserMessages'
import {
  buildCompactionUsageStatsRecord,
  buildUsageStatsRecord,
  parseMessageMetadata,
  resolveUsageModelId,
  resolveUsageProviderId
} from '@/session/usageStats'
import type {
  ExecutionJournalAuditReader,
  TapeAnchorReader,
  TapeCompactionModelCallWriter,
  TapeMessageFactWriter
} from '@/tape/ports/capabilities'
import type { TapeCompactionModelCallInput } from '@/tape/domain/compactionUsage'
import {
  getAttachmentSearchableText,
  normalizeAttachmentRepresentationPreference,
  normalizeAttachmentResolvedRepresentation,
  normalizePdfEmbeddedTextCoverage
} from '@shared/utils/attachmentRepresentation'

/** 附件进全文检索索引的最大字符数；超长附件保留头尾并标注截断。 */
const MAX_SEARCHABLE_ATTACHMENT_CHARACTERS = 32_000
const SEARCH_ATTACHMENT_TRUNCATION_MARKER = '[Attachment search text truncated]'
/** 压缩导致消息整体后移时，tape 事实按批补发，避免单事务一次性物化过大。 */
const COMPACTION_SHIFT_MATERIALIZATION_BATCH_SIZE = 500
const MAX_COMPACTION_ATTEMPT_ID_CHARACTERS = 128

type CompactionMessageOptions = {
  compactionAttemptId: string
  boundaryReason?: SessionCompactionBoundaryReason | null
}

function normalizeCompactionAttemptId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && normalized.length <= MAX_COMPACTION_ATTEMPT_ID_CHARACTERS ? normalized : null
}

function normalizeCompactionBoundaryReason(value: unknown): SessionCompactionBoundaryReason | null {
  return value === 'summary_unavailable' || value === 'summary_rejected_larger' ? value : null
}

function parseTapeAnchorState(row: DeepChatTapeEntryRow): Record<string, unknown> | null {
  try {
    const payload = JSON.parse(row.payload_json) as unknown
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    const state = (payload as Record<string, unknown>).state
    return state && typeof state === 'object' && !Array.isArray(state)
      ? (state as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function summaryUpdatedAtFromCompactionAnchor(row: DeepChatTapeEntryRow): number | null {
  const state = parseTapeAnchorState(row)
  const generatedSummary = state?.summary ?? state?.summaryText
  return typeof generatedSummary === 'string' && generatedSummary.trim() ? row.created_at : null
}

function shouldConvertPendingBlockToError(
  status: AssistantMessageBlock['status']
): status is 'pending' | 'loading' {
  return status === 'pending' || status === 'loading'
}

/** 把一条 assistant 消息的 blocks 收敛为终态：遗留 pending/loading 一律转 error，
 * 并在末尾补上错误块（已存在相同错误块则不重复），供启动恢复时使用。 */
export function buildTerminalErrorBlocks(
  blocks: AssistantMessageBlock[],
  errorMessage: string
): AssistantMessageBlock[] {
  const normalizedBlocks: AssistantMessageBlock[] = Array.isArray(blocks)
    ? blocks.map(
        (block): AssistantMessageBlock =>
          shouldConvertPendingBlockToError(block.status)
            ? { ...block, status: 'error' as const }
            : block
      )
    : []

  const lastBlock = normalizedBlocks[normalizedBlocks.length - 1]
  if (lastBlock?.type === 'error' && lastBlock.content === errorMessage) {
    return normalizedBlocks
  }

  normalizedBlocks.push({
    type: 'error',
    content: errorMessage,
    status: 'error',
    timestamp: Date.now()
  })

  return normalizedBlocks
}

type StructuredMessageMaps = {
  userRows: Map<string, DeepChatUserMessageRow>
  fileRows: Map<string, DeepChatUserMessageFileRow[]>
  linkRows: Map<string, DeepChatUserMessageLinkRow[]>
  assistantRows: Map<string, DeepChatAssistantBlockRow[]>
}

function normalizePersistedActionType(
  actionType: string | null
): AssistantMessageBlock['action_type'] | undefined {
  if (
    actionType === 'tool_call_permission' ||
    actionType === 'question_request' ||
    actionType === 'rate_limit'
  ) {
    return actionType
  }

  return undefined
}

/** 从消息 JSON 里抽出可检索的纯文本：user 取 text+附件文本，block 数组取
 * content/text/error 字段；解析失败按原始字符串处理。供全文索引使用。 */
function extractSearchableMessageContent(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent) as
      | UserMessageContent
      | Array<{
          type?: string
          content?: string
          text?: string
          error?: string
        }>

    if (Array.isArray(parsed)) {
      const segments = parsed
        .flatMap((block) => {
          if (!block || typeof block !== 'object') {
            return []
          }

          const values = [block.content, block.text, block.error]
          return values.filter(
            (value): value is string => typeof value === 'string' && value.trim().length > 0
          )
        })
        .map((value) => value.trim())

      if (segments.length > 0) {
        return segments.join('\n')
      }
    } else if (parsed && typeof parsed === 'object') {
      const segments: string[] = []
      if (typeof parsed.text === 'string' && parsed.text.trim()) {
        segments.push(parsed.text.trim())
      }
      const searchableAttachmentText = buildSearchableAttachmentText(parsed.files)
      if (searchableAttachmentText) segments.push(searchableAttachmentText)
      return segments.join('\n')
    }
  } catch {
    // Plain-text fallback.
  }

  return rawContent.trim()
}

/** 拼接附件的可检索文本；超限时头尾各留一半并保证不切断 UTF-16 代理对。 */
function buildSearchableAttachmentText(files: unknown): string {
  if (!Array.isArray(files)) return ''
  const text = files
    .flatMap((file) => {
      const searchableText = getAttachmentSearchableText(file).trim()
      return searchableText ? [searchableText] : []
    })
    .join('\n')
  if (text.length <= MAX_SEARCHABLE_ATTACHMENT_CHARACTERS) return text

  const marker = `\n${SEARCH_ATTACHMENT_TRUNCATION_MARKER}\n`
  const retainedCharacters = Math.max(
    0,
    Math.floor((MAX_SEARCHABLE_ATTACHMENT_CHARACTERS - marker.length) / 2)
  )
  let headEnd = retainedCharacters
  if (isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd -= 1
  let tailStart = text.length - retainedCharacters
  if (isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1
  return `${text.slice(0, headEnd).trimEnd()}${marker}${text.slice(tailStart).trimStart()}`
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * 会话消息的持久化层（transcript）：直接读写 SQLite，是 session 模块中唯一
 * 触碰消息存储的地方。
 *
 * 消息一主多辅：deepchatMessages 表存主记录（role/status/content JSON），
 * 结构化明细拆在辅表——用户消息拆 text/files/links 三张表，assistant 消息
 * 按 block 拆表。读路径把主行与辅表重新物化成完整记录（materializeContent），
 * 批量读取时用 loadStructuredMaps 一次批量取辅表避免逐行查询。
 *
 * 三条伴生写入贯穿全部变更：
 * 1. 全文检索文档（search documents）——消息定稿/变更时同步 upsert；
 * 2. 用量统计（usage stats）——从 assistant 消息的 metadata 提取；
 * 3. tape 事实（appendMessageRecord/Replacement/Retraction）——把每次变更
 *    追加成可回放的执行事实流，删除用 retraction 而非抹除。
 *
 * 多表一致的操作全部包在数据库事务里（runInDatabaseTransaction），保证
 * 崩溃后不会出现主记录在、辅表缺失的中间态。
 */
export class SessionTranscript {
  private database: SessionDatabase
  private readonly tapeFacts: TapeMessageFactWriter
  private readonly compactionUsage: TapeCompactionModelCallWriter

  constructor(
    database: SessionDatabase,
    tapeFacts: TapeMessageFactWriter & TapeCompactionModelCallWriter,
    private readonly executionAudit?: Pick<
      ExecutionJournalAuditReader,
      'listMessageIdsWithNestedExecutionAudit'
    >,
    private readonly compactionAnchors?: Pick<
      TapeAnchorReader,
      'getReconstructionAnchorByCompactionAttemptId'
    >
  ) {
    this.database = database
    this.tapeFacts = tapeFacts
    this.compactionUsage = tapeFacts
  }

  private runInDatabaseTransaction<T>(operation: () => T): T {
    return this.database.getDatabase().transaction(operation)() as T
  }

  /** 新建用户消息：写主记录 + 结构化辅表 + 检索文档 + tape 事实。 */
  createUserMessage(
    sessionId: string,
    orderSeq: number,
    content: UserMessageContent,
    options?: {
      status?: 'pending' | 'sent'
      metadata?: MessageMetadata
    }
  ): string {
    const id = nanoid()
    const serializedContent = JSON.stringify(content)
    this.database.deepchatMessagesTable.insert({
      id,
      sessionId,
      orderSeq,
      role: 'user',
      content: serializedContent,
      status: options?.status ?? 'sent',
      ...(options?.metadata ? { metadata: JSON.stringify(options.metadata) } : {})
    })
    this.persistUserContent(id, content)
    this.upsertMessageSearchDocument(sessionId, id, 'user', serializedContent)
    this.appendLiveTapeFacts(id)
    return id
  }

  /** 新建 assistant 占位消息：空 blocks、pending 状态，流式过程中逐步填充。 */
  createAssistantMessage(sessionId: string, orderSeq: number): string {
    const id = nanoid()
    this.database.deepchatMessagesTable.insert({
      id,
      sessionId,
      orderSeq,
      role: 'assistant',
      content: '[]',
      status: 'pending'
    })
    return id
  }

  /** 创建压缩标记消息（事务内）。 */
  private insertCompactionMessageRecord(
    sessionId: string,
    orderSeq: number,
    status: 'compacting' | 'compacted',
    summaryUpdatedAt: number | null,
    options: CompactionMessageOptions
  ): string {
    const id = nanoid()
    this.database.deepchatMessagesTable.insert({
      id,
      sessionId,
      orderSeq,
      role: 'assistant',
      content: JSON.stringify(this.buildCompactionBlocks(status)),
      status: 'sent',
      metadata: JSON.stringify(
        this.buildCompactionMetadata(
          status,
          summaryUpdatedAt,
          options.compactionAttemptId,
          options.boundaryReason
        )
      )
    })
    this.appendLiveTapeFacts(id)
    return id
  }

  /** 在指定序号插入压缩标记消息，标记压缩流程的开始/完成。 */
  createCompactionMessage(
    sessionId: string,
    orderSeq: number,
    status: 'compacting' | 'compacted',
    summaryUpdatedAt: number | null,
    options: CompactionMessageOptions
  ): string {
    return this.runInDatabaseTransaction(() =>
      this.insertCompactionMessageRecord(sessionId, orderSeq, status, summaryUpdatedAt, options)
    )
  }

  /**
   * 在指定序号插入压缩标记消息，可选地把该序号起的所有已有消息整体后移
   * 一位（压缩摘要要占据历史中的固定位置时用）。位移与插入必须同事务：
   * 中间态会让序号出现重复。
   */
  createCompactionMessageAtOrderSeq(
    sessionId: string,
    orderSeq: number,
    status: 'compacting' | 'compacted',
    summaryUpdatedAt: number | null,
    options: CompactionMessageOptions & { shiftExistingMessages?: boolean }
  ): string {
    let messageId = ''
    this.runInDatabaseTransaction(() => {
      if (options?.shiftExistingMessages) {
        const shiftedMessageIds = this.database.deepchatMessagesTable.getIdsFromOrderSeq(
          sessionId,
          orderSeq
        )
        this.database.deepchatMessagesTable.incrementOrderSeqFrom(sessionId, orderSeq)
        this.appendCompactionOrderShiftFacts(sessionId, shiftedMessageIds)
      }
      messageId = this.insertCompactionMessageRecord(
        sessionId,
        orderSeq,
        status,
        summaryUpdatedAt,
        options
      )
    })
    return messageId
  }

  /** 位移过的消息逐条补发 tape 事实（reason=compaction_order_shifted），
   * 分批物化控制单次内存占用；任何一条没找到即整体失败。 */
  private appendCompactionOrderShiftFacts(sessionId: string, messageIds: string[]): void {
    if (messageIds.length === 0) return

    const shiftedRecords: ChatMessageRecord[] = []
    for (
      let offset = 0;
      offset < messageIds.length;
      offset += COMPACTION_SHIFT_MATERIALIZATION_BATCH_SIZE
    ) {
      const batchIds = messageIds.slice(
        offset,
        offset + COMPACTION_SHIFT_MATERIALIZATION_BATCH_SIZE
      )
      const rows = this.database.deepchatMessagesTable.getBySessionAndIds(sessionId, batchIds)
      shiftedRecords.push(...this.toRecords(rows))
    }
    if (shiftedRecords.length !== messageIds.length) {
      throw new Error('Failed to materialize every message shifted by compaction.')
    }
    for (const record of shiftedRecords) {
      this.tapeFacts.appendMessageReplacement(record, {
        reason: 'compaction_order_shifted',
        revisionKind: 'order'
      })
    }
  }

  /** 流式过程中覆写 assistant blocks；消息保持 pending 直到 finalize。 */
  updateAssistantContent(
    messageId: string,
    blocks: AssistantMessageBlock[],
    metadata?: string
  ): void {
    this.database.deepchatAssistantBlocksTable.replaceForMessage(messageId, blocks)
    this.database.deepchatMessagesTable.updateStatus(messageId, 'pending')
    if (metadata !== undefined) {
      this.updateAssistantMetadata(messageId, metadata)
    }
  }

  updateAssistantMetadata(messageId: string, metadata: string): void {
    this.database.deepchatMessagesTable.updateMetadata(messageId, metadata)
    this.persistUsageStats(messageId, metadata, 'live')
  }

  updateMessageStatus(messageId: string, status: 'pending' | 'sent' | 'error'): void {
    this.database.deepchatMessagesTable.updateStatus(messageId, status)
  }

  markSteerMessagesRead(messageIds: string[], readAt: number): ChatMessageRecord[] {
    for (const messageId of messageIds) {
      const message = this.getMessage(messageId)
      if (!message || message.role !== 'user' || message.status !== 'pending') {
        throw new Error(`Pending steer message not found: ${messageId}`)
      }
      const metadata = parseMessageMetadata(message.metadata)
      if (metadata.inputReceipt?.mode !== 'steer' || metadata.inputReceipt.readAt !== null) {
        throw new Error(`Message ${messageId} is not an unread steer message.`)
      }
      this.database.deepchatMessagesTable.updateMetadata(
        messageId,
        JSON.stringify({
          ...metadata,
          inputReceipt: {
            mode: 'steer',
            readAt
          }
        } satisfies MessageMetadata)
      )
      const updated = this.getMessage(messageId)
      if (!updated) {
        throw new Error(`Failed to mark steer message read: ${messageId}`)
      }
      this.tapeFacts.appendMessageReplacement(updated, {
        reason: 'steer_message_read',
        revisionKind: 'record'
      })
    }
    return messageIds.map((messageId) => this.requireMessage(messageId))
  }

  settleSteerMessages(messageIds: string[]): ChatMessageRecord[] {
    for (const messageId of messageIds) {
      const message = this.getMessage(messageId)
      if (!message || message.role !== 'user' || message.status !== 'pending') {
        throw new Error(`Pending steer message not found: ${messageId}`)
      }
      this.database.deepchatMessagesTable.updateStatus(messageId, 'sent')
      const updated = this.requireMessage(messageId)
      this.tapeFacts.appendMessageReplacement(updated, {
        reason: 'steer_message_settled',
        revisionKind: 'record'
      })
    }
    return messageIds.map((messageId) => this.requireMessage(messageId))
  }

  failPendingSteerMessages(messageIds: string[]): ChatMessageRecord[] {
    for (const messageId of messageIds) {
      const message = this.getMessage(messageId)
      if (!message || message.role !== 'user' || message.status !== 'pending') {
        throw new Error(`Pending steer message not found: ${messageId}`)
      }
      const metadata = parseMessageMetadata(message.metadata)
      if (metadata.inputReceipt?.mode !== 'steer' || metadata.inputReceipt.readAt !== null) {
        throw new Error(`Message ${messageId} is not an unread steer message.`)
      }
      this.database.deepchatMessagesTable.updateStatus(messageId, 'error')
      const updated = this.requireMessage(messageId)
      this.tapeFacts.appendMessageReplacement(updated, {
        reason: 'steer_message_restart_failed',
        revisionKind: 'record'
      })
    }
    return messageIds.map((messageId) => this.requireMessage(messageId))
  }

  /** 轮次完成：blocks 定稿、状态转 sent，同步检索文档/用量/tape 事实。 */
  finalizeAssistantMessage(
    messageId: string,
    blocks: AssistantMessageBlock[],
    metadata: string
  ): void {
    this.database.deepchatAssistantBlocksTable.replaceForMessage(messageId, blocks)
    this.database.deepchatMessagesTable.updateContentAndStatus(
      messageId,
      JSON.stringify(blocks),
      'sent',
      metadata
    )
    this.upsertAssistantSearchDocument(messageId, blocks)
    this.persistUsageStats(messageId, metadata, 'live')
    this.appendLiveTapeFacts(messageId)
  }

  /** 压缩标记消息就地推进状态（compacting → compacted），事务内同步 tape。 */
  updateCompactionMessage(
    messageId: string,
    status: 'compacting' | 'compacted',
    summaryUpdatedAt: number | null,
    options: CompactionMessageOptions
  ): void {
    this.runInDatabaseTransaction(() => {
      this.database.deepchatMessagesTable.updateContentAndStatus(
        messageId,
        JSON.stringify(this.buildCompactionBlocks(status)),
        'sent',
        JSON.stringify(
          this.buildCompactionMetadata(
            status,
            summaryUpdatedAt,
            options.compactionAttemptId,
            options.boundaryReason
          )
        )
      )
      this.appendLiveTapeFacts(messageId)
    })
  }

  /** 记录压缩本身消耗的模型调用（token 统计），并同步进用量表。 */
  recordCompactionModelCall(input: TapeCompactionModelCallInput): void {
    this.runInDatabaseTransaction(() => {
      const receipt = this.compactionUsage.appendCompactionModelCall(input)
      this.database.deepchatUsageStatsTable.upsert(
        buildCompactionUsageStatsRecord({
          sessionId: receipt.row.session_id,
          event: receipt.event,
          source: 'live'
        })
      )
    })
  }

  /** 把 assistant 消息标记为失败；有无 metadata 走两条分支（有则同时记账）。 */
  setMessageError(messageId: string, blocks: AssistantMessageBlock[], metadata?: string): void {
    this.database.deepchatAssistantBlocksTable.replaceForMessage(messageId, blocks)
    const serializedBlocks = JSON.stringify(blocks)
    if (metadata === undefined) {
      this.database.deepchatMessagesTable.updateContentAndStatus(
        messageId,
        serializedBlocks,
        'error'
      )
      this.upsertAssistantSearchDocument(messageId, blocks)
      this.appendLiveTapeFacts(messageId)
      return
    }
    this.database.deepchatMessagesTable.updateContentAndStatus(
      messageId,
      serializedBlocks,
      'error',
      metadata
    )
    this.upsertAssistantSearchDocument(messageId, blocks)
    this.persistUsageStats(messageId, metadata, 'live')
    this.appendLiveTapeFacts(messageId)
  }

  getMessages(sessionId: string): ChatMessageRecord[] {
    const rows = this.database.deepchatMessagesTable.getBySession(sessionId)
    return this.toRecords(rows)
  }

  getPendingAssistantMessages(sessionId: string): ChatMessageRecord[] {
    const rows = this.database.deepchatMessagesTable.getPendingAssistantBySession(sessionId)
    return this.toRecords(rows)
  }

  hasMessages(sessionId: string): boolean {
    return this.database.deepchatMessagesTable.hasBySession(sessionId)
  }

  /** 消息分页：limit+1 探测 hasMore；游标取本页最旧一条（倒序存储）。
   * 同时标记每条消息是否有嵌套执行审计，供 UI 展示入口。 */
  listMessagesPage(
    sessionId: string,
    options?: {
      limit?: number
      cursor?: MessagePageCursor | null
    }
  ): ChatMessagePageResult {
    const limit = Math.min(Math.max(Math.floor(options?.limit ?? 100), 1), 500)
    const rows = this.database.deepchatMessagesTable.listPageBySession(sessionId, {
      limit: limit + 1,
      cursor: options?.cursor ?? null
    })
    const hasMore = rows.length > limit
    const pageRows = (hasMore ? rows.slice(0, limit) : rows).reverse()
    let auditedMessageIds = new Set<string>()
    if (this.executionAudit && pageRows.length > 0) {
      try {
        auditedMessageIds = new Set(
          this.executionAudit.listMessageIdsWithNestedExecutionAudit(
            sessionId,
            pageRows.map((row) => row.id)
          )
        )
      } catch (error) {
        logger.warn('Failed to project nested execution audit availability', { sessionId }, error)
      }
    }
    const messages = this.toRecords(pageRows).map((message) => ({
      ...message,
      hasNestedExecutionAudit: auditedMessageIds.has(message.id)
    }))
    const nextCursor =
      hasMore && messages.length > 0
        ? {
            orderSeq: messages[0].orderSeq,
            id: messages[0].id
          }
        : null

    return {
      messages,
      nextCursor,
      hasMore
    }
  }

  getMessagesUpToOrderSeq(sessionId: string, maxOrderSeq: number): ChatMessageRecord[] {
    const rows = this.database.deepchatMessagesTable.getBySessionUpToOrderSeq(
      sessionId,
      maxOrderSeq
    )
    return this.toRecords(rows)
  }

  getMessageIds(sessionId: string): string[] {
    return this.database.deepchatMessagesTable.getIdsBySession(sessionId)
  }

  getMessage(messageId: string): ChatMessageRecord | null {
    const row = this.database.deepchatMessagesTable.get(messageId)
    if (!row) return null
    return this.toRecord(row)
  }

  private requireMessage(messageId: string): ChatMessageRecord {
    const message = this.getMessage(messageId)
    if (!message) {
      throw new Error(`Message not found: ${messageId}`)
    }
    return message
  }

  getLastUserMessageBeforeOrAt(sessionId: string, orderSeq: number): ChatMessageRecord | null {
    const row = this.database.deepchatMessagesTable.getLastUserMessageBeforeOrAtOrderSeq(
      sessionId,
      orderSeq
    )
    if (!row) return null
    return this.toRecord(row)
  }

  /** 更新任意消息的原始 content JSON：user 同步辅表与检索文档，assistant
   * 重建 blocks 表；已定稿的消息再补一条 tape 替换事实。 */
  updateMessageContent(messageId: string, content: string): void {
    this.database.deepchatMessagesTable.updateContent(messageId, content)
    const row = this.database.deepchatMessagesTable.get(messageId)
    if (!row) {
      return
    }

    if (row.role === 'user') {
      const parsed = this.parseUserContent(content)
      if (parsed) {
        this.persistUserContent(messageId, parsed)
        this.upsertMessageSearchDocument(row.session_id, messageId, 'user', content, row.updated_at)
      }
      const updated = this.getMessage(messageId)
      if (updated) {
        this.tapeFacts.appendMessageReplacement(updated, {
          reason: 'message_content_updated',
          revisionKind: 'record'
        })
      }
      return
    }

    const blocks = this.parseAssistantBlocks(content)
    this.database.deepchatAssistantBlocksTable.replaceForMessage(messageId, blocks)
    if (row.status === 'sent' || row.status === 'error') {
      this.upsertMessageSearchDocument(
        row.session_id,
        messageId,
        'assistant',
        content,
        row.updated_at
      )
    }
    const updated = this.getMessage(messageId)
    if (updated) {
      this.tapeFacts.appendMessageReplacement(updated, {
        reason: 'message_content_updated',
        revisionKind: 'record'
      })
    }
  }

  /** 下一个可用序号 = 当前最大序号 + 1；序号在会话内单调递增。 */
  getNextOrderSeq(sessionId: string): number {
    return this.database.deepchatMessagesTable.getMaxOrderSeq(sessionId) + 1
  }

  /** 删除会话的全部消息及所有伴生表数据（会话级清空）。 */
  deleteBySession(sessionId: string): void {
    this.database.deepchatSearchDocumentsTable.deleteBySession(sessionId)
    this.database.deepchatAssistantBlocksTable.deleteBySession(sessionId)
    this.database.deepchatUserMessageLinksTable.deleteBySession(sessionId)
    this.database.deepchatUserMessageFilesTable.deleteBySession(sessionId)
    this.database.deepchatUserMessagesTable.deleteBySession(sessionId)
    this.database.deepchatMessageTracesTable.deleteBySessionId(sessionId)
    this.database.deepchatMessageSearchResultsTable.deleteBySessionId(sessionId)
    this.database.deepchatMessagesTable.deleteBySession(sessionId)
  }

  /** 删除单条消息：事务内先记 tape 撤销事实，再清主表与全部辅表。 */
  deleteMessage(messageId: string): void {
    this.deleteMessageWithReason(messageId, 'message_deleted')
  }

  private deleteMessageWithReason(messageId: string, reason: string): void {
    this.runInDatabaseTransaction(() => {
      const record = this.getMessage(messageId)
      if (record) {
        this.tapeFacts.appendMessageRetraction(record, reason)
      }
      this.database.deepchatSearchDocumentsTable.delete(`message:${messageId}`)
      this.database.deepchatAssistantBlocksTable.delete(messageId)
      this.database.deepchatUserMessageLinksTable.delete(messageId)
      this.database.deepchatUserMessageFilesTable.delete(messageId)
      this.database.deepchatUserMessagesTable.delete(messageId)
      this.database.deepchatMessageTracesTable.deleteByMessageIds([messageId])
      this.database.deepchatMessageSearchResultsTable.deleteByMessageIds([messageId])
      this.database.deepchatMessagesTable.delete(messageId)
    })
  }

  /** 删除某序号起的全部消息（重试截断用），同样先补 tape 撤销事实。 */
  deleteFromOrderSeq(sessionId: string, fromOrderSeq: number): void {
    this.runInDatabaseTransaction(() => {
      const records = this.getMessages(sessionId).filter(
        (record) => record.orderSeq >= fromOrderSeq
      )
      for (const record of records) {
        this.tapeFacts.appendMessageRetraction(record, 'messages_deleted_from_order_seq')
      }
      const messageIds = records.map((record) => record.id)
      if (messageIds.length > 0) {
        this.database.deepchatSearchDocumentsTable.deleteByMessageIds(messageIds)
        this.database.deepchatAssistantBlocksTable.deleteByMessageIds(messageIds)
        this.database.deepchatUserMessageLinksTable.deleteByMessageIds(messageIds)
        this.database.deepchatUserMessageFilesTable.deleteByMessageIds(messageIds)
        this.database.deepchatUserMessagesTable.deleteByMessageIds(messageIds)
        this.database.deepchatMessageTracesTable.deleteByMessageIds(messageIds)
        this.database.deepchatMessageSearchResultsTable.deleteByMessageIds(messageIds)
      }
      this.database.deepchatMessagesTable.deleteFromOrderSeq(sessionId, fromOrderSeq)
    })
  }

  /** 落库一条联网搜索结果（挂在某条消息下），payload 补齐 searchId。 */
  addSearchResult(row: {
    sessionId: string
    messageId: string
    searchId?: string | null
    rank?: number | null
    result: SearchResult
  }): void {
    const payload: SearchResult = {
      title: row.result.title || '',
      url: row.result.url || '',
      snippet: row.result.snippet,
      favicon: row.result.favicon,
      content: row.result.content,
      description: row.result.description,
      icon: row.result.icon,
      rank: row.result.rank,
      searchId: row.result.searchId ?? row.searchId ?? undefined
    }

    this.database.deepchatMessageSearchResultsTable.add({
      sessionId: row.sessionId,
      messageId: row.messageId,
      searchId: row.searchId,
      rank: row.rank,
      content: JSON.stringify(payload)
    })
  }

  /** 读取某条消息的搜索结果；带 searchId 时精确匹配，匹配不到回退旧格式。 */
  getSearchResults(messageId: string, searchId?: string): SearchResult[] {
    const rows = this.database.deepchatMessageSearchResultsTable.listByMessageId(messageId)
    const parsed: SearchResult[] = []

    for (const row of rows) {
      try {
        const result = JSON.parse(row.content) as SearchResult
        parsed.push({
          ...result,
          rank: typeof result.rank === 'number' ? result.rank : (row.rank ?? undefined),
          searchId: result.searchId ?? row.search_id ?? undefined
        })
      } catch (error) {
        console.warn('[SessionTranscript] Failed to parse search result row:', error)
      }
    }

    if (searchId) {
      const filtered = parsed.filter((item) => item.searchId === searchId)
      if (filtered.length > 0) {
        return filtered
      }

      const legacyResults = parsed.filter((item) => !item.searchId)
      if (legacyResults.length > 0) {
        return legacyResults
      }
    }

    return parsed
  }

  /** 记录一次模型请求的完整 trace（endpoint/headers/body，供审计检查器）。 */
  insertMessageTrace(row: {
    id: string
    messageId: string
    sessionId: string
    providerId: string
    modelId: string
    endpoint: string
    headersJson: string
    bodyJson: string
    truncated: boolean
    createdAt?: number
    requestSeq?: number
    logicalRound?: number | null
    physicalAttempt?: number | null
  }): number {
    return this.database.deepchatMessageTracesTable.insert(row)
  }

  listMessageTraces(messageId: string): MessageTraceRecord[] {
    const rows = this.database.deepchatMessageTracesTable.listByMessageId(messageId)
    return rows.map((row) => ({
      id: row.id,
      messageId: row.message_id,
      sessionId: row.session_id,
      providerId: row.provider_id,
      modelId: row.model_id,
      requestSeq: row.request_seq,
      logicalRound: row.logical_round,
      physicalAttempt: row.physical_attempt,
      endpoint: row.endpoint,
      headersJson: row.headers_json,
      bodyJson: row.body_json,
      truncated: row.truncated === 1,
      createdAt: row.created_at
    }))
  }

  getMessageTraceCount(messageId: string): number {
    return this.database.deepchatMessageTracesTable.countByMessageId(messageId)
  }

  getMaxMessageTraceRequestSeq(messageId: string): number {
    return this.database.deepchatMessageTracesTable.maxRequestSeqByMessageId(messageId)
  }

  /**
   * 把源会话中已定稿（sent）的消息复制到新会话，作为 fork 的历史部分。
   * 压缩标记消息不复制（它们只对原会话的压缩状态有意义）；复制的消息
   * 重新编号从 1 开始，辅表/检索文档一并重建。返回复制条数。
   */
  cloneSentMessagesToSession(
    sourceSessionId: string,
    targetSessionId: string,
    maxOrderSeq: number
  ): number {
    const sourceRows = this.database.deepchatMessagesTable
      .getBySessionUpToOrderSeq(sourceSessionId, maxOrderSeq)
      .filter(
        (row) =>
          row.status === 'sent' && parseMessageMetadata(row.metadata).messageType !== 'compaction'
      )
    const sourceRecords = this.toRecords(sourceRows)

    let nextOrderSeq = 1
    for (const record of sourceRecords) {
      const nextId = nanoid()
      this.database.deepchatMessagesTable.insert({
        id: nextId,
        sessionId: targetSessionId,
        orderSeq: nextOrderSeq,
        role: record.role,
        content: record.content,
        status: 'sent',
        isContextEdge: record.isContextEdge,
        metadata: record.metadata
      })
      if (record.role === 'user') {
        const userContent = this.parseUserContent(record.content)
        if (userContent) {
          this.persistUserContent(nextId, userContent)
        }
      } else {
        this.database.deepchatAssistantBlocksTable.replaceForMessage(
          nextId,
          this.parseAssistantBlocks(record.content)
        )
      }
      this.upsertMessageSearchDocument(
        targetSessionId,
        nextId,
        record.role,
        record.content,
        record.updatedAt
      )
      nextOrderSeq += 1
    }

    return sourceRecords.length
  }

  /**
   * 启动恢复：把上次退出时遗留的 pending 消息收敛为 error 终态。
   * 例外（shouldKeepPending）：steer 输入和等待用户操作的权限询问/提问
   * 卡片保持 pending——它们本来就是在等用户，不是中断残留。
   * forceRecoverMessagesBySession 指定无视例外强制恢复的消息。
   */
  recoverPendingMessages(options?: {
    forceRecoverMessagesBySession?: ReadonlyMap<string, ReadonlySet<string>>
  }): number {
    const pendingRows = this.database.deepchatMessagesTable.getByStatus('pending')
    const recoveredRecords = new Map(
      this.toRecords(pendingRows).map((record) => [record.id, record])
    )
    let recoveredCount = 0
    for (const row of pendingRows) {
      const forceRecovery = options?.forceRecoverMessagesBySession?.get(row.session_id)?.has(row.id)
      if (!forceRecovery && this.shouldKeepPending(row)) {
        continue
      }
      if (row.role === 'assistant') {
        const blocks = this.parseAssistantBlocks(
          recoveredRecords.get(row.id)?.content ?? row.content
        )
        const recoveredBlocks = buildTerminalErrorBlocks(blocks, 'common.error.sessionInterrupted')
        this.database.deepchatAssistantBlocksTable.replaceForMessage(row.id, recoveredBlocks)
        this.database.deepchatMessagesTable.updateContentAndStatus(
          row.id,
          JSON.stringify(recoveredBlocks),
          'error'
        )
      } else {
        this.database.deepchatMessagesTable.updateStatus(row.id, 'error')
      }
      recoveredCount += 1
    }
    return recoveredCount
  }

  /**
   * 对账压缩标记消息（启动恢复的一部分）：按 metadata 里的 attemptId 找
   * tape 重建锚点——有锚点说明压缩已完成，补写成 compacted；找不到锚点
   * 说明压缩没做完，删除标记并记入 retracted。逐条容错，失败计数不中断。
   */
  reconcileCompactionMessages(): { compacted: number; retracted: number; failed: number } {
    if (!this.compactionAnchors) return { compacted: 0, retracted: 0, failed: 0 }

    let compacted = 0
    let retracted = 0
    let failed = 0
    for (const row of this.database.deepchatMessagesTable.getCompactionRecoveryCandidates()) {
      try {
        const metadata = parseMessageMetadata(row.metadata)
        const compactionAttemptId = normalizeCompactionAttemptId(metadata.compactionAttemptId)
        const anchor = compactionAttemptId
          ? this.compactionAnchors.getReconstructionAnchorByCompactionAttemptId(
              row.session_id,
              compactionAttemptId
            )
          : undefined

        if (anchor && compactionAttemptId) {
          this.updateCompactionMessage(
            row.id,
            'compacted',
            summaryUpdatedAtFromCompactionAnchor(anchor),
            {
              compactionAttemptId,
              boundaryReason: normalizeCompactionBoundaryReason(
                parseTapeAnchorState(anchor)?.reason
              )
            }
          )
          compacted += 1
          continue
        }

        this.deleteMessageWithReason(row.id, 'stale_compaction_marker_recovered')
        retracted += 1
      } catch (error) {
        failed += 1
        logger.warn(
          'Failed to reconcile compaction marker',
          { sessionId: row.session_id, messageId: row.id },
          error
        )
      }
    }

    return { compacted, retracted, failed }
  }

  /** 数据修复入口：为旧库记录补建结构化辅表与检索文档（幂等）。 */
  backfillMessageRow(row: DeepChatMessageRow): void {
    if (row.role === 'user') {
      const content = this.parseUserContent(row.content)
      if (content) {
        this.persistUserContent(row.id, content)
      }
    } else {
      this.database.deepchatAssistantBlocksTable.replaceForMessage(
        row.id,
        this.parseAssistantBlocks(row.content)
      )
    }

    if (row.status === 'sent' || row.status === 'error') {
      this.upsertMessageSearchDocument(
        row.session_id,
        row.id,
        row.role,
        this.materializeContent(row),
        row.updated_at
      )
    }
  }

  /** 恢复时判定该 pending 消息是否应保留：steer 输入、待用户操作的动作卡。 */
  private shouldKeepPending(row: DeepChatMessageRow): boolean {
    if (row.role === 'user') {
      return parseMessageMetadata(row.metadata).inputReceipt?.mode === 'steer'
    }
    const blocks = this.parseAssistantBlocks(this.materializeContent(row))
    return blocks.some(
      (block) =>
        block.type === 'action' &&
        (block.action_type === 'tool_call_permission' ||
          block.action_type === 'question_request') &&
        block.status === 'pending' &&
        block.extra?.needsUserAction !== false
    )
  }

  /** 把消息的最新状态追加为 tape 事实（新建或定稿时调用）。 */
  private appendLiveTapeFacts(messageId: string): void {
    const record = this.getMessage(messageId)
    if (!record) {
      return
    }
    this.tapeFacts.appendMessageRecord(record)
  }

  private toRecord(row: DeepChatMessageRow): ChatMessageRecord {
    return this.toRecords([row])[0]!
  }

  /** 行 → 记录；批量读取时先取全部辅表再逐行物化，避免 N+1 查询。 */
  private toRecords(rows: DeepChatMessageRow[]): ChatMessageRecord[] {
    if (rows.length === 0) {
      return []
    }

    const maps = this.loadStructuredMaps(rows.map((row) => row.id))
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      orderSeq: row.order_seq,
      role: row.role,
      content: this.materializeContent(row, maps),
      status: row.status,
      isContextEdge: row.is_context_edge,
      metadata: row.metadata,
      traceCount: row.trace_count ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  /**
   * 物化消息 content：主行的 JSON 只是权威源的一部分，user 消息要并回
   * text/files/links 辅表，assistant 消息以 blocks 表为准（主行为空时回退）。
   * 批量路径传入预取的 maps，单条路径自行查询。
   */
  private materializeContent(row: DeepChatMessageRow, maps?: StructuredMessageMaps): string {
    if (row.role === 'user') {
      const userRow =
        maps?.userRows.get(row.id) ?? this.database.deepchatUserMessagesTable.get(row.id)
      if (!userRow) {
        return row.content
      }

      const fileRows = maps
        ? (maps.fileRows.get(row.id) ?? [])
        : this.database.deepchatUserMessageFilesTable.listByMessageIds([row.id])
      const linkRows = maps
        ? (maps.linkRows.get(row.id) ?? [])
        : this.database.deepchatUserMessageLinksTable.listByMessageIds([row.id])

      const rawUserContent = this.parseUserContent(row.content)
      const activeSkills = rawUserContent?.activeSkills ?? []
      const inlineItems = rawUserContent?.inlineItems ?? []
      return JSON.stringify({
        text: userRow.text,
        files: fileRows.map((fileRow) => this.toMessageFile(fileRow)),
        links: linkRows.map((linkRow) => linkRow.url),
        search: userRow.search_enabled === 1,
        think: userRow.think_enabled === 1,
        ...(activeSkills.length > 0 ? { activeSkills } : {}),
        ...(inlineItems.length > 0 ? { inlineItems } : {})
      } satisfies UserMessageContent)
    }

    const assistantRows = maps
      ? (maps.assistantRows.get(row.id) ?? [])
      : this.database.deepchatAssistantBlocksTable.listByMessageId(row.id)
    if (assistantRows.length === 0) {
      return row.content
    }

    return JSON.stringify(assistantRows.map((blockRow) => this.toAssistantBlock(blockRow)))
  }

  private parseAssistantBlocks(rawContent: string): AssistantMessageBlock[] {
    try {
      const parsed = JSON.parse(rawContent) as AssistantMessageBlock[]
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /** 解析用户消息 content JSON，字段逐一兜底为合法默认值。 */
  private parseUserContent(rawContent: string): UserMessageContent | null {
    try {
      const parsed = JSON.parse(rawContent) as Partial<UserMessageContent>
      if (!parsed || typeof parsed !== 'object') {
        return null
      }

      return {
        text: typeof parsed.text === 'string' ? parsed.text : '',
        files: Array.isArray(parsed.files) ? (parsed.files.filter(Boolean) as MessageFile[]) : [],
        links: Array.isArray(parsed.links)
          ? parsed.links.filter((item): item is string => typeof item === 'string')
          : [],
        search: parsed.search === true,
        think: parsed.think === true,
        activeSkills: this.normalizeActiveSkills(parsed.activeSkills),
        inlineItems: Array.isArray(parsed.inlineItems) ? parsed.inlineItems : []
      }
    } catch {
      return null
    }
  }

  private normalizeActiveSkills(activeSkills?: string[]): string[] {
    if (!Array.isArray(activeSkills)) {
      return []
    }

    return Array.from(
      new Set(
        activeSkills
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
      )
    )
  }

  /** 生成压缩标记消息的可见文案块（进行中/已完成两种）。 */
  private buildCompactionBlocks(status: 'compacting' | 'compacted'): AssistantMessageBlock[] {
    return [
      {
        type: 'content',
        content:
          status === 'compacting'
            ? 'Compacting conversation context...'
            : 'Conversation context compacted.',
        status: status === 'compacting' ? 'loading' : 'success',
        timestamp: Date.now()
      }
    ]
  }

  private buildCompactionMetadata(
    status: 'compacting' | 'compacted',
    summaryUpdatedAt: number | null,
    compactionAttemptId: string,
    boundaryReason: SessionCompactionBoundaryReason | null = null
  ): MessageMetadata {
    return {
      messageType: 'compaction',
      compactionStatus: status,
      compactionAttemptId,
      compactionBoundaryReason: boundaryReason,
      summaryUpdatedAt
    }
  }

  /** 把用户消息内容拆写进三张辅表（text/files/links），附件元数据打包进 JSON。 */
  private persistUserContent(messageId: string, content: UserMessageContent): void {
    this.database.deepchatUserMessagesTable.upsert({
      messageId,
      text: content.text,
      searchEnabled: content.search === true,
      thinkEnabled: content.think === true
    })
    this.database.deepchatUserMessageFilesTable.replaceForMessage(
      messageId,
      content.files.map((file) => ({
        name: file.name,
        path: file.path,
        mimeType: file.mimeType ?? file.type,
        size: file.size,
        metadataJson: JSON.stringify({
          type: file.type,
          content: file.content,
          token: file.token,
          thumbnail: file.thumbnail,
          metadata: file.metadata,
          requestedRepresentation: normalizeAttachmentRepresentationPreference(
            file.requestedRepresentation
          ),
          pdfTextCoverage: normalizePdfEmbeddedTextCoverage(file.pdfTextCoverage),
          resolvedRepresentation: normalizeAttachmentResolvedRepresentation(
            file.resolvedRepresentation
          )
        })
      }))
    )
    this.database.deepchatUserMessageLinksTable.replaceForMessage(messageId, content.links)
  }

  private toMessageFile(row: DeepChatUserMessageFileRow): MessageFile {
    const extra = this.parseJson<Record<string, unknown>>(row.metadata_json, {})
    return {
      name: row.name ?? '',
      path: row.path,
      type: typeof extra.type === 'string' ? extra.type : (row.mime_type ?? undefined),
      size: row.size ?? undefined,
      content: typeof extra.content === 'string' ? extra.content : undefined,
      mimeType: row.mime_type ?? undefined,
      token: typeof extra.token === 'number' ? extra.token : undefined,
      thumbnail: typeof extra.thumbnail === 'string' ? extra.thumbnail : undefined,
      requestedRepresentation: normalizeAttachmentRepresentationPreference(
        extra.requestedRepresentation
      ),
      pdfTextCoverage: normalizePdfEmbeddedTextCoverage(extra.pdfTextCoverage),
      resolvedRepresentation: normalizeAttachmentResolvedRepresentation(
        extra.resolvedRepresentation
      ),
      metadata:
        extra.metadata && typeof extra.metadata === 'object' && !Array.isArray(extra.metadata)
          ? (extra.metadata as MessageFile['metadata'])
          : undefined
    }
  }

  private toAssistantBlock(row: DeepChatAssistantBlockRow): AssistantMessageBlock {
    const extra = this.parseJson<{
      id?: string
      timestamp?: number
      imageData?: string
      extra?: AssistantMessageBlock['extra']
      toolCallExtra?: Record<string, unknown>
      reasoningTime?: number
    }>(row.extra_json, {})

    const toolCall =
      row.tool_call_id ||
      row.tool_name ||
      row.tool_params ||
      row.tool_response ||
      extra.toolCallExtra
        ? {
            ...extra.toolCallExtra,
            id: row.tool_call_id ?? undefined,
            name: row.tool_name ?? undefined,
            params: row.tool_params ?? undefined,
            response: row.tool_response ?? undefined
          }
        : undefined

    const reasoningTime =
      typeof extra.reasoningTime === 'number'
        ? extra.reasoningTime
        : row.reasoning_start_at !== null && row.reasoning_end_at !== null
          ? {
              start: row.reasoning_start_at,
              end: row.reasoning_end_at
            }
          : undefined

    const imageData = extra.imageData?.trim()
    const actionType = normalizePersistedActionType(row.action_type)

    return {
      id: extra.id,
      type: row.block_type as AssistantMessageBlock['type'],
      content: row.text_content ?? undefined,
      status: row.status as AssistantMessageBlock['status'],
      timestamp: extra.timestamp ?? row.updated_at,
      reasoning_time: reasoningTime,
      image_data:
        imageData && row.image_mime_type
          ? {
              data: imageData,
              mimeType: row.image_mime_type
            }
          : undefined,
      tool_call: toolCall as AssistantMessageBlock['tool_call'],
      extra: extra.extra,
      ...(actionType ? { action_type: actionType } : {})
    }
  }

  /** 批量预取一批消息的全部辅表行并按消息 id 分组（读路径去 N+1 的关键）。 */
  private loadStructuredMaps(messageIds: string[]): StructuredMessageMaps {
    const userRows = this.database.deepchatUserMessagesTable.listByMessageIds(messageIds)
    const fileRows = this.database.deepchatUserMessageFilesTable.listByMessageIds(messageIds)
    const linkRows = this.database.deepchatUserMessageLinksTable.listByMessageIds(messageIds)
    const assistantRows = this.database.deepchatAssistantBlocksTable.listByMessageIds(messageIds)

    return {
      userRows: new Map(userRows.map((row) => [row.message_id, row])),
      fileRows: this.groupByMessageId(fileRows),
      linkRows: this.groupByMessageId(linkRows),
      assistantRows: this.groupByMessageId(assistantRows)
    }
  }

  private groupByMessageId<T extends { message_id: string }>(rows: T[]): Map<string, T[]> {
    const grouped = new Map<string, T[]>()
    for (const row of rows) {
      const bucket = grouped.get(row.message_id)
      if (bucket) {
        bucket.push(row)
      } else {
        grouped.set(row.message_id, [row])
      }
    }
    return grouped
  }

  private upsertAssistantSearchDocument(messageId: string, blocks: AssistantMessageBlock[]): void {
    const messageRow = this.database.deepchatMessagesTable.get(messageId)
    if (!messageRow) {
      return
    }

    this.upsertMessageSearchDocument(
      messageRow.session_id,
      messageId,
      'assistant',
      JSON.stringify(blocks),
      messageRow.updated_at
    )
  }

  /** upsert 消息的检索文档；标题取所属会话标题，内容经 searchable 抽取。 */
  private upsertMessageSearchDocument(
    sessionId: string,
    messageId: string,
    role: 'user' | 'assistant',
    rawContent: string,
    updatedAt: number = Date.now()
  ): void {
    const sessionTitle = this.database.newSessionsTable.get(sessionId)?.title ?? ''
    this.database.deepchatSearchDocumentsTable.upsert({
      documentKey: `message:${messageId}`,
      sessionId,
      messageId,
      documentKind: 'message',
      role,
      title: sessionTitle,
      content: extractSearchableMessageContent(rawContent),
      updatedAt
    })
  }

  private parseJson<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) {
      return fallback
    }

    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  /** 从 assistant 消息 metadata 提取 token 用量写进统计表；压缩消息与
   * 无法确定 provider/model 的消息跳过，解析失败只记错误不影响主流程。 */
  private persistUsageStats(
    messageId: string,
    metadataRaw: string,
    source: 'backfill' | 'live'
  ): void {
    const usageStatsTable = this.database.deepchatUsageStatsTable
    const messageRow = this.database.deepchatMessagesTable.get(messageId)
    if (!messageRow || messageRow.role !== 'assistant') {
      return
    }

    try {
      const metadata = parseMessageMetadata(metadataRaw)
      if (metadata.messageType === 'compaction') {
        return
      }

      const sessionRow = this.database.deepchatSessionsTable.get(messageRow.session_id)
      const providerId = resolveUsageProviderId(metadata, sessionRow?.provider_id)
      const modelId = resolveUsageModelId(metadata, sessionRow?.model_id)

      if (!providerId || !modelId) {
        return
      }

      const usageRecord = buildUsageStatsRecord({
        messageId: messageRow.id,
        sessionId: messageRow.session_id,
        createdAt: messageRow.created_at,
        updatedAt: messageRow.updated_at,
        providerId,
        modelId,
        metadata,
        source
      })

      if (!usageRecord) {
        return
      }

      usageStatsTable.upsert(usageRecord)
    } catch (error) {
      logger.error('Failed to persist deepchat usage stats', { messageId, source }, error)
      return
    }
  }
}
