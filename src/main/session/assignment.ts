import { toAppSessionId } from '@/agent/shared/agentSessionIds'
import type {
  AgentTransferBlockReason,
  AgentTransferImpact,
  AgentTransferImpactSample,
  PermissionMode,
  SessionGenerationSettings,
  SessionRecord,
  SessionWithState,
  SubagentTapeLinkInput,
  SubagentTapeLinkReceipt
} from '@shared/types/agent-interface'
import type { AcpConfigState } from '@shared/types/acp'
import { resolveAcpAgentAlias } from '@shared/utils/acpAgentAlias'
import type {
  SessionAgentAssignmentPort,
  SessionAssignmentAcpControlPort,
  SessionAssignmentEnvironmentPort,
  SessionAssignmentPolicyPort,
  SessionAssignmentProjectionPort,
  SessionAssignmentRuntimePort,
  SessionAssignmentStorePort,
  SessionAssignmentWorkdirPort,
  SessionLifecycleDeletionPort
} from './contracts'
import { normalizeDisabledAgentTools } from '@/agent/shared/agentSessionNormalization'
import type { AgentLifecycleGatePort } from '@/agent/lifecycleGate'
import {
  normalizeOrchestrationPolicy,
  type OrchestrationPolicy
} from '@shared/orchestration/policy'
import { normalizeToolModeOverride, type ToolModeOverride } from '@shared/toolMode'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * 会话归属（assignment）模块：管理「会话 ↔ Agent」的绑定关系及其上的每会话配置。
 *
 * 职责分四块：
 * 1. 批量迁移——把一个 Agent 名下的全部会话移动到另一个 Agent（moveAgentSessions）、
 *    或整树删除（deleteAgentSessions）；迁移前用 getAgentTransferImpact 生成影响面
 *    报告供 UI 确认。
 * 2. 单会话配置——权限模式、模型、工具模式、项目目录、编排策略、禁用工具、生成参数，
 *    以及 ACP 会话特有的命令/配置项查询与设置。
 * 3. 会话级操作串行化——runWithSessionOperationGate 保证同一会话上的写操作不并发交错。
 * 4. 子代理产物挂接——linkSubagentTape 把子会话的执行录像（tape）登记到父会话。
 *
 * 本类只做编排与校验，持久化走 sessions 存储端口，运行时操作走 runtime 端口；
 * 删除委托 deletion 端口，迁移目标的合法性由 policy 端口裁定。
 */

/** 迁移前停止生成中的会话：最多等 10 秒，每 50ms 轮询一次状态。 */
const TRANSFER_STOP_TIMEOUT_MS = 10_000
const TRANSFER_STOP_POLL_MS = 50

export interface SessionAgentAssignmentDependencies {
  sessions: SessionAssignmentStorePort
  runtime: SessionAssignmentRuntimePort
  policy: SessionAssignmentPolicyPort
  projection: SessionAssignmentProjectionPort
  deletion: SessionLifecycleDeletionPort
  environment: SessionAssignmentEnvironmentPort
  acp: SessionAssignmentAcpControlPort
  agentLifecycle: AgentLifecycleGatePort
}

export class SessionAssignment implements SessionAgentAssignmentPort, SessionAssignmentWorkdirPort {
  /** 每个会话一条操作尾巴链：新操作排在链尾执行，保证同会话写操作串行。 */
  private readonly sessionOperationTails = new Map<string, Promise<void>>()

  constructor(private readonly dependencies: SessionAgentAssignmentDependencies) {}

  /**
   * 把 operation 排到该会话操作队列的末尾，前一个完成后才开始。
   *
   * tail 存的是「吞掉异常」的 promise，避免链上任何一次失败把后续操作全部
   * 堵死；operation 本身的异常原样抛给本次调用方。若自己仍是链尾则清除，
   * 防止 Map 随长生命周期会话无限增长。
   */
  async runWithSessionOperationGate<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperationTails.get(sessionId) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    const tail = next.then(
      () => undefined,
      () => undefined
    )
    this.sessionOperationTails.set(sessionId, tail)

    try {
      return await next
    } finally {
      if (this.sessionOperationTails.get(sessionId) === tail) {
        this.sessionOperationTails.delete(sessionId)
      }
    }
  }

  /** 校验 child 确实是 parent 的子代理会话后，把子会话 tape 登记到父会话的运行时门面。 */
  async linkSubagentTape(input: SubagentTapeLinkInput): Promise<SubagentTapeLinkReceipt> {
    this.requireChildSession(input.parentSessionId, input.childSessionId)
    const resolved = this.dependencies.runtime.resolveSubagentFacet(
      toAppSessionId(input.parentSessionId)
    )
    return await resolved.facet.linkTape({
      ...input,
      parentSessionId: toAppSessionId(input.parentSessionId),
      childSessionId: toAppSessionId(input.childSessionId)
    })
  }

  /**
   * 统计把某 Agent 的全部会话迁走会产生的影响，供 UI 在迁移前展示确认。
   *
   * 只读不写。逐会话评估运行状态与待处理输入，把「空草稿」（可静默删除）、
   * 「可迁移」「被阻塞」三类计数，并挑最多 6 个非空或被阻塞的会话作样本；
   * 没有样本时用户无法判断迁移的代价，故排除纯空草稿。
   */
  async getAgentTransferImpact(agentId: string): Promise<AgentTransferImpact> {
    const normalizedAgentId = agentId.trim()
    if (!normalizedAgentId) {
      throw new Error('Agent id is required.')
    }

    // 包含子代理会话：迁移父会话时它们也要跟着处理。
    const sessions = this.dependencies.sessions.list({
      agentId: normalizedAgentId,
      includeSubagents: true
    })
    const samples: AgentTransferImpactSample[] = []
    let emptyDrafts = 0
    let movableSessions = 0
    let blockedSessions = 0

    for (const session of sessions) {
      const assessment = await this.assessTransferSession(session)
      if (assessment.isEmptyDraft) emptyDrafts += 1
      if (assessment.blockReason) {
        blockedSessions += 1
      } else if (!assessment.isEmptyDraft) {
        movableSessions += 1
      }

      if (samples.length < 6 && (!assessment.isEmptyDraft || assessment.blockReason)) {
        // 样本优先给被阻塞或非空的会话：它们才是用户需要关注的部分。
        samples.push({
          id: session.id,
          title: session.title,
          sessionKind: session.sessionKind,
          isDraft: Boolean(session.isDraft),
          projectDir: session.projectDir,
          status: assessment.status,
          blockReason: assessment.blockReason
        })
      }
    }

    return {
      agentId: normalizedAgentId,
      totalSessions: sessions.length,
      regularSessions: sessions.filter((session) => session.sessionKind === 'regular').length,
      subagentSessions: sessions.filter((session) => session.sessionKind === 'subagent').length,
      emptyDrafts,
      movableSessions,
      blockedSessions,
      samples
    }
  }

  /**
   * 把 fromAgent 名下全部会话迁移到 toAgent；空草稿直接删除而不是搬运。
   *
   * 两阶段执行：先对每个会话做评估与目标校验（此阶段抛错则什么都没动），
   * 再逐个落地。落地阶段一旦失败属于部分成功，错误信息里附上已完成的
   * 计数，并先广播已迁移/已删除的变更，避免 UI 与实际状态脱节。
   * 迁移目标可能在逐会话校验中随 projectDir 不同而不同，故不能只校验一次。
   */
  async moveAgentSessions(
    fromAgentId: string,
    toAgentId: string
  ): Promise<{ movedSessionIds: string[]; deletedSessionIds: string[] }> {
    const sourceAgentId = fromAgentId.trim()
    const targetAgentId = toAgentId.trim()
    if (!sourceAgentId || !targetAgentId) {
      throw new Error('Source and target agent ids are required.')
    }
    if (sourceAgentId === targetAgentId) {
      throw new Error('Source and target agents cannot be the same.')
    }
    await this.dependencies.policy.resolveTransferTarget(targetAgentId, null)

    // 第一阶段：全面评估，任何阻塞即整体失败，保证「要么不动，要么尽量迁完」。
    const sessions = this.dependencies.sessions.list({
      agentId: sourceAgentId,
      includeSubagents: true
    })
    const transferSessionIds: string[] = []
    const emptyDraftSessionIds: string[] = []
    const movedSessionIds: string[] = []
    const deletedSessionIds: string[] = []
    const deletedSessionIdSet = new Set<string>()

    for (const session of sessions) {
      const assessment = await this.assessTransferSession(session)
      if (assessment.blockReason) {
        throw new Error(`Session ${session.id} cannot be moved: ${assessment.blockReason}`)
      }
      if (assessment.isEmptyDraft) {
        emptyDraftSessionIds.push(session.id)
        continue
      }

      await this.dependencies.policy.resolveTransferTarget(targetAgentId, session.projectDir)
      transferSessionIds.push(session.id)
    }

    try {
      // 第二阶段：落地。非空会话逐个迁移（走会话操作门串行化）；空草稿不值得
      // 搬运，直接整树删除。deletedSessionIdSet 记录级联删除覆盖到的会话，
      // 跳过已被连带删除的条目。
      for (const sessionId of transferSessionIds) {
        if (deletedSessionIdSet.has(sessionId)) continue
        await this.runWithSessionOperationGate(sessionId, async () => {
          if (!this.dependencies.sessions.get(sessionId)) {
            throw new Error(`Session ${sessionId} is no longer available.`)
          }
          await this.moveSessionToAgentInternal(sessionId, targetAgentId, true)
        })
        movedSessionIds.push(sessionId)
      }

      for (const sessionId of emptyDraftSessionIds) {
        if (deletedSessionIdSet.has(sessionId)) continue
        if (!this.dependencies.sessions.get(sessionId)) {
          throw new Error(`Session ${sessionId} is no longer available.`)
        }
        const deleted = await this.dependencies.deletion.deleteSessionTree(sessionId)
        deleted.forEach((deletedSessionId) => deletedSessionIdSet.add(deletedSessionId))
        deletedSessionIds.push(...deleted)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const partialCounts = [
        movedSessionIds.length > 0 ? `${movedSessionIds.length} moved` : '',
        deletedSessionIds.length > 0 ? `${deletedSessionIds.length} deleted` : ''
      ].filter(Boolean)

      if (partialCounts.length > 0) {
        this.notifyTransferResults(movedSessionIds, deletedSessionIds)
        throw new Error(`${message} Partial transfer completed: ${partialCounts.join(', ')}.`)
      }
      throw error
    }

    this.notifyTransferResults(movedSessionIds, deletedSessionIds)
    return { movedSessionIds, deletedSessionIds }
  }

  /**
   * 删除某 Agent 名下全部会话（含子代理树）。
   *
   * 与迁移不同，这里采用「先全量校验、再逐个删除」且不做两阶段回滚补偿——
   * 删除本身不可逆，中途失败时已完成的部分保持已删除状态，调用方拿到已删
   * id 列表即可。最后统一广播 deleted 变更。
   */
  async deleteAgentSessions(agentId: string): Promise<string[]> {
    const normalizedAgentId = agentId.trim()
    if (!normalizedAgentId) {
      throw new Error('Agent id is required.')
    }

    const sessions = this.dependencies.sessions.list({
      agentId: normalizedAgentId,
      includeSubagents: true
    })
    const deletedSessionIds: string[] = []
    const deletedSessionIdSet = new Set<string>()

    // 先确认全部会话都可删，再开始删；避免删到一半发现某个会话仍在生成。
    for (const session of sessions) {
      const assessment = await this.assessTransferSession(session)
      if (assessment.blockReason) {
        throw new Error(`Session ${session.id} cannot be deleted: ${assessment.blockReason}`)
      }
    }

    for (const session of sessions) {
      if (deletedSessionIdSet.has(session.id) || !this.dependencies.sessions.get(session.id)) {
        continue
      }
      // deleteSessionTree 返回级联删除的整棵会话树，后续循环据此跳过重复项。
      const deleted = await this.dependencies.deletion.deleteSessionTree(session.id)
      deleted.forEach((sessionId) => deletedSessionIdSet.add(sessionId))
      deletedSessionIds.push(...deleted)
    }

    if (deletedSessionIds.length > 0) {
      this.dependencies.projection.notify({
        sessionIds: deletedSessionIds,
        reason: 'deleted'
      })
    }
    return deletedSessionIds
  }

  /** 从会话菜单把单个会话移动到目标 Agent（仅限 regular 会话），完成后广播更新。 */
  async moveSessionToAgent(sessionId: string, toAgentId: string): Promise<SessionWithState> {
    return await this.runWithSessionOperationGate(sessionId, async () => {
      const updated = await this.moveSessionToAgentInternal(sessionId, toAgentId)
      this.dependencies.projection.notify({ sessionIds: [sessionId], reason: 'updated' })
      return updated
    })
  }

  /**
   * 查询 ACP 会话暴露的斜杠命令列表；非 ACP 会话一律返回空。
   *
   * 两条路径：直接 ACP 会话（handle 本身是 acp）走 handle；兼容模式（deepchat
   * handle 但 providerId 为 acp）走独立的 acp 控制端口。
   */
  async getAcpSessionCommands(sessionId: string): Promise<
    Array<{
      name: string
      description: string
      input?: { hint: string } | null
    }>
  > {
    if (!this.dependencies.sessions.get(sessionId)) return []
    const { handle } = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
    if (handle.kind === 'acp') return await handle.acp.getCommands()
    if ((await handle.snapshot())?.providerId !== 'acp') return []
    return await this.dependencies.acp.getAcpSessionCommands(sessionId)
  }

  /** 查询 ACP 会话的配置选项状态（如可选模型/模式）；非 ACP 会话返回 null。 */
  async getAcpSessionConfigOptions(sessionId: string): Promise<AcpConfigState | null> {
    if (!this.dependencies.sessions.get(sessionId)) return null
    const { handle } = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
    if (handle.kind === 'acp') return await handle.acp.getConfigOptions()
    if ((await handle.snapshot())?.providerId !== 'acp') return null
    return await this.dependencies.acp.getAcpSessionConfigOptions(sessionId)
  }

  /** 设置 ACP 会话的某个配置项，返回更新后的配置状态；非 ACP 会话直接报错。 */
  async setAcpSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<AcpConfigState | null> {
    if (!this.dependencies.sessions.get(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    const { handle } = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
    if (handle.kind === 'acp') return await handle.acp.setConfigOption(configId, value)
    if ((await handle.snapshot())?.providerId !== 'acp') {
      throw new Error('ACP session config options are only available for ACP sessions.')
    }
    return await this.dependencies.acp.setAcpSessionConfigOption(sessionId, configId, value)
  }

  /** 读取会话的权限模式（如只读/自动执行）；会话不存在时抛错。 */
  async getPermissionMode(sessionId: string): Promise<PermissionMode> {
    this.requireSession(sessionId)
    return await this.dependencies.runtime
      .resolveSession(toAppSessionId(sessionId))
      .handle.settings.getPermissionMode()
  }

  /** 写入会话的权限模式；持久化由运行时 handle 的 settings 负责。 */
  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    this.requireSession(sessionId)
    await this.dependencies.runtime
      .resolveSession(toAppSessionId(sessionId))
      .handle.settings.setPermissionMode(mode)
  }

  /**
   * 切换会话使用的模型。仅 Office Agent（deepchat）会话允许换模型——ACP 会话
   * 的模型由外部 agent 进程持有，本地无权改写。返回的记录用快照回填最新状态，
   * 避免读到切换前的旧 provider/model。
   */
  async setSessionModel(
    sessionId: string,
    providerId: string,
    modelId: string
  ): Promise<SessionWithState> {
    const session = this.requireSession(sessionId)
    const nextProviderId = providerId?.trim()
    const nextModelId = modelId?.trim()
    if (!nextProviderId || !nextModelId) {
      throw new Error('setSessionModel requires providerId and modelId.')
    }

    const { handle } = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
    if (handle.kind !== 'deepchat') throw new Error('ACP session model is locked.')
    await handle.deepchat.setModel(nextProviderId, nextModelId)
    const state = await handle.snapshot()
    const updated: SessionWithState = {
      ...session,
      status: state?.status ?? 'idle',
      providerId: state?.providerId ?? nextProviderId,
      modelId: state?.modelId ?? nextModelId
    }
    this.dependencies.projection.notify({ sessionIds: [sessionId], reason: 'updated' })
    return updated
  }

  /**
   * 覆盖会话的工具模式（如强制读/写集）。
   *
   * 生成进行中禁止修改：工具模式影响本轮的工具调用决策，中途切换会让同一轮
   * 前后行为不一致。走会话操作门避免与并发写操作交错；更新后立即 materialize
   * 出新状态返回，而不是让调用方再查一次。
   */
  async setSessionToolMode(
    sessionId: string,
    override: ToolModeOverride
  ): Promise<SessionWithState> {
    return await this.runWithSessionOperationGate(sessionId, async () => {
      this.requireSession(sessionId)
      const { handle } = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
      if (handle.kind !== 'deepchat') {
        throw new Error('Tool mode is only available for Office Agent sessions.')
      }
      const state = await handle.snapshot()
      if (state?.status === 'generating') {
        throw new Error('Tool mode cannot be changed while a turn is running.')
      }

      this.dependencies.sessions.updateToolModeOverride(
        sessionId,
        normalizeToolModeOverride(override)
      )
      const materialized = await this.dependencies.projection.materialize(sessionId)
      if (!materialized) {
        throw new Error(`Failed to build session state after tool mode update: ${sessionId}`)
      }
      this.dependencies.projection.notify({ sessionIds: [sessionId], reason: 'updated' })
      return materialized
    })
  }

  /**
   * 修改会话绑定的项目目录（可为 null 表示不绑定）。
   *
   * 顺序敏感：先校验（ACP 会话必须有工作目录），再更新存储，同步环境层与
   * 运行时 settings，最后同步 ACP 侧工作目录。ACP 同步失败会抛错终止，但
   * 存储已更新——这是有意的：本地目录是权威数据，ACP 侧是可重试的镜像。
   */
  async setSessionProjectDir(
    sessionId: string,
    projectDir: string | null
  ): Promise<SessionWithState> {
    const session = this.requireSession(sessionId)
    const { handle } = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
    const state = await handle.snapshot()
    const providerId = state?.providerId?.trim() || (handle.kind === 'acp' ? 'acp' : '')
    const normalizedProjectDir = projectDir?.trim() || null
    this.assertAcpSessionHasWorkdir(providerId, normalizedProjectDir)

    this.dependencies.sessions.update(sessionId, { projectDir: normalizedProjectDir })
    if (normalizedProjectDir) this.dependencies.environment.syncPath(normalizedProjectDir)
    await handle.settings.setProjectDir(normalizedProjectDir)
    await this.syncAcpSessionWorkdir(providerId, sessionId, session.agentId, normalizedProjectDir)

    // 更新后二次确认会话仍存在：目录同步过程中可能触发删除等外部变更。
    if (!this.dependencies.sessions.get(sessionId)) {
      throw new Error(`Session not found after update: ${sessionId}`)
    }

    this.dependencies.projection.notify({ sessionIds: [sessionId], reason: 'updated' })
    const materialized = await this.dependencies.projection.materialize(sessionId)
    if (!materialized) {
      throw new Error(`Failed to build session state after project update: ${sessionId}`)
    }
    return materialized
  }

  async getSessionGenerationSettings(sessionId: string): Promise<SessionGenerationSettings | null> {
    this.requireSession(sessionId)
    return await this.dependencies.runtime
      .resolveSession(toAppSessionId(sessionId))
      .handle.settings.getGenerationSettings()
  }

  async getSessionDisabledAgentTools(sessionId: string): Promise<string[]> {
    this.requireSession(sessionId)
    return this.dependencies.sessions.getDisabledAgentTools(sessionId)
  }

  async getOrchestrationPolicy(sessionId: string): Promise<OrchestrationPolicy> {
    this.requireSession(sessionId)
    return this.dependencies.sessions.getOrchestrationPolicy(sessionId)
  }

  /**
   * 更新编排策略（会话与子代理的协作方式）。proactive 策略有额外前置：
   * 只允许 regular 会话且必须是 Office Agent 会话——子代理与 ACP 会话
   * 都没有发起主动协作所需的运行时能力。
   */
  async updateOrchestrationPolicy(
    sessionId: string,
    policy: OrchestrationPolicy
  ): Promise<OrchestrationPolicy> {
    return await this.runWithSessionOperationGate(sessionId, async () => {
      const session = this.requireSession(sessionId)
      const normalized = normalizeOrchestrationPolicy(policy)
      if (normalized === 'proactive') {
        if (session.sessionKind !== 'regular') {
          throw new Error('Proactive collaboration requires a regular parent session.')
        }
        if (
          this.dependencies.runtime.getSessionAgentKind(toAppSessionId(sessionId)) !== 'deepchat'
        ) {
          throw new Error('Proactive collaboration requires a Office Agent session.')
        }
      }
      this.dependencies.sessions.updateOrchestrationPolicy(sessionId, normalized)
      this.dependencies.projection.notify({ sessionIds: [sessionId], reason: 'updated' })
      return normalized
    })
  }

  /** 更新会话级禁用的 Agent 工具清单；入参先规范化（去重/去空）再落库。 */
  async updateSessionDisabledAgentTools(
    sessionId: string,
    disabledAgentTools: string[]
  ): Promise<string[]> {
    this.requireSession(sessionId)
    const normalized = normalizeDisabledAgentTools(disabledAgentTools)
    this.dependencies.sessions.updateDisabledAgentTools(sessionId, normalized)

    return normalized
  }

  async updateSessionGenerationSettings(
    sessionId: string,
    settings: Partial<SessionGenerationSettings>
  ): Promise<SessionGenerationSettings> {
    this.requireSession(sessionId)
    return await this.dependencies.runtime
      .resolveSession(toAppSessionId(sessionId))
      .handle.settings.updateGenerationSettings(settings)
  }

  /** 校验 ACP 会话是否允许设置该工作目录；具体规则由 policy 端口持有。 */
  assertAcpSessionHasWorkdir(providerId: string, projectDir: string | null): void {
    this.dependencies.policy.assertAcpSessionHasWorkdir(providerId, projectDir)
  }

  /**
   * 把工作目录同步到 ACP 侧。非 ACP 会话或目录为空时是 no-op。
   *
   * 直接 ACP 会话走 handle 自身；兼容模式走独立控制端口（需带 agent 别名）。
   * 失败只记警告后原样抛出：调用方（如 setSessionProjectDir）需要知道镜像
   * 未同步成功，以便提示用户重试。
   */
  async syncAcpSessionWorkdir(
    providerId: string,
    sessionId: string,
    agentId: string,
    projectDir?: string | null
  ): Promise<void> {
    if (providerId !== 'acp') return
    const normalizedProjectDir = projectDir?.trim()
    if (!normalizedProjectDir) return

    try {
      const { handle } = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
      if (handle.kind === 'acp') {
        await handle.acp.updateWorkdir(normalizedProjectDir)
        return
      }
      await this.dependencies.acp.setAcpWorkdir(
        sessionId,
        resolveAcpAgentAlias(agentId),
        normalizedProjectDir
      )
    } catch (error) {
      console.warn('[SessionAssignment] Failed to sync ACP workdir:', {
        sessionId,
        agentId,
        projectDir: normalizedProjectDir,
        error
      })
      throw error
    }
  }

  /** 预热直接 ACP 会话的外部 agent 进程（如启动连接），非直接 ACP 会话报错。 */
  async prepareDirectAcpSession(sessionId: string): Promise<void> {
    const { handle } = this.dependencies.runtime.resolveSession(toAppSessionId(sessionId))
    if (handle.kind !== 'acp') {
      throw new Error(`Session ${sessionId} is not a direct ACP session.`)
    }
    await handle.acp.prepare()
  }

  /** 清除兼容模式下会话上残留的 ACP 绑定（迁移走后旧绑定必须失效）。 */
  async clearCompatibilityAcpSession(sessionId: string): Promise<void> {
    await this.dependencies.acp.clearAcpSession(sessionId)
  }

  /**
   * 评估一个会话能否参与迁移/删除，产出三方面结论：
   * - isEmptyDraft：草稿且无消息、无子代理——迁移场景下不值得搬，直接删。
   * - blockReason：待处理输入检查失败时按 pending-input 阻塞（宁可不迁，
   *   也不在输入状态不明时移动会话）。
   * - queuedInputIds / status：供 prepareSessionForTransfer 决定清什么、停什么。
   * 消息与输入检查失败只降级为警告，不中断整个批量操作的评估。
   */
  private async assessTransferSession(session: SessionRecord): Promise<{
    status: SessionWithState['status']
    isEmptyDraft: boolean
    queuedInputIds: string[]
    blockReason?: AgentTransferBlockReason
  }> {
    const { handle, facet } = this.dependencies.runtime.resolveTransferSource(
      toAppSessionId(session.id)
    )
    const state =
      handle.kind === 'acp' ? await handle.snapshot({ lightweight: true }) : await handle.snapshot()
    const status = state?.status ?? 'idle'
    let hasMessages = true
    try {
      hasMessages = await facet.hasMessages(toAppSessionId(session.id))
    } catch (error) {
      console.warn(
        `[SessionAssignment] Failed to inspect messages for session=${session.id}:`,
        error
      )
    }

    let queuedInputIds: string[] = []
    let pendingInputInspectionFailed = false
    try {
      queuedInputIds = (await facet.listPendingInputs(toAppSessionId(session.id)))
        .filter((input) => input.mode === 'queue')
        .map((input) => input.id)
    } catch (error) {
      console.warn(
        `[SessionAssignment] Failed to inspect pending input for session=${session.id}:`,
        error
      )
      pendingInputInspectionFailed = true
    }

    // 只有 regular 会话才可能有子代理；有无子代理影响空草稿判定。
    const hasSubagentChildren =
      session.sessionKind === 'regular' &&
      this.dependencies.sessions.list({
        includeSubagents: true,
        parentSessionId: session.id
      }).length > 0
    const isEmptyDraft = Boolean(session.isDraft) && !hasMessages && !hasSubagentChildren

    if (pendingInputInspectionFailed) {
      return { status, isEmptyDraft, queuedInputIds, blockReason: 'pending-input' }
    }
    return { status, isEmptyDraft, queuedInputIds }
  }

  /**
   * 迁移前的现场清理：丢弃排队中的输入，生成中的会话先取消并轮询等待其
   * 真正停下。超时强制报错——带着还在写入的运行时迁移会让目标侧读到
   * 半途状态，宁可让这次迁移失败。
   */
  private async prepareSessionForTransfer(
    sessionId: string,
    status: SessionWithState['status'],
    queuedInputIds: string[]
  ): Promise<void> {
    if (status !== 'generating' && queuedInputIds.length === 0) return

    const { handle } = this.dependencies.runtime.resolveTransferSource(toAppSessionId(sessionId))
    for (const itemId of queuedInputIds) {
      await handle.pending.delete(itemId)
    }
    if (status === 'generating') {
      await handle.cancel()
      const deadline = Date.now() + TRANSFER_STOP_TIMEOUT_MS
      while (
        (await handle.snapshot(handle.kind === 'acp' ? { lightweight: true } : undefined))
          ?.status === 'generating'
      ) {
        if (Date.now() >= deadline) {
          throw new Error(`Session ${sessionId} did not stop before transfer.`)
        }
        await delay(TRANSFER_STOP_POLL_MS)
      }
    }
  }

  /** 单会话迁移的入口：先过目标 Agent 的生命周期门（防与其启停操作竞争）。 */
  private async moveSessionToAgentInternal(
    sessionId: string,
    toAgentId: string,
    allowSubagent: boolean = false
  ): Promise<SessionWithState> {
    const targetAgentId = toAgentId.trim()
    if (!targetAgentId) throw new Error('Target agent id is required.')
    return await this.dependencies.agentLifecycle.runWithAgentOperation(targetAgentId, async () => {
      return await this.moveSessionToAgentUnderLifecycleGate(
        sessionId,
        targetAgentId,
        allowSubagent
      )
    })
  }

  /**
   * 迁移的实质步骤（已在生命周期门内执行）。
   *
   * 流程：评估 → 解析目标配置 → 清理运行现场 → 把新归属上下文写入目标
   * 门面 → 更新存储（agentId/projectDir/禁用工具）→ 同步 ACP 工作目录 →
   * materialize 出新状态。收尾时清理旧运行时：直接 ACP 关闭整个运行时，
   * 兼容模式只清残留绑定；清理失败仅警告，不回滚已完成的迁移。
   */
  private async moveSessionToAgentUnderLifecycleGate(
    sessionId: string,
    toAgentId: string,
    allowSubagent: boolean
  ): Promise<SessionWithState> {
    const session = this.requireSession(sessionId)
    if (!allowSubagent && session.sessionKind !== 'regular') {
      throw new Error('Only regular conversations can be moved from the conversation menu.')
    }

    const targetAgentId = toAgentId.trim()
    if (!targetAgentId) throw new Error('Target agent id is required.')
    if (session.agentId === targetAgentId) {
      throw new Error('Conversation is already assigned to the selected agent.')
    }

    const assessment = await this.assessTransferSession(session)
    if (assessment.blockReason) {
      throw new Error(`Session ${sessionId} cannot be moved: ${assessment.blockReason}`)
    }

    const target = await this.dependencies.policy.resolveTransferTarget(
      targetAgentId,
      session.projectDir
    )
    await this.prepareSessionForTransfer(sessionId, assessment.status, assessment.queuedInputIds)
    const source = this.dependencies.runtime.resolveTransferSource(toAppSessionId(sessionId))
    // 记录迁移前的 ACP 形态，收尾阶段按形态选择清理方式。
    const previousDirectAcp = source.handle.kind === 'acp'
    const previousCompatibilityAcp =
      source.handle.kind === 'deepchat' && (await source.handle.snapshot())?.providerId === 'acp'
    const { facet: transferTarget } = this.dependencies.runtime.resolveDeepChatTransferTarget(
      target.agentId
    )

    await transferTarget.setSessionAgentContext(toAppSessionId(sessionId), {
      agentId: target.agentId,
      providerId: target.providerId,
      modelId: target.modelId,
      projectDir: target.projectDir,
      permissionMode: target.permissionMode,
      generationSettings: target.generationSettings
    })

    this.dependencies.sessions.updateAgentId(sessionId, target.agentId)
    this.dependencies.sessions.update(sessionId, {
      projectDir: target.projectDir
    })
    this.dependencies.sessions.updateDisabledAgentTools(sessionId, target.disabledAgentTools)
    await this.syncAcpSessionWorkdir(
      target.providerId,
      sessionId,
      target.agentId,
      target.projectDir
    )

    if (!this.dependencies.sessions.get(sessionId)) {
      throw new Error(`Session not found after transfer: ${sessionId}`)
    }
    const materialized = await this.dependencies.projection.materialize(sessionId)
    if (!materialized) {
      throw new Error(`Failed to build session state after transfer: ${sessionId}`)
    }

    if (previousDirectAcp && source.closeRuntime) {
      try {
        await source.closeRuntime()
      } catch (error) {
        console.warn(
          `[SessionAssignment] Failed to close direct ACP runtime after transfer ${sessionId}:`,
          error
        )
      }
    } else if (previousCompatibilityAcp) {
      try {
        await this.clearCompatibilityAcpSession(sessionId)
      } catch (error) {
        console.warn(
          `[SessionAssignment] Failed to clear stale ACP binding after transfer ${sessionId}:`,
          error
        )
      }
    }

    return materialized
  }

  /** 校验存在性；找不到即抛错，让上层把「会话已消失」与其它失败区分开。 */
  private requireSession(sessionId: string): SessionRecord {
    const session = this.dependencies.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    return session
  }

  private requireChildSession(parentSessionId: string, childSessionId: string): void {
    this.requireSession(parentSessionId)
    const child = this.requireSession(childSessionId)
    if (child.sessionKind !== 'subagent' || child.parentSessionId !== parentSessionId) {
      throw new Error(`Session ${childSessionId} is not a child of ${parentSessionId}.`)
    }
  }

  /** 迁移/删除完成后统一向渲染层广播变更；moved 与 deleted 用不同原因。 */
  private notifyTransferResults(movedSessionIds: string[], deletedSessionIds: string[]): void {
    if (movedSessionIds.length > 0) {
      this.dependencies.projection.notify({ sessionIds: movedSessionIds, reason: 'updated' })
    }
    if (deletedSessionIds.length > 0) {
      this.dependencies.projection.notify({ sessionIds: deletedSessionIds, reason: 'deleted' })
    }
  }
}
