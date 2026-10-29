/**
 * 会话/聊天的 IPC 路由注册表。
 *
 * 渲染层经由 @shared/contracts 里的 sessions* 与 chat* 路由契约调用主进程，
 * 这两类路由全部集中在本文件。每个条目只做「解析入参 → 调服务 → 投影出参」
 * 的薄转发，业务逻辑下沉到 SessionService/ChatService 与各端口实现。
 *
 * 边界约定：
 * - 每个路由的入参/出参都过一遍 zod 契约 parse，跨进程边界的字段形状由
 *   契约文件单点定义，输出经投影后不会泄露内部未知字段。
 * - 需要调用方身份（激活/停用会话、订阅 Tape 推送、聊天发送）的路由才显式
 *   调 requireRendererCaller 取 webContentsId，其余路由不关心调用方。
 * - 路由失败即向渲染层抛错，这里不做降级或重试；取消语义见
 *   withSubmissionCancellation 与 chatCancelSubmission 路由。
 */
import {
  chatCancelSubmissionRoute,
  chatDismissToolInteractionRoute,
  chatRespondToolInteractionRoute,
  chatSendMessageRoute,
  chatSteerActiveTurnRoute,
  chatStopStreamRoute,
  sessionsActivateRoute,
  sessionsClearMessagesRoute,
  sessionsCompactRoute,
  sessionsConvertPendingInputToSteerRoute,
  sessionsCreateRoute,
  sessionsDeleteAgentSessionsRoute,
  sessionsDeleteMessageRoute,
  sessionsDeletePendingInputRoute,
  sessionsDeleteRoute,
  sessionsDeactivateRoute,
  sessionsEditUserMessageRoute,
  sessionsEnsureAcpDraftRoute,
  sessionsExportMessageTapeReplaySliceRoute,
  sessionsExportTapeInspectorSupportTraceRoute,
  sessionsExportRoute,
  sessionsForkRoute,
  sessionsGetAcpSessionCommandsRoute,
  sessionsGetAcpSessionConfigOptionsRoute,
  sessionsGetActiveRoute,
  sessionsGetAgentsRoute,
  sessionsGetAgentTransferImpactRoute,
  sessionsGetCompactionSnapshotRoute,
  sessionsGetContextOccupancyRoute,
  sessionsGetDisabledAgentToolsRoute,
  sessionsGetTapeInspectorRecordDetailRoute,
  sessionsGetGenerationSettingsRoute,
  sessionsGetLightweightByIdsRoute,
  sessionsGetPermissionModeRoute,
  sessionsGetSearchResultsRoute,
  sessionsGetTapeContextRoute,
  sessionsGetUsageDashboardRoute,
  sessionsListLightweightRoute,
  sessionsListMessagesPageRoute,
  sessionsListMessageTracesRoute,
  sessionsListPendingInputsRoute,
  sessionsListRoute,
  sessionsListTapeInspectorEvidenceRoute,
  sessionsListTapeInspectorPageRoute,
  sessionsResolveTapeInspectorEvidenceEntriesRoute,
  sessionsSubscribeTapeInspectorHeadRoute,
  sessionsUnsubscribeTapeInspectorHeadRoute,
  sessionsMoveAgentSessionsRoute,
  sessionsMoveQueuedInputRoute,
  sessionsMoveToAgentRoute,
  sessionsQueuePendingInputRoute,
  sessionsRenameRoute,
  sessionsResumePendingQueueRoute,
  sessionsRestoreRoute,
  sessionsResolveBlockedPendingInputRoute,
  sessionsRetryMessageRoute,
  sessionsRetryPendingQueueInputRoute,
  sessionsRetryRtkHealthCheckRoute,
  sessionsSearchHistoryRoute,
  sessionsSetAcpSessionConfigOptionRoute,
  sessionsSetModelRoute,
  sessionsSetToolModeRoute,
  sessionsSetPermissionModeRoute,
  sessionsSetProjectDirRoute,
  sessionsSteerPendingInputRoute,
  sessionsTogglePinnedRoute,
  sessionsTranslateTextRoute,
  sessionsUpdateDisabledAgentToolsRoute,
  sessionsUpdateGenerationSettingsRoute,
  sessionsUpdateQueuedInputRoute
} from '@shared/contracts/routes'
import type { SessionPermissionPort } from '@/session/contracts'
import type { UsageStatsService } from '@/session/usageStatsService'
import type { AgentSessionExportService } from '@/exporter/agentSessionExporter'
import { listAvailableAgents } from '@/agent/shared/availableAgentCatalog'
import type { TapeInspectorHeadWatcher } from '@/tape/application/traceInspectorHeadWatcher'
import {
  createRouteMap,
  requireRendererCaller,
  type DeepchatRouteMap
} from '@/routes/routeRegistry'
import type { Scheduler } from '@/routes/scheduler'
import type { SessionAgentAssignmentPort, SessionLifecyclePort, SessionTurnPort } from './contracts'
import type { SessionQuery } from './query'
import {
  SessionService,
  type SessionServiceDesktopPort,
  type SessionServiceProjectionPort
} from './sessionService'
import {
  ChatService,
  type ChatServiceProjectionPort,
  type ChatServiceRemoteTurnPort
} from './chatService'
import type { SessionHistorySearch } from './sessionHistorySearch'
import type { SessionTranslation } from './sessionTranslation'
import type { AgentSettingsPort } from '@/agent/settings'
import { SubmissionCancellationRegistry } from './submissionCancellationRegistry'

/**
 * 路由层的投影端口聚合：SessionService 与 ChatService 各自的查询需求，
 * 加上 SessionQuery 中属于只读检索/轻量写的能力（轻量列表、搜索结果、
 * Tape 上下文与 Inspector、消息 traces、重命名与置顶）。路由处理函数只
 * 依赖这个聚合类型，避免直接耦合具体存储实现。
 */
export type SessionRouteProjectionPort = SessionServiceProjectionPort &
  ChatServiceProjectionPort &
  Pick<
    SessionQuery,
    | 'listLightweight'
    | 'getLightweightByIds'
    | 'getSearchResults'
    | 'getTapeContext'
    | 'listTapeInspectorPage'
    | 'listTapeInspectorEvidence'
    | 'resolveTapeInspectorEvidenceEntries'
    | 'getTapeInspectorRecordDetail'
    | 'exportTapeInspectorSupportTrace'
    | 'listMessageTraces'
    | 'listMessageViewManifests'
    | 'listNestedExecutionAudit'
    | 'exportMessageTapeReplaySlice'
    | 'renameSession'
    | 'toggleSessionPinned'
  >

/**
 * 构建会话/聊天路由表。依赖全部以端口（Pick 出的最小接口）注入，便于按
 * 进程装配与替换实现；remoteTurn 缺省时远端分流不启用，聊天链路保持
 * 纯本地行为。
 */
export function createSessionRoutes(deps: {
  lifecycle: SessionLifecyclePort
  projection: SessionRouteProjectionPort
  desktop: SessionServiceDesktopPort
  turn: SessionTurnPort
  assignment: SessionAgentAssignmentPort
  permission: Pick<SessionPermissionPort, 'clearSessionPermissions'>
  agentSettings: Pick<AgentSettingsPort, 'listAgents' | 'getAcpEnabled'>
  scheduler: Scheduler
  historySearch: Pick<SessionHistorySearch, 'search'>
  exportService: Pick<AgentSessionExportService, 'export'>
  translation: Pick<SessionTranslation, 'translate'>
  usageStats: Pick<UsageStatsService, 'getDashboard'>
  rtkRuntime: { retryHealthCheck(): Promise<unknown> }
  tapeInspectorHeadWatcher: Pick<TapeInspectorHeadWatcher, 'subscribe' | 'unsubscribe'>
  /**
   * 远端（StaffDeck）轮次端口。未配置分发服务时为 undefined，
   * 此时 ChatService 的本地链路与改动前完全一致。
   */
  remoteTurn?: ChatServiceRemoteTurnPort
}): DeepchatRouteMap {
  // 按「窗口 + submissionId」登记在途提交，供 chatCancelSubmission 路由触发取消。
  const submissionCancellations = new SubmissionCancellationRegistry()
  const sessionService = new SessionService({
    lifecycle: deps.lifecycle,
    projection: deps.projection,
    desktop: deps.desktop,
    scheduler: deps.scheduler
  })
  const chatService = new ChatService({
    turn: deps.turn,
    projection: deps.projection,
    sessionPermissionPort: deps.permission,
    scheduler: deps.scheduler,
    ...(deps.remoteTurn ? { remoteTurn: deps.remoteTurn } : {})
  })

  /**
   * 在任务执行期间登记一个可取消的提交：带 submissionId 的请求会拿到
   * AbortSignal 传给服务层，finally 保证注销，避免窗口关闭后残留条目。
   * 未携带 submissionId 的请求（如恢复会话）直接执行，不参与取消。
   */
  async function withSubmissionCancellation<T>(
    webContentsId: number,
    submissionId: string | undefined,
    task: (signal?: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (!submissionId) return await task()
    const registration = submissionCancellations.register(webContentsId, submissionId)
    try {
      return await task(registration.signal)
    } finally {
      registration.unregister()
    }
  }

  return createRouteMap([
    // ---- 会话创建 / 恢复 / 列表 / 激活 ----
    // 创建是唯一在创建阶段就走取消登记的会话路由：渲染层创建时即可带
    // submissionId，用户能在初始化完成前撤销。返回值里 initialTurn 单独
    // 拆出，仅在实际产生了首轮时才回传，避免输出契约里出现 null 字段。
    // 激活/停用/取当前会话依赖调用方窗口，故需要 requireRendererCaller。
    [
      sessionsCreateRoute.name,
      async (rawInput, context) => {
        const input = sessionsCreateRoute.input.parse(rawInput)
        const caller = requireRendererCaller(context)
        const { submissionId, ...createInput } = input
        const created = await withSubmissionCancellation(
          caller.webContentsId,
          submissionId,
          async (signal) =>
            signal
              ? await sessionService.createSession(createInput, caller, { signal })
              : await sessionService.createSession(createInput, caller)
        )
        const { initialTurn, ...session } = created
        return sessionsCreateRoute.output.parse({
          session,
          ...(initialTurn ? { initialTurn } : {})
        })
      }
    ],
    [
      sessionsRestoreRoute.name,
      async (rawInput) => {
        const input = sessionsRestoreRoute.input.parse(rawInput)
        return sessionsRestoreRoute.output.parse(
          await sessionService.restoreSession(input.sessionId, input.limit)
        )
      }
    ],
    [
      sessionsListMessagesPageRoute.name,
      async (rawInput) => {
        const input = sessionsListMessagesPageRoute.input.parse(rawInput)
        const page = await sessionService.listMessagesPage(input.sessionId, {
          cursor: input.cursor ?? null,
          limit: input.limit
        })
        return sessionsListMessagesPageRoute.output.parse(page)
      }
    ],
    [
      sessionsListRoute.name,
      async (rawInput) => {
        const input = sessionsListRoute.input.parse(rawInput)
        return sessionsListRoute.output.parse({
          sessions: await sessionService.listSessions(input)
        })
      }
    ],
    [
      sessionsListLightweightRoute.name,
      async (rawInput) => {
        const input = sessionsListLightweightRoute.input.parse(rawInput)
        return sessionsListLightweightRoute.output.parse(
          await deps.projection.listLightweight(input)
        )
      }
    ],
    [
      sessionsGetLightweightByIdsRoute.name,
      async (rawInput) => {
        const input = sessionsGetLightweightByIdsRoute.input.parse(rawInput)
        return sessionsGetLightweightByIdsRoute.output.parse({
          items: await deps.projection.getLightweightByIds(input.sessionIds)
        })
      }
    ],
    [
      sessionsActivateRoute.name,
      async (rawInput, context) => {
        const input = sessionsActivateRoute.input.parse(rawInput)
        await sessionService.activateSession(requireRendererCaller(context), input.sessionId)
        return sessionsActivateRoute.output.parse({ activated: true })
      }
    ],
    [
      sessionsDeactivateRoute.name,
      async (rawInput, context) => {
        sessionsDeactivateRoute.input.parse(rawInput)
        await sessionService.deactivateSession(requireRendererCaller(context))
        return sessionsDeactivateRoute.output.parse({ deactivated: true })
      }
    ],
    [
      sessionsGetActiveRoute.name,
      async (rawInput, context) => {
        sessionsGetActiveRoute.input.parse(rawInput)
        return sessionsGetActiveRoute.output.parse({
          session: await sessionService.getActiveSession(requireRendererCaller(context))
        })
      }
    ],
    [
      sessionsEnsureAcpDraftRoute.name,
      async (rawInput) => {
        const input = sessionsEnsureAcpDraftRoute.input.parse(rawInput)
        return sessionsEnsureAcpDraftRoute.output.parse(
          await deps.lifecycle.ensureAcpDraftSession(input)
        )
      }
    ],
    // ---- 待发送队列管理 ----
    // 队列条目的入队/改写/排序/删除，以及「转 steer、重试、解除阻塞」
    // 都直接落在 turn 端口；列表接口并行取条目与「是否可恢复」标记，
    // 一次往返返回渲染层需要的全部状态。
    [
      sessionsListPendingInputsRoute.name,
      async (rawInput) => {
        const input = sessionsListPendingInputsRoute.input.parse(rawInput)
        const [items, resumeAvailable] = await Promise.all([
          deps.turn.listPendingInputs(input.sessionId),
          deps.turn.isPendingQueueResumeAvailable(input.sessionId)
        ])
        return sessionsListPendingInputsRoute.output.parse({
          items,
          resumeAvailable
        })
      }
    ],
    [
      sessionsResumePendingQueueRoute.name,
      async (rawInput) => {
        const input = sessionsResumePendingQueueRoute.input.parse(rawInput)
        return sessionsResumePendingQueueRoute.output.parse({
          started: await deps.turn.resumePendingQueue(input.sessionId)
        })
      }
    ],
    [
      sessionsRetryPendingQueueInputRoute.name,
      async (rawInput) => {
        const input = sessionsRetryPendingQueueInputRoute.input.parse(rawInput)
        return sessionsRetryPendingQueueInputRoute.output.parse(
          await deps.turn.retryPendingQueueInput(input.sessionId, input.itemId)
        )
      }
    ],
    [
      sessionsQueuePendingInputRoute.name,
      async (rawInput) => {
        const input = sessionsQueuePendingInputRoute.input.parse(rawInput)
        return sessionsQueuePendingInputRoute.output.parse({
          item: await deps.turn.queuePendingInput(input.sessionId, input.content)
        })
      }
    ],
    [
      sessionsUpdateQueuedInputRoute.name,
      async (rawInput) => {
        const input = sessionsUpdateQueuedInputRoute.input.parse(rawInput)
        return sessionsUpdateQueuedInputRoute.output.parse({
          item: await deps.turn.updateQueuedInput(input.sessionId, input.itemId, input.content)
        })
      }
    ],
    [
      sessionsMoveQueuedInputRoute.name,
      async (rawInput) => {
        const input = sessionsMoveQueuedInputRoute.input.parse(rawInput)
        return sessionsMoveQueuedInputRoute.output.parse({
          items: await deps.turn.moveQueuedInput(input.sessionId, input.itemId, input.toIndex)
        })
      }
    ],
    [
      sessionsConvertPendingInputToSteerRoute.name,
      async (rawInput) => {
        const input = sessionsConvertPendingInputToSteerRoute.input.parse(rawInput)
        return sessionsConvertPendingInputToSteerRoute.output.parse({
          item: await deps.turn.convertPendingInputToSteer(input.sessionId, input.itemId)
        })
      }
    ],
    [
      sessionsSteerPendingInputRoute.name,
      async (rawInput) => {
        const input = sessionsSteerPendingInputRoute.input.parse(rawInput)
        return sessionsSteerPendingInputRoute.output.parse({
          item: await deps.turn.steerPendingInput(input.sessionId, input.itemId)
        })
      }
    ],
    [
      sessionsDeletePendingInputRoute.name,
      async (rawInput) => {
        const input = sessionsDeletePendingInputRoute.input.parse(rawInput)
        await deps.turn.deletePendingInput(input.sessionId, input.itemId)
        return sessionsDeletePendingInputRoute.output.parse({ deleted: true })
      }
    ],
    [
      sessionsResolveBlockedPendingInputRoute.name,
      async (rawInput) => {
        const input = sessionsResolveBlockedPendingInputRoute.input.parse(rawInput)
        return sessionsResolveBlockedPendingInputRoute.output.parse({
          item: await deps.turn.resolveBlockedPendingInput(
            input.sessionId,
            input.itemId,
            input.action
          )
        })
      }
    ],
    // ---- 消息级操作（重试 / 删除 / 编辑 / 分叉）----
    // 重试允许调用方指定附件降级策略；当附件准备结果为
    // needs_user_action 时不算接受成功，retried 据此为 false，渲染层
    // 借此区分「已重试」与「等待用户补附件」两种结果。
    [
      sessionsRetryMessageRoute.name,
      async (rawInput) => {
        const input = sessionsRetryMessageRoute.input.parse(rawInput)
        const result = input.attachmentFallbackPolicy
          ? await deps.turn.retryMessage(input.sessionId, input.messageId, {
              attachmentFallbackPolicy: input.attachmentFallbackPolicy
            })
          : await deps.turn.retryMessage(input.sessionId, input.messageId)
        const accepted = result.attachmentPreparation?.status !== 'needs_user_action'
        return sessionsRetryMessageRoute.output.parse({
          retried: accepted,
          accepted,
          ...(result.attachmentPreparation
            ? { attachmentPreparation: result.attachmentPreparation }
            : {})
        })
      }
    ],
    [
      sessionsDeleteMessageRoute.name,
      async (rawInput) => {
        const input = sessionsDeleteMessageRoute.input.parse(rawInput)
        await deps.turn.deleteMessage(input.sessionId, input.messageId)
        return sessionsDeleteMessageRoute.output.parse({ deleted: true })
      }
    ],
    [
      sessionsEditUserMessageRoute.name,
      async (rawInput) => {
        const input = sessionsEditUserMessageRoute.input.parse(rawInput)
        return sessionsEditUserMessageRoute.output.parse({
          message: await deps.turn.editUserMessage(input.sessionId, input.messageId, input.text)
        })
      }
    ],
    [
      sessionsForkRoute.name,
      async (rawInput) => {
        const input = sessionsForkRoute.input.parse(rawInput)
        return sessionsForkRoute.output.parse({
          session: await deps.lifecycle.forkSession(
            input.sourceSessionId,
            input.targetMessageId,
            input.newTitle
          )
        })
      }
    ],
    // ---- 历史搜索与 Tape 上下文 / Inspector ----
    // Tape 侧的检索与导出都委托 projection 只读端口。Inspector 的
    // 订阅/退订把调用方 webContentsId 一并交给 watcher，保证推送只发给
    // 发起订阅的窗口。消息 traces 是聚合接口：一次取回 traces、视图
    // manifest 与嵌套执行审计三份材料，省去渲染层多次往返。
    [
      sessionsSearchHistoryRoute.name,
      async (rawInput) => {
        const input = sessionsSearchHistoryRoute.input.parse(rawInput)
        return sessionsSearchHistoryRoute.output.parse({
          hits: await deps.historySearch.search(input.query, input.options)
        })
      }
    ],
    [
      sessionsGetSearchResultsRoute.name,
      async (rawInput) => {
        const input = sessionsGetSearchResultsRoute.input.parse(rawInput)
        return sessionsGetSearchResultsRoute.output.parse({
          results: await deps.projection.getSearchResults(input.messageId, input.searchId)
        })
      }
    ],
    [
      sessionsGetTapeContextRoute.name,
      async (rawInput) => {
        const input = sessionsGetTapeContextRoute.input.parse(rawInput)
        return sessionsGetTapeContextRoute.output.parse({
          context: await deps.projection.getTapeContext(
            input.sessionId,
            input.entryIds,
            input.options
          )
        })
      }
    ],
    [
      sessionsListTapeInspectorPageRoute.name,
      async (rawInput) => {
        const input = sessionsListTapeInspectorPageRoute.input.parse(rawInput)
        return sessionsListTapeInspectorPageRoute.output.parse(
          await deps.projection.listTapeInspectorPage(input)
        )
      }
    ],
    [
      sessionsListTapeInspectorEvidenceRoute.name,
      async (rawInput) => {
        const input = sessionsListTapeInspectorEvidenceRoute.input.parse(rawInput)
        return sessionsListTapeInspectorEvidenceRoute.output.parse(
          await deps.projection.listTapeInspectorEvidence(input)
        )
      }
    ],
    [
      sessionsResolveTapeInspectorEvidenceEntriesRoute.name,
      async (rawInput) => {
        const input = sessionsResolveTapeInspectorEvidenceEntriesRoute.input.parse(rawInput)
        return sessionsResolveTapeInspectorEvidenceEntriesRoute.output.parse(
          await deps.projection.resolveTapeInspectorEvidenceEntries(input)
        )
      }
    ],
    [
      sessionsGetTapeInspectorRecordDetailRoute.name,
      async (rawInput) => {
        const input = sessionsGetTapeInspectorRecordDetailRoute.input.parse(rawInput)
        return sessionsGetTapeInspectorRecordDetailRoute.output.parse(
          await deps.projection.getTapeInspectorRecordDetail(input)
        )
      }
    ],
    [
      sessionsExportTapeInspectorSupportTraceRoute.name,
      async (rawInput) => {
        const input = sessionsExportTapeInspectorSupportTraceRoute.input.parse(rawInput)
        return sessionsExportTapeInspectorSupportTraceRoute.output.parse(
          await deps.projection.exportTapeInspectorSupportTrace(input)
        )
      }
    ],
    [
      sessionsSubscribeTapeInspectorHeadRoute.name,
      async (rawInput, context) => {
        const input = sessionsSubscribeTapeInspectorHeadRoute.input.parse(rawInput)
        const caller = requireRendererCaller(context)
        return sessionsSubscribeTapeInspectorHeadRoute.output.parse({
          subscribed: true,
          ...deps.tapeInspectorHeadWatcher.subscribe({
            ...input,
            webContentsId: caller.webContentsId
          })
        })
      }
    ],
    [
      sessionsUnsubscribeTapeInspectorHeadRoute.name,
      async (rawInput, context) => {
        const input = sessionsUnsubscribeTapeInspectorHeadRoute.input.parse(rawInput)
        const caller = requireRendererCaller(context)
        deps.tapeInspectorHeadWatcher.unsubscribe({
          ...input,
          webContentsId: caller.webContentsId
        })
        return sessionsUnsubscribeTapeInspectorHeadRoute.output.parse({ unsubscribed: true })
      }
    ],
    [
      sessionsListMessageTracesRoute.name,
      async (rawInput) => {
        const input = sessionsListMessageTracesRoute.input.parse(rawInput)
        const traces = await deps.projection.listMessageTraces(input.messageId)
        const manifests = await deps.projection.listMessageViewManifests(input.messageId)
        const nestedExecutions = await deps.projection.listNestedExecutionAudit(input.messageId)
        return sessionsListMessageTracesRoute.output.parse({
          traces,
          manifests,
          nestedExecutions
        })
      }
    ],
    [
      sessionsExportMessageTapeReplaySliceRoute.name,
      async (rawInput) => {
        const input = sessionsExportMessageTapeReplaySliceRoute.input.parse(rawInput)
        return sessionsExportMessageTapeReplaySliceRoute.output.parse({
          slice: await deps.projection.exportMessageTapeReplaySlice(input.messageId, input.options)
        })
      }
    ],
    // ---- 独立辅助能力（翻译 / 可用代理 / 用量看板 / RTK 重试）----
    // 不属于会话生命周期的横向能力：代理目录由 agentSettings 驱动的
    // 目录模块提供（而非 assignment 端口）；RTK 重试触发底层 runtime
    // 自查，成功与否由其内部记录，路由只确认触发。
    [
      sessionsTranslateTextRoute.name,
      async (rawInput) => {
        const input = sessionsTranslateTextRoute.input.parse(rawInput)
        return sessionsTranslateTextRoute.output.parse({
          text: await deps.translation.translate(input.text, input.locale, input.agentId)
        })
      }
    ],
    [
      sessionsGetAgentsRoute.name,
      async (rawInput) => {
        sessionsGetAgentsRoute.input.parse(rawInput)
        return sessionsGetAgentsRoute.output.parse({
          agents: await listAvailableAgents(deps.agentSettings)
        })
      }
    ],
    [
      sessionsGetUsageDashboardRoute.name,
      async (rawInput) => {
        sessionsGetUsageDashboardRoute.input.parse(rawInput)
        return sessionsGetUsageDashboardRoute.output.parse({
          dashboard: await deps.usageStats.getDashboard()
        })
      }
    ],
    [
      sessionsRetryRtkHealthCheckRoute.name,
      async (rawInput) => {
        sessionsRetryRtkHealthCheckRoute.input.parse(rawInput)
        await deps.rtkRuntime.retryHealthCheck()
        return sessionsRetryRtkHealthCheckRoute.output.parse({ retried: true })
      }
    ],
    // ---- 会话元信息（重命名 / 置顶）----
    [
      sessionsRenameRoute.name,
      async (rawInput) => {
        const input = sessionsRenameRoute.input.parse(rawInput)
        return sessionsRenameRoute.output.parse({
          session: await deps.projection.renameSession(input.sessionId, input.title)
        })
      }
    ],
    [
      sessionsTogglePinnedRoute.name,
      async (rawInput) => {
        const input = sessionsTogglePinnedRoute.input.parse(rawInput)
        return sessionsTogglePinnedRoute.output.parse({
          session: await deps.projection.toggleSessionPinned(input.sessionId, input.pinned)
        })
      }
    ],
    // ---- 上下文管理 ----
    // 清空消息、压缩（compaction）与上下文占用查询都走 turn 端口；
    // 压缩快照单独暴露，供渲染层做恢复与展示，不与触发压缩的路由耦合。
    [
      sessionsClearMessagesRoute.name,
      async (rawInput) => {
        const input = sessionsClearMessagesRoute.input.parse(rawInput)
        await deps.turn.clearSessionMessages(input.sessionId)
        return sessionsClearMessagesRoute.output.parse({ cleared: true })
      }
    ],
    [
      sessionsCompactRoute.name,
      async (rawInput) => {
        const input = sessionsCompactRoute.input.parse(rawInput)
        return sessionsCompactRoute.output.parse(await deps.turn.compactSession(input.sessionId))
      }
    ],
    [
      sessionsGetCompactionSnapshotRoute.name,
      async (rawInput) => {
        const input = sessionsGetCompactionSnapshotRoute.input.parse(rawInput)
        return sessionsGetCompactionSnapshotRoute.output.parse(
          await deps.turn.getSessionCompactionSnapshot(input.sessionId)
        )
      }
    ],
    [
      sessionsGetContextOccupancyRoute.name,
      async (rawInput) => {
        const input = sessionsGetContextOccupancyRoute.input.parse(rawInput)
        return sessionsGetContextOccupancyRoute.output.parse(
          await deps.turn.getSessionContextOccupancy(input.sessionId)
        )
      }
    ],
    // ---- 导出 / 删除 ----
    [
      sessionsExportRoute.name,
      async (rawInput) => {
        const input = sessionsExportRoute.input.parse(rawInput)
        return sessionsExportRoute.output.parse(
          await deps.exportService.export(input.sessionId, input.format)
        )
      }
    ],
    [
      sessionsDeleteRoute.name,
      async (rawInput) => {
        const input = sessionsDeleteRoute.input.parse(rawInput)
        await deps.lifecycle.deleteSession(input.sessionId)
        return sessionsDeleteRoute.output.parse({ deleted: true })
      }
    ],
    // ---- 代理（agent）与会话的归属管理 ----
    // 迁移影响预查询、按代理批量搬移/删除名下会话、单会话转交，均落在
    // assignment 端口；影响预查询让渲染层在删/移代理前先展示代价。
    [
      sessionsGetAgentTransferImpactRoute.name,
      async (rawInput) => {
        const input = sessionsGetAgentTransferImpactRoute.input.parse(rawInput)
        return sessionsGetAgentTransferImpactRoute.output.parse({
          impact: await deps.assignment.getAgentTransferImpact(input.agentId)
        })
      }
    ],
    [
      sessionsMoveAgentSessionsRoute.name,
      async (rawInput) => {
        const input = sessionsMoveAgentSessionsRoute.input.parse(rawInput)
        return sessionsMoveAgentSessionsRoute.output.parse(
          await deps.assignment.moveAgentSessions(input.fromAgentId, input.toAgentId)
        )
      }
    ],
    [
      sessionsDeleteAgentSessionsRoute.name,
      async (rawInput) => {
        const input = sessionsDeleteAgentSessionsRoute.input.parse(rawInput)
        return sessionsDeleteAgentSessionsRoute.output.parse({
          deletedSessionIds: await deps.assignment.deleteAgentSessions(input.agentId)
        })
      }
    ],
    [
      sessionsMoveToAgentRoute.name,
      async (rawInput) => {
        const input = sessionsMoveToAgentRoute.input.parse(rawInput)
        return sessionsMoveToAgentRoute.output.parse({
          session: await deps.assignment.moveSessionToAgent(input.sessionId, input.toAgentId)
        })
      }
    ],
    // ---- ACP 会话命令与配置项 / 会话级执行设置 ----
    // ACP 命令列表与配置开关，以及权限模式、模型、工具模式、工作目录、
    // 生成参数、禁用工具等会话级设置，全部经由 assignment 端口读写；
    // 这些设置只影响后续轮次的执行环境，不改变既有消息。
    [
      sessionsGetAcpSessionCommandsRoute.name,
      async (rawInput) => {
        const input = sessionsGetAcpSessionCommandsRoute.input.parse(rawInput)
        return sessionsGetAcpSessionCommandsRoute.output.parse({
          commands: await deps.assignment.getAcpSessionCommands(input.sessionId)
        })
      }
    ],
    [
      sessionsGetAcpSessionConfigOptionsRoute.name,
      async (rawInput) => {
        const input = sessionsGetAcpSessionConfigOptionsRoute.input.parse(rawInput)
        return sessionsGetAcpSessionConfigOptionsRoute.output.parse({
          state: await deps.assignment.getAcpSessionConfigOptions(input.sessionId)
        })
      }
    ],
    [
      sessionsSetAcpSessionConfigOptionRoute.name,
      async (rawInput) => {
        const input = sessionsSetAcpSessionConfigOptionRoute.input.parse(rawInput)
        return sessionsSetAcpSessionConfigOptionRoute.output.parse({
          state: await deps.assignment.setAcpSessionConfigOption(
            input.sessionId,
            input.configId,
            input.value
          )
        })
      }
    ],
    [
      sessionsGetPermissionModeRoute.name,
      async (rawInput) => {
        const input = sessionsGetPermissionModeRoute.input.parse(rawInput)
        return sessionsGetPermissionModeRoute.output.parse({
          mode: await deps.assignment.getPermissionMode(input.sessionId)
        })
      }
    ],
    [
      sessionsSetPermissionModeRoute.name,
      async (rawInput) => {
        const input = sessionsSetPermissionModeRoute.input.parse(rawInput)
        await deps.assignment.setPermissionMode(input.sessionId, input.mode)
        return sessionsSetPermissionModeRoute.output.parse({ updated: true })
      }
    ],
    [
      sessionsSetModelRoute.name,
      async (rawInput) => {
        const input = sessionsSetModelRoute.input.parse(rawInput)
        return sessionsSetModelRoute.output.parse({
          session: await deps.assignment.setSessionModel(
            input.sessionId,
            input.providerId,
            input.modelId
          )
        })
      }
    ],
    [
      sessionsSetToolModeRoute.name,
      async (rawInput) => {
        const input = sessionsSetToolModeRoute.input.parse(rawInput)
        return sessionsSetToolModeRoute.output.parse({
          session: await deps.assignment.setSessionToolMode(input.sessionId, input.override)
        })
      }
    ],
    [
      sessionsSetProjectDirRoute.name,
      async (rawInput) => {
        const input = sessionsSetProjectDirRoute.input.parse(rawInput)
        return sessionsSetProjectDirRoute.output.parse({
          session: await deps.assignment.setSessionProjectDir(input.sessionId, input.projectDir)
        })
      }
    ],
    [
      sessionsGetGenerationSettingsRoute.name,
      async (rawInput) => {
        const input = sessionsGetGenerationSettingsRoute.input.parse(rawInput)
        return sessionsGetGenerationSettingsRoute.output.parse({
          settings: await deps.assignment.getSessionGenerationSettings(input.sessionId)
        })
      }
    ],
    [
      sessionsGetDisabledAgentToolsRoute.name,
      async (rawInput) => {
        const input = sessionsGetDisabledAgentToolsRoute.input.parse(rawInput)
        return sessionsGetDisabledAgentToolsRoute.output.parse({
          disabledAgentTools: await deps.assignment.getSessionDisabledAgentTools(input.sessionId)
        })
      }
    ],
    [
      sessionsUpdateDisabledAgentToolsRoute.name,
      async (rawInput) => {
        const input = sessionsUpdateDisabledAgentToolsRoute.input.parse(rawInput)
        return sessionsUpdateDisabledAgentToolsRoute.output.parse({
          disabledAgentTools: await deps.assignment.updateSessionDisabledAgentTools(
            input.sessionId,
            input.disabledAgentTools
          )
        })
      }
    ],
    [
      sessionsUpdateGenerationSettingsRoute.name,
      async (rawInput) => {
        const input = sessionsUpdateGenerationSettingsRoute.input.parse(rawInput)
        return sessionsUpdateGenerationSettingsRoute.output.parse({
          settings: await deps.assignment.updateSessionGenerationSettings(
            input.sessionId,
            input.settings
          )
        })
      }
    ],
    [
      chatSendMessageRoute.name,
      async (rawInput, context) => {
        const input = chatSendMessageRoute.input.parse(rawInput)
        const caller = requireRendererCaller(context)
        return chatSendMessageRoute.output.parse(
          await withSubmissionCancellation(
            caller.webContentsId,
            input.submissionId,
            async (signal) =>
              signal
                ? await chatService.sendMessage(input.sessionId, input.content, { signal })
                : await chatService.sendMessage(input.sessionId, input.content)
          )
        )
      }
    ],
    [
      chatSteerActiveTurnRoute.name,
      async (rawInput, context) => {
        const input = chatSteerActiveTurnRoute.input.parse(rawInput)
        const caller = requireRendererCaller(context)
        return chatSteerActiveTurnRoute.output.parse(
          await withSubmissionCancellation(
            caller.webContentsId,
            input.submissionId,
            async (signal) =>
              signal
                ? await chatService.steerActiveTurn(input.sessionId, input.content, { signal })
                : await chatService.steerActiveTurn(input.sessionId, input.content)
          )
        )
      }
    ],
    [
      chatCancelSubmissionRoute.name,
      async (rawInput, context) => {
        const input = chatCancelSubmissionRoute.input.parse(rawInput)
        const caller = requireRendererCaller(context)
        return chatCancelSubmissionRoute.output.parse({
          cancelled: submissionCancellations.cancel(caller.webContentsId, input.submissionId)
        })
      }
    ],
    [
      chatStopStreamRoute.name,
      async (rawInput) => {
        const input = chatStopStreamRoute.input.parse(rawInput)
        return chatStopStreamRoute.output.parse(await chatService.stopStream(input))
      }
    ],
    [
      chatRespondToolInteractionRoute.name,
      async (rawInput) => {
        const input = chatRespondToolInteractionRoute.input.parse(rawInput)
        return chatRespondToolInteractionRoute.output.parse(
          await chatService.respondToolInteraction(input)
        )
      }
    ],
    [
      chatDismissToolInteractionRoute.name,
      async (rawInput) => {
        const input = chatDismissToolInteractionRoute.input.parse(rawInput)
        return chatDismissToolInteractionRoute.output.parse(
          await chatService.dismissToolInteraction(input)
        )
      }
    ]
  ])
}
