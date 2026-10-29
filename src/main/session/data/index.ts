import type { DatabaseConnectionProvider } from '@/data/databaseConnection'
import type { DeepChatTapeEntryRow } from '@/tape/domain/entry'
import type { TapeMutationProjection } from '@/tape/ports/storage'
import type { SessionTapePort } from './contracts'
import type { ChatMessageRecord } from '@shared/types/agent-interface'
import { SessionPendingInputStore } from './pendingInputStore'
import { SessionPendingInputs } from './pendingInputs'
import { SessionSettingsStore } from './settings'
import { normalizeTapeHandoffState, SessionTape } from '@/tape/application/sessionTape'
import { ExecutionJournalService } from '@/tape/application/executionJournalService'
import type {
  ExecutionJournalWriter,
  NestedExecutionJournalWriter
} from '@/tape/ports/capabilities'
import { SessionTranscript } from './transcript'
import { SessionDatabase } from './database'

/** 从既有连接创建数据层（常规入口）。 */
export function createSessionData(
  connection: DatabaseConnectionProvider,
  getTapeMutationProjection: (() => TapeMutationProjection) | undefined,
  events: SessionDataEvents
) {
  const database = new SessionDatabase(connection, getTapeMutationProjection)
  return createSessionDataFromDatabase(database, events)
}

/**
 * 会话数据层的组装入口：把 database/transcript/pendingInputs/settings/tape
 * 按依赖关系拼装成一个 SessionData 聚合对象。tape 端口在此做了薄适配——
 * 首次访问时惰性补建该会话的 tape（ensureTape），而 inspector 只读接口
 * 刻意不做 bootstrap（见内联注释）。
 */

/** 数据层对外的事件回调：待发输入与消息集合变更时通知上层广播。 */
export type SessionDataEvents = {
  publishPendingInputsChanged(sessionId: string): void
  publishMessagesChanged(sessionId: string, messages: ChatMessageRecord[]): void
}

/** 供已持有 database 的调用方复用（测试/拆分场景）。 */
export function createSessionDataFromDatabase(
  database: SessionDatabase,
  events: SessionDataEvents
) {
  const tapeStore = new SessionTape(database)
  const programmaticJournalService = new ExecutionJournalService(
    () => database.deepchatExecutionJournalStore
  )
  const programmaticExecutionJournal: Pick<ExecutionJournalWriter, 'commitToolOutcome'> &
    NestedExecutionJournalWriter = Object.freeze({
    commitToolOutcome: (input) => programmaticJournalService.commitToolOutcome(input),
    commitNestedDispatch: (input) => programmaticJournalService.commitNestedDispatch(input),
    commitNestedToolOutcome: (input) => programmaticJournalService.commitNestedToolOutcome(input)
  })
  const transcript = new SessionTranscript(database, tapeStore, tapeStore, tapeStore)
  const pendingInputStore = new SessionPendingInputStore(database)
  const ensureTape = (sessionId: string) => tapeStore.ensureSessionTapeReady(sessionId, transcript)
  const toTapeAnchor = (row: DeepChatTapeEntryRow) => ({
    sessionId: row.session_id,
    entryId: row.entry_id,
    kind: row.kind,
    name: row.name,
    payload: parseJsonObject(row.payload_json),
    meta: parseJsonObject(row.meta_json),
    createdAt: row.created_at
  })
  const tape: SessionTapePort = {
    getTapeInfo(sessionId) {
      ensureTape(sessionId)
      return Promise.resolve(tapeStore.info(sessionId))
    },
    searchTape(sessionId, query, options) {
      if (!options?.scope || options.scope === 'current') ensureTape(sessionId)
      return Promise.resolve(tapeStore.search(sessionId, query, options))
    },
    getTapeContext(sessionId, entryIds, options) {
      if (!options?.sourceSessionId || options.sourceSessionId.trim() === sessionId) {
        ensureTape(sessionId)
      }
      return Promise.resolve(tapeStore.getContext(sessionId, entryIds, options))
    },
    listTapeAnchors(sessionId, options) {
      ensureTape(sessionId)
      return Promise.resolve(tapeStore.anchors(sessionId, options))
    },
    handoffTape(sessionId, name, state) {
      normalizeTapeHandoffState(state)
      ensureTape(sessionId)
      return Promise.resolve(toTapeAnchor(tapeStore.handoff(sessionId, name, state)))
    },
    listMessageViewManifests(sessionId, messageId) {
      ensureTape(sessionId)
      return Promise.resolve(tapeStore.listViewManifestsByMessage(sessionId, messageId))
    },
    listNestedExecutionAuditForMessage(sessionId, messageId) {
      ensureTape(sessionId)
      return Promise.resolve(tapeStore.listNestedExecutionAuditForMessage(sessionId, messageId))
    },
    exportMessageTapeReplaySlice(sessionId, messageId, options) {
      ensureTape(sessionId)
      return Promise.resolve(tapeStore.exportReplaySlice(sessionId, messageId, options))
    },
    // Inspector reads must not bootstrap or write Tape state. Incarnation mismatches are returned
    // through the read contract instead.
    listTapeInspectorPage(input) {
      return tapeStore.listTapeInspectorPage(input)
    },
    resolveTapeInspectorEvidenceEntries(input) {
      return tapeStore.resolveTapeInspectorEvidenceEntries(input)
    },
    getTapeInspectorRecordDetail(input) {
      return tapeStore.getTapeInspectorRecordDetail(input)
    },
    exportTapeInspectorSupportFacts(input) {
      return tapeStore.exportTapeInspectorSupportFacts(input)
    },
    linkSubagentTape(input) {
      ensureTape(input.parentSessionId)
      ensureTape(input.childSessionId)
      return Promise.resolve(tapeStore.linkSubagentTape(input))
    }
  }

  return {
    database,
    settings: new SessionSettingsStore(database, tapeStore),
    transcript,
    tape,
    tapeStore,
    programmaticExecutionJournal,
    pendingInputs: new SessionPendingInputs(pendingInputStore, transcript, events)
  }
}

export type SessionData = ReturnType<typeof createSessionData>

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
