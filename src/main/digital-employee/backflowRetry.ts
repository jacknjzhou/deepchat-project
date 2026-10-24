import type { BackflowReason, StaffdeckBackflow } from './backflow'
import {
  backflowRetryDelayMs,
  type BackflowQueue,
  type QueuedBackflowEvent
} from './data/tables/backflowQueue'

/**
 * 回流补发器。
 *
 * 队列只解决「事件不丢」，这里解决「事件最终会发出去」。两者分开是因为时机完全
 * 不同：入队发生在一轮对话结束的那一刻（必须快、必须有结果）；补发是后台的慢活，
 * 失败也只该退避重来。
 *
 * 三条约束：
 *
 * - **按会话分组发送**。`events:batch` 的路径里带会话 id，一次请求只能落到一个
 *   会话；把不同会话的事件混在一批里，只能拆成两个请求——不如一开始就分组。
 * - **顺序即积压顺序**。同一会话的补发必须保持 `seq` 升序，否则管理端看到的是
 *   倒序对话。分组时按首次出现的顺序取组，组内保持 `seq` 升序。
 * - **关了回流就清队列**。用户关掉上报却继续把对话存在本地队列里等「以后发」，
 *   是把隐私开关做成了摆设。
 */

/** 每轮最多补发多少条事件。够消化一次断网积压，又不会一次占满事件循环。 */
export const BACKFLOW_RETRY_BATCH_LIMIT = 200
/** 检查间隔。补发不追求秒级，30 秒足够，也让退避的粒度不至于细到无意义。 */
export const BACKFLOW_RETRY_TICK_MS = 30_000
/**
 * 积压多久还没发出去就放弃（7 天）。
 *
 * 长期离线后队列会一直长；补发时每一批都要先建会话、再逐个分块上传，
 * 几万条事件的补发会拖到用户下次开机的第一分钟。7 天足够覆盖放假，
 * 再久的归档价值低于补发成本。
 */
export const BACKFLOW_QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface BackflowDrainOutcome {
  /** 已确认送达的事件数（含服务端判重）。 */
  sent: number
  /** 可重试失败、已推迟到下次的事件数。 */
  rescheduled: number
  /** 永久失败（服务端拒收）被丢弃的事件数。 */
  dropped: number
  /** 因为没有可发的东西、或开关关闭而整轮跳过。 */
  skipped: boolean
}

const EMPTY_OUTCOME: BackflowDrainOutcome = {
  sent: 0,
  rescheduled: 0,
  dropped: 0,
  skipped: false
}

/**
 * 这个失败原因值不值得留着重试。
 *
 * 只有「换个时间就能成」的才入队：网络层失败、5xx、超时、限流。411/401/404 这类
 * 重试一万次还是同一个结果，留着只会让队列变成垃圾场，还会在日志里反复刷同一件事。
 */
export function isRetryableBackflowReason(reason: BackflowReason | string | null): boolean {
  if (!reason) return false
  if (reason === 'NETWORK') return true
  if (!reason.startsWith('HTTP_')) return false
  const status = Number(reason.slice('HTTP_'.length))
  if (!Number.isFinite(status)) return false
  if (status === 408 || status === 429) return true
  return status >= 500 && status < 600
}

export interface BackflowRetryWorkerDeps {
  queue: BackflowQueue
  backflow: StaffdeckBackflow
  /** 隐私开关；关闭时清空队列而不是继续攒着。 */
  isEnabled: () => boolean
  now?: () => number
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
  batchLimit?: number
  log?: (message: string, error?: unknown) => void
}

export interface BackflowRetryWorker {
  start(): void
  stop(): void
  /** 立即补发一轮。返回本轮结果，便于测试与手动触发。 */
  drain(): Promise<BackflowDrainOutcome>
  /** 入队后立即试一次，让「刚好断了一秒」的对话不必等满一个 tick。 */
  kick(): void
  isDraining(): boolean
}

interface SessionGroup {
  employeeId: string
  sessionId: string
  title: string | null
  entries: QueuedBackflowEvent[]
}

/** 按「(员工, 会话)」分组，组序与组内序都保持队列的 `seq` 升序。 */
const groupBySession = (entries: readonly QueuedBackflowEvent[]): SessionGroup[] => {
  const groups = new Map<string, SessionGroup>()
  for (const entry of entries) {
    // `\u0000` 作分隔符：员工 id 与会话 id 都不可能包含它，拼起来不会撞键。
    const key = `${entry.employeeId}\u0000${entry.sessionId}`
    const existing = groups.get(key)
    if (existing) {
      existing.entries.push(entry)
      continue
    }
    groups.set(key, {
      employeeId: entry.employeeId,
      sessionId: entry.sessionId,
      title: entry.title,
      entries: [entry]
    })
  }
  return [...groups.values()]
}

export function createBackflowRetryWorker(deps: BackflowRetryWorkerDeps): BackflowRetryWorker {
  const now = deps.now ?? Date.now
  const schedule = deps.setInterval ?? setInterval
  const unschedule = deps.clearInterval ?? clearInterval
  const batchLimit = Math.max(1, deps.batchLimit ?? BACKFLOW_RETRY_BATCH_LIMIT)
  const log = deps.log ?? ((message: string, error?: unknown) => console.warn(message, error))

  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<BackflowDrainOutcome> | null = null

  const drain = async (): Promise<BackflowDrainOutcome> => {
    if (!deps.isEnabled()) {
      // 关掉回流之后，队列里那些还没发出去的对话没有任何存在的理由。
      deps.queue.clear()
      return { ...EMPTY_OUTCOME, skipped: true }
    }

    // 先清掉过期积压，否则它们会一直占着 batchLimit 的名额，把新事件挡在后面。
    const pruned = deps.queue.pruneOlderThan(now() - BACKFLOW_QUEUE_MAX_AGE_MS)
    if (pruned > 0) {
      log(`[digitalEmployee] backflow queue dropped ${pruned} event(s) older than 7 days`)
    }

    const due = deps.queue.listDue(now(), batchLimit)
    if (due.length === 0) return { ...EMPTY_OUTCOME, skipped: true }

    const outcome: BackflowDrainOutcome = { ...EMPTY_OUTCOME }
    for (const group of groupBySession(due)) {
      const events = group.entries.map((entry) => entry.event)
      let result: Awaited<ReturnType<StaffdeckBackflow['flush']>>
      try {
        result = await deps.backflow.flush({
          employeeId: group.employeeId,
          sessionId: group.sessionId,
          ...(group.title ? { title: group.title } : {}),
          events
        })
      } catch (error) {
        // `flush` 契约上不抛错；真抛了也不能让一条坏会话卡住整轮补发。
        log('[digitalEmployee] backflow retry threw', error)
        result = { ok: false, reason: 'NETWORK', delivered: 0 }
      }

      // `delivered` 是按顺序确认的条数，所以前 delivered 条可以安全删除。
      const confirmed = group.entries.slice(0, result.delivered)
      if (confirmed.length > 0) {
        deps.queue.deleteBySeq(confirmed.map((entry) => entry.seq))
        outcome.sent += confirmed.length
      }

      const remaining = group.entries.slice(result.delivered)
      if (remaining.length === 0) continue

      const seqs = remaining.map((entry) => entry.seq)
      if (!isRetryableBackflowReason(result.reason)) {
        // 服务端明确拒收：再来一次也是同一个结局，留着只会一直重试。
        deps.queue.drop(seqs)
        outcome.dropped += seqs.length
        log(
          `[digitalEmployee] backflow dropped ${seqs.length} event(s) for ${group.sessionId}: ${result.reason}`
        )
        continue
      }

      const attempts = remaining.reduce((max, entry) => Math.max(max, entry.attempts), 0) + 1
      deps.queue.reschedule(seqs, now() + backflowRetryDelayMs(attempts), String(result.reason))
      outcome.rescheduled += seqs.length
    }

    return outcome
  }

  const guardedDrain = (): Promise<BackflowDrainOutcome> => {
    // 闸门：tick 与 kick 可能同时到。两轮并行会重复发送同一批（服务端能去重，
    // 但白费流量，而且会让退避计数跳两格）。
    if (inFlight) return inFlight
    inFlight = drain().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  return {
    start() {
      if (timer) return
      timer = schedule(() => {
        void guardedDrain().catch((error) => log('[digitalEmployee] backflow retry failed', error))
      }, BACKFLOW_RETRY_TICK_MS)
    },
    stop() {
      if (timer) unschedule(timer)
      timer = null
    },
    drain() {
      return guardedDrain()
    },
    kick() {
      // 不等定时器：刚入队说明用户可能就在旁边看着，早点发出去。
      void guardedDrain().catch((error) => log('[digitalEmployee] backflow retry failed', error))
    },
    isDraining() {
      return inFlight !== null
    }
  }
}
