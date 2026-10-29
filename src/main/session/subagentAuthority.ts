import { normalizeDisabledAgentTools } from '@/agent/shared/agentSessionNormalization'

export interface SubagentAuthoritySource {
  disabledAgentTools?: readonly string[] | null
  enabledMcpServerIds?: readonly string[] | null
}

export interface ComposedSubagentAuthority {
  disabledAgentTools: string[]
  enabledMcpServerIds: string[] | undefined
}

/**
 * 合并多方授予的子代理权限面（父级、目标 Agent 策略等），遵循「只收不扩」：
 * - 禁用工具取并集——任何一方禁用的工具子代理都不可用；
 * - MCP 白名单取交集——必须每一方都允许的服务器才保留；全部未指定时返回
 *   undefined 表示「不设限」，而不是空集（空集等于全部禁用）。
 * 两侧语义故意不同：禁用清单天然是收紧方向，白名单天然是放宽方向。
 */
export function composeSubagentAuthority(
  ...sources: readonly SubagentAuthoritySource[]
): ComposedSubagentAuthority {
  return {
    disabledAgentTools: normalizeDisabledAgentTools(
      sources.flatMap((source) => source.disabledAgentTools ?? [])
    ),
    enabledMcpServerIds: intersectMcpAllowLists(sources.map((source) => source.enabledMcpServerIds))
  }
}

/** 多个 MCP 白名单求交集；null/undefined 的来源不参与收紧，全部缺失才不设限。 */
function intersectMcpAllowLists(
  allowLists: ReadonlyArray<readonly string[] | null | undefined>
): string[] | undefined {
  let intersection: Set<string> | null = null

  for (const allowList of allowLists) {
    if (allowList === null || allowList === undefined) continue
    const normalized = new Set(
      allowList
        .filter((serverId): serverId is string => typeof serverId === 'string')
        .map((serverId) => serverId.trim())
        .filter(Boolean)
    )
    if (intersection === null) {
      intersection = normalized
      continue
    }
    const current = intersection as Set<string>
    intersection = new Set([...current].filter((serverId) => normalized.has(serverId)))
  }

  return intersection === null
    ? undefined
    : [...intersection].sort((left, right) => left.localeCompare(right))
}
