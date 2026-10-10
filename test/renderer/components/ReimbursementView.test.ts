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

type FixtureEntry = {
  id: string
  typeKey: string
  templateName: string
  person: string | null
  period: string | null
  amount: number | null
  amountUncertain: boolean
  uncertainCount: number
  fileNames: string[]
  isOverride: boolean
  groupId: string | null
}

type FixtureCustomGroup = {
  group: { id: string; name: string; sortOrder: number }
  buckets: Array<{ period: string | null; documents: FixtureEntry[] }>
}

function makeEntry(id: string, overrides: Partial<FixtureEntry> = {}): FixtureEntry {
  return {
    id,
    typeKey: 'meeting_minutes',
    templateName: '会议纪要',
    person: '张三',
    period: '2026-09',
    amount: 100,
    amountUncertain: false,
    uncertainCount: 0,
    fileNames: ['a.pdf'],
    isOverride: false,
    groupId: null,
    ...overrides
  }
}

function makeTreeFixture({
  ungroupedDocuments = [],
  groupedDocuments = [],
  customGroups
}: {
  ungroupedDocuments?: FixtureEntry[]
  groupedDocuments?: FixtureEntry[]
  customGroups?: FixtureCustomGroup[]
} = {}) {
  const nodeCustomGroups =
    customGroups ??
    (groupedDocuments.length
      ? [
          {
            group: { id: 'grp-a', name: '分组一', sortOrder: 0 },
            buckets: [{ period: '2026-09', documents: groupedDocuments }]
          }
        ]
      : [])
  const total = ungroupedDocuments.length + groupedDocuments.length
  return {
    tree: [
      {
        category: {
          id: 'cat-a',
          name: '会议费',
          requiredMaterials: [],
          linkedTypeKeys: [],
          customGroups: [
            ...new Map(nodeCustomGroups.map((node) => [node.group.id, node.group])).values()
          ],
          sortOrder: 1
        },
        total,
        materials: [],
        groups:
          ungroupedDocuments.length > 0
            ? [{ person: '张三', buckets: [{ period: '2026-09', documents: ungroupedDocuments }] }]
            : [],
        customGroups: nodeCustomGroups
      }
    ],
    unassigned: [],
    summary: [{ categoryId: 'cat-a', total }]
  }
}

function makeTree(firstEntryOverride = false) {
  return makeTreeFixture({
    ungroupedDocuments: [makeEntry('d1', { isOverride: firstEntryOverride })]
  })
}

function makeConfig(customGroups: Array<{ id: string; name: string; sortOrder: number }>) {
  return {
    version: 1 as const,
    categories: [
      {
        id: 'cat-a',
        name: '会议费',
        requiredMaterials: [],
        linkedTypeKeys: [],
        customGroups,
        sortOrder: 1
      }
    ],
    personFieldKeys: [],
    dateFieldKeys: [],
    amountFieldKeys: [],
    dateGrouping: 'month' as const
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
    // Each entry row now renders a group select first; the category select
    // is the second native <select> inside the row.
    const selects = wrapper.findAll('[data-testid="reimbursement-entry-d1"] select')
    await selects[1]!.setValue('cat-a')
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
    store.reimbursementTree = makeTree(true)
    const wrapper = mountView(pinia)
    await flushPromises()
    // The view lands on the first category, so the overridden entry shows
    // its owning category id instead of a blank native select.
    const selects = wrapper.findAll('[data-testid="reimbursement-entry-d1"] select')
    expect((selects[1]!.element as HTMLSelectElement).value).toBe('cat-a')
  })

  it('shows forced-unassigned and auto values in the unassigned view', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    store.reimbursementTree = {
      tree: [],
      unassigned: [
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
                  isOverride: true,
                  groupId: null
                },
                {
                  id: 'd2',
                  typeKey: 'meeting_minutes',
                  templateName: '会议纪要',
                  person: '张三',
                  period: '2026-09',
                  amount: 100,
                  amountUncertain: false,
                  uncertainCount: 0,
                  fileNames: ['b.pdf'],
                  isOverride: false,
                  groupId: null
                }
              ]
            }
          ]
        }
      ],
      summary: []
    }
    const wrapper = mountView(pinia)
    await flushPromises()
    // Empty tree keeps the view on unassigned: overridden entries map to the
    // sentinel option while auto-classified ones keep the auto option.
    const overridden = wrapper.get('[data-testid="reimbursement-entry-d1"] select')
    expect((overridden.element as HTMLSelectElement).value).toBe('__unassigned__')
    const automatic = wrapper.get('[data-testid="reimbursement-entry-d2"] select')
    expect((automatic.element as HTMLSelectElement).value).toBe('__auto__')
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
    const selects = wrapper.findAll('[data-testid="reimbursement-entry-d1"] select')
    await selects[1]!.setValue('cat-a')
    await flushPromises()
    expect(store.setReimbursementOverride).toHaveBeenCalledWith('d1', 'cat-a')
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', code: 'documents.reimbursement.moveFailed' })
    )
  })

  it('renders group select on entries and moves grouped entries to the custom group section', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    store.reimbursementTree = makeTreeFixture({
      ungroupedDocuments: [makeEntry('d-ungrouped')],
      groupedDocuments: [makeEntry('d-grouped', { groupId: 'grp-a' })]
    })
    const wrapper = mountView(pinia)
    await flushPromises()
    const root = wrapper.element as HTMLElement
    const groupSection = root.querySelector('[data-testid="reimbursement-custom-group-grp-a"]')
    expect(groupSection).not.toBeNull()
    // The grouped entry renders exactly once, inside the custom group section.
    const groupedRows = root.querySelectorAll('[data-testid="reimbursement-entry-d-grouped"]')
    expect(groupedRows).toHaveLength(1)
    expect(groupedRows[0] !== null && groupSection?.contains(groupedRows[0])).toBe(true)
    // The person→period blocks only hold ungrouped entries.
    const personBlocks = root.querySelectorAll('div.mb-5')
    expect(personBlocks.length).toBeGreaterThan(0)
    for (const block of personBlocks) {
      expect(block.querySelector('[data-testid="reimbursement-entry-d-grouped"]')).toBeNull()
    }
    expect(
      personBlocks[0]?.querySelector('[data-testid="reimbursement-entry-d-ungrouped"]')
    ).not.toBeNull()
    // Entry rows expose the group select with the current value.
    const ungroupedSelect = wrapper.get('[data-testid="reimbursement-group-d-ungrouped"]')
    expect((ungroupedSelect.element as HTMLSelectElement).value).toBe('__none__')
    const groupedSelect = wrapper.get('[data-testid="reimbursement-group-d-grouped"]')
    expect((groupedSelect.element as HTMLSelectElement).value).toBe('grp-a')
  })

  it('add group saves config with appended customGroup', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    const config = makeConfig([])
    store.reimbursementConfig = config
    vi.spyOn(store, 'loadReimbursementConfig').mockResolvedValue(config)
    vi.spyOn(store, 'saveReimbursementConfig').mockResolvedValue(config)
    store.reimbursementTree = makeTree()
    const wrapper = mountView(pinia)
    await flushPromises()
    await wrapper.get('[data-testid="reimbursement-add-group"]').trigger('click')
    await wrapper.get('[data-testid="reimbursement-new-group-name"]').setValue('  差旅  ')
    await wrapper.get('[data-testid="reimbursement-add-group-confirm"]').trigger('click')
    await flushPromises()
    expect(store.saveReimbursementConfig).toHaveBeenCalledTimes(1)
    const sent = vi.mocked(store.saveReimbursementConfig).mock.calls[0]![0]
    const category = sent.categories.find((item) => item.id === 'cat-a')
    expect(category?.customGroups).toHaveLength(1)
    expect(category?.customGroups[0]?.name).toBe('差旅')
    expect(category?.customGroups[0]?.id).toMatch(/^grp-/)
  })

  it('keeps the add-group form input when saving fails', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    const config = makeConfig([])
    store.reimbursementConfig = config
    vi.spyOn(store, 'loadReimbursementConfig').mockResolvedValue(config)
    vi.spyOn(store, 'saveReimbursementConfig').mockRejectedValue(new Error('boom'))
    const notifySpy = vi
      .spyOn(rendererNotificationManager, 'notify')
      .mockImplementation(() => undefined)
    store.reimbursementTree = makeTree()
    const wrapper = mountView(pinia)
    await flushPromises()
    await wrapper.get('[data-testid="reimbursement-add-group"]').trigger('click')
    await wrapper.get('[data-testid="reimbursement-new-group-name"]').setValue('差旅')
    await wrapper.get('[data-testid="reimbursement-add-group-confirm"]').trigger('click')
    await flushPromises()
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', code: 'documents.reimbursement.groupSaveFailed' })
    )
    const input = wrapper.get('[data-testid="reimbursement-new-group-name"]')
    expect((input.element as HTMLInputElement).value).toBe('差旅')
  })

  it('resets the add-group form when switching categories', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    store.reimbursementTree = makeTree()
    const wrapper = mountView(pinia)
    await flushPromises()
    await wrapper.get('[data-testid="reimbursement-add-group"]').trigger('click')
    await wrapper.get('[data-testid="reimbursement-new-group-name"]').setValue('差旅')
    await wrapper.get('[data-testid="reimbursement-category-unassigned"]').trigger('click')
    expect(wrapper.find('[data-testid="reimbursement-new-group-name"]').exists()).toBe(false)
    await wrapper.get('[data-testid="reimbursement-category-cat-a"]').trigger('click')
    await wrapper.get('[data-testid="reimbursement-add-group"]').trigger('click')
    const input = wrapper.get('[data-testid="reimbursement-new-group-name"]')
    expect((input.element as HTMLInputElement).value).toBe('')
  })

  it('delete group removes it from config', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    const config = makeConfig([{ id: 'grp-a', name: '分组一', sortOrder: 0 }])
    store.reimbursementConfig = config
    vi.spyOn(store, 'loadReimbursementConfig').mockResolvedValue(config)
    vi.spyOn(store, 'saveReimbursementConfig').mockResolvedValue(config)
    store.reimbursementTree = makeTreeFixture({
      ungroupedDocuments: [makeEntry('d1')],
      customGroups: [{ group: { id: 'grp-a', name: '分组一', sortOrder: 0 }, buckets: [] }]
    })
    const wrapper = mountView(pinia)
    await flushPromises()
    await wrapper.get('[data-testid="reimbursement-group-delete-grp-a"]').trigger('click')
    await flushPromises()
    expect(store.saveReimbursementConfig).toHaveBeenCalledTimes(1)
    const sent = vi.mocked(store.saveReimbursementConfig).mock.calls[0]![0]
    const category = sent.categories.find((item) => item.id === 'cat-a')
    expect(category?.customGroups).toHaveLength(0)
  })

  it('moveGroup action wires entry select to setReimbursementGroupOverride', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    vi.spyOn(store, 'setReimbursementGroupOverride').mockResolvedValue()
    store.reimbursementTree = makeTreeFixture({
      ungroupedDocuments: [makeEntry('d2')],
      customGroups: [{ group: { id: 'grp-a', name: '分组一', sortOrder: 0 }, buckets: [] }]
    })
    const wrapper = mountView(pinia)
    await flushPromises()
    await wrapper.get('[data-testid="reimbursement-group-d2"]').setValue('grp-a')
    await flushPromises()
    expect(store.setReimbursementGroupOverride).toHaveBeenCalledWith('d2', 'grp-a')
  })

  it('unassigned view hides group select', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    store.reimbursementTree = {
      ...makeTreeFixture({ ungroupedDocuments: [makeEntry('d1')] }),
      unassigned: [
        {
          person: '张三',
          buckets: [{ period: '2026-09', documents: [makeEntry('d9', { isOverride: true })] }]
        }
      ]
    }
    const wrapper = mountView(pinia)
    await flushPromises()
    await wrapper.get('[data-testid="reimbursement-category-unassigned"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid^="reimbursement-group-"]')).toHaveLength(0)
  })
})
