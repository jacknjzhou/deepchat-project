import type { KnowledgeSyncInput, KnowledgeSyncResult } from './knowledgeSync'

/**
 * 知识同步调度器。
 *
 * 两条触发路径，各有明确理由：
 * - **定时预热**：后台每 `TICK_MS` 检查一次，到点才真正跑，避免冷启动即同步。
 * - **首轮对话触发**：用户第一次跟这个员工说话时立刻跑一轮，否则要等一小时
 *   才能检索到本该立刻可用的知识。
 *
 * 与 `AutoWatchScheduler` 的关键差别是「并发闸门」：知识同步会写同一张状态表
 * 并重复下载，两轮并行不只是浪费流量，还会互相覆盖 hash 记账。
 */

export const TICK_MS = 60_000
export const DEFAULT_SYNC_INTERVAL_SECONDS = 3600

export interface KnowledgeSyncEmployee {
  id: string
  name: string
  knowledgeBaseIds: string[]
  /**
   * 员工 SOP 必须随配置一起带进来：syncEmployee 拿它做增量比对。
   * 不带的话 syncSopsIfNeeded 会把仍在使用的 SOP 记账当成「已移除」，
   * 定时轮每跑一次就删一遍 SOP——这是数据删除，不是可忽略的优化项。
   */
  sops?: KnowledgeSyncInput['sops']
}

export interface KnowledgeSyncSchedulerDeps {
  now: () => number
  /** 连接配置是否齐备；不齐备时整轮跳过。 */
  isEnabled: () => boolean
  /**
   * 员工列表。必须是异步且可失败的：来源是远端接口，而降级到 mock 时的
   * 假员工 id 一旦被拿去同步，会在服务端刷出一串 404。
   */
  listEmployees: () => Promise<KnowledgeSyncEmployee[]>
  syncEmployee: (input: KnowledgeSyncInput) => Promise<KnowledgeSyncResult>
  /** 读配置的同步间隔（秒）；非法值由实现侧兜底成 `DEFAULT_SYNC_INTERVAL_SECONDS`。 */
  readIntervalSeconds: () => number
  /** 注入定时器与清理函数，便于测试用假时钟推进。 */
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}

export interface KnowledgeSyncScheduler {
  start(): void
  stop(): void
  /** 立即跑一轮（首轮对话触发）。与定时轮共用同一闸门。 */
  runOnce(): Promise<void>
  isRunning(): boolean
}

export function createKnowledgeSyncScheduler(
  deps: KnowledgeSyncSchedulerDeps
): KnowledgeSyncScheduler {
  const scheduleInterval = deps.setInterval ?? setInterval
  const clearSchedule = deps.clearInterval ?? clearInterval

  let timer: ReturnType<typeof setInterval> | null = null
  let nextRunAt = deps.now() + resolveIntervalMs(deps.readIntervalSeconds())
  let inFlight: Promise<void> | null = null

  function resolveIntervalMs(seconds: number): number {
    // 0 / 负数 / NaN 一律回落到默认值：间隔写坏不该变成「每 tick 都全量同步」。
    if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_SYNC_INTERVAL_SECONDS * 1000
    return seconds * 1000
  }

  const runRound = async (): Promise<void> => {
    if (!deps.isEnabled()) return

    let employees: KnowledgeSyncEmployee[]
    try {
      employees = await deps.listEmployees()
    } catch {
      // 员工列表拉不到（服务端故障、鉴权过期）时整轮放弃：
      // 没有员工就无从同步，且下一轮自然会重试。
      return
    }

    for (const employee of employees) {
      // 没配知识库的员工占多数：跳过而不是让同步层去空跑。
      if (employee.knowledgeBaseIds.length === 0) continue
      try {
        await deps.syncEmployee({
          employeeId: employee.id,
          employeeName: employee.name,
          knowledgeBaseIds: employee.knowledgeBaseIds,
          sops: employee.sops
        })
      } catch {
        // 单员工失败必须隔离：否则一个坏员工会让整个租户的同步永久停摆。
      }
    }
  }

  const runGuarded = (): Promise<void> => {
    // 闸门放在最外层：定时轮与首轮触发共用，避免两份循环同时写状态表。
    if (inFlight) return inFlight
    const round = runRound().finally(() => {
      inFlight = null
    })
    inFlight = round
    return round
  }

  return {
    start() {
      if (timer) return
      // 启动时就把下一次算好，确保首轮不会在 tick 里立刻触发。
      nextRunAt = deps.now() + resolveIntervalMs(deps.readIntervalSeconds())
      timer = scheduleInterval(() => {
        if (deps.now() < nextRunAt) return
        nextRunAt = deps.now() + resolveIntervalMs(deps.readIntervalSeconds())
        void runGuarded()
      }, TICK_MS)
    },
    stop() {
      if (timer) clearSchedule(timer)
      timer = null
    },
    runOnce() {
      return runGuarded()
    },
    isRunning() {
      return inFlight !== null
    }
  }
}
