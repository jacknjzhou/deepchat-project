// test/renderer/components/ReimbursementView.test.ts
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import ReimbursementView from '@/pages/documents/ReimbursementView.vue'
import { rendererNotificationManager } from '@renderer-notifications/rendererNotificationRuntime'
import { useDocumentsStore } from '@/stores/documents'

// test/setup.renderer.ts mocks a lightweight pinia globally; restore the real one
// so the test store and the mounted component share the same pinia instance.
vi.mock('pinia', async () => vi.importActual<typeof import('pinia')>('pinia'))

const configClientMock = vi.hoisted(() => ({
  openSettings: vi.fn(async () => undefined)
}))
vi.mock('@api/ConfigClient', () => ({ createConfigClient: () => configClientMock }))

const dcButtonStub = defineComponent({
  name: 'DcButtonStub',
  props: ['variant', 'size', 'disabled'],
  template: '<button :disabled="disabled"><slot /></button>'
})

const dcBadgeStub = defineComponent({
  name: 'DcBadgeStub',
  props: ['variant'],
  template: '<span><slot /></span>'
})

// jsdom has no layout: render all tree rows and forward the scoped slot.
const recycleScrollerStub = defineComponent({
  name: 'RecycleScrollerStub',
  props: {
    items: { type: Array, default: () => [] },
    itemSize: { type: null },
    minItemSize: { type: Number }
  },
  template: `
    <div>
      <div v-for="(item, index) in items" :key="item.key">
        <slot :item="item" :index="index" />
      </div>
    </div>
  `
})

const mountView = (pinia: ReturnType<typeof createPinia>) =>
  mount(ReimbursementView, {
    global: {
      plugins: [pinia],
      stubs: { DcButton: dcButtonStub, DcBadge: dcBadgeStub, RecycleScroller: recycleScrollerStub }
    }
  })

function setupStore() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return { pinia, store: useDocumentsStore() }
}

function makeTree() {
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
        materials: [],
        groups: [
          {
            person: '张三',
            buckets: [
              {
                period: '2026-09',
                documents: [
                  {
                    id: 'd1',
                    typeKey: 'meeting_minutes',
                    templateName: '会议纪要',
                    person: '张三',
                    period: '2026-09',
                    amount: 100,
                    amountUncertain: false,
                    uncertainCount: 0,
                    fileNames: ['a.pdf'],
                    isOverride: false
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    unassigned: [
      {
        person: '李四',
        buckets: [
          {
            period: '2026-08',
            documents: [
              {
                id: 'd2',
                typeKey: 'meeting_minutes',
                templateName: '会议纪要',
                person: '李四',
                period: '2026-08',
                amount: 50,
                amountUncertain: false,
                uncertainCount: 0,
                fileNames: ['b.pdf'],
                isOverride: false
              }
            ]
          }
        ]
      }
    ],
    summary: [
      { categoryId: 'cat-a', total: 1 },
      { categoryId: null, total: 1 }
    ]
  }
}

describe('ReimbursementView', () => {
  it('renders the full tree from the store', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    store.reimbursementTree = makeTree()
    const wrapper = mountView(pinia)
    await flushPromises()
    expect(wrapper.find('[data-testid="reimbursement-view"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('会议费')
    expect(wrapper.text()).toContain('张三')
    expect(wrapper.text()).toContain('a.pdf')
    expect(wrapper.text()).toContain('b.pdf')
  })

  it('moves document via override select', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    vi.spyOn(store, 'setReimbursementOverride').mockResolvedValue()
    store.reimbursementTree = makeTree()
    const wrapper = mountView(pinia)
    await flushPromises()
    const select = wrapper.get('[data-testid="reimbursement-entry-d1"] select')
    expect(select.exists()).toBe(true)
    await select.setValue('cat-a')
    expect(store.setReimbursementOverride).toHaveBeenCalledWith('d1', 'cat-a')
  })

  it('exports package and notifies success once', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    let resolveExport!: (value: { canceled: boolean; path: string; exportedFiles: number }) => void
    const exportPromise = new Promise<{ canceled: boolean; path: string; exportedFiles: number }>(
      (resolve) => {
        resolveExport = resolve
      }
    )
    vi.spyOn(store, 'exportReimbursementPackage').mockReturnValue(exportPromise)
    const notifySpy = vi
      .spyOn(rendererNotificationManager, 'notify')
      .mockImplementation(() => undefined)
    const wrapper = mountView(pinia)
    await flushPromises()
    const exportButton = wrapper.get('[data-testid="reimbursement-export"]')
    await exportButton.trigger('click')
    await exportButton.trigger('click')
    resolveExport({ canceled: false, path: 'D:\\pkg', exportedFiles: 2 })
    await flushPromises()
    expect(store.exportReimbursementPackage).toHaveBeenCalledTimes(1)
    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'success', code: 'documents.reimbursement.exportSuccess' })
    )
  })

  it('mirrors the owning category on overridden selects', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    const tree = makeTree()
    tree.tree[0].groups[0].buckets[0].documents[0].isOverride = true
    store.reimbursementTree = tree
    const wrapper = mountView(pinia)
    await flushPromises()
    const select = wrapper.get('[data-testid="reimbursement-entry-d1"] select')
    expect((select.element as HTMLSelectElement).value).toBe('cat-a')
  })

  it('shows forced-unassigned and auto values for unassigned entries', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    const tree = makeTree()
    tree.unassigned[0].buckets[0].documents[0].isOverride = true
    store.reimbursementTree = tree
    const wrapper = mountView(pinia)
    await flushPromises()
    const overridden = wrapper.get('[data-testid="reimbursement-entry-d2"] select')
    expect((overridden.element as HTMLSelectElement).value).toBe('__unassigned__')
  })

  it('notifies an error when moving fails', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    vi.spyOn(store, 'setReimbursementOverride').mockRejectedValue(new Error('boom'))
    const notifySpy = vi
      .spyOn(rendererNotificationManager, 'notify')
      .mockImplementation(() => undefined)
    store.reimbursementTree = makeTree()
    const wrapper = mountView(pinia)
    await flushPromises()
    await wrapper.get('[data-testid="reimbursement-entry-d1"] select').setValue('cat-a')
    await flushPromises()
    expect(store.setReimbursementOverride).toHaveBeenCalledWith('d1', 'cat-a')
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', code: 'documents.reimbursement.moveFailed' })
    )
  })

  it('filters to the unassigned branch only', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    store.reimbursementTree = makeTree()
    const wrapper = mountView(pinia)
    await flushPromises()
    expect(wrapper.text()).toContain('会议费')
    await wrapper.get('[data-testid="reimbursement-unassigned-only"]').trigger('click')
    // category rows are hidden but entry selects keep category options for inline reclassification
    expect(wrapper.find('[data-testid="reimbursement-toggle-cat:cat-a"]').exists()).toBe(false)
    expect(
      wrapper.get('[data-testid="reimbursement-entry-d2"] select option[value="cat-a"]')
    ).toBeTruthy()
    expect(wrapper.text()).toContain('b.pdf')
  })

  it('opens the category management settings from the toolbar', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    store.reimbursementTree = makeTree()
    const wrapper = mountView(pinia)
    await flushPromises()
    await wrapper.get('[data-testid="reimbursement-manage-categories"]').trigger('click')
    expect(configClientMock.openSettings).toHaveBeenCalledWith({
      routeName: 'settings-documents-reimbursement'
    })
  })

  it('keeps the error state with retry from the toolbar area', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    store.reimbursementLoadError = 'settings.documents.reimbursement.loadFailed'
    const wrapper = mountView(pinia)
    await flushPromises()
    expect(wrapper.find('[data-testid="reimbursement-retry"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('settings.documents.reimbursement.loadFailed')
  })
})
