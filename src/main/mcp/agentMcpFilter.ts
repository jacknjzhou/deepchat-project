import type { AgentSettingsPort } from '@/agent/settings'
import type { MCPToolDefinition } from '@shared/types/mcp'

/**
 * 按 agent 的 MCP 白名单过滤工具定义。
 *
 * 语义：未配置任何选择的 agent 得到空列表（白名单制，不是黑名单），
 * 不存在「默认全部开放」；过滤以 server 名为粒度，agent 配置无法选择
 * 单个工具。这是 Office Agent 侧的过滤；ACP agent 的同名控制在
 * ToolManager.callTool 的派发闸门中二次执行，两层独立生效。
 */
export async function getAgentFilteredTools(
  agentId: string,
  isBuiltin: boolean | undefined,
  allTools: MCPToolDefinition[],
  agentSettings: Pick<AgentSettingsPort, 'getAgentMcpSelections'>
): Promise<MCPToolDefinition[]> {
  if (!agentId) return []

  const selections = await agentSettings.getAgentMcpSelections(agentId, isBuiltin)
  if (!selections?.length) return []

  const selectionSet = new Set(selections)
  return allTools.filter((tool) => selectionSet.has(tool.server?.name))
}
