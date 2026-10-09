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

const mountView = (pinia: ReturnType<typeof createPinia>) =>
  mount(ReimbursementView, {
    global: { plugins: [pinia], stubs: { DcButton: dcButtonStub, DcBadge: dcBadgeStub } }
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
    unassigned: [],
    summary: [{ categoryId: 'cat-a', total: 1 }]
  }
}

describe('ReimbursementView', () => {
  it('renders category list and groups from store tree', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    store.reimbursementTree = makeTree()
    const wrapper = mountView(pinia)
    await flushPromises()
    expect(wrapper.find('[data-testid="reimbursement-view"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('会议费')
    expect(wrapper.text()).toContain('张三')
    expect(wrapper.text()).toContain('a.pdf')
  })

  it('moves document via override select', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    vi.spyOn(store, 'setReimbursementOverride').mockResolvedValue()
    store.reimbursementTree = makeTree()
    const wrapper = mountView(pinia)
    await flushPromises()
    const select = wrapper.find('[data-testid="reimbursement-entry-d1"] select')
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
    const request = notifySpy.mock.calls[0][0] as { kind: string; title: string }
    expect(request.kind).toBe('success')
    expect(request.title).toContain('exportDone')
  })
})
