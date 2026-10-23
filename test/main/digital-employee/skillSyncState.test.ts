import { describe, expect, it } from 'vitest'
import {
  createSkillSyncStateStore,
  DIGITAL_EMPLOYEE_SKILL_SYNC_KEY
} from '../../../src/main/digital-employee/skillSyncState'

/**
 * 技能安装基线。
 *
 * 存的只是「上一次成功装的是哪个 id」，丢了最坏情况是全量重装一遍，
 * 所以读取一律做成全量容错：坏数据降级成空基线，绝不中断准备流程。
 */

function createHarness(initial?: unknown) {
  const values = new Map<string, unknown>()
  if (initial !== undefined) values.set(DIGITAL_EMPLOYEE_SKILL_SYNC_KEY, initial)

  return {
    settings: {
      get: <TValue = unknown>(key: string) => values.get(key) as TValue | undefined,
      set: (key: string, value: unknown) => {
        values.set(key, value)
      }
    },
    raw: (key = DIGITAL_EMPLOYEE_SKILL_SYNC_KEY) => values.get(key)
  }
}

describe('createSkillSyncStateStore', () => {
  it('returns undefined for an employee that was never synced', () => {
    const store = createSkillSyncStateStore(createHarness())
    expect(store.get('emp-1')).toBeUndefined()
  })

  it('round-trips a baseline per employee', () => {
    const harness = createHarness()
    const store = createSkillSyncStateStore(harness)

    store.set('emp-1', { 'invoice-summary': 'sk_1' })
    store.set('emp-2', { 'expense-audit': 'sk_2' })

    expect(store.get('emp-1')).toEqual({ 'invoice-summary': 'sk_1' })
    expect(store.get('emp-2')).toEqual({ 'expense-audit': 'sk_2' })
  })

  it('removes the entry when set to undefined', () => {
    const harness = createHarness()
    const store = createSkillSyncStateStore(harness)

    store.set('emp-1', { 'invoice-summary': 'sk_1' })
    store.set('emp-1', undefined)

    expect(store.get('emp-1')).toBeUndefined()
    expect(harness.raw()).toEqual({})
  })

  it('removes the entry when set to an empty baseline', () => {
    const harness = createHarness()
    const store = createSkillSyncStateStore(harness)

    store.set('emp-1', { 'invoice-summary': 'sk_1' })
    store.set('emp-1', {})

    // An empty map means "nothing installed"; keeping it would make the store
    // accumulate one dead key per employee that ever had a skill removed.
    expect(store.get('emp-1')).toBeUndefined()
  })

  it('does not write when removing an unknown employee', () => {
    const harness = createHarness()
    const store = createSkillSyncStateStore(harness)

    store.set('emp-1', undefined)

    expect(harness.raw()).toBeUndefined()
  })

  it('ignores a malformed entry without losing the others', () => {
    const store = createSkillSyncStateStore(
      createHarness({
        'emp-1': { 'invoice-summary': 'sk_1' },
        'emp-2': 'not-an-object',
        'emp-3': { slug: 1 }
      })
    )

    expect(store.get('emp-1')).toEqual({ 'invoice-summary': 'sk_1' })
    expect(store.get('emp-2')).toBeUndefined()
    expect(store.get('emp-3')).toBeUndefined()
  })

  it('treats a non-object root as empty, keeping the other employees writable', () => {
    const harness = createHarness(['unexpected'])
    const store = createSkillSyncStateStore(harness)

    expect(store.get('emp-1')).toBeUndefined()

    store.set('emp-1', { 'invoice-summary': 'sk_1' })
    expect(store.get('emp-1')).toEqual({ 'invoice-summary': 'sk_1' })
  })

  it('uses the documented settings key by default', () => {
    const harness = createHarness()
    const store = createSkillSyncStateStore(harness)

    store.set('emp-1', { a: 'b' })

    expect(DIGITAL_EMPLOYEE_SKILL_SYNC_KEY).toBe('digitalEmployee.skillSync')
    expect(harness.raw()).toEqual({ 'emp-1': { a: 'b' } })
  })
})
