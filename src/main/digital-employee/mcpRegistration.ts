import type { MCPServerConfig } from '@shared/types/mcp'
import {
  isEmployeeKnowledgeServerName,
  isEmployeeMcpServerName,
  mcpServerNameForEmployee
} from './employeeScope'

/**
 * Registers one employee's StaffDeck tools as a remote MCP server.
 *
 * Two things make this less trivial than it looks:
 *
 * 1. The endpoint has to carry the employee id in the path. A standard MCP
 *    client sends `tools/list` with `{}` and cannot inject `_meta`, and deepchat's
 *    `MCPServerConfig` only supports static headers, so the server has no other
 *    way to tell which employee is asking.
 * 2. Registration must be idempotent. Every conversation asks for it, and
 *    rewriting settings each time triggers a full MCP reconnect — the tool list
 *    would flicker mid-conversation.
 *
 * Only registration lives here. The per-session tool allowlist is the store's
 * job: one is a configuration-time decision, the other a per-conversation one.
 */

export interface StaffdeckConnection {
  baseUrl: string
  apiKey: string
}

export interface StaffdeckMcpRegistrarDeps {
  getConnection: () => StaffdeckConnection | null
  mcpSettings: {
    getMcpServers: () => Promise<Record<string, MCPServerConfig>>
    addMcpServer: (name: string, config: MCPServerConfig) => Promise<boolean>
    removeMcpServer: (name: string) => Promise<void>
    updateMcpServer: (name: string, patch: Partial<MCPServerConfig>) => Promise<void>
  }
  serverManager: {
    startServer: (name: string) => Promise<unknown>
    stopServer: (name: string) => Promise<void>
  }
}

export type StaffdeckMcpRegisterReason =
  | 'NOT_CONFIGURED'
  | 'NO_TOOLS'
  | 'START_FAILED'
  | 'REGISTER_FAILED'

export interface StaffdeckMcpRegisterResult {
  registered: boolean
  started: boolean
  reason?: StaffdeckMcpRegisterReason
}

export interface StaffdeckMcpRegistrar {
  registerForEmployee(input: {
    employeeId: string
    tools: readonly string[]
    /** Card label for the MCP center; registration works without it. */
    employeeName?: string
  }): Promise<StaffdeckMcpRegisterResult>
  unregister(employeeId: string): Promise<void>
}

/** Tools the server exposes are namespaced; anything else belongs to a local server. */
const STAFFDECK_TOOL_PREFIX = 'staffdeck_'

const hasStaffdeckTools = (tools: readonly string[]): boolean =>
  tools.some((tool) => tool.startsWith(STAFFDECK_TOOL_PREFIX))

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '')

const buildConfig = (
  connection: StaffdeckConnection,
  employeeId: string,
  employeeName?: string
): MCPServerConfig => ({
  // The remaining fields exist because `MCPServerConfig` models stdio servers
  // too; `normalizeServerConfig` fills them for http ones.
  command: '',
  args: [],
  env: {},
  // MCP 中心会把这行当卡片描述展示：设置页里的一串 `staffdeck-agent_<id>-<摘要>`
  // 没法认，写上员工名它才是一张可读的卡。
  descriptions: employeeName
    ? `StaffDeck 远端工具 · ${employeeName}（凭证由服务端持有）`
    : 'StaffDeck 远端工具（凭证由服务端持有）',
  icons: '',
  enabled: true,
  type: 'http',
  // 设置里存的是主机根（占位符 `https://staffdeck.example.com`），`/api/v1`
  // 由客户端自己拼——与本目录其余 client 同一约定。MCP 客户端直接连这个 URL，
  // 少了这段每次 initialize 都是 404。
  baseUrl:
    `${normalizeBaseUrl(connection.baseUrl)}/api/v1/mcp/agents/` +
    `${encodeURIComponent(employeeId)}`,
  customHeaders: { Authorization: `Bearer ${connection.apiKey}` }
})

/**
 * Fields that decide whether an existing registration is still correct.
 *
 * `enabled` deliberately not compared: this entry is system-owned configuration
 * but the toggle in the MCP center is the user's. Rewriting it would silently
 * re-enable a server the user just turned off, and `updateMcpServer` below
 * carries the current value forward for the same reason.
 */
const sameTarget = (current: MCPServerConfig | undefined, next: MCPServerConfig): boolean =>
  Boolean(
    current &&
    current.type === next.type &&
    current.baseUrl === next.baseUrl &&
    current.descriptions === next.descriptions &&
    current.customHeaders?.Authorization === next.customHeaders?.Authorization
  )

export function createStaffdeckMcpRegistrar(
  deps: StaffdeckMcpRegistrarDeps
): StaffdeckMcpRegistrar {
  const stopQuietly = async (name: string): Promise<void> => {
    try {
      await deps.serverManager.stopServer(name)
    } catch {
      // Stopping a server that never started is not an error worth surfacing,
      // and a failed stop must not block removing the stale registration.
    }
  }

  const unregister = async (employeeId: string): Promise<void> => {
    const name = mcpServerNameForEmployee(employeeId)
    const servers = await deps.mcpSettings.getMcpServers()
    if (!servers[name]) return
    await stopQuietly(name)
    await deps.mcpSettings.removeMcpServer(name)
  }

  const startQuietly = async (name: string): Promise<boolean> => {
    try {
      await deps.serverManager.startServer(name)
      return true
    } catch {
      // Unreachable server = no remote tools. The conversation itself still works.
      return false
    }
  }

  return {
    async registerForEmployee({ employeeId, tools, employeeName }) {
      const name = mcpServerNameForEmployee(employeeId)
      const connection = deps.getConnection()

      // Without credentials there is nothing to authenticate with; keeping the
      // old registration would keep sending a dead key to the server.
      if (!connection) {
        await unregister(employeeId)
        return { registered: false, started: false, reason: 'NOT_CONFIGURED' }
      }

      if (!hasStaffdeckTools(tools)) {
        await unregister(employeeId)
        return { registered: false, started: false, reason: 'NO_TOOLS' }
      }

      const next = buildConfig(connection, employeeId, employeeName)
      const servers = await deps.mcpSettings.getMcpServers()
      const current = servers[name]

      try {
        if (!current) {
          await deps.mcpSettings.addMcpServer(name, next)
        } else if (!sameTarget(current, next)) {
          // The toggle belongs to the user: a target change (rotated key, moved
          // endpoint, renamed employee) must not re-enable a disabled server.
          await deps.mcpSettings.updateMcpServer(name, {
            ...next,
            enabled: current.enabled ?? true
          })
        }
      } catch {
        return { registered: false, started: false, reason: 'REGISTER_FAILED' }
      }

      const started = await startQuietly(name)
      return started
        ? { registered: true, started: true }
        : { registered: true, started: false, reason: 'START_FAILED' }
    },

    unregister
  }
}

/** Names this feature owns, so teardown can clean up without touching user servers. */
export const listEmployeeMcpServers = (servers: Record<string, MCPServerConfig>): string[] =>
  Object.keys(servers).filter(
    (name) => isEmployeeMcpServerName(name) || isEmployeeKnowledgeServerName(name)
  )
