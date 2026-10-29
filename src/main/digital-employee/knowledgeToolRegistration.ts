import type { MCPServerConfig } from '@shared/types/mcp'
import { deriveLocalKnowledgeBaseId } from './knowledgeProvisioning'
import { isEmployeeKnowledgeServerName, knowledgeServerNameForEmployee } from './employeeScope'

/**
 * 每员工本地知识检索 server 的注册器。
 *
 * 与 `mcpRegistration.ts` 的远端工具注册器同一套幂等纪律（同一员工反复问询、
 * 重写配置会触发全量 MCP 重连），但有三个本质差异：
 *
 * 1. 不需要连接凭证——server 是 in-memory 的，检索的是本地向量库。
 * 2. 员工绑定关系（本地库 id）放在 config 的 `env` 里，`mcpClient` 会把它
 *    原样转给 in-memory 工厂。
 * 3. 员工没配知识库是常态而非故障：此时清掉旧注册（模型不能再查已下线的
 *    知识），返回 `NO_KNOWLEDGE`，不算失败链路。
 */

export interface KnowledgeToolRegistrarDeps {
  /** MCP 配置存储：注册即写入一条 inmemory 类型的 server 记录。 */
  mcpSettings: {
    getMcpServers: () => Promise<Record<string, MCPServerConfig>>
    addMcpServer: (name: string, config: MCPServerConfig) => Promise<boolean>
    updateMcpServer: (name: string, patch: Partial<MCPServerConfig>) => Promise<void>
    removeMcpServer: (name: string) => Promise<void>
  }
  /** server 生命周期管理：写入配置后需显式启动，检索工具才出现在模型列表里。 */
  serverManager: {
    startServer: (name: string) => Promise<unknown>
    stopServer: (name: string) => Promise<void>
  }
}

/**
 * 未注册成功时的归类。区分这三个值的用处：
 * NO_KNOWLEDGE 是常态（没配知识库），不应触发用户可见的错误提示；
 * 后两者才是真故障，需要走 provision 的失败链路记录。
 */
export type KnowledgeToolRegisterReason = 'NO_KNOWLEDGE' | 'REGISTER_FAILED' | 'START_FAILED'

export interface KnowledgeToolRegisterResult {
  /** 配置层面是否已写入（NO_KNOWLEDGE 与 REGISTER_FAILED 时为 false）。 */
  registered: boolean
  /** server 是否实际启动。注册成功但启动失败时为 registered=true、started=false。 */
  started: boolean
  reason?: KnowledgeToolRegisterReason
}

export interface KnowledgeToolRegistrar {
  /**
   * 为员工注册（或对齐）本地知识检索工具。
   * 幂等：重复调用只在目标不一致时才改写配置，避免触发全量 MCP 重连。
   */
  registerForEmployee(input: {
    employeeId: string
    /** 员工绑定的知识库 id 列表；全部为空时视为「无知识库」并拆除旧注册。 */
    knowledgeBaseIds: readonly string[]
  }): Promise<KnowledgeToolRegisterResult>
  /** 拆除该员工的知识检索 server；本就不存在时静默返回。 */
  unregister(employeeId: string): Promise<void>
}

/**
 * 构造该员工知识 server 的 MCP 配置。
 * 本地库 id 通过 `env` 传递——`mcpClient` 会把它原样转给 inmemory 工厂，
 * 用于构造 `DigitalEmployeeKnowledgeServer` 实例。
 */
const buildConfig = (employeeId: string): MCPServerConfig => ({
  command: '',
  args: [],
  env: { localKnowledgeBaseId: deriveLocalKnowledgeBaseId(employeeId) },
  descriptions: '数字员工本地知识检索（本地向量库，无外部依赖）',
  icons: '📚',
  enabled: true,
  type: 'inmemory'
})

/** Fields that decide whether an existing registration is still correct. */
const sameTarget = (current: MCPServerConfig | undefined, next: MCPServerConfig): boolean =>
  Boolean(
    current &&
    current.type === next.type &&
    current.enabled === next.enabled &&
    current.env?.localKnowledgeBaseId === next.env?.localKnowledgeBaseId
  )

export function createKnowledgeToolRegistrar(
  deps: KnowledgeToolRegistrarDeps
): KnowledgeToolRegistrar {
  const stopQuietly = async (name: string): Promise<void> => {
    try {
      await deps.serverManager.stopServer(name)
    } catch {
      // 与远端注册器同一容错：停一个从未启动的 server 不值得上报。
    }
  }

  const unregister = async (employeeId: string): Promise<void> => {
    const name = knowledgeServerNameForEmployee(employeeId)
    const servers = await deps.mcpSettings.getMcpServers()
    // 配置里没有则什么都不动，避免对不存在的 server 发停启指令。
    if (!servers[name]) return
    await stopQuietly(name)
    await deps.mcpSettings.removeMcpServer(name)
  }

  return {
    async registerForEmployee({ employeeId, knowledgeBaseIds }) {
      const name = knowledgeServerNameForEmployee(employeeId)

      if (!knowledgeBaseIds.some((id) => id !== '')) {
        // 没绑知识库是常态：先清掉旧注册，模型才不会对着已下线的知识发起查询。
        await unregister(employeeId)
        return { registered: false, started: false, reason: 'NO_KNOWLEDGE' }
      }

      const next = buildConfig(employeeId)
      const servers = await deps.mcpSettings.getMcpServers()
      const current = servers[name]

      try {
        // 三分支保证幂等：新建、目标漂移时改写、其余情况零写入——
        // 无谓的配置重写会触发全量 MCP 重连。
        if (!current) {
          await deps.mcpSettings.addMcpServer(name, next)
        } else if (!sameTarget(current, next)) {
          await deps.mcpSettings.updateMcpServer(name, next)
        }
      } catch {
        return { registered: false, started: false, reason: 'REGISTER_FAILED' }
      }

      try {
        await deps.serverManager.startServer(name)
        return { registered: true, started: true }
      } catch {
        // 起不来只代表这轮没有检索工具，注册保留，下轮 provision 会再试。
        return { registered: true, started: false, reason: 'START_FAILED' }
      }
    },

    unregister
  }
}

/** Names this feature owns, so teardown can clean up without touching user servers. */
export const listEmployeeKnowledgeServers = (servers: Record<string, MCPServerConfig>): string[] =>
  Object.keys(servers).filter(isEmployeeKnowledgeServerName)
