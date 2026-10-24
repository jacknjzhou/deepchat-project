import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackflowEvent, BackflowResult, FlushInput } from '@/digital-employee/backflow'
import type {
  BackflowQueue,
  BackflowQueueEnqueueInput,
  QueuedBackflowEvent
} from '@/digital-employee/data/tables/backflowQueue'
import {
  BACKFLOW_QUEUE_MAX_AGE_MS,
  BACKFLOW_RETRY_TICK_MS,
  createBackflowRetryWorker,
  isRetryableBackflowReason
} from '@/digital-employee/backflowRetry' /**
 * 补发器是「最终会发出去」的唯一保证。
 *
 * 断言的中心只有一条：**失败的事件留在队列里，成功的事件立刻消失**。这条成立，
 * 「离线那轮对话永久丢失」就不可能再发生；剩下的是排队顺序与退避的问题。
 *
 * 队列用内存假实现而不是真 SQLite：这个文件验的是补发策略，表本身的 SQL 行为在
 * `backflowQueue.test.ts` 里单独验。两者混在一起时，一次原生模块 ABI 不匹配就会
 * 让「策略对不对」这件事也没法跑。
 */

const EMPLOYEE = 'agent_f2828efc2a2a476d'
const SESSION = 'session-local-1'

const event = (eventId: string): BackflowEvent => ({
  type: 'message',
  eventId,
  role: 'user',
  content: eventId
})

interface FakeRow extends QueuedBackflowEvent {
  createdAt: number
  lastError?: string
}

/** 与 `BackflowQueueTable` 语义一致的最小实现（顺序、去重、到期过滤）。 */
class FakeQueue implements BackflowQueue {
  rows: FakeRow[] = []
  private seq = 0
  private readonly now: () => number

  constructor(now: () => number) {
    this.now = now
  }

  enqueue(input: BackflowQueueEnqueueInput): number {
    let inserted = 0
    for (const item of input.events) {
      const duplicated = this.rows.some(
        (row) => row.sessionId === input.sessionId && row.event.eventId === item.eventId
      )
      if (duplicated) continue
      this.seq += 1
      const at = input.now ?? this.now()
      this.rows.push({
        seq: this.seq,
        employeeId: input.employeeId,
        sessionId: input.sessionId,
        title: input.title ?? null,
        event: item,
        attempts: 0,
        nextAttemptAt: at,
        createdAt: at
      })
      inserted += 1
    }
    return inserted
  }

  listDue(now: number, limit: number): QueuedBackflowEvent[] {
    return this.rows
      .filter((row) => row.nextAttemptAt <= now)
      .sort((left, right) => left.seq - right.seq)
      .slice(0, limit)
      .map((row) => ({ ...row }))
  }

  deleteBySeq(seqs: readonly number[]): void {
    const targets = new Set(seqs)
    this.rows = this.rows.filter((row) => !targets.has(row.seq))
  }

  reschedule(seqs: readonly number[], nextAttemptAt: number, reason: string): void {
    const targets = new Set(seqs)
    for (const row of this.rows) {
      if (!targets.has(row.seq)) continue
      row.attempts += 1
      row.nextAttemptAt = nextAttemptAt
      row.lastError = reason
    }
  }

  drop(seqs: readonly number[]): void {
    this.deleteBySeq(seqs)
  }

  clear(): void {
    this.rows = []
  }

  pruneOlderThan(cutoff: number): number {
    const before = this.rows.length
    this.rows = this.rows.filter((row) => row.createdAt >= cutoff)
    return before - this.rows.length
  }

  stats(now: number) {
    const due = this.rows.filter((row) => row.nextAttemptAt <= now).length
    return {
      pending: this.rows.length,
      due,
      oldestCreatedAt: this.rows.length > 0 ? Math.min(...this.rows.map((r) => r.createdAt)) : null
    }
  }
}

function createHarness(
  options: {
    enabled?: boolean
    /** 每次 flush 的返回；用完取最后一个。`null` 表示抛错。 */
    results?: Array<BackflowResult | null>
    batchLimit?: number
  } = {}
) {
  let clock = 1_000_000
  const queue = new FakeQueue(() => clock)
  const flushCalls: FlushInput[] = []
  const results = [...(options.results ?? [{ ok: true, reason: null, delivered: 99 }])]
  let index = 0

  const backflow = {
    async flush(input: FlushInput): Promise<BackflowResult> {
      flushCalls.push(input)
      const result = results[Math.min(index, results.length - 1)]
      index += 1
      if (result === null) throw new Error('boom')
      // `delivered` 不能超过实际条数，否则调用方会试着删不存在的行。
      return { ...result, delivered: Math.min(result.delivered, input.events.length) }
    },
    reset() {}
  }

  const handlers: Array<() => void> = []
  const worker = createBackflowRetryWorker({
    queue,
    backflow,
    isEnabled: () => options.enabled ?? true,
    now: () => clock,
    batchLimit: options.batchLimit,
    setInterval: ((handler: () => void) => {
      handlers.push(handler)
      return handlers.length as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof setInterval,
    clearInterval: (() => {
      handlers.length = 0
    }) as unknown as typeof clearInterval,
    log: () => undefined
  })

  return {
    queue,
    worker,
    flushCalls,
    advance: (ms: number) => {
      clock += ms
    },
    now: () => clock,
    tick: () => {
      for (const handler of handlers) handler()
    }
  }
}

describe('isRetryableBackflowReason', () => {
  it('retries network and transient server failures', () => {
    expect(isRetryableBackflowReason('NETWORK')).toBe(true)
    expect(isRetryableBackflowReason('HTTP_500')).toBe(true)
    expect(isRetryableBackflowReason('HTTP_503')).toBe(true)
    expect(isRetryableBackflowReason('HTTP_429')).toBe(true)
    expect(isRetryableBackflowReason('HTTP_408')).toBe(true)
  })

  it('does not retry a definitive rejection', () => {
    // 重试一万次还是同一个 401：留着只会让队列变成垃圾场。
    expect(isRetryableBackflowReason('HTTP_401')).toBe(false)
    expect(isRetryableBackflowReason('HTTP_403')).toBe(false)
    expect(isRetryableBackflowReason('HTTP_404')).toBe(false)
    expect(isRetryableBackflowReason('HTTP_400')).toBe(false)
    expect(isRetryableBackflowReason('HTTP_422')).toBe(false)
  })

  it('does not retry local preconditions', () => {
    expect(isRetryableBackflowReason('DISABLED')).toBe(false)
    expect(isRetryableBackflowReason('NOT_CONFIGURED')).toBe(false)
    expect(isRetryableBackflowReason('EMPTY')).toBe(false)
    expect(isRetryableBackflowReason(null)).toBe(false)
  })
})

describe('backflow retry worker', () => {
  let harness: ReturnType<typeof createHarness>

  afterEach(() => harness?.worker.stop())

  it('sends queued events and clears them on success', async () => {
    harness = createHarness()
    harness.queue.enqueue({ employeeId: EMPLOYEE, sessionId: SESSION, events: [event('e1')] })

    const outcome = await harness.worker.drain()

    expect(outcome.sent).toBe(1)
    expect(outcome.rescheduled).toBe(0)
    expect(harness.queue.stats(harness.now()).pending).toBe(0)
    expect(harness.flushCalls[0]).toMatchObject({ employeeId: EMPLOYEE, sessionId: SESSION })
  })

  it('keeps the failed side of a partially delivered batch', async () => {
    // flush 只确认前 N 条，剩下的必须留在队列里——按 delivered 切而不是整批删。
    harness = createHarness({ results: [{ ok: false, reason: 'HTTP_500', delivered: 1 }] })
    harness.queue.enqueue({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [event('e1'), event('e2'), event('e3')]
    })

    const outcome = await harness.worker.drain()

    expect(outcome.sent).toBe(1)
    expect(outcome.rescheduled).toBe(2)
    const left = harness.queue.listDue(harness.now() + 3_600_000, 10)
    expect(left.map((entry) => entry.event.eventId)).toEqual(['e2', 'e3'])
  })

  it('backs off instead of hammering the server', async () => {
    harness = createHarness({ results: [{ ok: false, reason: 'NETWORK', delivered: 0 }] })
    harness.queue.enqueue({ employeeId: EMPLOYEE, sessionId: SESSION, events: [event('e1')] })

    await harness.worker.drain()

    // 刚失败过，同一时刻再跑一轮应该什么都发不出去。
    expect(await harness.worker.drain()).toMatchObject({ sent: 0, skipped: true })
    expect(harness.flushCalls).toHaveLength(1)
    // 30 秒后回到可发状态。
    harness.advance(30_000)
    expect(harness.queue.listDue(harness.now(), 10)).toHaveLength(1)
  })

  it('grows the wait with each further failure', async () => {
    harness = createHarness({
      results: [
        { ok: false, reason: 'HTTP_503', delivered: 0 },
        { ok: false, reason: 'HTTP_503', delivered: 0 }
      ]
    })
    harness.queue.enqueue({ employeeId: EMPLOYEE, sessionId: SESSION, events: [event('e1')] })

    await harness.worker.drain()
    harness.advance(30_000)
    await harness.worker.drain()

    // 第二次失败后要等 60s，30s 时还不该到点。
    expect(harness.queue.listDue(harness.now() + 30_000, 10)).toHaveLength(0)
    expect(harness.queue.listDue(harness.now() + 61_000, 10)).toHaveLength(1)
  })

  it('drops events the server definitively rejected', async () => {
    harness = createHarness({ results: [{ ok: false, reason: 'HTTP_422', delivered: 0 }] })
    harness.queue.enqueue({ employeeId: EMPLOYEE, sessionId: SESSION, events: [event('e1')] })

    const outcome = await harness.worker.drain()

    expect(outcome.dropped).toBe(1)
    expect(harness.queue.stats(harness.now()).pending).toBe(0)
  })

  it('keeps the queue when flush throws, instead of losing the events', async () => {
    harness = createHarness({ results: [null] })
    harness.queue.enqueue({ employeeId: EMPLOYEE, sessionId: SESSION, events: [event('e1')] })

    const outcome = await harness.worker.drain()

    expect(outcome.rescheduled).toBe(1)
    expect(harness.queue.stats(harness.now()).pending).toBe(1)
  })

  it('splits events by session because one batch carries one session id', async () => {
    harness = createHarness()
    harness.queue.enqueue({ employeeId: EMPLOYEE, sessionId: 'a', events: [event('e1')] })
    harness.queue.enqueue({ employeeId: EMPLOYEE, sessionId: 'b', events: [event('e2')] })

    await harness.worker.drain()

    expect(harness.flushCalls.map((call) => call.sessionId)).toEqual(['a', 'b'])
  })

  it('keeps the original order inside a session', async () => {
    // 管理端按到达顺序展示对话，补发时倒序会让它看起来像是倒着说的。
    harness = createHarness()
    harness.queue.enqueue({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [event('e1'), event('e2'), event('e3')]
    })

    await harness.worker.drain()

    expect(harness.flushCalls[0].events.map((item) => item.eventId)).toEqual(['e1', 'e2', 'e3'])
  })

  it('carries the title through so the remote session gets its name', async () => {
    harness = createHarness()
    harness.queue.enqueue({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      title: '库存查询',
      events: [event('e1')]
    })

    await harness.worker.drain()

    expect(harness.flushCalls[0].title).toBe('库存查询')
  })

  it('drops the whole queue when reporting is switched off', async () => {
    // 关掉上报却继续把对话攒在本地等「以后发」，是把隐私开关做成摆设。
    harness = createHarness({ enabled: false })
    harness.queue.enqueue({ employeeId: EMPLOYEE, sessionId: SESSION, events: [event('e1')] })

    const outcome = await harness.worker.drain()

    expect(outcome.skipped).toBe(true)
    expect(harness.queue.stats(harness.now()).pending).toBe(0)
    expect(harness.flushCalls).toHaveLength(0)
  })

  it('does nothing when the queue is empty', async () => {
    harness = createHarness()
    expect(await harness.worker.drain()).toMatchObject({ skipped: true, sent: 0 })
    expect(harness.flushCalls).toHaveLength(0)
  })

  it('drops events older than a week so the backlog cannot grow forever', async () => {
    harness = createHarness()
    harness.queue.enqueue({
      employeeId: EMPLOYEE,
      sessionId: 'old',
      events: [event('e1')],
      now: harness.now() - BACKFLOW_QUEUE_MAX_AGE_MS - 1
    })
    harness.queue.enqueue({ employeeId: EMPLOYEE, sessionId: 'new', events: [event('e2')] })

    await harness.worker.drain()

    expect(harness.flushCalls.map((call) => call.sessionId)).toEqual(['new'])
  })

  it('respects the batch limit so one drain cannot block the loop for minutes', async () => {
    harness = createHarness({ batchLimit: 1 })
    harness.queue.enqueue({ employeeId: EMPLOYEE, sessionId: 'a', events: [event('e1')] })
    harness.queue.enqueue({ employeeId: EMPLOYEE, sessionId: 'b', events: [event('e2')] })

    await harness.worker.drain()

    expect(harness.flushCalls).toHaveLength(1)
    expect(harness.queue.stats(harness.now()).pending).toBe(1)
  })

  it('shares one in-flight drain between tick and kick', async () => {
    // 两轮并行会重复发送同一批，也会把退避计数一次推两格。
    harness = createHarness()
    harness.queue.enqueue({ employeeId: EMPLOYEE, sessionId: SESSION, events: [event('e1')] })

    const [first, second] = await Promise.all([harness.worker.drain(), harness.worker.drain()])

    expect(first).toBe(second)
    expect(harness.flushCalls).toHaveLength(1)
  })

  it('runs a drain on every tick once started', async () => {
    harness = createHarness()
    harness.worker.start()
    harness.queue.enqueue({ employeeId: EMPLOYEE, sessionId: SESSION, events: [event('e1')] })

    harness.tick()
    await vi.waitFor(() => expect(harness.flushCalls).toHaveLength(1))
    expect(BACKFLOW_RETRY_TICK_MS).toBeGreaterThan(0)
  })
})
