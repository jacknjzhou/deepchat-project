import { resolveAcpAgentAlias } from '@shared/utils/acpAgentAlias'
import type {
  DeepChatAgentConfig,
  PermissionMode,
  SessionGenerationSettings
} from '@shared/types/agent-interface'
import type {
  CreateAssignmentInput,
  ResolvedSessionAssignment,
  ResolvedSubagentAssignment,
  ResolvedTransferTarget,
  SessionAssignmentCatalogPort,
  SessionAssignmentConfigPort,
  SessionAssignmentPolicyPort,
  SubagentAssignmentInput
} from './contracts'
import {
  normalizeActiveSkills,
  normalizeDisabledAgentTools
} from '@/agent/shared/agentSessionNormalization'
import { composeSubagentAuthority } from './subagentAuthority'

/** 会话的权限模式缺省放开到 full_access：显式收窄才是例外。 */
const resolveAssignmentPermissionMode = (mode?: PermissionMode | null): PermissionMode =>
  mode ?? 'full_access'

/** 权限等级：数值越高越宽松，用于「取更严一侧」的比较。 */
const PERMISSION_MODE_RANK: Readonly<Record<PermissionMode, number>> = {
  default: 0,
  auto_approve: 1,
  full_access: 2
}

/** 跨 Agent 子代理的权限模式：父级与目标侧取更严格的一个（收缩不扩张）。 */
function resolveCrossAgentPermissionMode(
  parentMode: PermissionMode | undefined,
  targetMode: PermissionMode | null | undefined
): PermissionMode {
  const parent = resolveAssignmentPermissionMode(parentMode)
  if (!targetMode) return parent
  return PERMISSION_MODE_RANK[targetMode] < PERMISSION_MODE_RANK[parent] ? targetMode : parent
}

/**
 * 会话归属策略（assignmentPolicy）：把「用户传来的建会话/派生子代理/迁移
 * 参数」解析成最终生效的归属配置（agent/provider/model/目录/权限/生成参数）。
 *
 * 解析原则：调用方显式传入的值优先，逐级回退到 Agent 配置默认值、全局
 * 默认值；解析不到必需项（如模型）直接报错让建会话失败，而不是带着空配置
 * 起一个不可用的会话。跨 Agent 子代理遵循「只收不扩」：目标 Agent 的策略
 * 只能收紧父级授予的权限面，不能放大。
 */
export class SessionAssignmentPolicy implements SessionAssignmentPolicyPort {
  constructor(
    private readonly catalog: SessionAssignmentCatalogPort,
    private readonly config: SessionAssignmentConfigPort
  ) {}

  /** 解析常规会话创建的归属配置；模型/provider 无着落时报错。 */
  async resolveCreateAssignment(input: CreateAssignmentInput): Promise<ResolvedSessionAssignment> {
    const descriptor = this.catalog.resolveAgent(input.agentId)
    const agentConfig =
      descriptor.kind === 'deepchat'
        ? await this.config.resolveDeepChatAgentConfig(descriptor.id)
        : null
    const projectDir = this.resolveProjectDir(input, agentConfig?.defaultProjectPath)
    const defaultModel = this.config.getDefaultModel()
    const providerId =
      descriptor.kind === 'acp'
        ? 'acp'
        : (input.providerId ??
          agentConfig?.defaultModelPreset?.providerId ??
          defaultModel?.providerId ??
          '')
    const modelId =
      descriptor.kind === 'acp'
        ? descriptor.id
        : (input.modelId ?? agentConfig?.defaultModelPreset?.modelId ?? defaultModel?.modelId ?? '')

    if (!providerId || !modelId) {
      throw new Error('No provider or model configured. Please set a default model in settings.')
    }
    this.assertAcpSessionHasWorkdir(providerId, projectDir)

    return {
      agentId: descriptor.id,
      agentType: descriptor.kind,
      providerId,
      modelId,
      projectDir,
      permissionMode: resolveAssignmentPermissionMode(
        input.permissionMode ?? agentConfig?.permissionMode
      ),
      generationSettings: this.mergeDefaultGenerationSettings(
        agentConfig,
        input.generationSettings
      ),
      disabledAgentTools:
        descriptor.kind === 'deepchat'
          ? normalizeDisabledAgentTools(input.disabledAgentTools ?? agentConfig?.disabledAgentTools)
          : []
    }
  }

  /** 解析 ACP 草稿会话的最小归属（仅 agent + 权限模式）；非 ACP Agent 报错。 */
  resolveAcpDraftAssignment(
    agentId: string,
    permissionMode?: PermissionMode
  ): { agentId: string; permissionMode: PermissionMode } {
    const descriptor = this.catalog.resolveAgent(agentId)
    if (descriptor.kind !== 'acp') {
      throw new Error(`Agent ${agentId} is not an ACP agent.`)
    }
    return {
      agentId: descriptor.id,
      permissionMode: resolveAssignmentPermissionMode(permissionMode)
    }
  }

  /**
   * 解析子代理会话的归属。ACP 目标只做目录校验；Office Agent 目标分两种：
   * 同 Agent 子代理直接沿用父级参数；跨 Agent 子代理则系统提示词换成目标
   * Agent 的，权限/工具面与父级求交（只收不扩）。
   */
  async resolveSubagentAssignment(
    input: SubagentAssignmentInput
  ): Promise<ResolvedSubagentAssignment> {
    let descriptor: { id: string; kind: 'deepchat' | 'acp' }
    try {
      descriptor = this.catalog.resolveAgent(resolveAcpAgentAlias(input.agentId.trim()))
    } catch {
      throw new Error(`Agent ${input.agentId} is not a valid subagent target.`)
    }

    if (descriptor.kind === 'acp') {
      this.assertAcpSessionHasWorkdir('acp', input.projectDir)
      return {
        agentId: descriptor.id,
        targetAgentId: input.targetAgentId?.trim() ? descriptor.id : null,
        providerId: 'acp',
        modelId: descriptor.id,
        permissionMode: resolveAssignmentPermissionMode(input.permissionMode),
        generationSettings: { systemPrompt: '' },
        disabledAgentTools: [],
        activeSkills: []
      }
    }

    this.assertAcpSessionHasWorkdir(input.providerId, input.projectDir)

    const parentAgentId = input.parentAgentId?.trim() || null
    const isCrossAgent = Boolean(parentAgentId && parentAgentId !== descriptor.id)
    const targetAgentId = input.targetAgentId?.trim() ? descriptor.id : null

    if (!isCrossAgent) {
      return {
        agentId: descriptor.id,
        targetAgentId,
        providerId: input.providerId,
        modelId: input.modelId,
        permissionMode: resolveAssignmentPermissionMode(input.permissionMode),
        generationSettings: input.generationSettings,
        disabledAgentTools: normalizeDisabledAgentTools(input.disabledAgentTools),
        activeSkills: normalizeActiveSkills(input.activeSkills)
      }
    }

    // Cross-agent child: keep the parent workdir/model and intersect its live authority with the
    // target Agent policy. A target default may restrict the parent but can never elevate it.
    const agentConfig = await this.config.resolveDeepChatAgentConfig(descriptor.id)
    const parentGeneration = input.generationSettings ?? {}
    const generationSettings = this.mergeDefaultGenerationSettings(agentConfig, {
      ...parentGeneration,
      systemPrompt:
        typeof agentConfig?.systemPrompt === 'string'
          ? agentConfig.systemPrompt
          : parentGeneration.systemPrompt
    })

    return {
      agentId: descriptor.id,
      targetAgentId,
      providerId: input.providerId,
      modelId: input.modelId,
      permissionMode: resolveCrossAgentPermissionMode(
        input.permissionMode,
        agentConfig?.permissionMode
      ),
      generationSettings,
      disabledAgentTools: composeSubagentAuthority(
        { disabledAgentTools: input.disabledAgentTools },
        { disabledAgentTools: agentConfig?.disabledAgentTools }
      ).disabledAgentTools,
      activeSkills: normalizeActiveSkills(input.activeSkills)
    }
  }

  /**
   * 解析迁移目标：目标必须是 Office Agent（历史不能迁给 ACP——外部 agent
   * 进程不认这些记录），且其默认模型必须存在；工作目录沿用会话现有的，
   * 没有才落目标 Agent 的默认。
   */
  async resolveTransferTarget(
    targetAgentId: string,
    currentProjectDir: string | null
  ): Promise<ResolvedTransferTarget> {
    let descriptor: { id: string; kind: 'deepchat' | 'acp' }
    try {
      descriptor = this.catalog.resolveAgent(resolveAcpAgentAlias(targetAgentId.trim()))
    } catch {
      throw new Error(`Target agent not found: ${targetAgentId}`)
    }
    if (descriptor.kind === 'acp') {
      throw new Error('Conversation history cannot be moved to ACP agents.')
    }

    const agentConfig = await this.config.resolveDeepChatAgentConfig(descriptor.id)
    const defaultModel = this.config.getDefaultModel()
    const providerId =
      agentConfig?.defaultModelPreset?.providerId?.trim() || defaultModel?.providerId?.trim() || ''
    const modelId =
      agentConfig?.defaultModelPreset?.modelId?.trim() || defaultModel?.modelId?.trim() || ''
    if (!providerId || !modelId) {
      throw new Error('Target Office Agent does not have a default model.')
    }
    if (providerId.toLowerCase() === 'acp') {
      throw new Error('Conversation history cannot be moved to ACP agents.')
    }

    return {
      agentId: descriptor.id,
      providerId,
      modelId,
      projectDir:
        currentProjectDir?.trim() ||
        agentConfig?.defaultProjectPath?.trim() ||
        this.config.getDefaultProjectPath()?.trim() ||
        null,
      permissionMode: resolveAssignmentPermissionMode(agentConfig?.permissionMode),
      generationSettings: this.mergeDefaultGenerationSettings(agentConfig),
      disabledAgentTools: normalizeDisabledAgentTools(agentConfig?.disabledAgentTools)
    }
  }

  /** ACP 会话必须先选工作目录才能发消息（外部 agent 以目录为运行根）。 */
  assertAcpSessionHasWorkdir(providerId: string, projectDir: string | null): void {
    if (providerId === 'acp' && !projectDir?.trim()) {
      throw new Error('ACP agent requires selecting a workdir before sending messages.')
    }
  }

  /** 目录解析：显式 null 可保留（新建空草稿场景），否则逐级回退默认值。 */
  private resolveProjectDir(
    input: CreateAssignmentInput,
    agentDefaultProjectDir: string | null | undefined
  ): string | null {
    if (input.preserveExplicitNullProjectDir && input.projectDir === null) return null
    return (
      input.projectDir?.trim() ||
      agentDefaultProjectDir?.trim() ||
      this.config.getDefaultProjectPath()?.trim() ||
      null
    )
  }

  private mergeDefaultGenerationSettings(
    config: DeepChatAgentConfig | null,
    overrides?: Partial<SessionGenerationSettings>
  ): Partial<SessionGenerationSettings> | undefined {
    const defaults: Partial<SessionGenerationSettings> = {}
    if (typeof config?.systemPrompt === 'string') defaults.systemPrompt = config.systemPrompt
    const merged = { ...defaults, ...overrides }
    return Object.keys(merged).length > 0 ? merged : undefined
  }
}
