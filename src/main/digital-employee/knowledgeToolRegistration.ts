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
  mcpSettings: {
    getMcpServers: () => Promise<Record<string, MCPServerConfig>>
    addMcpServer: (name: string, config: MCPServerConfig) => Promise<boolean>
    updateMcpServer: (name: string, patch: Partial<MCPServerConfig>) => Promise<void>
    removeMcpServer: (name: string) => Promise<void>
  }
  serverManager: {
    startServer: (name: string) => Promise<unknown>
    stopServer: (name: string) => Promise<void>
  }
}

export type KnowledgeToolRegisterReason = 'NO_KNOWLEDGE' | 'REGISTER_FAILED' | 'START_FAILED'

export interface KnowledgeToolRegisterResult {
  registered: boolean
  started: boolean
  reason?: KnowledgeToolRegisterReason
}

export interface KnowledgeToolRegistrar {
  registerForEmployee(input: {
    employeeId: string
    knowledgeBaseIds: readonly string[]
  }): Promise<KnowledgeToolRegisterResult>
  unregister(employeeId: string): Promise<void>
}

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
    if (!servers[name]) return
    await stopQuietly(name)
    await deps.mcpSettings.removeMcpServer(name)
  }

  return {
    async registerForEmployee({ employeeId, knowledgeBaseIds }) {
      const name = knowledgeServerNameForEmployee(employeeId)

      if (!knowledgeBaseIds.some((id) => id !== '')) {
        await unregister(employeeId)
        return { registered: false, started: false, reason: 'NO_KNOWLEDGE' }
      }

      const next = buildConfig(employeeId)
      const servers = await deps.mcpSettings.getMcpServers()
      const current = servers[name]

      try {
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
