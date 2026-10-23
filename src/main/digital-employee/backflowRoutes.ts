import { digitalEmployeeBackflowRoute } from '@shared/contracts/routes'
import type { DigitalEmployeeBackflowResult } from '@shared/contracts/routes'
import { createRouteMap } from '@/routes/routeRegistry'
import type { BackflowEvent, StaffdeckBackflow } from './backflow'

/**
 * 回流上报 route。
 *
 * renderer 掌握本轮产生的本地事件，主进程掌握凭证与开关，所以事件由 renderer
 * 送上来、由主进程发出去。放在独立 route 而不是塞进 `provisioning`，是因为
 * 两者的时机与失败语义相反：准备发生在对话**开始前**且必须在读工具列表前完成；
 * 上报发生在**结束后**且永远不能影响对话。
 */

export interface DigitalEmployeeBackflowRoutesDeps {
  backflow: StaffdeckBackflow
}

export function createDigitalEmployeeBackflowRoutes(
  deps: DigitalEmployeeBackflowRoutesDeps
) {
  const flush = async (raw: unknown): Promise<DigitalEmployeeBackflowResult> => {
    const input = digitalEmployeeBackflowRoute.input.parse(raw)
    const result = await deps.backflow.flush({
      employeeId: input.employeeId,
      sessionId: input.sessionId,
      events: input.events as readonly BackflowEvent[]
    })
    return { ok: result.ok, reason: result.reason, delivered: result.delivered }
  }

  return createRouteMap([[digitalEmployeeBackflowRoute.name, flush]])
}
