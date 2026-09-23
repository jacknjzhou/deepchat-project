import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, reactive } from 'vue'

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
  emits: ['update:open', 'submitted'],
  template: '<div data-testid="recognize-dialog-stub" :data-open="String(open)" />'
})

// Reactive like the real pinia store: the table and filters read store state
// across renders, so slot/table content only stays correct with reactivity.
const stubStore = reactive({
  templates: [contractTemplate] as Array<Record<string, unknown>>,
  archiveDocuments: [] as Array<Record<string, unknown>>,
  archiveIsLoading: false,
  archiveLoadError: null as string | null,
  archiveTotal: 0,
  archivePage: 1,
  archiveTotalPages: 1,
  archiveStats: [] as Array<{ typeKey: string; total: number; draft: number; confirmed: number }>,
  tasks: [] as Array<Record<string, unknown>>,
  archiveFilter: {
    typeKey: undefined as string | undefined,
    status: undefined as string | undefined,
    keyword: undefined as string | undefined,
    dateFrom: undefined as number | undefined,
    dateTo: undefined as number | undefined
  },
  loadTemplates: vi.fn(async () => {}),
  loadArchiveDocuments: vi.fn(async (_page = 1) => {}),
  loadArchiveStats: vi.fn(async () => {}),
  loadArchiveTasks: vi.fn(async () => {}),
  handleTaskUpdated: vi.fn(),
  createRecognitionTasks: vi.fn(),
  retryRecognitionTask: vi.fn(async () => []),
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

async function setup(options: { loadError?: string } = {}) {
  vi.resetModules()
  stubStore.templates = [contractTemplate]
  stubStore.archiveDocuments = [makeRecord()]
  stubStore.archiveIsLoading = false
  stubStore.archiveLoadError = options.loadError ?? null
  stubStore.archiveTotal = 0
  stubStore.archivePage = 1
  stubStore.archiveTotalPages = 1
  stubStore.archiveStats = []
  stubStore.tasks = []
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
        DcButton: dcButtonStub,
        DcBadge: dcBadgeStub
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
    stubStore.loadArchiveStats.mockClear()
    stubStore.loadArchiveTasks.mockClear()
    stubStore.handleTaskUpdated.mockClear()
    stubStore.createRecognitionTasks.mockClear()
    stubStore.retryRecognitionTask.mockClear()
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

  it('默认日期为最近一周并加载第一页', async () => {
    await setup()
    const from = stubStore.archiveFilter.dateFrom as number
    const to = stubStore.archiveFilter.dateTo as number
    expect(from).toBeGreaterThan(0)
    expect(to - from).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000)
    expect(to - from).toBeLessThan(8 * 24 * 60 * 60 * 1000)
    expect(stubStore.loadArchiveDocuments).toHaveBeenCalledWith(1)
  })

  it('点击类型 Tab 切换筛选并回到第一页', async () => {
    const { wrapper } = await setup()
    stubStore.archiveFilter.status = 'draft'
    stubStore.loadArchiveDocuments.mockClear()
    await wrapper.get('[data-testid="archive-tab-contract"]').trigger('click')
    await flushPromises()
    expect(stubStore.archiveFilter.typeKey).toBe('contract')
    expect(stubStore.archiveFilter.status).toBeUndefined()
    expect(stubStore.loadArchiveDocuments).toHaveBeenCalledWith(1)
    // 类型 Tab 下展示该模板全部字段列（不再渲染摘要列）
    expect(wrapper.text()).toContain('购买方')
    expect(wrapper.text()).not.toContain('settings.documents.archive.colSummary')
  })

  it('状态 chips 展示统计并可筛选', async () => {
    const { wrapper } = await setup()
    stubStore.archiveStats = [{ typeKey: 'contract', total: 3, draft: 2, confirmed: 1 }]
    await flushPromises()
    expect(wrapper.get('[data-testid="archive-status-chip-draft"]').text()).toContain('2')
    stubStore.loadArchiveDocuments.mockClear()
    await wrapper.get('[data-testid="archive-status-chip-draft"]').trigger('click')
    await flushPromises()
    expect(stubStore.archiveFilter.status).toBe('draft')
    expect(stubStore.loadArchiveDocuments).toHaveBeenCalledWith(1)
  })

  it('分页控件按页加载', async () => {
    const { wrapper } = await setup()
    stubStore.archiveTotal = 51
    stubStore.archiveTotalPages = 2
    await flushPromises()
    stubStore.loadArchiveDocuments.mockClear()
    await wrapper.get('[data-testid="archive-page-next"]').trigger('click')
    await flushPromises()
    expect(stubStore.loadArchiveDocuments).toHaveBeenCalledWith(2)
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

  it('mount 后订阅 documents.task.updated，回调转发 handleTaskUpdated，卸载退订', async () => {
    const { wrapper } = await setup()
    const onMock = (window as unknown as { deepchat: { on: ReturnType<typeof vi.fn> } }).deepchat.on
    const callIndex = onMock.mock.calls.findIndex((call) => call[0] === 'documents.task.updated')
    expect(callIndex).toBeGreaterThanOrEqual(0)
    const unsubscribe = onMock.mock.results[callIndex]?.value as ReturnType<typeof vi.fn>
    expect(unsubscribe).not.toHaveBeenCalled()
    const payload = { id: 't9', batchId: 'b9', status: 'running' }
    ;(onMock.mock.calls[callIndex][1] as (value: unknown) => void)(payload)
    expect(stubStore.handleTaskUpdated).toHaveBeenCalledWith(payload)
    wrapper.unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })
})
