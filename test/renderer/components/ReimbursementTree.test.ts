import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import ReimbursementTree from '@/pages/documents/ReimbursementTree.vue'

const dcBadgeStub = defineComponent({
  name: 'DcBadgeStub',
  props: ['variant'],
  template: '<span><slot /></span>'
})

// jsdom has no layout: render all items and forward the scoped slot.
const recycleScrollerStub = defineComponent({
  name: 'RecycleScrollerStub',
  props: { items: { type: Array, default: () => [] }, itemSize: { type: null }, minItemSize: { type: Number } },
  template: `
    <div>
      <div v-for="(item, index) in items" :key="item.key">
        <slot :item="item" :index="index" />
      </div>
    </div>
  `
})

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    typeKey: 'meeting_minutes',
    templateName: '会议纪要',
    person: '张三',
    period: '2026-09',
    amount: 100,
    amountUncertain: false,
    uncertainCount: 0,
    fileNames: ['a.pdf'],
    isOverride: false,
    ...overrides
  }
}

function makeProps(unassigned = []) {
  return {
    tree: [
      {
        category: {
          id: 'cat-a',
          name: '会议费',
          requiredMaterials: [],
          linkedTypeKeys: [],
          sortOrder: 1
        },
        total: 1,
        materials: [{ name: '发票', linkedTypeKeys: ['invoice'], count: 2 }],
        groups: [
          {
            person: '张三',
            buckets: [{ period: '2026-09', documents: [entry()] }]
          }
        ]
      }
    ],
    unassigned
  }
}

function mountTree(props: Record<string, unknown> = {}) {
  return mount(ReimbursementTree, {
    props: { ...makeProps(), ...props },
    global: {
      stubs: { DcBadge: dcBadgeStub, Icon: true, RecycleScroller: recycleScrollerStub }
    }
  })
}

describe('ReimbursementTree', () => {
  it('renders category, person, period and entry rows with counts', () => {
    const wrapper = mountTree()
    expect(wrapper.text()).toContain('会议费')
    expect(wrapper.text()).toContain('张三')
    expect(wrapper.text()).toContain('2026-09')
    expect(wrapper.text()).toContain('a.pdf')
    expect(wrapper.find('[data-testid="reimbursement-toggle-cat:cat-a"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="reimbursement-toggle-unassigned"]').exists()).toBe(true)
  })

  it('collapsing a category hides its descendants but keeps the header', async () => {
    const wrapper = mountTree()
    await wrapper.get('[data-testid="reimbursement-toggle-cat:cat-a"]').trigger('click')
    expect(wrapper.text()).not.toContain('张三')
    expect(wrapper.text()).not.toContain('a.pdf')
    expect(wrapper.text()).toContain('会议费')
  })

  it('renders the unassigned group last without a materials button', () => {
    const wrapper = mountTree()
    const buttons = wrapper.findAll('[data-testid^="reimbursement-materials-"]')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].attributes('data-testid')).toBe('reimbursement-materials-cat-a')
    expect(wrapper.find('[data-testid="reimbursement-toggle-unassigned"]').exists()).toBe(true)
  })

  it('toggles the materials row under a category node', async () => {
    const wrapper = mountTree()
    expect(wrapper.text()).not.toContain('发票')
    await wrapper.get('[data-testid="reimbursement-materials-cat-a"]').trigger('click')
    expect(wrapper.text()).toContain('发票')
  })

  it('emits move with the selected category id from an entry select', async () => {
    const wrapper = mountTree()
    await wrapper.get('[data-testid="reimbursement-entry-d1"] select').setValue('cat-a')
    expect(wrapper.emitted('move')?.at(-1)?.[0]).toEqual('d1')
    expect(wrapper.emitted('move')?.at(-1)?.[1]).toEqual('cat-a')
  })

  it('mirrors the owning category for overrides and the sentinel in unassigned', () => {
    // tree 分支的 d1 与 unassigned 分支的 d1 都必须是 isOverride:true。
    const base = makeProps()
    base.tree[0].groups[0].buckets[0].documents[0].isOverride = true
    const wrapper = mount(ReimbursementTree, {
      props: {
        ...base,
        unassigned: [
          {
            person: '李四',
            buckets: [
              {
                period: '2026-09',
                documents: [
                  entry({ id: 'd1', person: '李四', isOverride: true }),
                  entry({ id: 'd2', person: '李四', isOverride: false })
                ]
              }
            ]
          }
        ]
      },
      global: {
        stubs: { DcBadge: dcBadgeStub, Icon: true, RecycleScroller: recycleScrollerStub }
      }
    })
    // category 分支中的 override 条目映射其所属类别 id
    const d1Selects = wrapper.findAll('[data-testid="reimbursement-entry-d1"] select')
    expect(d1Selects).toHaveLength(2)
    expect((d1Selects[0].element as HTMLSelectElement).value).toBe('cat-a')
    // unassigned 分支中的 override 条目映射哨兵值
    expect((d1Selects[1].element as HTMLSelectElement).value).toBe('__unassigned__')
    // 自动归类条目保持 __auto__
    const autoSelect = wrapper.get('[data-testid="reimbursement-entry-d2"] select')
    expect((autoSelect.element as HTMLSelectElement).value).toBe('__auto__')
  })

  it('showUnassignedOnly hides the category branch', () => {
    const wrapper = mountTree({ showUnassignedOnly: true })
    expect(wrapper.text()).not.toContain('会议费')
    expect(wrapper.find('[data-testid="reimbursement-toggle-unassigned"]').exists()).toBe(true)
  })

  it('renders the empty state when neither categories nor documents exist', () => {
    const wrapper = mountTree({ tree: [], unassigned: [] })
    expect(wrapper.find('[data-testid="reimbursement-toggle-unassigned"]').exists()).toBe(false)
    // The suite-wide vue-i18n mock renders message keys instead of translations.
    expect(wrapper.text()).toContain('settings.documents.reimbursement.empty')
  })

  it('falls back to unknown labels and keys when person or period is null', () => {
    const props = makeProps()
    props.tree[0].groups = [
      {
        person: null,
        buckets: [{ period: null, documents: [entry({ person: null, period: null })] }]
      }
    ]
    const wrapper = mountTree(props)
    expect(wrapper.text()).toContain('settings.documents.reimbursement.unknownPerson')
    expect(wrapper.text()).toContain('settings.documents.reimbursement.unknownPeriod')
    expect(
      wrapper.find('[data-testid="reimbursement-toggle-cat:cat-a:p:unknown"]').exists()
    ).toBe(true)
    expect(
      wrapper
        .find('[data-testid="reimbursement-toggle-cat:cat-a:p:unknown:b:unknown"]')
        .exists()
    ).toBe(true)
  })

  it('renders count badges and hides material badge without linked type keys', async () => {
    const wrapper = mountTree()
    const categoryHeader = wrapper.get(
      '[data-testid="reimbursement-toggle-cat:cat-a"]'
    ).element.parentElement
    expect(categoryHeader?.textContent).toContain('1')

    const props = makeProps()
    props.tree[0].materials = [{ name: '收据', linkedTypeKeys: [], count: 0 }]
    const materialsWrapper = mountTree(props)
    await materialsWrapper.get('[data-testid="reimbursement-materials-cat-a"]').trigger('click')
    expect(materialsWrapper.text()).toContain('收据')
    // Empty linkedTypeKeys hides the materialCount badge; the i18n mock renders keys.
    expect(materialsWrapper.text()).not.toContain(
      'settings.documents.reimbursement.materialCount'
    )
  })

  it('hides the amount for entries without one', () => {
    const props = makeProps()
    props.tree[0].groups[0].buckets[0].documents[0].amount = null
    const wrapper = mountTree(props)
    expect(wrapper.get('[data-testid="reimbursement-entry-d1"]').text()).not.toContain('¥')
  })
})
