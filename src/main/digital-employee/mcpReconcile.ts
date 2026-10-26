import type { MCPServerConfig } from '@shared/types/mcp'
import { listEmployeeMcpServers } from './mcpRegistration'
import { knowledgeServerNameForEmployee } from './employeeScope'

/**
 * 清掉已经不该存在的 `staffdeck-*` / `de-kb-*` MCP 注册。
 *
 * 注册只在「用户点开始对话」时发生，注销却依赖同一条路径再走一次。员工被删除、
 * 被改成 remote、或管理员停用它之后，用户不会再点它——于是那条注册永久留在
 * MCP 配置里，该员工的 `staffdeck_*` 工具出现在**所有**会话的工具列表中。这是
 * 数据污染而不是显示问题：模型会看到不属于当前会话的工具，并且能调用它。
 *
 * 三条判定约束：
 *
 * - **只碰自己的命名空间**。前缀是 `staffdeck-` / `de-kb-`，用户自建的 server
 *   一个都不动。
 * - **拿不到可信列表就不动**。provider 降级到 mock 时列表里是假员工 id，按它清理
 *   会把所有真实注册删光。宁可留一批孤儿，也不能删错。
 * - **hybrid 要留**。它可能还在本地执行，注册仍然有用。
 */

export interface StaffdeckMcpReconcileDeps {
  mcpSettings: {
    getMcpServers: () => Promise<Record<string, MCPServerConfig>>
    removeMcpServer: (name: string) => Promise<void>
  }
  /** 停掉进程内的连接；配置删了而连接悬着会让工具列表继续出现在缓存里。 */
  stopServer: (name: string) => Promise<void>
  mcpServerNameFor: (employeeId: string) => string
  /**
   * 当前**可信**的本地执行员工名单。
   *
   * 返回 `null` 表示拿不到可信数据（provider 降级、拉取失败）。调用方据此跳过
   * 整轮清理，而不是把空数组当成「一个员工都没有」。
   */
  listLocalEmployeeIds: () => Promise<readonly string[] | null>
}

export interface StaffdeckMcpReconcileResult {
  /** 被清掉的 MCP server 名。 */
  removed: string[]
  /** `true` 表示本轮因拿不到可信名单而整体跳过。 */
  skipped: boolean
}

export type StaffdeckMcpReconciler = () => Promise<StaffdeckMcpReconcileResult>

/**
 * 从 server 名反查员工 id 是不可能的：名字里存的是规范化片段加摘要，原 id 丢了。
 *
 * 所以清理不能走 `unregister(employeeId)`，只能按名字摘配置。这不是偷懒——
 * 是本功能的名字设计决定了「按名字删」才是唯一可行路径。反向匹配方向也换了：
 * 先算出**在册员工**应该有的名字集合，不在集合里的就是孤儿。
 */
export function createStaffdeckMcpReconciler(
  deps: StaffdeckMcpReconcileDeps
): StaffdeckMcpReconciler {
  return async () => {
    const employeeIds = await deps.listLocalEmployeeIds().catch(() => null)
    if (employeeIds === null) {
      // 拿不到可信名单：不动任何注册。删错一个，用户得重新授权一遍。
      return { removed: [], skipped: true }
    }

    const servers = await deps.mcpSettings.getMcpServers()
    const registered = listEmployeeMcpServers(servers)
    if (registered.length === 0) return { removed: [], skipped: false }

    // 在册员工保留两种注册：远端工具（staffdeck-）与本地知识检索（de-kb-）。
    // 员工只是清空了知识库时，provision 自己会 unregister 那一条；
    // 对账只负责员工整个消失的情况。
    const keep = new Set<string>()
    for (const id of employeeIds) {
      keep.add(deps.mcpServerNameFor(id))
      keep.add(knowledgeServerNameForEmployee(id))
    }
    const stale = registered.filter((name) => !keep.has(name))

    const removed: string[] = []
    for (const name of stale) {
      // 先停再删：只删配置会让进程里的连接悬着，工具列表继续出现在缓存中。
      // 停止失败不阻断删除——留着一个指向不存在的员工的连接更糟。
      await deps.stopServer(name).catch(() => undefined)
      await deps.mcpSettings.removeMcpServer(name).catch(() => undefined)
      removed.push(name)
    }

    return { removed, skipped: false }
  }
}
