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

const stubStore = reactive({
  templates: [contractTemplate, invoiceTemplate] as Array<Record<string, unknown>>,
  createRecognitionTasks: vi.fn(async () => [] as Array<Record<string, unknown>>),
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

// The selected-file count lives in the readonly input's value, which is not
// part of textContent in jsdom, so read it off the element directly.
const filesInputValue = (wrapper: { get: (selector: string) => { element: Element } }) =>
  (wrapper.get('[data-testid="recognize-file-input"]').element as HTMLInputElement).value

async function selectFiles(
  wrapper: { get: (selector: string) => { trigger: (e: string) => Promise<void> } },
  filePaths: string[]
) {
  selectFilesMock.mockResolvedValueOnce({ canceled: false, filePaths })
  await wrapper.get('[data-testid="recognize-select-file"]').trigger('click')
  await flushPromises()
}

describe('DocumentRecognizeDialog', () => {
  beforeEach(() => {
    stubStore.createRecognitionTasks.mockClear()
    stubStore.loadTemplates.mockClear()
    selectFilesMock.mockClear()
  })

  it('渲染文件选择与模板下拉且自动分类为默认项', async () => {
    const { wrapper } = await setup()
    expect(wrapper.find('[data-testid="recognize-select-file"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="recognize-template-trigger"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('合同模板')
    expect(wrapper.text()).toContain('发票模板')
    const options = wrapper.findAll('option').map((o) => o.element.value)
    expect(options[0]).toBe('__auto__')
  })

  it('按契约以多选模式调用 selectFiles 并显示计数', async () => {
    const { wrapper } = await setup()
    await selectFiles(wrapper, ['C:\\a.png'])
    expect(selectFilesMock).toHaveBeenCalledWith({
      multiple: true,
      filters: [{ name: 'Documents', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf'] }]
    })
    expect(filesInputValue(wrapper)).toContain('1')
  })

  it('未选文件时提交禁用且模板为空时触发 loadTemplates', async () => {
    const { wrapper } = await setup({ templates: [] })
    expect(stubStore.loadTemplates).toHaveBeenCalledTimes(1)
    expect(submitDisabled(wrapper)).toBe(true)
    await selectFiles(wrapper, ['C:\\a.png'])
    expect(submitDisabled(wrapper)).toBe(false)
  })

  it('多选文件并提交创建批量任务', async () => {
    stubStore.createRecognitionTasks.mockResolvedValueOnce([{ id: 'task-1' }, { id: 'task-2' }])
    const { wrapper } = await setup()
    await selectFiles(wrapper, ['C:\\a.png', 'C:\\b.pdf'])
    expect(filesInputValue(wrapper)).toContain('2')
    await wrapper.get('[data-testid="recognize-submit"]').trigger('click')
    await flushPromises()
    expect(stubStore.createRecognitionTasks).toHaveBeenCalledWith({
      files: [
        { path: 'C:\\a.png', name: 'a.png' },
        { path: 'C:\\b.pdf', name: 'b.pdf' }
      ],
      templateId: 'auto'
    })
    expect(wrapper.emitted('submitted')?.[0]).toEqual([2])
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
  })

  it('默认模板为自动分类且可切换到具体模板', async () => {
    const { wrapper } = await setup()
    const options = wrapper.findAll('option').map((o) => o.element.value)
    expect(options[0]).toBe('__auto__')
    await selectFiles(wrapper, ['C:\\a.png'])
    await wrapper.find('select').setValue('tpl-1')
    await wrapper.get('[data-testid="recognize-submit"]').trigger('click')
    await flushPromises()
    expect(stubStore.createRecognitionTasks).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'tpl-1' })
    )
  })

  it('移除已选文件', async () => {
    const { wrapper } = await setup()
    await selectFiles(wrapper, ['C:\\a.png', 'C:\\b.pdf'])
    await wrapper.get('[data-testid="recognize-file-remove-1"]').trigger('click')
    expect(filesInputValue(wrapper)).toContain('1')
  })

  it('提交中按钮禁用', async () => {
    let resolveTasks!: (value: Array<Record<string, unknown>>) => void
    stubStore.createRecognitionTasks.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTasks = resolve
        })
    )
    const { wrapper } = await setup()
    await selectFiles(wrapper, ['C:\\a.png'])
    await wrapper.get('[data-testid="recognize-submit"]').trigger('click')
    expect(submitDisabled(wrapper)).toBe(true)
    resolveTasks([{ id: 'task-1' }])
    await flushPromises()
  })

  it('失败显示 recognizeFailed 且可重试', async () => {
    stubStore.createRecognitionTasks.mockRejectedValueOnce(new Error('create tasks failed'))
    const { wrapper } = await setup()
    await selectFiles(wrapper, ['C:\\a.png'])
    await wrapper.get('[data-testid="recognize-submit"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="recognize-error"]').text()).toContain(
      'settings.documents.archive.recognizeFailed'
    )
    expect(wrapper.get('[data-testid="recognize-error"]').text()).toContain('create tasks failed')
    stubStore.createRecognitionTasks.mockResolvedValueOnce([{ id: 'task-1' }])
    await wrapper.get('[data-testid="recognize-submit"]').trigger('click')
    await flushPromises()
    expect(stubStore.createRecognitionTasks).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('submitted')?.[0]).toEqual([1])
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
  })
})
