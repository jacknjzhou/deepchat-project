import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import {
  BackflowQueueTable,
  BACKFLOW_QUEUE_MAX_DELAY_MS,
  backflowRetryDelayMs
} from '@/digital-employee/data/tables/backflowQueue'
import type { BackflowEvent } from '@/digital-employee/backflow'

/**
 * 队列是「不丢」的唯一保证。
 *
 * 以前 `flush()` 失败就到此为止，离线那一轮对话永久消失。这里的断言围绕三件事：
 * 落盘能重放（事件内容与 id 一字不差）、同事件不重复入队、退避间隔真的在涨。
 */

const EMPLOYEE = 'agent_f2828efc2a2a476d'
const SESSION = 'session-local-1'

const event = (eventId: string): BackflowEvent => ({
  type: 'message',
  eventId,
  role: 'user',
  content: `内容 ${eventId}`
})

describe('backflow retry delay', () => {
  it('starts at 30s and doubles per attempt', () => {
    expect(backflowRetryDelayMs(1)).toBe(30_000)
    expect(backflowRetryDelayMs(2)).toBe(60_000)
    expect(backflowRetryDelayMs(3)).toBe(120_000)
  })

  it('caps at 30 minutes instead of growing forever', () => {
    expect(backflowRetryDelayMs(20)).toBe(BACKFLOW_QUEUE_MAX_DELAY_MS)
    expect(backflowRetryDelayMs(99)).toBe(BACKFLOW_QUEUE_MAX_DELAY_MS)
  })

  it('treats a nonsense attempt count as the first retry', () => {
    // 0 / 负数 / NaN 只可能来自损坏的行；按首次重试处理，不会算出负数间隔。
    expect(backflowRetryDelayMs(0)).toBe(30_000)
    expect(backflowRetryDelayMs(-5)).toBe(30_000)
    expect(backflowRetryDelayMs(Number.NaN)).toBe(30_000)
  })
})

describe('BackflowQueueTable', () => {
  let db: Database.Database
  let queue: BackflowQueueTable

  beforeEach(() => {
    db = new Database(':memory:')
    queue = new BackflowQueueTable(db)
    queue.createTable()
  })
  afterEach(() => db.close())

  it('enqueues events and lists them back with their session', () => {
    const inserted = queue.enqueue({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      title: '库存查询',
      events: [event('e1'), event('e2')]
    })

    expect(inserted).toBe(2)
    const due = queue.listDue(Date.now(), 10)
    expect(due).toHaveLength(2)
    expect(due[0]).toMatchObject({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      title: '库存查询',
      attempts: 0
    })
    expect(due[0].event).toEqual(event('e1'))
    expect(due[1].event).toEqual(event('e2'))
  })

  it('ignores an event it already holds for that session', () => {
    // 重发整批是设计内的正常操作：服务端按 id 去重，本地也不该攒出两份。
    queue.enqueue({ employeeId: EMPLOYEE, sessionId: SESSION, events: [event('e1')] })
    const second = queue.enqueue({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [event('e1'), event('e2')]
    })

    expect(second).toBe(1)
    expect(queue.listDue(Date.now(), 10)).toHaveLength(2)
  })

  it('allows the same event id in a different session', () => {
    // 唯一键是 (session, event)：两个会话里同名的 `m:msg-1` 是两条不同的事件。
    queue.enqueue({ employeeId: EMPLOYEE, sessionId: 'a', events: [event('e1')] })
    queue.enqueue({ employeeId: EMPLOYEE, sessionId: 'b', events: [event('e1')] })
    expect(queue.listDue(Date.now(), 10)).toHaveLength(2)
  })

  it('hides events scheduled for later', () => {
    queue.enqueue({ employeeId: EMPLOYEE, sessionId: SESSION, events: [event('e1')] })
    const seqs = queue.listDue(Date.now(), 10).map((entry) => entry.seq)
    queue.reschedule(seqs, Date.now() + 60_000, 'HTTP_500')

    expect(queue.listDue(Date.now(), 10)).toHaveLength(0)
    expect(queue.listDue(Date.now() + 61_000, 10)).toHaveLength(1)
  })

  it('counts attempts each time it reschedules', () => {
    queue.enqueue({ employeeId: EMPLOYEE, sessionId: SESSION, events: [event('e1')] })
    const seqs = queue.listDue(Date.now(), 10).map((entry) => entry.seq)

    queue.reschedule(seqs, Date.now(), 'NETWORK')
    queue.reschedule(seqs, Date.now(), 'NETWORK')

    expect(queue.listDue(Date.now(), 10)[0].attempts).toBe(2)
  })

  it('deletes only what was confirmed delivered', () => {
    queue.enqueue({ employeeId: EMPLOYEE, sessionId: SESSION, events: [event('e1'), event('e2')] })
    const due = queue.listDue(Date.now(), 10)
    queue.deleteBySeq([due[0].seq])

    const left = queue.listDue(Date.now(), 10)
    expect(left).toHaveLength(1)
    expect(left[0].event).toEqual(event('e2'))
  })

  it('reports pending and due counts separately', () => {
    queue.enqueue({ employeeId: EMPLOYEE, sessionId: SESSION, events: [event('e1'), event('e2')] })
    const seqs = queue.listDue(Date.now(), 10).map((entry) => entry.seq)
    queue.reschedule([seqs[0]], Date.now() + 60_000, 'NETWORK')

    const stats = queue.stats(Date.now())
    expect(stats.pending).toBe(2)
    expect(stats.due).toBe(1)
    expect(stats.oldestCreatedAt).not.toBeNull()
  })

  it('drops rows whose JSON no longer parses instead of retrying them forever', () => {
    queue.enqueue({ employeeId: EMPLOYEE, sessionId: SESSION, events: [event('e1')] })
    db.prepare('UPDATE digital_employee_backflow_queue SET event_json = ? WHERE event_id = ?').run(
      '{not json',
      'e1'
    )

    expect(queue.listDue(Date.now(), 10)).toHaveLength(0)
    expect(queue.stats(Date.now()).pending).toBe(0)
  })

  it('clears everything when reporting is switched off', () => {
    queue.enqueue({ employeeId: EMPLOYEE, sessionId: SESSION, events: [event('e1')] })
    queue.clear()
    expect(queue.stats(Date.now()).pending).toBe(0)
  })

  it('prunes events that have been stuck for too long', () => {
    const ancient = Date.now() - 8 * 24 * 60 * 60 * 1000
    queue.enqueue({
      employeeId: EMPLOYEE,
      sessionId: SESSION,
      events: [event('old')],
      now: ancient
    })
    queue.enqueue({ employeeId: EMPLOYEE, sessionId: SESSION, events: [event('new')] })

    expect(queue.pruneOlderThan(Date.now() - 7 * 24 * 60 * 60 * 1000)).toBe(1)
    expect(queue.listDue(Date.now(), 10).map((entry) => entry.event.eventId)).toEqual(['new'])
  })
})
