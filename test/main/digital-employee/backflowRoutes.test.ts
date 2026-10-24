import { describe, expect, it, vi } from 'vitest'
import { createDigitalEmployeeBackflowRoutes } from '../../../src/main/digital-employee/backflowRoutes'
import type { BackflowEvent, BackflowResult } from '../../../src/main/digital-employee/backflow'
import type {
  BackflowQueue,
  BackflowQueueEnqueueInput,
  QueuedBackflowEvent
} from '../../../src/main/digital-employee/data/tables/backflowQueue'

/**
 * 回流 route 的职责边界：按契约收参、把结果压平成 renderer 能用的形状，并在
 * 「可重试的失败」时把事件落进本地队列。
 *
 * 上线语义靠 `ok` 与 `reason` 分离表达：`ok: true` 只表示主进程接手了（送达或
 * 落盘），`reason` 才是「到底送没送到」。renderer 的游标跟着 `ok` 走。
 */

const EMPLOYEE = 'agent_f2828efc2a2a476d'
const SESSION = 'session-local-1'

/** 只记录调用的假队列；真 SQL 行为在 backflowQueue.test.ts。 */
function createQueue() {
  const enqueued: BackflowQueueEnqueueInput[] = []
  const stored: QueuedBackflowEvent[] = []
  let seq = 0
  const queue: BackflowQueue = {
    enqueue(input) {
      enqueued.push(input)
      for (const event of input.events) {
        seq += 1
        stored.push({
          seq,
          employeeId: input.employeeId,
          sessionId: input.sessionId,
          title: input.title ?? null,
          event,
          attempts: 0,
          nextAttemptAt: 0
        })
      }
      return input.events.length
    },
    listDue: () => stored,
    deleteBySeq: () => undefined,
    reschedule: () => undefined,
    drop: () => undefined,
    clear: () => undefined,
    pruneOlderThan: () => 0,
    stats: () => ({ pending: stored.length, due: stored.length, oldestCreatedAt: null })
  }
  return { queue, enqueued, stored }
}

function harness(result: BackflowResult, options: { withQueue?: boolean } = {}) {
  const seen: Array<{ employeeId: string; sessionId: string; events: readonly BackflowEvent[] }> =
    []
  const { queue, enqueued } = createQueue()
  const kick = vi.fn()
  const routes = createDigitalEmployeeBackflowRoutes({
    backflow: {
      async flush(input) {
        seen.push(input)
        return result
      }
    },
    ...(options.withQueue === false ? {} : { queue, retryWorker: { kick } })
  })
  const handler = routes.get('digitalEmployee.backflow')!
  return { handler, seen, enqueued, queue, kick }
}

describe('digitalEmployee.backflow route', () => {
  it('passes the parsed events through', async () => {
    const { handler, seen } = harness({ ok: true, reason: null, delivered: 1 })

    await handler({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [{ type: 'message', eventId: 'e1', role: 'user', content: 'hi' }]
    })

    expect(seen[0].employeeId).toBe(EMPLOYEE)
    expect(seen[0].sessionId).toBe(SESSION)
    expect(seen[0].events).toHaveLength(1)
  })

  it('reports the delivered count so the caller knows what to drop', async () => {
    const { handler } = harness({ ok: false, reason: 'HTTP_500', delivered: 2 })

    const result = await handler({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [
        { type: 'usage', eventId: 'u1', promptTokens: 1, completionTokens: 2, totalTokens: 3 }
      ]
    })

    expect(result).toMatchObject({ reason: 'HTTP_500', delivered: 2 })
  })

  it('rejects a malformed event instead of silently dropping it', async () => {
    const { handler } = harness({ ok: true, reason: null, delivered: 0 })

    await expect(
      handler({ employeeId: EMPLOYEE, sessionId: SESSION, events: [{ type: 'nope' }] })
    ).rejects.toThrow()
  })

  it('queues the undelivered events when the failure is retryable', async () => {
    // 这是 P1-1 的核心：以前 5xx 之后那一轮就永久丢了，现在它落到磁盘等补发。
    const { handler, enqueued, kick } = harness({ ok: false, reason: 'HTTP_503', delivered: 1 })

    const result = await handler({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      title: '库存查询',
      events: [
        { type: 'message', eventId: 'e1', role: 'user', content: 'a' },
        { type: 'message', eventId: 'e2', role: 'assistant', content: 'b' }
      ]
    })

    expect(enqueued[0]).toMatchObject({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      title: '库存查询'
    })
    // 只落盘没送达的那半：已确认的那条再进队列会被服务端判重，白费一次请求。
    expect(enqueued[0].events.map((event) => event.eventId)).toEqual(['e2'])
    expect(result).toMatchObject({ ok: true, reason: 'HTTP_503', delivered: 1, queued: 1 })
    expect(kick).toHaveBeenCalledTimes(1)
  })

  it('treats a queued batch as accepted so the renderer can move its cursor', async () => {
    // `ok` 的语义是「主进程接手了」而不是「送到了」。renderer 若因此保留游标，
    // 下一轮会重采同一批，而队列里已经有了一份。
    const { handler } = harness({ ok: false, reason: 'NETWORK', delivered: 0 })

    const result = await handler({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [{ type: 'message', eventId: 'e1', role: 'user', content: 'a' }]
    })

    expect(result.ok).toBe(true)
    expect(result.queued).toBe(1)
  })

  it('does not queue what the server definitively rejected', async () => {
    // 401/422 重试一万次还是同一个结局；入队只会让队列变成永不消失的垃圾。
    const { handler, enqueued, kick } = harness({ ok: false, reason: 'HTTP_401', delivered: 0 })

    const result = await handler({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [{ type: 'message', eventId: 'e1', role: 'user', content: 'a' }]
    })

    expect(enqueued).toHaveLength(0)
    expect(result).toMatchObject({ ok: false, reason: 'HTTP_401', queued: 0 })
    expect(kick).not.toHaveBeenCalled()
  })

  it('does not queue when reporting is switched off', async () => {
    const { handler, enqueued } = harness({ ok: false, reason: 'DISABLED', delivered: 0 })

    const result = await handler({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [{ type: 'message', eventId: 'e1', role: 'user', content: 'a' }]
    })

    expect(enqueued).toHaveLength(0)
    expect(result.ok).toBe(false)
  })

  it('does not queue when there is no connection to send to', async () => {
    const { handler, enqueued } = harness({ ok: false, reason: 'NOT_CONFIGURED', delivered: 0 })

    await handler({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [{ type: 'message', eventId: 'e1', role: 'user', content: 'a' }]
    })

    expect(enqueued).toHaveLength(0)
  })

  it('reports the pending backlog so the UI can show there is a queue', async () => {
    const { handler } = harness({ ok: false, reason: 'HTTP_500', delivered: 0 })

    const result = await handler({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [{ type: 'message', eventId: 'e1', role: 'user', content: 'a' }]
    })

    expect(result.pending).toBe(1)
  })

  it('never throws when persisting the queue fails', async () => {
    // 这条路由在发消息的返回路径上：抛异常会变成用户看到的「发送失败」。
    const broken: BackflowQueue = {
      enqueue: () => {
        throw new Error('disk full')
      },
      listDue: () => [],
      deleteBySeq: () => undefined,
      reschedule: () => undefined,
      drop: () => undefined,
      clear: () => undefined,
      pruneOlderThan: () => 0,
      stats: () => ({ pending: 0, due: 0, oldestCreatedAt: null })
    }
    const routes = createDigitalEmployeeBackflowRoutes({
      backflow: {
        async flush() {
          return { ok: false, reason: 'HTTP_500', delivered: 0 }
        }
      },
      queue: broken,
      log: () => undefined
    })

    const result = await routes.get('digitalEmployee.backflow')!({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [{ type: 'message', eventId: 'e1', role: 'user', content: 'a' }]
    })

    // 落盘失败时如实回 `ok: false`：这批事件真的没人接手，renderer 必须保留游标。
    expect(result).toMatchObject({ ok: false, reason: 'HTTP_500', queued: 0 })
  })
})
