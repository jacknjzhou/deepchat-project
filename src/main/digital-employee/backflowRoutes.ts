import {
  digitalEmployeeBackflowQueueStatusRoute,
  digitalEmployeeBackflowRoute
} from '@shared/contracts/routes'
import type { DigitalEmployeeBackflowResult } from '@shared/contracts/routes'
import { createRouteMap } from '@/routes/routeRegistry'
import type { BackflowEvent, StaffdeckBackflow } from './backflow'
import type { BackflowQueue } from './data/tables/backflowQueue'
import { isRetryableBackflowReason, type BackflowRetryWorker } from './backflowRetry'

/**
 * 回流上报 route。
 *
 * renderer 掌握本轮产生的本地事件，主进程掌握凭证与开关，所以事件由 renderer
 * 送上来、由主进程发出去。放在独立 route 而不是塞进 `provisioning`，是因为
 * 两者的时机与失败语义相反：准备发生在对话**开始前**且必须在读工具列表前完成；
 * 上报发生在**结束后**且永远不能影响对话。
 *
 * 失败不再是一种「算了」的结局：可重试的失败会落进本地队列，由
 * `backflowRetry` 按指数退避补发。这是 `ok` 与 `reason` 语义分离的原因——
 * `ok: true` 只表示「主进程接手了」，`reason` 才是「到底送没送到」。
 */

export interface DigitalEmployeeBackflowRoutesDeps {
  backflow: StaffdeckBackflow
  /** 落盘队列。省略则不落盘（仅测试用；生产必须提供）。 */
  queue?: BackflowQueue
  /** 入队后踢一次补发，让刚断一秒的对话不必等满一个 tick。 */
  retryWorker?: Pick<BackflowRetryWorker, 'kick'>
  now?: () => number
  log?: (message: string, error?: unknown) => void
}

/**
 * 组装回流上报与队列状态两条路由。
 * 上报路由的主逻辑在 `flush`：直发 → 失败部分入队 → 踢补发。
 */
export function createDigitalEmployeeBackflowRoutes(deps: DigitalEmployeeBackflowRoutesDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((message: string) => console.warn(message))

  /** 队列未提供时按 0 处理，让无队列的测试环境拿到合法的 pending 值。 */
  const pendingCount = (): number => deps.queue?.stats(now()).pending ?? 0

  /**
   * 上报主流程。返回值语义：
   * - 直发成功或失败事件已全部落队：`ok: true`（renderer 游标可前进）；
   * - 入队失败或不可重试的失败：`ok: false`，事件由 renderer 保留待重报。
   */
  const flush = async (raw: unknown): Promise<DigitalEmployeeBackflowResult> => {
    const input = digitalEmployeeBackflowRoute.input.parse(raw)
    const result = await deps.backflow.flush({
      employeeId: input.employeeId,
      sessionId: input.sessionId,
      ...(input.title ? { title: input.title } : {}),
      events: input.events as readonly BackflowEvent[]
    })

    const failed = result.delivered > 0 ? input.events.slice(result.delivered) : input.events

    // 全部送达，或压根不该重试（关了开关 / 没配连接 / 服务端明确拒收）：不落盘。
    // 最后一种值得单说——`flush` 里「失败即停」的前提下，它后面那批事件其实还有
    // 机会在下一轮成功，但把被拒的事件放进队列只会无限重试同一个失败。
    if (result.ok || !deps.queue || !isRetryableBackflowReason(result.reason)) {
      return {
        ok: result.ok,
        reason: result.reason,
        delivered: result.delivered,
        queued: 0,
        pending: pendingCount()
      }
    }

    let queued = 0
    try {
      queued = deps.queue.enqueue({
        employeeId: input.employeeId,
        sessionId: input.sessionId,
        ...(input.title ? { title: input.title } : {}),
        events: failed as readonly BackflowEvent[],
        now: now()
      })
    } catch (error) {
      // 落盘失败也不能让调用方看到异常：这条路在发消息的返回路径上。
      log('[digitalEmployee] backflow queue persist failed', error)
      return {
        ok: false,
        reason: result.reason,
        delivered: result.delivered,
        queued: 0,
        pending: pendingCount()
      }
    }

    if (queued > 0) deps.retryWorker?.kick()

    return {
      // 已落盘就是「主进程接手了」，renderer 的游标可以安全前进。
      ok: true,
      reason: result.reason,
      delivered: result.delivered,
      queued,
      pending: pendingCount()
    }
  }

  return createRouteMap([
    [digitalEmployeeBackflowRoute.name, flush],
    [
      digitalEmployeeBackflowQueueStatusRoute.name,
      // 队列观测路由：无队列时返回全空形状，前端无需区分两种部署形态。
      async () => {
        const stats = deps.queue?.stats(now()) ?? {
          pending: 0,
          due: 0,
          oldestCreatedAt: null
        }
        return digitalEmployeeBackflowQueueStatusRoute.output.parse(stats)
      }
    ]
  ])
}
