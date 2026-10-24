import { digitalEmployeeProvisionRoute } from '@shared/contracts/routes'
import { createRouteMap, type DeepchatRouteMap } from '@/routes/routeRegistry'
import type { EmployeeProvisioner } from './provisioning'

/**
 * Preparation route: registers the employee's remote tools and installs its
 * skills before the renderer builds a conversation.
 *
 * The renderer calls this and then reads the MCP tool list; the order matters,
 * because the tool allowlist is the complement of what that list returns. If
 * registration happened in the background, the first conversation of a session
 * would run without any `staffdeck_*` tool and there is no retry afterwards.
 *
 * Reporting is flattened on purpose: the renderer needs three booleans and a
 * count, not the registrar's internal reason codes.
 */

export interface DigitalEmployeeProvisioningRoutesDeps {
  provisioner: EmployeeProvisioner
  /**
   * 首轮对话触发一次知识同步（D3 决策 3）。
   *
   * 放在这里而不是对话入口，是因为准备工作本来就在「用户点开始对话」时发生，
   * 且 renderer 会等它返回再建会话——知识赶在第一轮之前落盘，检索才有东西可查。
   * 没有它就只能等定时轮，最坏等一个完整间隔（默认 1h）。
   *
   * 必须 fire-and-forget：同步要下载几十个概念并建索引，等它会把「开始对话」
   * 卡住几十秒。而同步失败也只意味着这轮检索不到知识，不该挡住对话。
   *
   * 缺省表示不启用（无连接、或该员工没有知识库）。
   */
  triggerKnowledgeSync?: (employeeId: string) => void
}

export function createDigitalEmployeeProvisioningRoutes(
  deps: DigitalEmployeeProvisioningRoutesDeps
): DeepchatRouteMap {
  return createRouteMap([
    [
      digitalEmployeeProvisionRoute.name,
      async (rawInput) => {
        const input = digitalEmployeeProvisionRoute.input.parse(rawInput)
        // `provisionById` never rejects; the route is a thin projection.
        const outcome = await deps.provisioner.provisionById(input.employeeId)

        // 同一个判断里排除 remote：它的知识在服务端，本地同步纯属浪费带宽。
        if (outcome.skipped === null && deps.triggerKnowledgeSync) {
          deps.triggerKnowledgeSync(input.employeeId)
        }

        return digitalEmployeeProvisionRoute.output.parse({
          employeeId: outcome.employeeId,
          skipped: outcome.skipped,
          toolsReady: outcome.mcp?.registered === true && outcome.mcp.started === true,
          installedSkills: outcome.skills?.installed ?? 0,
          failedSkills: outcome.skills?.failedSkills ?? [],
          skillNames: outcome.skillNames,
          failures: outcome.failures
        })
      }
    ]
  ])
}
