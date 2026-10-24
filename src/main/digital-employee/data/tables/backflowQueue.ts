import type Database from 'better-sqlite3-multiple-ciphers'
import { BaseTable } from '@/data/baseTable'
import type { BackflowEvent } from '@/digital-employee/backflow'

/**
 * 回流事件的本地持久化队列。
 *
 * 为什么必须有它：`flush()` 是一次性的——网络断一次、服务端 5xx 一次，那一轮对话
 * 就永远不进归档。spec §5.6 要求「本地队列暂存 + 指数退避重试」，说的就是这件事：
 * 上报失败时**先把事件落到磁盘**，之后由后台按退避节奏补发。
 *
 * 三条设计约束：
 *
 * - **一行一个事件**，不是一行一批。去重粒度是「单个事件 id」（服务端就是这么去的），
 *   一行一批的话，重发时夹带一条已存事件就会让整批被忽略。
 * - **落盘即视为「交给主进程」**。renderer 的游标可以前进，否则它下一轮会重采同一批，
 *   而队列这边靠唯一索引静默忽略重复——两者都对，但同时存在会让人怀疑到底谁在重试。
 * - **队列不分租户**。行里只记 session/event，不带 baseUrl：配置改指向另一套 StaffDeck
 *   时，积压事件会补发到新地址。已知限制，写在这里而不是让它变成一个隐形的 surprise。
 */

export const BACKFLOW_QUEUE_TABLE = 'digital_employee_backflow_queue'

/** 首次重试等 30 秒，之后翻倍，上限 30 分钟。 */
export const BACKFLOW_QUEUE_BASE_DELAY_MS = 30_000
export const BACKFLOW_QUEUE_MAX_DELAY_MS = 30 * 60_000

/**
 * 第 `attempts` 次失败后的等待时长（`attempts` 从 1 开始）。
 *
 * 有意不加抖动：抖动是为了打散大量客户端的重试风暴，而这里是**单机单客户端**，
 * 加抖动只会让「第几次失败后等多久」变得不可预测、也没法断言。
 */
export function backflowRetryDelayMs(attempts: number): number {
  const normalized = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 1
  // 2^16 已经远大于上限，再往上算只会溢出，没有意义。
  const exponent = Math.min(normalized - 1, 16)
  return Math.min(BACKFLOW_QUEUE_BASE_DELAY_MS * 2 ** exponent, BACKFLOW_QUEUE_MAX_DELAY_MS)
}

interface BackflowQueueRow {
  seq: number
  employee_id: string
  session_id: string
  title: string | null
  event_id: string
  event_json: string
  attempts: number
  next_attempt_at: number
}

/** 待补发的一条事件，已按 `seq` 还原了所属会话与标题。 */
export interface QueuedBackflowEvent {
  seq: number
  employeeId: string
  sessionId: string
  title: string | null
  event: BackflowEvent
  attempts: number
  /** 下次可发的时间戳。补发器据此推算退避档位。 */
  nextAttemptAt: number
}

export interface BackflowQueueEnqueueInput {
  employeeId: string
  sessionId: string
  title?: string
  events: readonly BackflowEvent[]
  now?: number
}

export interface BackflowQueueStats {
  /** 积压事件总数（含尚未到重试时间的）。 */
  pending: number
  /** 已经到点、可以立刻发的事件数。 */
  due: number
  /** 最早一条的入队时间；空队列为 `null`。 */
  oldestCreatedAt: number | null
}

export interface BackflowQueue {
  /** 落盘待补发事件；返回真正新增的条数（同会话里已存在的事件被忽略）。 */
  enqueue(input: BackflowQueueEnqueueInput): number
  listDue(now: number, limit: number): QueuedBackflowEvent[]
  /** 送达后删除。 */
  deleteBySeq(seqs: readonly number[]): void
  /** 可重试失败：累加尝试次数并推到下次可发时间。 */
  reschedule(seqs: readonly number[], nextAttemptAt: number, reason: string): void
  /** 永久失败：没有补发的意义（例如事件被服务端判为非法），直接丢弃。 */
  drop(seqs: readonly number[]): void
  /** 清空整个队列。用户关掉回流时用——攒着不发等于把隐私开关做成摆设。 */
  clear(): void
  /** 丢掉早于 `cutoff` 入队的事件，返回丢弃条数。防止离线数周后队列无限长。 */
  pruneOlderThan(cutoff: number): number
  stats(now: number): BackflowQueueStats
}

/** 单条事件的 JSON 坏掉时整条丢掉：一行解析不了，不该连带同会话的其他事件。 */
const parseEvent = (raw: string): BackflowEvent | null => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const event = parsed as { type?: unknown; eventId?: unknown }
    if (typeof event.type !== 'string' || typeof event.eventId !== 'string') return null
    return parsed as BackflowEvent
  } catch {
    return null
  }
}

export class BackflowQueueTable extends BaseTable implements BackflowQueue {
  constructor(db: Database.Database) {
    super(db, BACKFLOW_QUEUE_TABLE)
  }

  getCreateTableSQL(): string {
    return `
      CREATE TABLE IF NOT EXISTS ${BACKFLOW_QUEUE_TABLE} (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT,
        event_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_de_backflow_queue_event
        ON ${BACKFLOW_QUEUE_TABLE}(session_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_de_backflow_queue_due
        ON ${BACKFLOW_QUEUE_TABLE}(next_attempt_at, seq);
    `
  }

  /** 表由启动时的 schema catalog 建；没有版本化迁移。 */
  getLatestVersion(): number {
    return 0
  }

  getMigrationSQL(): string | null {
    return null
  }

  enqueue(input: BackflowQueueEnqueueInput): number {
    if (input.events.length === 0) return 0
    const now = input.now ?? Date.now()
    const statement = this.db.prepare(
      `INSERT OR IGNORE INTO ${BACKFLOW_QUEUE_TABLE}
         (employee_id, session_id, title, event_id, event_json, attempts, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
    )
    const insertAll = this.db.transaction((events: readonly BackflowEvent[]): number => {
      let inserted = 0
      for (const event of events) {
        const outcome = statement.run(
          input.employeeId,
          input.sessionId,
          input.title ?? null,
          event.eventId,
          JSON.stringify(event),
          now,
          now
        )
        inserted += outcome.changes
      }
      return inserted
    })
    return insertAll(input.events)
  }

  listDue(now: number, limit: number): QueuedBackflowEvent[] {
    const bounded = Math.max(1, Math.floor(limit))
    const rows = this.db
      .prepare(
        `SELECT seq, employee_id, session_id, title, event_id, event_json, attempts, next_attempt_at
         FROM ${BACKFLOW_QUEUE_TABLE}
         WHERE next_attempt_at <= ?
         ORDER BY seq ASC
         LIMIT ?`
      )
      .all(now, bounded) as BackflowQueueRow[]

    const entries: QueuedBackflowEvent[] = []
    const unreadable: number[] = []
    for (const row of rows) {
      const event = parseEvent(row.event_json)
      if (!event) {
        unreadable.push(row.seq)
        continue
      }
      entries.push({
        seq: row.seq,
        employeeId: row.employee_id,
        sessionId: row.session_id,
        title: row.title,
        event,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at
      })
    }
    // 坏行当场清掉：留着只会被每轮重新解析、重新跳过，永远不消失。
    if (unreadable.length > 0) this.deleteBySeq(unreadable)
    return entries
  }

  deleteBySeq(seqs: readonly number[]): void {
    if (seqs.length === 0) return
    const statement = this.db.prepare(`DELETE FROM ${BACKFLOW_QUEUE_TABLE} WHERE seq = ?`)
    const remove = this.db.transaction((values: readonly number[]) => {
      for (const seq of values) statement.run(seq)
    })
    remove(seqs)
  }

  reschedule(seqs: readonly number[], nextAttemptAt: number, reason: string): void {
    if (seqs.length === 0) return
    const statement = this.db.prepare(
      `UPDATE ${BACKFLOW_QUEUE_TABLE}
       SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?
       WHERE seq = ?`
    )
    const update = this.db.transaction((values: readonly number[]) => {
      for (const seq of values) statement.run(nextAttemptAt, reason, seq)
    })
    update(seqs)
  }

  drop(seqs: readonly number[]): void {
    // 永久失败没有补发的意义（401 换了 key 也一样是被服务端拒的事件），
    // 记录原因只会让表无限增长。原因由调用方写日志。
    this.deleteBySeq(seqs)
  }

  clear(): void {
    this.db.prepare(`DELETE FROM ${BACKFLOW_QUEUE_TABLE}`).run()
  }

  pruneOlderThan(cutoff: number): number {
    const outcome = this.db
      .prepare(`DELETE FROM ${BACKFLOW_QUEUE_TABLE} WHERE created_at < ?`)
      .run(cutoff)
    return outcome.changes
  }

  stats(now: number): BackflowQueueStats {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS pending,
           SUM(CASE WHEN next_attempt_at <= ? THEN 1 ELSE 0 END) AS due,
           MIN(created_at) AS oldest
         FROM ${BACKFLOW_QUEUE_TABLE}`
      )
      .get(now) as { pending: number; due: number | null; oldest: number | null }
    return {
      pending: row.pending ?? 0,
      due: row.due ?? 0,
      oldestCreatedAt: row.oldest ?? null
    }
  }
}
