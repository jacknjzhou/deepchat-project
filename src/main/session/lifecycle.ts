import logger from '@shared/logger'
import { toAppSessionId } from '@/agent/shared/agentSessionIds'
import { normalizeCreateSessionInput } from '@/agent/shared/agentSessionNormalization'
import type {
  CreateDetachedSessionInput,
  CreateSessionInput,
  DeepChatSubagentMeta,
  MessageStartResult,
  PermissionMode,
  SessionRecord,
  SessionWithState
} from '@shared/types/agent-interface'
import type {
  SessionAssignmentPolicyPort,
  SessionAssignmentWorkdirPort,
  SessionInitialTurnPort,
  SessionLifecycleDeletionPort,
  SessionLifecycleDesktopPort,
  SessionLifecyclePort,
  SessionLifecycleProjectionPort,
  SessionLifecycleRuntimeConfig,
  SessionLifecycleRuntimePort,
  SessionLifecycleSkillPort,
  SessionLifecycleStorePort,
  SessionLifecyclePermissionPort,
  SessionLifecycleSubagentInput,
  SessionLifecycleTranscriptPort,
  ResolvedSessionAssignment,
  ResolvedSubagentAssignment
} from './contracts'
import { isAcpAuthenticationRequiredError } from '@/agent/acp/runtime/acpAuthentication'
import type { EnsureAcpDraftResult } from './contracts'
import type { AgentLifecycleGatePort } from '@/agent/lifecycleGate'
import { LiveDelegationSubagentContextSchema } from '@shared/orchestration/liveDelegation'
import {
  DEFAULT_ORCHESTRATION_POLICY,
  normalizeOrchestrationPolicy
} from '@shared/orchestration/policy'
import type { SessionDeletionGatePort } from './deletionGate'
import { normalizeToolModeOverride } from '@shared/toolMode'

const SUBAGENT_SESSION_INIT_MAX_ATTEMPTS = 2

/** 区分「调用方主动取消」与真实失败：取消要走会话回收路径，失败则原样抛出。 */
function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
}

export interface SessionLifecycleDependencies {
  sessions: SessionLifecycleStorePort
  runtime: SessionLifecycleRuntimePort
  transcript: SessionLifecycleTranscriptPort
  skills: SessionLifecycleSkillPort
  assignmentPolicy: SessionAssignmentPolicyPort
  workdir: SessionAssignmentWorkdirPort
  initialTurn: SessionInitialTurnPort
  projection: SessionLifecycleProjectionPort
  desktop: SessionLifecycleDesktopPort
  deletion: SessionLifecycleDeletionPort
  deletionGate: SessionDeletionGatePort
  permissions?: SessionLifecyclePermissionPort
  agentLifecycle: AgentLifecycleGatePort
  /**
   * 记录会话与数字员工的归属。
   *
   * 数字员工会话的工具面按员工收敛（`staffdeck-*` / `de-kb-*`），运行时靠这条
   * 绑定推导白名单——所以必须在 `startInitialTurn` 之前写入：首轮消息的
   * 工具列表在那时已经组装，写晚了第一轮就会看到全部员工的工具。
   * 白名单是安全边界，写入失败必须让建会话失败，而不是降级成「全量工具」。
   */
  bindDigitalEmployeeSession?: (sessionId: string, employeeId: string) => void
}

/**
 * 会话生命周期模块：负责会话的创建、复制（fork）与删除，是 session 模块的入口层。
 *
 * 支持四种创建形态：
 * - createSession：带首条消息的常规会话，创建后立即启动首轮生成；
 * - createDetachedSession：不带首轮的独立会话（如脚本/测试场景）；
 * - createSubagentSession：挂在父会话下的子代理会话，初始化失败自动重试一次；
 * - ensureAcpDraftSession：按需创建或复用 ACP 草稿会话（打开目录即预热的场景）。
 *
 * 所有创建都先经 assignmentPolicy 解析出实际归属（agent/provider/model 等），
 * 再进 agentLifecycle 门执行，保证与该 Agent 的启停操作互斥。初始化失败会
 * 清理半成品会话，不留下不可用的记录。forkSession 从指定消息处分叉出新会话；
 * deleteSession 委托 deletion 模块整树删除并广播。
 */
export class SessionLifecycle implements SessionLifecyclePort {
  constructor(private readonly dependencies: SessionLifecycleDependencies) {}

  /**
   * 创建常规会话并启动首轮生成。
   *
   * assignment 解析放在生命周期门之外：解析只读配置，可以并发；进门后的
   * 创建过程才与 Agent 的其它操作互斥。返回值携带首轮的 start 结果，
   * 供渲染层立即流式展示。
   */
  async createSession(
    input: CreateSessionInput,
    webContentsId: number,
    options?: { signal?: AbortSignal }
  ): Promise<SessionWithState & { initialTurn?: MessageStartResult }> {
    const assignment = await this.dependencies.assignmentPolicy.resolveCreateAssignment({
      agentId: input.agentId || 'deepchat',
      providerId: input.providerId,
      modelId: input.modelId,
      projectDir: input.projectDir,
      permissionMode: input.permissionMode,
      generationSettings: input.generationSettings,
      disabledAgentTools: input.disabledAgentTools,
      preserveExplicitNullProjectDir: true
    })
    options?.signal?.throwIfAborted()
    return await this.dependencies.agentLifecycle.runWithAgentOperation(
      assignment.agentId,
      async () =>
        await this.createSessionUnderLifecycleGate(input, webContentsId, options, assignment)
    )
  }

  /**
   * 生命周期门内的常规创建流程，时序严格：
   * 建记录 → 绑定数字员工归属 → 初始化运行时 → 绑定窗口 → 广播 created →
   * 启动首轮。任何一步失败按阶段处理：初始化失败销毁记录；首轮失败仅在
   * 用户取消时回收。数字员工绑定必须在首轮之前完成，见依赖项上的说明。
   */
  private async createSessionUnderLifecycleGate(
    input: CreateSessionInput,
    webContentsId: number,
    options: { signal?: AbortSignal } | undefined,
    assignment: ResolvedSessionAssignment
  ): Promise<SessionWithState & { initialTurn?: MessageStartResult }> {
    const {
      agentId,
      providerId,
      modelId,
      projectDir,
      permissionMode,
      generationSettings,
      disabledAgentTools
    } = assignment
    logger.info(`[SessionLifecycle] createSession agent=${agentId} webContentsId=${webContentsId}`)
    const normalizedInput = normalizeCreateSessionInput(input)
    logger.info(`[SessionLifecycle] resolved provider=${providerId} model=${modelId}`)

    // 标题取首条消息前 50 字；编排策略与工具模式仅 Office Agent 会话可自定义。
    const title = normalizedInput.text.slice(0, 50) || 'New Chat'
    const orchestrationPolicy =
      assignment.agentType === 'deepchat'
        ? normalizeOrchestrationPolicy(input.orchestrationPolicy)
        : DEFAULT_ORCHESTRATION_POLICY
    const sessionId = this.dependencies.sessions.create(agentId, title, projectDir, {
      isDraft: false,
      disabledAgentTools,
      orchestrationPolicy,
      toolModeOverride:
        assignment.agentType === 'deepchat'
          ? normalizeToolModeOverride(input.toolModeOverride)
          : null
    })
    logger.info(`[SessionLifecycle] session created id=${sessionId}`)

    // 归属绑定先于运行时初始化与首轮消息：工具白名单在两者中都可能被读取。
    const digitalEmployeeId = input.digitalEmployeeId?.trim()
    if (digitalEmployeeId) {
      this.dependencies.bindDigitalEmployeeSession?.(sessionId, digitalEmployeeId)
    }

    // 运行时初始化失败则销毁半成品会话，不留孤儿记录。
    try {
      options?.signal?.throwIfAborted()
      await this.initializeSessionRuntime(sessionId, {
        agentId,
        providerId,
        modelId,
        projectDir,
        permissionMode,
        ...(generationSettings ? { generationSettings } : {})
      })
      options?.signal?.throwIfAborted()
    } catch (error) {
      await this.cleanupFailedSessionInitialization(sessionId, providerId)
      throw error
    }
    logger.info('[SessionLifecycle] agent.initSession done')

    this.dependencies.desktop.bind(webContentsId, sessionId)
    this.dependencies.projection.notify({
      sessionIds: [sessionId],
      reason: 'created',
      activeSessionId: sessionId,
      webContentsId
    })

    try {
      const state = await this.dependencies.runtime.resolveSession(sessionId).snapshot()
      options?.signal?.throwIfAborted()
      const result: SessionWithState = {
        id: sessionId,
        agentId,
        title,
        projectDir,
        isPinned: false,
        isDraft: false,
        sessionKind: 'regular',
        parentSessionId: null,
        subagentMeta: null,
        orchestrationPolicy,
        toolModeOverride:
          assignment.agentType === 'deepchat'
            ? normalizeToolModeOverride(input.toolModeOverride)
            : null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: state?.status ?? 'idle',
        providerId: state?.providerId ?? providerId,
        modelId: state?.modelId ?? modelId
      }

      const initialTurn = await this.dependencies.initialTurn.startInitialTurn({
        sessionId,
        content: normalizedInput,
        projectDir,
        initialTitle: title,
        fallbackProviderId: providerId,
        fallbackModelId: modelId,
        ...(options?.signal ? { signal: options.signal } : {})
      })
      return { ...result, ...(initialTurn ? { initialTurn } : {}) }
    } catch (error) {
      // 首轮启动阶段被取消：会话可能已有部分消息，走回收检查决定留或删。
      if (isAbortError(error, options?.signal)) {
        await this.cleanupCancelledNewSession(sessionId, webContentsId)
      }
      throw error
    }
  }

  /** 创建不启动首轮的独立会话；与 createSession 共用解析与门机制，只是没有消息启动。 */
  async createDetachedSession(input: CreateDetachedSessionInput): Promise<SessionWithState> {
    const assignment = await this.dependencies.assignmentPolicy.resolveCreateAssignment({
      agentId: input.agentId?.trim() || 'deepchat',
      providerId: input.providerId,
      modelId: input.modelId,
      projectDir: input.projectDir,
      permissionMode: input.permissionMode,
      generationSettings: input.generationSettings,
      disabledAgentTools: input.disabledAgentTools,
      preserveExplicitNullProjectDir: false
    })
    return await this.dependencies.agentLifecycle.runWithAgentOperation(
      assignment.agentId,
      async () => await this.createDetachedSessionUnderLifecycleGate(input, assignment)
    )
  }

  private async createDetachedSessionUnderLifecycleGate(
    input: CreateDetachedSessionInput,
    assignment: ResolvedSessionAssignment
  ): Promise<SessionWithState> {
    const title = input.title?.trim() || 'New Chat'
    const {
      agentId,
      providerId,
      modelId,
      projectDir,
      permissionMode,
      generationSettings,
      disabledAgentTools
    } = assignment
    const orchestrationPolicy =
      assignment.agentType === 'deepchat'
        ? normalizeOrchestrationPolicy(input.orchestrationPolicy)
        : DEFAULT_ORCHESTRATION_POLICY

    const sessionId = this.dependencies.sessions.create(agentId, title, projectDir, {
      isDraft: false,
      disabledAgentTools,
      orchestrationPolicy,
      toolModeOverride:
        assignment.agentType === 'deepchat'
          ? normalizeToolModeOverride(input.toolModeOverride)
          : null,
      metadata: input.metadata ?? null
    })
    try {
      await this.initializeSessionRuntime(sessionId, {
        agentId,
        providerId,
        modelId,
        projectDir,
        permissionMode,
        generationSettings
      })
    } catch (error) {
      await this.cleanupFailedSessionInitialization(sessionId, providerId)
      throw error
    }

    // 可选技能列表在运行时就绪后激活。
    if (input.activeSkills && input.activeSkills.length > 0) {
      await this.dependencies.skills.setActiveSkills(sessionId, input.activeSkills)
    }
    this.dependencies.projection.notify({ sessionIds: [sessionId], reason: 'created' })

    const state = await this.dependencies.runtime.resolveSession(sessionId).snapshot()
    return {
      id: sessionId,
      agentId,
      title,
      projectDir,
      isPinned: false,
      isDraft: false,
      sessionKind: 'regular',
      parentSessionId: null,
      subagentMeta: null,
      orchestrationPolicy,
      toolModeOverride:
        assignment.agentType === 'deepchat'
          ? normalizeToolModeOverride(input.toolModeOverride)
          : null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      status: state?.status ?? 'idle',
      providerId: state?.providerId ?? providerId,
      modelId: state?.modelId ?? modelId
    }
  }

  /**
   * 创建子代理会话。外层先持父会话的操作门：创建动作与父会话的删除互斥，
   * 否则可能出现「父会话正在删、子会话还在挂」的竞态。
   */
  async createSubagentSession(input: SessionLifecycleSubagentInput): Promise<SessionWithState> {
    const parentSessionId = input.parentSessionId?.trim()
    if (!parentSessionId) throw new Error('Subagent session requires a parentSessionId.')

    return await this.dependencies.deletionGate.runWithSessionOperation(
      parentSessionId,
      async () => {
        if (!this.dependencies.sessions.get(parentSessionId)) {
          throw new Error(`Subagent parent Session does not exist: ${parentSessionId}`)
        }
        return await this.createSubagentSessionUnderParentGate(input)
      }
    )
  }

  /** 门内再解析子代理运行时配置（外部 agent 进程可能需要专门的派生配置）。 */
  private async createSubagentSessionUnderParentGate(
    input: SessionLifecycleSubagentInput
  ): Promise<SessionWithState> {
    const agentId = input.agentId?.trim()
    if (!agentId) throw new Error('Subagent session requires an agentId.')
    const projectDir = input.projectDir?.trim() || null
    const runtimeConfig = await this.dependencies.assignmentPolicy.resolveSubagentAssignment({
      agentId,
      parentAgentId: input.parentAgentId,
      targetAgentId: input.targetAgentId,
      projectDir,
      providerId: input.providerId,
      modelId: input.modelId,
      permissionMode: input.permissionMode,
      generationSettings: input.generationSettings,
      disabledAgentTools: input.disabledAgentTools,
      activeSkills: input.activeSkills
    })
    return await this.dependencies.agentLifecycle.runWithAgentOperation(
      runtimeConfig.agentId,
      async () => await this.createSubagentSessionUnderLifecycleGate(input, runtimeConfig)
    )
  }

  /**
   * 子代理会话的实际创建，失败自动重试一次。
   *
   * 重试的原因：子代理创建常由编排流程自动触发，运行时偶发初始化失败
   * （外部 agent 进程未就绪等）不该让整轮委派失败。每次重试都从建记录
   * 开始，失败的记录已被 cleanup 清掉。权限克隆仅限「子代理目标就是父
   * 会话自身」的场景——只有 self-target 子代理与父共享信任边界。
   */
  private async createSubagentSessionUnderLifecycleGate(
    input: SessionLifecycleSubagentInput,
    runtimeConfig: ResolvedSubagentAssignment
  ): Promise<SessionWithState> {
    const parentSessionId = input.parentSessionId?.trim()
    if (!parentSessionId) throw new Error('Subagent session requires a parentSessionId.')

    const slotId = input.slotId?.trim()
    if (!slotId) throw new Error('Subagent session requires a slotId.')

    const displayName = input.displayName?.trim() || 'Subagent'
    const projectDir = input.projectDir?.trim() || null
    const liveDelegationContext =
      input.liveDelegationContext === undefined
        ? undefined
        : LiveDelegationSubagentContextSchema.parse(input.liveDelegationContext)
    const subagentMeta: DeepChatSubagentMeta = {
      slotId,
      displayName,
      targetAgentId: runtimeConfig.targetAgentId || null,
      ...(liveDelegationContext ? { liveDelegation: liveDelegationContext } : {})
    }
    let lastError: unknown = null

    for (let attempt = 1; attempt <= SUBAGENT_SESSION_INIT_MAX_ATTEMPTS; attempt += 1) {
      const sessionId = this.dependencies.sessions.create(
        runtimeConfig.agentId,
        displayName,
        projectDir,
        {
          isDraft: false,
          disabledAgentTools: runtimeConfig.disabledAgentTools,
          orchestrationPolicy: DEFAULT_ORCHESTRATION_POLICY,
          sessionKind: 'subagent',
          parentSessionId,
          subagentMeta
        }
      )

      try {
        await this.initializeSessionRuntime(sessionId, {
          agentId: runtimeConfig.agentId,
          providerId: runtimeConfig.providerId,
          modelId: runtimeConfig.modelId,
          projectDir,
          permissionMode: runtimeConfig.permissionMode,
          generationSettings: runtimeConfig.generationSettings
        })
        if (runtimeConfig.activeSkills.length > 0) {
          await this.dependencies.skills.setActiveSkills(sessionId, runtimeConfig.activeSkills)
        }
        const parentAgentId = input.parentAgentId?.trim()
        if (parentAgentId && runtimeConfig.agentId === parentAgentId) {
          // Only self-target children share the parent's trust boundary.
          this.dependencies.permissions?.cloneSessionPermissions?.(parentSessionId, sessionId)
        }
        if (!this.dependencies.sessions.get(sessionId)) {
          throw new Error(`Subagent session not found after creation: ${sessionId}`)
        }

        const session = await this.dependencies.projection.materializeRequired(sessionId)
        this.dependencies.projection.notify({ sessionIds: [session.id], reason: 'created' })
        return session
      } catch (error) {
        lastError = error
        await this.cleanupFailedSessionInitialization(sessionId, runtimeConfig.providerId)
        if (attempt >= SUBAGENT_SESSION_INIT_MAX_ATTEMPTS) throw error

        console.warn(
          `[SessionLifecycle] Retrying subagent session initialization (${attempt}/${SUBAGENT_SESSION_INIT_MAX_ATTEMPTS - 1} retry used) for agent=${runtimeConfig.agentId} slot=${slotId}:`,
          error
        )
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to create subagent session for slot ${slotId}.`)
  }

  /**
   * 确保存在一个可用的 ACP 草稿会话（打开项目目录时预热外部 agent）。
   *
   * 复用规则：同 agent + 同 projectDir、仍是草稿且无消息的会话可直接复用，
   * 避免每次打开目录都新建外部 agent 进程。预热阶段的认证挑战不视为失败，
   * 以 auth_required 状态返回让 UI 引导登录——草稿会话保留，认证后继续用。
   */
  async ensureAcpDraftSession(input: {
    agentId: string
    projectDir: string
    permissionMode?: PermissionMode
  }): Promise<EnsureAcpDraftResult> {
    const agentId = input.agentId?.trim()
    if (!agentId) throw new Error('ACP draft session requires an agentId.')

    const projectDir = input.projectDir?.trim()
    if (!projectDir) throw new Error('ACP draft session requires a non-empty projectDir.')

    const { agentId: canonicalAgentId, permissionMode } =
      this.dependencies.assignmentPolicy.resolveAcpDraftAssignment(agentId, input.permissionMode)
    let record = await this.findReusableDraftSession(canonicalAgentId, projectDir)
    let createdDraftSession = false
    if (!record) {
      const sessionId = this.dependencies.sessions.create(
        canonicalAgentId,
        'New Chat',
        projectDir,
        { isDraft: true }
      )
      try {
        await this.ensureSessionRuntimeInitialized(sessionId, {
          agentId: canonicalAgentId,
          providerId: 'acp',
          modelId: canonicalAgentId,
          projectDir,
          permissionMode
        })
      } catch (error) {
        await this.cleanupFailedSessionInitialization(sessionId, 'acp')
        throw error
      }
      record = this.dependencies.sessions.get(sessionId)
      if (!record) throw new Error(`Failed to read created ACP draft session: ${sessionId}`)
      createdDraftSession = true
    } else {
      await this.ensureSessionRuntimeInitialized(record.id, {
        agentId: canonicalAgentId,
        providerId: 'acp',
        modelId: canonicalAgentId,
        projectDir,
        permissionMode
      })
    }

    try {
      await this.dependencies.workdir.prepareDirectAcpSession(record.id)
    } catch (error) {
      if (!isAcpAuthenticationRequiredError(error)) throw error
      this.dependencies.projection.notify({
        sessionIds: [record.id],
        reason: createdDraftSession ? 'created' : 'updated'
      })
      return {
        status: 'auth_required',
        session: {
          ...record,
          status: 'error',
          providerId: 'acp',
          modelId: canonicalAgentId
        },
        challenge: error.challenge
      }
    }
    this.dependencies.projection.notify({
      sessionIds: [record.id],
      reason: createdDraftSession ? 'created' : 'updated'
    })
    const state = await this.dependencies.runtime
      .resolveSession(toAppSessionId(record.id))
      .snapshot()
    return {
      status: 'ready',
      session: {
        ...record,
        status: state?.status ?? 'idle',
        providerId: state?.providerId ?? 'acp',
        modelId: state?.modelId ?? canonicalAgentId
      }
    }
  }

  /**
   * 从源会话的某条消息处复制出一份新会话（保留到该消息为止的完整历史）。
   * 新会话继承源会话的全部配置；复制失败时回滚——关闭运行时并删除记录。
   */
  async forkSession(
    sourceSessionId: string,
    targetMessageId: string,
    newTitle?: string
  ): Promise<SessionWithState> {
    const sourceSession = this.dependencies.sessions.get(sourceSessionId)
    if (!sourceSession) throw new Error(`Session not found: ${sourceSessionId}`)
    return await this.dependencies.agentLifecycle.runWithAgentOperation(
      sourceSession.agentId,
      async () => await this.forkSessionUnderLifecycleGate(sourceSession, targetMessageId, newTitle)
    )
  }

  private async forkSessionUnderLifecycleGate(
    sourceSession: SessionRecord,
    targetMessageId: string,
    newTitle?: string
  ): Promise<SessionWithState> {
    const sourceSessionId = sourceSession.id
    const sourceRuntime = this.dependencies.runtime.resolveSession(toAppSessionId(sourceSessionId))
    const sourceState = await sourceRuntime.snapshot()
    if (!sourceState) throw new Error(`Session state not found: ${sourceSessionId}`)
    const generationSettings = await sourceRuntime.getGenerationSettings()
    const disabledAgentTools = this.dependencies.sessions.getDisabledAgentTools(sourceSessionId)
    const title = this.buildForkTitle(sourceSession.title, newTitle)
    const targetSessionId = this.dependencies.sessions.create(
      sourceSession.agentId,
      title,
      sourceSession.projectDir ?? null,
      {
        isDraft: false,
        disabledAgentTools,
        orchestrationPolicy: sourceSession.orchestrationPolicy,
        toolModeOverride: sourceSession.toolModeOverride
      }
    )

    try {
      await this.initializeSessionRuntime(targetSessionId, {
        agentId: sourceSession.agentId,
        providerId: sourceState.providerId,
        modelId: sourceState.modelId,
        projectDir: sourceSession.projectDir ?? null,
        permissionMode: sourceState.permissionMode,
        generationSettings: generationSettings ?? undefined
      })
      await this.dependencies.transcript.forkSessionFromMessage(
        sourceSessionId,
        targetSessionId,
        targetMessageId
      )
    // 复制历史失败即整体失败：新会话没有独立价值，必须回滚。
    } catch (error) {
      try {
        await this.dependencies.runtime.resolveSession(targetSessionId).close()
      } catch (cleanupError) {
        console.warn(
          `[SessionLifecycle] Failed to cleanup forked session runtime ${targetSessionId}:`,
          cleanupError
        )
      }
      this.dependencies.sessions.delete(targetSessionId)
      throw error
    }

    this.dependencies.projection.notify({ sessionIds: [targetSessionId], reason: 'created' })
    const record = this.dependencies.sessions.get(targetSessionId)
    if (!record) throw new Error(`Forked session not found: ${targetSessionId}`)
    const targetState = await this.dependencies.runtime.resolveSession(targetSessionId).snapshot()
    return {
      ...record,
      status: targetState?.status ?? 'idle',
      providerId: targetState?.providerId ?? sourceState.providerId,
      modelId: targetState?.modelId ?? sourceState.modelId
    }
  }

  /** 删除会话及其全部子代理树，并向渲染层广播 deleted 变更。 */
  async deleteSession(sessionId: string): Promise<void> {
    const deletedSessionIds = await this.dependencies.deletion.deleteSessionTree(sessionId)
    this.dependencies.projection.notify({ sessionIds: deletedSessionIds, reason: 'deleted' })
  }

  /** 查找可复用的 ACP 草稿：同 agent 同目录、草稿、无消息。查不到返回 null。 */
  private async findReusableDraftSession(
    agentId: string,
    projectDir: string
  ): Promise<SessionRecord | null> {
    for (const session of this.dependencies.sessions.list({ agentId, projectDir })) {
      if (!session.isDraft) continue
      if (!(await this.hasSessionMessages(session.id))) return session
    }
    return null
  }

  /**
   * 检查会话是否已有消息。检查失败时按「有消息」处理：复用/清理判定都
   * 保守化——宁可留着一个多余会话，也不误删已有内容的会话。
   */
  private async hasSessionMessages(sessionId: string): Promise<boolean> {
    try {
      return await this.dependencies.transcript.hasMessages(sessionId)
    } catch (error) {
      console.warn(`[SessionLifecycle] Failed to inspect messages for session=${sessionId}:`, error)
      return true
    }
  }

  /**
   * 确保会话运行时就绪：未初始化则完整初始化；已初始化则只补齐差异
   * （权限模式不一致时覆写，ACP 工作目录重新同步）。供草稿复用路径使用。
   */
  private async ensureSessionRuntimeInitialized(
    sessionId: string,
    config: SessionLifecycleRuntimeConfig & { projectDir: string }
  ): Promise<void> {
    const runtime = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
    if (!(await runtime.isInitialized())) {
      await this.initializeSessionRuntime(sessionId, config)
      return
    }
    const state = await runtime.snapshot()
    if (!state) throw new Error(`Session ${sessionId} not found`)
    if (state.permissionMode && state.permissionMode !== config.permissionMode) {
      await runtime.setPermissionMode(config.permissionMode)
    }
    await this.dependencies.workdir.syncAcpSessionWorkdir(
      config.providerId,
      sessionId,
      config.agentId ?? config.modelId,
      config.projectDir
    )
  }

  /** 初始化运行时并同步 ACP 工作目录；这两步合起来才算「会话可用」。 */
  private async initializeSessionRuntime(
    sessionId: string,
    config: SessionLifecycleRuntimeConfig
  ): Promise<void> {
    await this.dependencies.runtime.resolveSession(toAppSessionId(sessionId)).initialize(config)
    await this.dependencies.workdir.syncAcpSessionWorkdir(
      config.providerId,
      sessionId,
      config.agentId ?? config.modelId,
      config.projectDir ?? null
    )
  }

  /**
   * 初始化失败后的清理：关闭运行时（兼容模式 ACP 还需清残留绑定），最后
   * 无条件删除会话记录。清理本身失败只警告，不掩盖原始初始化错误。
   */
  private async cleanupFailedSessionInitialization(
    sessionId: string,
    providerId?: string
  ): Promise<void> {
    try {
      const runtime = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
      if (providerId === 'acp' && runtime.kind !== 'acp') {
        try {
          await this.dependencies.workdir.clearCompatibilityAcpSession(sessionId)
        } catch (error) {
          console.warn(
            `[SessionLifecycle] Failed to clear ACP session after initialization error ${sessionId}:`,
            error
          )
        }
      }

      await runtime.close()
    } catch (cleanupError) {
      console.warn(
        `[SessionLifecycle] Failed to cleanup session runtime after initialization error ${sessionId}:`,
        cleanupError
      )
    } finally {
      this.dependencies.sessions.delete(sessionId)
    }
  }

  /**
   * 新建会话的首轮被用户取消后的回收：已有消息（首轮已产生内容）则保留
   * 会话，只解除窗口绑定并整树删除空会话。检查失败时保留会话——宁留勿删。
   */
  private async cleanupCancelledNewSession(
    sessionId: string,
    webContentsId: number
  ): Promise<void> {
    try {
      if (await this.dependencies.transcript.hasMessages(sessionId)) return
    } catch (error) {
      console.warn(
        `[SessionLifecycle] Failed to inspect cancelled session ${sessionId}; preserving it:`,
        error
      )
      return
    }

    try {
      if (this.dependencies.desktop.getActiveId(webContentsId) === sessionId) {
        this.dependencies.desktop.unbind(webContentsId)
      }
      const deletedSessionIds = await this.dependencies.deletion.deleteSessionTree(sessionId)
      if (deletedSessionIds.length > 0) {
        this.dependencies.projection.notify({ sessionIds: deletedSessionIds, reason: 'deleted' })
      }
    } catch (error) {
      console.warn(`[SessionLifecycle] Failed to cleanup cancelled session ${sessionId}:`, error)
    }
  }

  /** 派生标题：自定义优先；过长源标题截断到 60 字，否则加「 - Fork」后缀。 */
  private buildForkTitle(sourceTitle: string, customTitle?: string): string {
    const normalizedCustom = customTitle?.trim()
    if (normalizedCustom) return normalizedCustom
    const base = sourceTitle?.trim() || 'New Chat'
    return base.length >= 60 ? base.slice(0, 60).trim() : `${base} - Fork`
  }
}
