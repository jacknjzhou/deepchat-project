import { SessionDatabase } from './database'
import type { PermissionMode, SessionGenerationSettings } from '@shared/types/agent-interface'
import type { DeepChatSessionSummaryRow } from '@/session/data/tables/deepchatSessions'
import type { DeepChatTapeEntryRow } from '@/tape/domain/entry'
import type {
  TapeAnchorReader,
  TapeAnchorWriter,
  TapeLifecycleAdmin
} from '@/tape/ports/capabilities'

export type SessionSummaryState = {
  summaryText: string | null
  summaryCursorOrderSeq: number
  summaryUpdatedAt: number | null
}

export type ReconstructionAnchorPromptState = {
  entryId: number
  name: string
  state: Record<string, unknown>
  createdAt: number
}

export type SummaryStateCompareAndSetResult = {
  applied: boolean
  currentState: SessionSummaryState
}

export type SummaryTapeAnchorInput = {
  name: string
  state: Record<string, unknown>
  meta?: Record<string, unknown>
}

function normalizeSummaryState(row: DeepChatSessionSummaryRow | null): SessionSummaryState {
  return {
    summaryText: row?.summary_text ?? null,
    summaryCursorOrderSeq: Math.max(1, row?.summary_cursor_order_seq ?? 1),
    summaryUpdatedAt: row?.summary_updated_at ?? null
  }
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {}

  return null
}

function resolveAnchorState(row: DeepChatTapeEntryRow): Record<string, unknown> | null {
  const payload = parseJsonObject(row.payload_json)
  const state = payload?.state
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    return state as Record<string, unknown>
  }
  return null
}

function normalizeCursorOrderSeq(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value))
  }
  return 1
}

function normalizeSummaryText(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null
}

function summaryStateFromTapeAnchor(
  row: DeepChatTapeEntryRow | undefined
): SessionSummaryState | null {
  if (!row) {
    return null
  }

  if (row.name === 'summary/reset') {
    return {
      summaryText: null,
      summaryCursorOrderSeq: 1,
      summaryUpdatedAt: null
    }
  }

  const state = resolveAnchorState(row)
  const generatedSummary =
    normalizeSummaryText(state?.summary) ?? normalizeSummaryText(state?.summaryText)
  const priorSummary = normalizeSummaryText(state?.priorSummary)
  const cursorOrderSeq = normalizeCursorOrderSeq(
    state?.cursorOrderSeq ?? state?.summaryCursorOrderSeq
  )

  if (!generatedSummary) {
    return {
      summaryText: priorSummary,
      summaryCursorOrderSeq: cursorOrderSeq,
      summaryUpdatedAt: null
    }
  }

  return {
    summaryText: generatedSummary,
    summaryCursorOrderSeq: cursorOrderSeq,
    summaryUpdatedAt: row.created_at
  }
}

function reconstructionAnchorPromptStateFromRow(
  row: DeepChatTapeEntryRow | undefined
): ReconstructionAnchorPromptState | null {
  if (!row?.name) {
    return null
  }

  const state = resolveAnchorState(row)
  if (!state) {
    return null
  }

  return {
    entryId: row.entry_id,
    name: row.name,
    state,
    createdAt: row.created_at
  }
}

function summaryStatesEqual(left: SessionSummaryState, right: SessionSummaryState): boolean {
  return (
    (left.summaryText ?? null) === (right.summaryText ?? null) &&
    Math.max(1, left.summaryCursorOrderSeq) === Math.max(1, right.summaryCursorOrderSeq) &&
    (left.summaryUpdatedAt ?? null) === (right.summaryUpdatedAt ?? null)
  )
}

/**
 * 会话级设置存储（SessionSettingsStore）：provider/model/权限模式/生成参数
 * 的持久化，外加上下文摘要（summary）状态的维护。
 *
 * 摘要状态有双份来源：sessions 行上的快照字段与 tape 上的重建锚点。读侧
 * 以 tape 锚点为准（它是权威事实流），行字段只是加速读取的镜像；写侧用
 * compareAndSetSummaryState 做乐观并发控制——期望状态不匹配（有并发压缩）
 * 就拒绝应用。锚点与行更新同事务，崩溃后两侧不会分叉。
 */
export class SessionSettingsStore {
  private database: SessionDatabase
  private readonly tape: TapeAnchorReader & TapeAnchorWriter & TapeLifecycleAdmin

  constructor(
    database: SessionDatabase,
    tape: TapeAnchorReader & TapeAnchorWriter & TapeLifecycleAdmin
  ) {
    this.database = database
    this.tape = tape
  }

  /** 创建会话设置行并初始化其 tape（两者同生）。 */
  create(
    id: string,
    providerId: string,
    modelId: string,
    permissionMode: PermissionMode,
    generationSettings?: Partial<SessionGenerationSettings>
  ): void {
    this.database.deepchatSessionsTable.create(
      id,
      providerId,
      modelId,
      permissionMode,
      generationSettings
    )
    this.tape.initializeSessionTape(id)
  }

  get(id: string) {
    return this.database.deepchatSessionsTable.get(id)
  }

  /** 删除会话设置：先删 tape（外层资源），再删行。 */
  delete(id: string): void {
    this.tape.deleteSessionTape(id)
    this.database.deepchatSessionsTable.delete(id)
  }

  updatePermissionMode(id: string, mode: PermissionMode): void {
    this.database.deepchatSessionsTable.updatePermissionMode(id, mode)
  }

  updateSessionModel(id: string, providerId: string, modelId: string): void {
    this.database.deepchatSessionsTable.updateSessionModel(id, providerId, modelId)
  }

  getGenerationSettings(id: string): Partial<SessionGenerationSettings> | null {
    return this.database.deepchatSessionsTable.getGenerationSettings(id)
  }

  updateGenerationSettings(id: string, settings: Partial<SessionGenerationSettings>): void {
    this.database.deepchatSessionsTable.updateGenerationSettings(id, settings)
  }

  updateSessionConfiguration(
    id: string,
    providerId: string,
    modelId: string,
    generationSettings: Partial<SessionGenerationSettings>,
    permissionMode?: PermissionMode
  ): void {
    const update = (): void => {
      this.database.deepchatSessionsTable.updateSessionModel(id, providerId, modelId)
      if (permissionMode !== undefined) {
        this.database.deepchatSessionsTable.updatePermissionMode(id, permissionMode)
      }
      this.database.deepchatSessionsTable.updateGenerationSettings(id, generationSettings)
    }

    this.database.getDatabase().transaction(update)()
  }

  /** 读取摘要状态：tape 锚点优先，无锚点回退行字段。 */
  getSummaryState(id: string): SessionSummaryState {
    const tapeState = summaryStateFromTapeAnchor(this.tape.getLatestReconstructionAnchor(id))
    if (tapeState) {
      return tapeState
    }

    return normalizeSummaryState(this.database.deepchatSessionsTable.getSummaryState(id))
  }

  getReconstructionAnchorPromptState(id: string): ReconstructionAnchorPromptState | null {
    return reconstructionAnchorPromptStateFromRow(this.tape.getLatestReconstructionAnchor(id))
  }

  getReconstructionAnchorPromptStateByCompactionAttemptId(
    id: string,
    compactionAttemptId: string
  ): ReconstructionAnchorPromptState | null {
    return reconstructionAnchorPromptStateFromRow(
      this.tape.getReconstructionAnchorByCompactionAttemptId(id, compactionAttemptId)
    )
  }

  updateSummaryState(id: string, state: SessionSummaryState): void {
    this.database.deepchatSessionsTable.updateSummaryState(id, state)
  }

  /**
   * 摘要状态的乐观写入：当前状态与期望一致才应用新状态并（可选）落 tape
   * 锚点。要求带锚点的写入必须没有更新的锚点存在（防旧锚点回写覆盖新摘要）。
   * 返回是否应用成功及当前实际状态，供调用方决定重试或放弃。
   */
  compareAndSetSummaryState(
    id: string,
    expectedState: SessionSummaryState,
    nextState: SessionSummaryState,
    tapeAnchor?: SummaryTapeAnchorInput
  ): SummaryStateCompareAndSetResult {
    const applyUpdate = (): boolean => {
      const latestTapeAnchor = this.tape.getLatestReconstructionAnchor(id)
      const currentState = this.getSummaryState(id)
      if (!summaryStatesEqual(currentState, expectedState)) {
        return false
      }
      if (!tapeAnchor && latestTapeAnchor) {
        return false
      }

      this.database.deepchatSessionsTable.updateSummaryState(id, nextState)
      if (tapeAnchor) {
        this.tape.appendAnchor({
          sessionId: id,
          name: tapeAnchor.name,
          state: tapeAnchor.state,
          meta: tapeAnchor.meta,
          createdAt: nextState.summaryUpdatedAt ?? undefined
        })
      }
      return true
    }

    const applied = this.database.getDatabase().transaction(applyUpdate)() as boolean

    if (applied) {
      return {
        applied: true,
        currentState: this.getSummaryState(id)
      }
    }

    return {
      applied: false,
      currentState: this.getSummaryState(id)
    }
  }

  /** 重置摘要：行字段清零 + 落 summary/reset 锚点，同一事务完成。 */
  resetSummaryState(id: string): void {
    const reset = (): void => {
      this.database.deepchatSessionsTable.resetSummaryState(id)
      this.tape.appendAnchor({
        sessionId: id,
        name: 'summary/reset',
        state: {
          cursorOrderSeq: 1,
          reason: 'summary_reset'
        }
      })
    }
    this.database.getDatabase().transaction(reset)()
  }

  resetTape(id: string): void {
    this.tape.resetSessionTape(id)
  }
}
