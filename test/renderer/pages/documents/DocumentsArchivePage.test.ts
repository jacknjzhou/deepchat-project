import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, reactive } from 'vue'

const fragmentStub = (name: string) => defineComponent({ name, template: '<slot />' })

const contractTemplate = {
  id: 'tpl_contract',
  typeKey: 'contract',
  name: 'Contract',
  icon: null,
  category: '合同类',
  fields: [
    {
      key: 'buyer',
      label: '购买方',
      valueType: 'text',
      required: true,
      promptHint: null,
      validation: null,
      enumOptions: null,
      order: 1
    }
  ],
  extractionMode: 'auto',
  promptPreset: null,
  isBuiltin: true,
  builtinSourceId: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1
}

const makeRecord = (overrides = {}) => ({
  id: 'd1',
  templateId: 'tpl-1',
  typeKey: 'contract',
  templateSnapshot: {
    fields: [
      {
        key: 'buyer',
        label: '购买方',
        valueType: 'text',
        required: true,
        promptHint: null,
        validation: null,
        enumOptions: null,
        order: 1
      }
    ]
  },
  fields: { buyer: { value: '甲公司', uncertain: false } },
  fileUris: [],
  source: 'manual',
  sessionId: null,
  status: 'draft',
  createdAt: 1700000000000,
  updatedAt: 1700000100000,
  ...overrides
})

const notifyMock = vi.fn()

const DetailDialogStub = defineComponent({
  name: 'DocumentDetailDialogStub',
  props: ['open', 'document'],
  emits: ['update:open', 're-recognized'],
  template:
    '<div data-testid="detail-dialog-stub" :data-open="String(open)" :data-document-id="document?.id ?? \'\'" />'
})

const RecognizeDialogStub = defineComponent({
  name: 'DocumentRecognizeDialogStub',
  props: ['open'],
  emits: ['update:open', 'recognized'],
  template: '<div data-testid="recognize-dialog-stub" :data-open="String(open)" />'
})

// Reactive like the real pinia store: the table and filters read store state
// across renders, so slot/table content only stays correct with reactivity.
const stubStore = reactive({
  templates: [contractTemplate] as Array<Record<string, unknown>>,
  archiveDocuments: [] as Array<Record<string, unknown>>,
  archiveIsLoading: false,
  archiveLoadError: null as string | null,
  archiveHasMore: false,
  archiveFilter: {
    typeKey: undefined as string | undefined,
    status: undefined as string | undefined,
    keyword: undefined as string | undefined,
    dateFrom: undefined as number | undefined,
    dateTo: undefined as number | undefined
  },
  loadTemplates: vi.fn(async () => {}),
  loadArchiveDocuments: vi.fn(async (_reset = true) => {}),
  exportArchiveCsv: vi.fn(async () => ({
    canceled: true as boolean,
    path: undefined as string | undefined
  }))
})

const inputStub = defineComponent({
  name: 'InputStub',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup(_, { emit }) {
    return {
      handleInput: (event: Event) => {
        emit('update:modelValue', (event.target as HTMLInputElement).value)
      }
    }
  },
  template: '<input :value="modelValue" @input="handleInput" />'
})

const selectStub = defineComponent({
  name: 'SelectStub',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup(_, { emit }) {
    return {
      handleChange: (event: Event) => {
        emit('update:modelValue', (event.target as HTMLSelectElement).value)
      }
    }
  },
  template: '<select :value="modelValue" @change="handleChange"><slot /></select>'
})

const selectItemStub = defineComponent({
  name: 'SelectItemStub',
  props: ['value'],
  template: '<option :value="value"><slot /></option>'
})

const dcButtonStub = defineComponent({
  name: 'DcButtonStub',
  props: ['variant', 'size', 'disabled'],
  template: '<button :disabled="disabled"><slot /></button>'
})

async function setup(options: { loadError?: string; hasMore?: boolean } = {}) {
  vi.resetModules()
  stubStore.templates = [contractTemplate]
  stubStore.archiveDocuments = [makeRecord()]
  stubStore.archiveIsLoading = false
  stubStore.archiveLoadError = options.loadError ?? null
  stubStore.archiveHasMore = options.hasMore ?? false
  stubStore.archiveFilter.typeKey = undefined
  stubStore.archiveFilter.status = undefined
  stubStore.archiveFilter.keyword = undefined
  stubStore.archiveFilter.dateFrom = undefined
  stubStore.archiveFilter.dateTo = undefined
  vi.doMock('@/stores/documents', () => ({
    useDocumentsStore: () => stubStore
  }))
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key
    })
  }))
  vi.doMock('@renderer-notifications/rendererNotificationRuntime', () => ({
    rendererNotificationManager: { notify: notifyMock }
  }))
  vi.doMock('@/pages/documents/DocumentDetailDialog.vue', () => ({ default: DetailDialogStub }))
  vi.doMock('@/pages/documents/DocumentRecognizeDialog.vue', () => ({
    default: RecognizeDialogStub
  }))
  const DocumentsArchivePage = (
    await import('../../../../src/renderer/src/pages/documents/DocumentsArchivePage.vue')
  ).default

  const wrapper = mount(DocumentsArchivePage, {
    global: {
      stubs: {
        Icon: true,
        Input: inputStub,
        Select: selectStub,
        // Fragment stubs: <option> must be a direct child of <select> for the
        // jsdom options collection (and therefore setValue) to see it.
        SelectTrigger: fragmentStub('SelectTrigger'),
        SelectValue: fragmentStub('SelectValue'),
        SelectContent: fragmentStub('SelectContent'),
        SelectItem: selectItemStub,
        DcButton: dcButtonStub
      }
    }
  })
  await flushPromises()
  return { wrapper }
}

describe('DocumentsArchivePage', () => {
  beforeEach(() => {
    notifyMock.mockClear()
    stubStore.loadTemplates.mockClear()
    stubStore.loadArchiveDocuments.mockClear()
    stubStore.exportArchiveCsv.mockClear()
  })

  it('挂载时调用 loadArchiveDocuments 并渲染行', async () => {
    const { wrapper } = await setup()
    expect(stubStore.loadArchiveDocuments).toHaveBeenCalled()
    expect(wrapper.text()).toContain('甲公司')
    expect(wrapper.text()).toContain('购买方')
  })

  it('全部类型视图渲染摘要列', async () => {
    const { wrapper } = await setup()
    expect(wrapper.text()).toContain('settings.documents.archive.colSummary')
    expect(wrapper.text()).toContain('购买方: 甲公司')
  })

  it('修改类型筛选后调用 loadArchiveDocuments', async () => {
    const { wrapper } = await setup()
    stubStore.loadArchiveDocuments.mockClear()
    await wrapper.get('[data-testid="archive-filter-type"]').setValue('contract')
    await flushPromises()
    expect(stubStore.loadArchiveDocuments).toHaveBeenCalled()
    expect(stubStore.archiveFilter.typeKey).toBe('contract')
  })

  it('导出按钮调用 exportArchiveCsv 并按结果提示', async () => {
    const { wrapper } = await setup()
    stubStore.exportArchiveCsv.mockResolvedValueOnce({ canceled: false, path: 'C:\\a.csv' })
    await wrapper.get('[data-testid="archive-export"]').trigger('click')
    await flushPromises()
    expect(stubStore.exportArchiveCsv).toHaveBeenCalled()
    expect(notifyMock).toHaveBeenCalledTimes(1)
    const request = notifyMock.mock.calls[0][0] as { kind: string; title: string }
    expect(request.kind).toBe('success')
    expect(request.title).toContain('exportSuccess')
    expect(request.title).toContain('a.csv')
  })

  it('行点击打开详情对话框', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="archive-row"]').trigger('click')
    await flushPromises()
    const dialog = wrapper.get('[data-testid="detail-dialog-stub"]')
    expect(dialog.attributes('data-open')).toBe('true')
    expect(dialog.attributes('data-document-id')).toBe('d1')
  })

  it('点击新建识别打开识别对话框', async () => {
    const { wrapper } = await setup()
    expect(wrapper.get('[data-testid="recognize-dialog-stub"]').attributes('data-open')).toBe(
      'false'
    )
    await wrapper.get('[data-testid="archive-new-recognition"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="recognize-dialog-stub"]').attributes('data-open')).toBe(
      'true'
    )
  })

  it('加载失败显示错误与重试', async () => {
    const { wrapper } = await setup({ loadError: 'settings.documents.archive.loadFailed' })
    expect(wrapper.text()).toContain('settings.documents.archive.loadFailed')
    stubStore.loadArchiveDocuments.mockClear()
    await wrapper.get('[data-testid="archive-retry"]').trigger('click')
    await flushPromises()
    expect(stubStore.loadArchiveDocuments).toHaveBeenCalled()
  })

  it('hasMore 时显示加载更多并按增量加载', async () => {
    const { wrapper } = await setup({ hasMore: true })
    stubStore.loadArchiveDocuments.mockClear()
    await wrapper.get('[data-testid="archive-load-more"]').trigger('click')
    await flushPromises()
    expect(stubStore.loadArchiveDocuments).toHaveBeenCalledWith(false)
  })
})
