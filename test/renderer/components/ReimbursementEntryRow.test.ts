import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ReimbursementEntryRow from '@/pages/documents/ReimbursementEntryRow.vue'

const entry = {
  id: 'd1',
  typeKey: 'meeting_minutes',
  templateName: '会议纪要',
  person: '孙若愚',
  period: '2026-03',
  amount: 1083.88,
  amountUncertain: false,
  uncertainCount: 0,
  fileNames: ['a.pdf'],
  isOverride: true,
  groupId: null
} as never

const groups = [
  { id: 'grp-a', name: '分组一', sortOrder: 0 },
  { id: 'grp-b', name: '分组二', sortOrder: 1 }
]

// 注：测试环境 vue-i18n 被全局 mock（t 返回 key 本身），断言用 key 字符串而非中文文案。

describe('ReimbursementEntryRow', () => {
  it('renders group select with groups and current value', () => {
    const wrapper = mount(ReimbursementEntryRow, {
      props: {
        entry: { ...entry, groupId: 'grp-a' },
        groups,
        categories: [],
        showGroupSelect: true
      }
    })
    const select = wrapper.find('[data-testid="reimbursement-group-d1"]')
    expect(select.exists()).toBe(true)
    expect((select.element as HTMLSelectElement).value).toBe('grp-a')
    expect(select.findAll('option').length).toBe(3) // 未分组 + 2 分组
  })

  it('disables group select when category has no groups', () => {
    const wrapper = mount(ReimbursementEntryRow, {
      props: { entry, groups: [], categories: [], showGroupSelect: true }
    })
    expect(
      (wrapper.find('[data-testid="reimbursement-group-d1"]').element as HTMLSelectElement).disabled
    ).toBe(true)
  })

  it('hides group select for unassigned view', () => {
    const wrapper = mount(ReimbursementEntryRow, {
      props: { entry, groups: [], categories: [], showGroupSelect: false }
    })
    expect(wrapper.find('[data-testid="reimbursement-group-d1"]').exists()).toBe(false)
  })

  it('emits the raw __none__ sentinel for clearing', async () => {
    const wrapper = mount(ReimbursementEntryRow, {
      props: { entry, groups, categories: [], showGroupSelect: true }
    })
    await wrapper.find('[data-testid="reimbursement-group-d1"]').setValue('__none__')
    expect(wrapper.emitted('moveGroup')?.at(-1)?.[0]).toBe('d1')
    expect(wrapper.emitted('moveGroup')?.at(-1)?.[1]).toBe('__none__')
  })
})
