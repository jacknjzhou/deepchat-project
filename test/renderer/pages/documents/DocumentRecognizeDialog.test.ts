import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, reactive } from 'vue'

const passthrough = (name: string) => defineComponent({ name, template: '<div><slot /></div>' })

const fragmentStub = (name: string) => defineComponent({ name, template: '<slot />' })

const makeTemplate = (id: string, typeKey: string, name: string) => ({
  id,
  typeKey,
  name,
  icon: null,
  category: '合同类',
  fields: [],
  extractionMode: 'auto',
  promptPreset: null,
  isBuiltin: true,
  builtinSourceId: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1
})

const contractTemplate = makeTemplate('tpl-1', 'contract', '合同模板')
const invoiceTemplate = makeTemplate('tpl-2', 'invoice', '发票模板')

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
  fileUris: ['C:\\a.png'],
  source: 'manual',
  sessionId: null,
  status: 'draft',
  createdAt: 1700000000000,
  updatedAt: 1700000100000,
  ...overrides
})

const stubStore = reactive({
  templates: [contractTemplate, invoiceTemplate] as Array<Record<string, unknown>>,
  recognizeDocument: vi.fn(async () => ({ document: makeRecord({ id: 'd2' }), meta: {} })),
  loadTemplates: vi.fn(async () => {})
})

const selectFilesMock = vi.fn()

const inputStub = defineComponent({
  name: 'InputStub',
  props: ['modelValue'],
  template: '<input :value="modelValue" readonly />'
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

// SelectTrigger must render a real element so the data-testid attribute
// survives, while SelectContent stays a fragment so <option> nodes remain
// direct children of the stubbed <select> (jsdom option list requirement).
const selectTriggerStub = passthrough('SelectTrigger')

async function setup(options: { templates?: Array<Record<string, unknown>> } = {}) {
  vi.resetModules()
  stubStore.templates = options.templates ?? [contractTemplate, invoiceTemplate]
  vi.doMock('@/stores/documents', () => ({
    useDocumentsStore: () => stubStore
  }))
  vi.doMock('@api/DeviceClient', () => ({
    createDeviceClient: () => ({ selectFiles: selectFilesMock })
  }))
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key
    })
  }))
  const DocumentRecognizeDialog = (
    await import('../../../../src/renderer/src/pages/documents/DocumentRecognizeDialog.vue')
  ).default

  const wrapper = mount(DocumentRecognizeDialog, {
    props: { open: true },
    global: {
      stubs: {
        Dialog: defineComponent({
          name: 'DialogStub',
          props: ['open'],
          template: '<div><slot /></div>'
        }),
        DialogContent: passthrough('DialogContent'),
        DialogHeader: passthrough('DialogHeader'),
        DialogTitle: passthrough('DialogTitle'),
        DialogDescription: passthrough('DialogDescription'),
        DialogFooter: passthrough('DialogFooter'),
        Input: inputStub,
        Select: selectStub,
        SelectTrigger: selectTriggerStub,
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

const submitDisabled = (wrapper: { get: (selector: string) => { element: Element } }) =>
  (wrapper.get('[data-testid="recognize-submit"]').element as HTMLButtonElement).disabled

async function selectFile(wrapper: { get: (selector: string) => { trigger: (e: string) => Promise<void> } }) {
  selectFilesMock.mockResolvedValueOnce({ canceled: false, filePaths: ['C:\\a.png'] })
  await wrapper.get('[data-testid="recognize-select-file"]').trigger('click')
  await flushPromises()
}

describe('DocumentRecognizeDialog', () => {
  beforeEach(() => {
    stubStore.recognizeDocument.mockClear()
    stubStore.loadTemplates.mockClear()
    selectFilesMock.mockClear()
  })

  it('渲染文件选择与模板下拉', async () => {
    const { wrapper } = await setup()
    expect(wrapper.find('[data-testid="recognize-select-file"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="recognize-template-trigger"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('合同模板')
    expect(wrapper.text()).toContain('发票模板')
  })

  it('选择文件后显示文件名并按契约调用 selectFiles', async () => {
    const { wrapper } = await setup()
    await selectFile(wrapper)
    expect(selectFilesMock).toHaveBeenCalledWith({
      multiple: false,
      filters: [{ name: 'Documents', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf'] }]
    })
    const input = wrapper.get('[data-testid="recognize-file-input"]')
    expect((input.element as HTMLInputElement).value).toContain('a.png')
  })

  it('未选文件或未选模板时开始识别禁用', async () => {
    const { wrapper } = await setup()
    expect(submitDisabled(wrapper)).toBe(true)
    await selectFile(wrapper)
    expect(submitDisabled(wrapper)).toBe(false)
  })

  it('模板未加载时保持禁用并触发 loadTemplates', async () => {
    const { wrapper } = await setup({ templates: [] })
    expect(stubStore.loadTemplates).toHaveBeenCalledTimes(1)
    await selectFile(wrapper)
    expect(submitDisabled(wrapper)).toBe(true)
  })

  it('提交调用 recognizeDocument 并 emit recognized 与关闭', async () => {
    const recognized = makeRecord({ id: 'd2' })
    stubStore.recognizeDocument.mockResolvedValueOnce({ document: recognized, meta: {} })
    const { wrapper } = await setup()
    await selectFile(wrapper)
    await wrapper.find('select').setValue('tpl-1')
    await wrapper.get('[data-testid="recognize-submit"]').trigger('click')
    await flushPromises()
    expect(stubStore.recognizeDocument).toHaveBeenCalledWith({
      templateId: 'tpl-1',
      file: { path: 'C:\\a.png' },
      source: 'manual'
    })
    expect(wrapper.emitted('recognized')).toEqual([[recognized]])
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })

  it('识别中按钮显示 recognizing 且禁用', async () => {
    let resolveRecognize!: (value: { document: unknown; meta: unknown }) => void
    stubStore.recognizeDocument.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRecognize = resolve
        })
    )
    const { wrapper } = await setup()
    await selectFile(wrapper)
    await wrapper.get('[data-testid="recognize-submit"]').trigger('click')
    await flushPromises()
    const submit = wrapper.get('[data-testid="recognize-submit"]')
    expect(submit.text()).toContain('settings.documents.archive.recognizing')
    expect((submit.element as HTMLButtonElement).disabled).toBe(true)
    resolveRecognize({ document: makeRecord({ id: 'd2' }), meta: {} })
    await flushPromises()
  })

  it('失败显示 recognizeFailed 且可重试', async () => {
    stubStore.recognizeDocument.mockRejectedValueOnce(new Error('recognize failed'))
    const { wrapper } = await setup()
    await selectFile(wrapper)
    await wrapper.get('[data-testid="recognize-submit"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="recognize-error"]').text()).toContain(
      'settings.documents.archive.recognizeFailed'
    )
    const recognized = makeRecord({ id: 'd3' })
    stubStore.recognizeDocument.mockResolvedValueOnce({ document: recognized, meta: {} })
    await wrapper.get('[data-testid="recognize-submit"]').trigger('click')
    await flushPromises()
    expect(stubStore.recognizeDocument).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('recognized')).toEqual([[recognized]])
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })
})
