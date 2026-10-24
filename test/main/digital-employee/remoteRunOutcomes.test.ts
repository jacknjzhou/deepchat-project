import { describe, expect, it } from 'vitest'
import { createRemoteRunOutcomeStore } from '../../../src/main/digital-employee/remoteRunOutcomes'

describe('remoteRunOutcomeStore', () => {
  it('returns null for a session that never had a turn', () => {
    const store = createRemoteRunOutcomeStore()
    expect(store.awaitingInputOf('s1')).toBeNull()
  })

  it('keeps the latest turn result per session, not per employee', () => {
    const store = createRemoteRunOutcomeStore()
    store.remember('s1', { task_id: 't1', expected_fields: ['金额'] })
    store.remember('s2', { task_id: 't2', expected_fields: ['事由'] })

    expect(store.awaitingInputOf('s1')?.task_id).toBe('t1')
    expect(store.awaitingInputOf('s2')?.task_id).toBe('t2')
  })

  /**
   * `null` 与「没有记录」在语义上不同：前者是「这一轮问完了」，
   * 后者是「这个会话没跑过远端」。`remember(sessionId, null)` 必须真的落成一条
   * 记录，否则 `awaitingInputOf` 分不出两者——而界面要靠它撤掉上一条提示条。
   */
  it('overwrites an earlier awaiting_input with null', () => {
    const store = createRemoteRunOutcomeStore()
    store.remember('s1', { task_id: 't1', expected_fields: ['金额'] })
    store.remember('s1', null)

    expect(store.awaitingInputOf('s1')).toBeNull()
  })

  it('drops the entry on forget', () => {
    const store = createRemoteRunOutcomeStore()
    store.remember('s1', { task_id: 't1' })
    store.forget('s1')

    expect(store.awaitingInputOf('s1')).toBeNull()
  })

  it('forgetting an unknown session is a no-op', () => {
    const store = createRemoteRunOutcomeStore()
    expect(() => store.forget('nope')).not.toThrow()
  })

  /**
   * 上限只为防长跑进程无界增长。断言的是「最久未更新的那条被淘汰」，
   * 而不是「第 513 条被淘汰」——实现换成时间戳也不会让这个断言失效。
   */
  it('evicts the least recently written entry once it exceeds the cap', () => {
    const store = createRemoteRunOutcomeStore()
    for (let index = 0; index < 513; index += 1) {
      store.remember(`s${index}`, { task_id: `t${index}` })
    }

    expect(store.awaitingInputOf('s0')).toBeNull()
    expect(store.awaitingInputOf('s512')?.task_id).toBe('t512')
  })

  it('re-writing an entry moves it out of the eviction path', () => {
    const store = createRemoteRunOutcomeStore()
    for (let index = 0; index < 512; index += 1) {
      store.remember(`s${index}`, { task_id: `t${index}` })
    }
    // 重写 s0 让它变成「最近使用」，随后插入新键不应把它淘汰。
    store.remember('s0', { task_id: 'fresh' })
    store.remember('s512', { task_id: 't512' })

    expect(store.awaitingInputOf('s0')?.task_id).toBe('fresh')
    expect(store.awaitingInputOf('s1')).toBeNull()
  })
})
