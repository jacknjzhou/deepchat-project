import logger from '@shared/logger'
import type {
  AgentTapeAnchorResult,
  AgentTapeAnchorsOptions,
  AgentTapeContextOptions,
  AgentTapeContextResult,
  AgentTapeHandoffState,
  AgentTapeInfo,
  AgentTapeSearchOptions,
  AgentTapeSearchResult,
  AssistantMessageBlock,
  ChatMessagePageResult,
  ChatMessageRecord,
  MessagePageCursor,
  MessageTraceRecord,
  SessionLightweightListResult,
  SessionListItem,
  SessionRecord,
  SessionWithState,
  UserMessageContent
} from '@shared/types/agent-interface'
import type { SearchResult } from '@shared/types/core/search'
import type { DeepChatTapeViewManifestRecord } from '@shared/types/tape-view-manifest'
import type {
  DeepChatTapeReplayExportOptions,
  DeepChatTapeReplaySlice
} from '@shared/types/tape-replay'
import type {
  DeepChatNestedExecutionAudit,
  DeepChatNestedExecutionAuditState
} from '@shared/types/execution-journal-audit'
import type {
  ExportTapeInspectorSupportTraceInput,
  ExportTapeInspectorSupportTraceOutput,
  GetTapeInspectorRecordDetailInput,
  GetTapeInspectorRecordDetailOutput,
  ListTapeInspectorEvidenceInput,
  ListTapeInspectorEvidenceOutput,
  ListTapeInspectorPageInput,
  ListTapeInspectorPageOutput,
  ResolveTapeInspectorEvidenceEntriesInput,
  ResolveTapeInspectorEvidenceEntriesOutput
} from '@shared/types/tape-inspector'
import { TAPE_INSPECTOR_SUPPORT_EVIDENCE_LIMIT } from '@shared/types/tape-inspector'
import { ExecutionJournalCorruptionError } from '@/tape/domain/executionJournal'
import type {
  SessionLightweightOptions,
  SessionListFilters,
  SessionProjectionAgentConfigPort,
  SessionProjectionEventPort,
  SessionProjectionMessageLookupPort,
  SessionProjectionMutationPort,
  SessionProjectionReadPort,
  SessionProjectionRuntimePort,
  SessionProjectionSearchResultStorePort,
  SessionProjectionStorePort,
  SessionProjectionTapePort,
  SessionProjectionTitlePort,
  SessionProjectionTraceStorePort,
  SessionProjectionTranscriptPort,
  SessionProjectionUiPort,
  SessionProjectionUpdate,
  TitleGenerationInput
} from './contracts'
import { projectMessagePageForClient } from './clientMessageProjection'

export interface SessionQueryDependencies {
  sessions: SessionProjectionStorePort
  runtime: SessionProjectionRuntimePort
  transcript: SessionProjectionTranscriptPort
  tape: SessionProjectionTapePort
  messages: SessionProjectionMessageLookupPort
  searchResults: SessionProjectionSearchResultStorePort
  traces: SessionProjectionTraceStorePort
  titles: SessionProjectionTitlePort
  agentConfig: SessionProjectionAgentConfigPort
  events: SessionProjectionEventPort
  ui: SessionProjectionUiPort
}

/** 嵌套执行审计不可用/损坏时的兜底响应：结构合法，但 operations 为空。 */
function unavailableNestedExecutionAudit(
  state: Exclude<DeepChatNestedExecutionAuditState, 'available'>
): DeepChatNestedExecutionAudit {
  return {
    schemaVersion: 1,
    state,
    operations: [],
    truncated: false
  }
}

function emptyNestedExecutionAudit(): DeepChatNestedExecutionAudit {
  return {
    schemaVersion: 1,
    state: 'available',
    operations: [],
    truncated: false
  }
}

function normalizeInspectorEvidenceLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 100
  return Math.min(Math.max(Math.floor(limit), 1), 200)
}

/** 会话查询与轻量写操作模块，是渲染层读取会话数据的统一读端口。
 *
 * 三类职责：
 * 1. 会话列表/详情——listSessions 与 materialize 系列会把存储记录与运行时
 *    快照合并成完整状态；轻量列表（listLightweight）只读已水合的运行时，
 *    Agent 不可用时列表仍可用，分页供大数据量下渐进加载。
 * 2. 消息与执行痕迹——消息分页、tape 信息/检索/上下文、审计检查器（inspector）
 *    证据分页、请求 trace、搜索结果读取；按消息聚合的接口先反查消息归属
 *    会话再委托 tape 端口。
 * 3. 轻量写与通知——改名/置顶、变更广播（notify）、异步标题生成（生成中
 *    轮询首轮消息，完成后覆写占位标题）。
 *
 * 读失败一律降级：单会话不可用就从列表跳过，子功能失败返回空值，绝不
 * 让一个坏会话拖垮整个列表接口。
 */
export class SessionQuery implements SessionProjectionReadPort, SessionProjectionMutationPort {
  constructor(private readonly dependencies: SessionQueryDependencies) {}

  /** 全量列表：逐条合并运行时快照；个别会话物化失败只跳过并告警。 */
  async listSessions(filters?: SessionListFilters): Promise<SessionWithState[]> {
    const records = this.dependencies.sessions.list(filters)
    const enriched: SessionWithState[] = []

    for (const record of records) {
      const session = await this.tryMaterializeRecord(record, 'list')
      if (session) enriched.push(session)
    }

    return enriched
  }

  /**
   * 轻量分页列表：不触碰未水合的运行时，侧栏场景用。prioritizeSessionId
   * 把指定会话提到最前——用户刚操作过的会话即使不在本页也应可见。
   */
  async listLightweight(
    options?: SessionLightweightOptions
  ): Promise<SessionLightweightListResult> {
    const page = this.dependencies.sessions.listPage({
      limit: options?.limit,
      cursor: options?.cursor,
      agentId: options?.agentId,
      includeSubagents: options?.includeSubagents
    })
    const items = await Promise.all(
      page.records.map((record) => this.mapSessionRecordToListItem(record))
    )
    const prioritizeSessionId = options?.prioritizeSessionId?.trim()

    if (prioritizeSessionId) {
      // 被置顶的会话单独取出后插到页首，但仍要过一遍过滤条件，避免混入
      // 用户当前筛选视图之外的条目。
      const prioritizedRecord = this.dependencies.sessions.get(prioritizeSessionId)
      if (prioritizedRecord && this.matchesLightweightFilter(prioritizedRecord, options)) {
        items.unshift(await this.mapSessionRecordToListItem(prioritizedRecord))
      }
    }

    return {
      items: this.dedupeAndSortSessionListItems(items),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore
    }
  }

  async getLightweightByIds(sessionIds: string[]): Promise<SessionListItem[]> {
    const dedupedIds = Array.from(
      new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean))
    )
    return this.dedupeAndSortSessionListItems(
      await Promise.all(
        this.dependencies.sessions
          .getMany(dedupedIds)
          .map((record) => this.mapSessionRecordToListItem(record))
      )
    )
  }

  /** 单条读取；record 不存在返回 null，物化失败返回 null（见 tryMaterializeRecord）。 */
  async getSession(sessionId: string): Promise<SessionWithState | null> {
    return await this.materialize(sessionId)
  }

  /** 存储记录 + 运行时快照 → 完整会话状态（status/provider/model 回填）。 */
  async materialize(sessionId: string): Promise<SessionWithState | null> {
    const record = this.dependencies.sessions.get(sessionId)
    if (!record) return null
    return await this.tryMaterializeRecord(record)
  }

  /** 与 materialize 相同，但调用方断言会话必须存在且可读（如写后回读）。 */
  async materializeRequired(sessionId: string): Promise<SessionWithState> {
    const record = this.dependencies.sessions.get(sessionId)
    if (!record) throw new Error(`Session not found: ${sessionId}`)
    return await this.materializeRecord(record)
  }

  async getMessages(sessionId: string): Promise<ChatMessageRecord[]> {
    this.requireSession(sessionId)
    return await this.dependencies.transcript.getMessages(sessionId)
  }

  /** 消息分页：transcript 端口取原始页后再做客户端投影（脱敏/裁剪）。 */
  async listMessagesPage(
    sessionId: string,
    options?: { limit?: number; cursor?: MessagePageCursor | null }
  ): Promise<ChatMessagePageResult> {
    this.requireSession(sessionId)
    const page = await this.dependencies.transcript.listMessagesPage(sessionId, options)
    return projectMessagePageForClient(page)
  }

  async getTapeInfo(sessionId: string): Promise<AgentTapeInfo> {
    this.requireSession(sessionId)
    return await this.dependencies.tape.getTapeInfo(sessionId)
  }

  async searchTape(
    sessionId: string,
    query: string,
    options?: AgentTapeSearchOptions
  ): Promise<AgentTapeSearchResult[]> {
    this.requireSession(sessionId)
    return await this.dependencies.tape.searchTape(sessionId, query, options)
  }

  async getTapeContext(
    sessionId: string,
    entryIds: number[],
    options?: AgentTapeContextOptions
  ): Promise<AgentTapeContextResult> {
    this.requireSession(sessionId)
    return await this.dependencies.tape.getTapeContext(sessionId, entryIds, options)
  }

  async listTapeInspectorPage(
    input: ListTapeInspectorPageInput
  ): Promise<ListTapeInspectorPageOutput> {
    this.requireSession(input.sessionId)
    return await this.dependencies.tape.listTapeInspectorPage(input)
  }

  async resolveTapeInspectorEvidenceEntries(
    input: ResolveTapeInspectorEvidenceEntriesInput
  ): Promise<ResolveTapeInspectorEvidenceEntriesOutput> {
    this.requireSession(input.sessionId)
    return await this.dependencies.tape.resolveTapeInspectorEvidenceEntries(input)
  }

  async getTapeInspectorRecordDetail(
    input: GetTapeInspectorRecordDetailInput
  ): Promise<GetTapeInspectorRecordDetailOutput> {
    this.requireSession(input.sessionId)
    return await this.dependencies.tape.getTapeInspectorRecordDetail(input)
  }

  /**
   * 导出供人工排查的「支持轨迹」包：事实数据 + 最近一段证据。
   * 证据按时间正序放回（查询是 older 模式倒序取的），truncated 各项如实
   * 标注，让接收方知道包不完整。
   */
  async exportTapeInspectorSupportTrace(
    input: ExportTapeInspectorSupportTraceInput
  ): Promise<ExportTapeInspectorSupportTraceOutput> {
    this.requireSession(input.sessionId)
    const facts = await this.dependencies.tape.exportTapeInspectorSupportFacts(input)
    if (facts.status === 'reset') return facts
    const evidence = await this.listTapeInspectorEvidence({
      sessionId: input.sessionId,
      mode: 'older',
      limit: TAPE_INSPECTOR_SUPPORT_EVIDENCE_LIMIT
    })
    return {
      status: 'ok',
      trace: {
        schemaVersion: 1,
        exportedAt: Date.now(),
        sessionId: input.sessionId,
        tapeIncarnationId: facts.tapeIncarnationId,
        snapshotMaxEntryId: facts.snapshotMaxEntryId,
        facts: facts.facts,
        evidence: [...evidence.records].reverse(),
        truncated: {
          facts: facts.factsTruncated,
          evidence: evidence.nextCursor !== null,
          detailData: facts.detailDataTruncated
        }
      }
    }
  }

  async listTapeAnchors(
    sessionId: string,
    options?: AgentTapeAnchorsOptions
  ): Promise<AgentTapeAnchorResult[]> {
    this.requireSession(sessionId)
    return await this.dependencies.tape.listTapeAnchors(sessionId, options)
  }

  async handoffTape(
    sessionId: string,
    name: string,
    state: AgentTapeHandoffState
  ): Promise<AgentTapeAnchorResult> {
    this.requireSession(sessionId)
    return await this.dependencies.tape.handoffTape(sessionId, name, state)
  }

  async listMessageViewManifests(messageId: string): Promise<DeepChatTapeViewManifestRecord[]> {
    const normalizedMessageId = messageId?.trim()
    if (!normalizedMessageId) return []

    const message = this.dependencies.messages.get(normalizedMessageId)
    if (!message || !this.dependencies.sessions.get(message.session_id)) return []

    try {
      return await this.dependencies.tape.listMessageViewManifests(
        message.session_id,
        normalizedMessageId
      )
    } catch (error) {
      logger.warn('[SessionQuery] Failed to list message view manifests', {
        messageId: normalizedMessageId,
        error
      })
      return []
    }
  }

  async listNestedExecutionAudit(messageId: string): Promise<DeepChatNestedExecutionAudit> {
    const normalizedMessageId = messageId?.trim()
    if (!normalizedMessageId) return emptyNestedExecutionAudit()

    const message = this.dependencies.messages.get(normalizedMessageId)
    if (!message || !this.dependencies.sessions.get(message.session_id)) {
      return emptyNestedExecutionAudit()
    }

    try {
      return await this.dependencies.tape.listNestedExecutionAuditForMessage(
        message.session_id,
        normalizedMessageId
      )
    } catch (error) {
      const state = error instanceof ExecutionJournalCorruptionError ? 'corrupt' : 'unavailable'
      logger.warn('[SessionQuery] Failed to list nested execution audit', {
        messageId: normalizedMessageId,
        state,
        error
      })
      return unavailableNestedExecutionAudit(state)
    }
  }

  async exportMessageTapeReplaySlice(
    messageId: string,
    options?: DeepChatTapeReplayExportOptions
  ): Promise<DeepChatTapeReplaySlice | null> {
    const normalizedMessageId = messageId?.trim()
    if (!normalizedMessageId) return null

    const message = this.dependencies.messages.get(normalizedMessageId)
    if (!message || !this.dependencies.sessions.get(message.session_id)) return null

    try {
      return await this.dependencies.tape.exportMessageTapeReplaySlice(
        message.session_id,
        normalizedMessageId,
        options
      )
    } catch (error) {
      logger.warn('[SessionQuery] Failed to export tape replay slice', {
        messageId: normalizedMessageId,
        error
      })
      return null
    }
  }

  /**
   * 读取某条消息附带的搜索结果（联网搜索工具的产物）。
   * 行内容是 JSON，解析失败的行跳过。带 searchId 过滤时优先精确匹配；
   * 匹配不到则回退到旧数据（无 searchId 的行）——历史消息入库时还没有
   * 这个字段，不能因此显示为空。
   */
  async getSearchResults(messageId: string, searchId?: string): Promise<SearchResult[]> {
    const normalizedMessageId = messageId?.trim()
    if (!normalizedMessageId) return []

    const parsed: SearchResult[] = []
    for (const row of this.dependencies.searchResults.listByMessageId(normalizedMessageId)) {
      try {
        const result = JSON.parse(row.content) as SearchResult
        parsed.push({
          ...result,
          rank: typeof result.rank === 'number' ? result.rank : (row.rank ?? undefined),
          searchId: result.searchId ?? row.search_id ?? undefined
        })
      } catch (error) {
        console.warn('[SessionQuery] Failed to parse search result row:', error)
      }
    }

    if (searchId) {
      const filtered = parsed.filter((item) => item.searchId === searchId)
      if (filtered.length > 0) return filtered
      const legacy = parsed.filter((item) => !item.searchId)
      if (legacy.length > 0) return legacy
    }

    return parsed
  }

  async listMessageTraces(messageId: string): Promise<MessageTraceRecord[]> {
    if (!messageId?.trim()) return []
    return this.dependencies.traces.listByMessageId(messageId).map((row) => ({
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

  /**
   * 检查器证据分页。older/newer 两种游标方向：older 供向前翻历史（只有
   * 这个方向产生 nextCursor），newer 供实时追加查看。
   */
  async listTapeInspectorEvidence(
    input: ListTapeInspectorEvidenceInput
  ): Promise<ListTapeInspectorEvidenceOutput> {
    this.requireSession(input.sessionId)
    const pageInput = {
      sessionId: input.sessionId,
      limit: normalizeInspectorEvidenceLimit(input.limit),
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      ...(input.requestSeq === undefined ? {} : { requestSeq: input.requestSeq }),
      ...(input.physicalAttempt === undefined ? {} : { physicalAttempt: input.physicalAttempt })
    }
    const page =
      input.mode === 'older'
        ? this.dependencies.traces.listInspectorMetadata({
            ...pageInput,
            mode: 'older',
            ...(input.cursor ? { cursor: input.cursor } : {})
          })
        : this.dependencies.traces.listInspectorMetadata({
            ...pageInput,
            mode: 'newer',
            ...(input.cursor ? { cursor: input.cursor } : {})
          })
    const records = page.rows.map((row) => ({
      recordType: 'evidence' as const,
      key: `trace:${row.id}` as const,
      traceId: row.id,
      messageId: row.message_id,
      requestSeq: row.request_seq,
      ...(row.logical_round === null ? {} : { logicalRound: row.logical_round }),
      ...(row.physical_attempt === null ? {} : { physicalAttempt: row.physical_attempt }),
      providerId: row.provider_id,
      modelId: row.model_id,
      createdAt: row.created_at,
      truncated: row.truncated === 1
    }))
    const lastRow = page.rows.at(-1)
    return {
      records,
      nextCursor:
        input.mode === 'older' && page.hasMore && lastRow
          ? { createdAt: lastRow.created_at, traceId: lastRow.id }
          : null,
      newerCursor: page.appendCursorRowId === null ? null : { rowId: page.appendCursorRowId }
    }
  }

  async getMessageTraceCount(messageId: string): Promise<number> {
    const normalizedMessageId = messageId?.trim()
    if (!normalizedMessageId) return 0
    return this.dependencies.traces.countByMessageId(normalizedMessageId)
  }

  async getMessageIds(sessionId: string): Promise<string[]> {
    this.requireSession(sessionId)
    return await this.dependencies.transcript.getMessageIds(sessionId)
  }

  async getMessage(messageId: string): Promise<ChatMessageRecord | null> {
    return await this.dependencies.transcript.getMessage(messageId)
  }

  async renameSession(sessionId: string, title: string): Promise<SessionWithState> {
    this.requireSession(sessionId)
    const normalized = title.trim()
    if (!normalized) throw new Error('Session title cannot be empty.')

    this.dependencies.sessions.update(sessionId, { title: normalized })
    const session = await this.materializeRequired(sessionId)
    this.notify({ sessionIds: [sessionId], reason: 'updated' })
    return session
  }

  async toggleSessionPinned(sessionId: string, pinned: boolean): Promise<SessionWithState> {
    this.requireSession(sessionId)
    this.dependencies.sessions.update(sessionId, { isPinned: pinned })
    const session = await this.materializeRequired(sessionId)
    this.notify({ sessionIds: [sessionId], reason: 'updated' })
    return session
  }

  /** 广播会话变更事件并刷新相关 UI。activated/deactivated 不触发侧栏刷新。 */
  notify(options: SessionProjectionUpdate = {}): void {
    const sessionIds = Array.from(
      new Set(options.sessionIds?.map((sessionId) => sessionId.trim()).filter(Boolean) ?? [])
    )
    const reason = options.reason ?? (sessionIds.length > 0 ? 'updated' : 'list-refreshed')

    this.dependencies.events.publish({
      sessionIds,
      reason,
      activeSessionId: options.activeSessionId,
      webContentsId: options.webContentsId
    })
    if (reason !== 'activated' && reason !== 'deactivated') {
      this.dependencies.ui.refreshSessionUi()
    }
  }

  /** 触发异步标题生成，不等待结果；失败只告警，占位标题保持不变。 */
  scheduleTitleGeneration(input: TitleGenerationInput): void {
    void this.generateSessionTitle(input)
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = this.dependencies.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    return session
  }

  /** 合并存储记录与运行时快照；list 模式用轻量快照减少列表场景的开销。 */
  private async materializeRecord(
    record: SessionRecord,
    mode: 'full' | 'list' = 'full'
  ): Promise<SessionWithState> {
    const state = await this.dependencies.runtime.snapshot(record.id, {
      lightweight: mode === 'list'
    })
    const status = state?.status ?? 'idle'
    return {
      ...record,
      status,
      providerId: state?.providerId ?? '',
      modelId: state?.modelId ?? ''
    }
  }

  /** materializeRecord 的容错版：单个会话不可用不拖垮列表，跳过并告警。 */
  private async tryMaterializeRecord(
    record: SessionRecord,
    mode: 'full' | 'list' = 'full'
  ): Promise<SessionWithState | null> {
    try {
      return await this.materializeRecord(record, mode)
    } catch (error) {
      console.warn(
        `[SessionQuery] Skipping unavailable session id=${record.id} agent=${record.agentId}:`,
        error
      )
      return null
    }
  }

  /**
   * 列表项映射：只读「已水合」的快照。未水合说明该 Agent 侧没有活跃
   * 状态，按 idle 呈现即可，绝不为列表去触发完整加载。
   */
  private async mapSessionRecordToListItem(record: SessionRecord): Promise<SessionListItem> {
    let status: SessionListItem['status'] = 'idle'
    try {
      status = (await this.dependencies.runtime.snapshotIfHydrated(record.id))?.status ?? 'idle'
    } catch {
      // Lightweight reads remain available when an Agent is unavailable.
    }
    return {
      ...record,
      status
    }
  }

  /** 按 updatedAt 倒序（新在前），同刻用 id 比较保证顺序稳定可复现。 */
  private dedupeAndSortSessionListItems(items: SessionListItem[]): SessionListItem[] {
    const sessionMap = new Map<string, SessionListItem>()
    for (const item of items) sessionMap.set(item.id, item)

    return Array.from(sessionMap.values()).sort((left, right) => {
      if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt
      return right.id.localeCompare(left.id)
    })
  }

  private matchesLightweightFilter(
    record: SessionRecord,
    options?: Pick<SessionLightweightOptions, 'includeSubagents' | 'agentId'>
  ): boolean {
    if (options?.agentId && record.agentId !== options.agentId) return false
    return options?.includeSubagents === true || record.sessionKind !== 'subagent'
  }

  /**
   * 异步生成会话标题：等首轮消息就绪 → 选定生成用模型 → 生成 → 覆写。
   * 多处防御性检查（会话仍在、标题未被用户改过）避免覆盖用户的手动命名；
   * 首选模型失败时回退到会话自身的 provider/model 再试一次。
   */
  private async generateSessionTitle(input: TitleGenerationInput): Promise<void> {
    const { sessionId, initialTitle, fallbackProviderId, fallbackModelId } = input
    try {
      const titleMessages = await this.waitForSessionTitleMessages(sessionId)
      if (!titleMessages) return

      const currentSession = this.dependencies.sessions.get(sessionId)
      if (!currentSession || currentSession.title !== initialTitle) return

      const assistantSelection = await this.resolveAssistantModelSelection(
        currentSession.agentId,
        fallbackProviderId,
        fallbackModelId
      )

      let generatedTitle: string
      try {
        generatedTitle = await this.dependencies.titles.summaryTitles(
          titleMessages,
          assistantSelection.providerId,
          assistantSelection.modelId
        )
      } catch (error) {
        // 仅当助手模型与会话自身的模型不同才值得回退重试：同模型再试
        // 大概率同样失败，直接把错误交给外层告警。
        const shouldFallback =
          assistantSelection.providerId !== fallbackProviderId ||
          assistantSelection.modelId !== fallbackModelId
        if (!shouldFallback) throw error
        generatedTitle = await this.dependencies.titles.summaryTitles(
          titleMessages,
          fallbackProviderId,
          fallbackModelId
        )
      }

      const normalized = this.normalizeGeneratedTitle(generatedTitle)
      if (!normalized || normalized === initialTitle) return

      // 写入前再查一次：等待/生成期间用户可能已改名或删除会话。
      const latest = this.dependencies.sessions.get(sessionId)
      if (!latest || latest.title !== initialTitle) return

      this.dependencies.sessions.update(sessionId, { title: normalized })
      this.notify({ sessionIds: [sessionId], reason: 'updated' })
    } catch (error) {
      console.warn(`[SessionQuery] title generation skipped for session=${sessionId}:`, error)
    }
  }

  /** 标题模型选择：Office Agent 用其配置的助手模型，否则退回会话自身配置。 */
  private async resolveAssistantModelSelection(
    agentId: string,
    fallbackProviderId: string,
    fallbackModelId: string
  ): Promise<{ providerId: string; modelId: string }> {
    if (this.dependencies.runtime.getAgentKind(agentId) === 'deepchat') {
      const assistantModel = await this.dependencies.agentConfig.getAssistantModel(agentId)
      const providerId = assistantModel?.providerId?.trim()
      const modelId = assistantModel?.modelId?.trim()
      if (providerId && modelId) return { providerId, modelId }
    }

    return { providerId: fallbackProviderId, modelId: fallbackModelId }
  }

  /**
   * 等待首轮产生可用的标题素材（最多 30 秒）。轮询与 waitForFirstTurnReady
   * 结合：首轮进行中没有素材可提，出错直接放弃，超时返回 null 表示放弃。
   */
  private async waitForSessionTitleMessages(
    sessionId: string
  ): Promise<Array<{ role: 'system' | 'user' | 'assistant'; content: string }> | null> {
    const maxWaitMs = 30000
    const pollMs = 250
    const startedAt = Date.now()
    const readTitleMessages = async () => {
      const titleMessages = this.buildTitleMessages(
        await this.dependencies.transcript.getMessages(sessionId)
      )
      return titleMessages.length > 0 ? titleMessages : null
    }

    while (Date.now() - startedAt < maxWaitMs) {
      if (!this.dependencies.sessions.get(sessionId)) return null

      const state = await this.dependencies.runtime.snapshot(sessionId)
      if (!state || state.status === 'error') return null
      if (state.status === 'idle') {
        const titleMessages = await readTitleMessages()
        if (titleMessages) return titleMessages
      }

      const remainingMs = maxWaitMs - (Date.now() - startedAt)
      const ready = await this.dependencies.runtime.waitForFirstTurnReady(sessionId, {
        timeoutMs: Math.min(pollMs, Math.max(0, remainingMs))
      })
      if (!ready) continue

      const titleMessages = await readTitleMessages()
      if (titleMessages) return titleMessages
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }

    return null
  }

  /** 从记录中抽出用于起标题的前 6 条 user/assistant 纯文本消息。 */
  private buildTitleMessages(
    records: ChatMessageRecord[]
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const sorted = [...records].sort((left, right) => left.orderSeq - right.orderSeq)
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []

    for (const record of sorted) {
      if (record.role === 'user') {
        const text = this.extractUserText(record.content)
        if (text) messages.push({ role: 'user', content: text })
      } else if (record.role === 'assistant') {
        const text = this.extractAssistantText(record.content)
        if (text) messages.push({ role: 'assistant', content: text })
      }
    }

    return messages.slice(0, 6)
  }

  private extractUserText(content: string): string {
    try {
      const parsed = JSON.parse(content) as UserMessageContent | string
      if (typeof parsed === 'string') return parsed.trim()
      return typeof parsed.text === 'string' ? parsed.text.trim() : ''
    } catch {
      return content.trim()
    }
  }

  private extractAssistantText(content: string): string {
    try {
      const parsed = JSON.parse(content) as AssistantMessageBlock[] | string
      if (typeof parsed === 'string') return parsed.trim()
      if (!Array.isArray(parsed)) return ''
      return parsed
        .filter((block) => block.type === 'content')
        .map((block) => block.content)
        .join('\n')
        .trim()
    } catch {
      return content.trim()
    }
  }

  /** 去掉思考块/引号包裹、截断到 80 字；清洗后为空则放弃本次标题。 */
  private normalizeGeneratedTitle(rawTitle: string): string {
    if (!rawTitle) return ''
    let cleaned = rawTitle.replace(/<think>.*?<\/think>/gs, '').trim()
    cleaned = cleaned.replace(/^<think>/, '').trim()
    cleaned = cleaned.replace(/^["'`]+|["'`]+$/g, '').trim()
    return cleaned.length > 80 ? cleaned.slice(0, 80).trim() : cleaned
  }
}
