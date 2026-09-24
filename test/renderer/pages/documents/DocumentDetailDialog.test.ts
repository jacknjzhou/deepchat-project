import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, reactive } from 'vue'

const passthrough = (name: string) => defineComponent({ name, template: '<div><slot /></div>' })

const fragmentStub = (name: string) => defineComponent({ name, template: '<slot />' })

const buyerField = {
  key: 'buyer',
  label: '购买方',
  valueType: 'text',
  required: true,
  promptHint: null,
  validation: null,
  enumOptions: null,
  order: 1
}

const makeRecord = (overrides = {}) => ({
  id: 'd1',
  templateId: 'tpl-1',
  typeKey: 'contract',
  templateSnapshot: {
    id: 'tpl-1',
    typeKey: 'contract',
    name: 'Contract',
    icon: null,
    category: '合同类',
    fields: [buyerField],
    extractionMode: 'auto',
    promptPreset: null,
    isBuiltin: true,
    builtinSourceId: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1
  },
  fields: { buyer: { value: '甲公司', uncertain: false } },
  fileUris: ['C:\\docs\\a.png'],
  source: 'manual',
  sessionId: null,
  status: 'draft',
  createdAt: 1700000000000,
  updatedAt: 1700000100000,
  ...overrides
})

const stubStore = reactive({
  archiveDocuments: [] as Array<Record<string, unknown>>,
  saveArchiveDocument: vi.fn(async (_id: string, _fields: Record<string, unknown>) => null),
  removeArchiveDocument: vi.fn(async (_id: string) => {}),
  recognizeDocument: vi.fn(async (_input: Record<string, unknown>) => ({
    document: makeRecord({ id: 'd2' }),
    meta: {}
  })),
  previewArchiveFile: vi.fn(async (_documentId: string, _uriIndex: number) => ({
    dataBase64: 'aGk=',
    mimeType: 'image/png',
    name: 'a.png'
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

const textareaStub = defineComponent({
  name: 'TextareaStub',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup(_, { emit }) {
    return {
      handleInput: (event: Event) => {
        emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
      }
    }
  },
  template: '<textarea :value="modelValue" @input="handleInput" />'
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

const alertActionStub = defineComponent({
  name: 'AlertDialogAsyncActionStub',
  emits: ['click'],
  template: '<button @click="$emit(\'click\')"><slot /></button>'
})

async function setup(recordOverrides: Record<string, unknown> = {}) {
  vi.resetModules()
  vi.doMock('@/stores/documents', () => ({
    useDocumentsStore: () => stubStore
  }))
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key
    })
  }))
  const DocumentDetailDialog = (
    await import('../../../../src/renderer/src/pages/documents/DocumentDetailDialog.vue')
  ).default
  const record = makeRecord(recordOverrides)

  const wrapper = mount(DocumentDetailDialog, {
    props: { open: true, document: record },
    global: {
      stubs: {
        Icon: true,
        Dialog: defineComponent({
          name: 'DialogStub',
          props: ['open'],
          template: '<div><slot /></div>'
        }),
        DialogContent: passthrough('DialogContent'),
        DialogHeader: passthrough('DialogHeader'),
        DialogTitle: passthrough('DialogTitle'),
        DialogFooter: passthrough('DialogFooter'),
        AlertDialog: defineComponent({
          name: 'AlertDialogStub',
          props: ['open'],
          template: '<div v-if="open"><slot /></div>'
        }),
        AlertDialogContent: passthrough('AlertDialogContent'),
        AlertDialogHeader: passthrough('AlertDialogHeader'),
        AlertDialogTitle: passthrough('AlertDialogTitle'),
        AlertDialogDescription: passthrough('AlertDialogDescription'),
        AlertDialogFooter: passthrough('AlertDialogFooter'),
        AlertDialogCancel: defineComponent({
          name: 'AlertDialogCancelStub',
          template: '<button><slot /></button>'
        }),
        AlertDialogAsyncAction: alertActionStub,
        Input: inputStub,
        Textarea: textareaStub,
        Select: selectStub,
        SelectTrigger: fragmentStub('SelectTrigger'),
        SelectValue: fragmentStub('SelectValue'),
        SelectContent: fragmentStub('SelectContent'),
        SelectItem: selectItemStub,
        DcButton: dcButtonStub
      }
    }
  })
  await flushPromises()
  return { wrapper, record }
}

describe('DocumentDetailDialog', () => {
  beforeEach(() => {
    stubStore.saveArchiveDocument.mockClear()
    stubStore.removeArchiveDocument.mockClear()
    stubStore.recognizeDocument.mockClear()
    stubStore.previewArchiveFile.mockClear()
  })

  it('按快照渲染字段控件并显示值', async () => {
    const { wrapper } = await setup()
    const input = wrapper.get('[data-testid="detail-field-buyer"]')
    expect((input.element as HTMLInputElement).value).toBe('甲公司')
    expect(wrapper.text()).toContain('购买方')
  })

  it('修改 text 字段后保存调用 saveArchiveDocument 且编辑字段 uncertain=false', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="detail-field-buyer"]').setValue('新值')
    await wrapper.get('[data-testid="detail-save"]').trigger('click')
    await flushPromises()
    expect(stubStore.saveArchiveDocument).toHaveBeenCalledTimes(1)
    expect(stubStore.saveArchiveDocument).toHaveBeenCalledWith('d1', {
      buyer: { value: '新值', uncertain: false }
    })
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })

  it('未编辑字段原样透传原 entry', async () => {
    const noteField = {
      key: 'note',
      label: '备注',
      valueType: 'text',
      required: false,
      promptHint: null,
      validation: null,
      enumOptions: null,
      order: 2
    }
    const { wrapper } = await setup({
      templateSnapshot: {
        fields: [buyerField, noteField]
      },
      fields: { buyer: { value: '甲公司', uncertain: true } }
    })
    await wrapper.get('[data-testid="detail-save"]').trigger('click')
    await flushPromises()
    expect(stubStore.saveArchiveDocument).toHaveBeenCalledTimes(1)
    const fields = stubStore.saveArchiveDocument.mock.calls[0][1] as Record<string, unknown>
    expect(fields.buyer).toEqual({ value: '甲公司', uncertain: true })
    expect(fields.note).toEqual({ value: null, uncertain: false })
  })

  it('required 空值阻断保存并显示 fieldRequired', async () => {
    const { wrapper } = await setup({ fields: {} })
    await wrapper.get('[data-testid="detail-save"]').trigger('click')
    await flushPromises()
    expect(stubStore.saveArchiveDocument).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="detail-field-error"]').text()).toContain(
      'settings.documents.archive.fieldRequired'
    )
  })

  it('draft 显示待确认状态，confirmed 显示确认时间', async () => {
    const draft = await setup()
    expect(draft.wrapper.text()).toContain('settings.documents.archive.statusDraft')
    const confirmed = await setup({ status: 'confirmed' })
    expect(confirmed.wrapper.text()).toContain('settings.documents.archive.statusConfirmed')
    expect(confirmed.wrapper.text()).toContain(new Date(1700000100000).toLocaleString())
  })

  it('删除走 AlertDialog 确认后调用 removeArchiveDocument 并关闭', async () => {
    const { wrapper } = await setup()
    expect(wrapper.find('[data-testid="detail-delete-confirm"]').exists()).toBe(false)
    await wrapper.get('[data-testid="detail-delete"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="detail-delete-confirm"]').exists()).toBe(true)
    await wrapper.get('[data-testid="detail-delete-confirm"]').trigger('click')
    await flushPromises()
    expect(stubStore.removeArchiveDocument).toHaveBeenCalledWith('d1')
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })

  it('重新识别调用 recognizeDocument(fileUris[0], 原模板) 并 emit re-recognized', async () => {
    const newDoc = makeRecord({ id: 'd2' })
    stubStore.recognizeDocument.mockResolvedValueOnce({ document: newDoc, meta: {} })
    const { wrapper, record } = await setup()
    await wrapper.get('[data-testid="detail-re-recognize"]').trigger('click')
    await flushPromises()
    expect(stubStore.recognizeDocument).toHaveBeenCalledWith({
      templateId: 'tpl-1',
      file: { path: record.fileUris[0] },
      source: 'manual'
    })
    expect(wrapper.emitted('re-recognized')).toEqual([[newDoc]])
  })

  it('文件区列出 fileUris 并自动预览图片，可手动重新加载', async () => {
    const { wrapper } = await setup()
    expect(stubStore.previewArchiveFile).toHaveBeenCalledWith('d1', 0)
    expect(wrapper.get('[data-testid="detail-preview-0"]').text()).toContain(
      'settings.documents.archive.filesTitle'
    )
    const image = wrapper.get('[data-testid="detail-preview-image"]')
    expect(image.attributes('src')).toBe('data:image/png;base64,aGk=')
    await wrapper.get('[data-testid="detail-preview-0"]').trigger('click')
    await flushPromises()
    expect(stubStore.previewArchiveFile).toHaveBeenCalledTimes(2)
  })

  it('preview 失败显示 previewFailed', async () => {
    stubStore.previewArchiveFile.mockRejectedValueOnce(new Error('preview failed'))
    const { wrapper } = await setup()
    await flushPromises()
    expect(wrapper.get('[data-testid="detail-preview-error"]').text()).toContain(
      'settings.documents.archive.previewFailed'
    )
  })
})
