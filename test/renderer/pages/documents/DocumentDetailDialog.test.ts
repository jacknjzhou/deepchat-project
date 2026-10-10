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
  reimbursementOverride: null,
  reimbursementGroupOverride: null,
  createdAt: 1700000000000,
  updatedAt: 1700000100000,
  ...overrides
})

const stubStore = reactive({
  archiveDocuments: [] as Array<Record<string, unknown>>,
  templates: [
    {
      id: 'tpl-1',
      typeKey: 'contract',
      name: 'Contract',
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
    },
    {
      id: 'tpl-2',
      typeKey: 'receipt',
      name: 'Receipt',
      icon: null,
      category: '其他',
      fields: [],
      extractionMode: 'auto',
      promptPreset: null,
      isBuiltin: true,
      builtinSourceId: null,
      version: 1,
      createdAt: 1,
      updatedAt: 1
    }
  ] as Array<Record<string, unknown>>,
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
  })),
  reimbursementConfig: null as Record<string, unknown> | null,
  loadReimbursementConfig: vi.fn(async (): Promise<null> => null),
  setReimbursementOverride: vi.fn(
    async (_id: string, _categoryId: string | null): Promise<unknown> => null
  ),
  setReimbursementGroupOverride: vi.fn(
    async (_id: string, _groupId: string | null): Promise<unknown> => null
  )
})

// cat-a 联动 contract 且带分组；cat-b 无分组且不联动任何 typeKey
const makeReimbursementConfig = () => ({
  version: 1,
  categories: [
    {
      id: 'cat-a',
      name: '类别A',
      requiredMaterials: [],
      linkedTypeKeys: ['contract'],
      customGroups: [
        { id: 'grp-1', name: '分组1', sortOrder: 1 },
        { id: 'grp-2', name: '分组2', sortOrder: 0 }
      ],
      sortOrder: 1
    },
    {
      id: 'cat-b',
      name: '类别B',
      requiredMaterials: [],
      linkedTypeKeys: [],
      customGroups: [],
      sortOrder: 0
    }
  ],
  personFieldKeys: [],
  dateFieldKeys: [],
  amountFieldKeys: [],
  dateGrouping: 'day'
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
    stubStore.setReimbursementOverride.mockClear()
    stubStore.setReimbursementGroupOverride.mockClear()
    stubStore.loadReimbursementConfig.mockClear()
    stubStore.reimbursementConfig = null
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

  it('重新识别调用 recognizeDocument(fileUris[0], 原模板, 当前单据) 并 emit re-recognized', async () => {
    const newDoc = makeRecord({ id: 'd1' })
    stubStore.recognizeDocument.mockResolvedValueOnce({ document: newDoc, meta: {} })
    const { wrapper, record } = await setup()
    await wrapper.get('[data-testid="detail-re-recognize"]').trigger('click')
    await flushPromises()
    expect(stubStore.recognizeDocument).toHaveBeenCalledWith({
      templateId: 'tpl-1',
      file: { path: record.fileUris[0] },
      source: 'manual',
      documentId: 'd1'
    })
    expect(wrapper.emitted('re-recognized')).toEqual([[newDoc]])
  })

  it('重新识别未提取到任何字段时报错并保留原单据', async () => {
    stubStore.recognizeDocument.mockResolvedValueOnce({
      document: makeRecord({
        id: 'd1',
        fields: { buyer: { value: null, uncertain: true } }
      }),
      meta: { route: 'vision', durationMs: 5, issues: ['model output is not valid JSON'] }
    })
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="detail-re-recognize"]').trigger('click')
    await flushPromises()
    // 全空结果视为失败：不切换到新单据，展示真实原因
    expect(wrapper.emitted('re-recognized')).toBeUndefined()
    expect(wrapper.text()).toContain('settings.documents.archive.reRecognizeFailed')
    expect(wrapper.text()).toContain('model output is not valid JSON')
  })

  it('重新识别进行中切换到其他文档不继承识别中状态', async () => {
    let resolveRecognize!: (value: { document: Record<string, unknown>; meta: unknown }) => void
    stubStore.recognizeDocument.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRecognize = resolve
        })
    )
    const { wrapper, record } = await setup()
    await wrapper.get('[data-testid="detail-re-recognize"]').trigger('click')
    expect(wrapper.find('[data-testid="detail-recognizing"]').exists()).toBe(true)
    // Extraction keeps running in the background; browsing another document
    // must not inherit the busy state.
    await wrapper.setProps({ document: makeRecord({ id: 'd2' }) })
    expect(wrapper.find('[data-testid="detail-recognizing"]').exists()).toBe(false)
    expect((wrapper.get('[data-testid="detail-save"]').element as HTMLButtonElement).disabled).toBe(
      false
    )
    // Completion still emits so the archive row updates, without feedback on
    // the other document's view.
    resolveRecognize({ document: record, meta: {} })
    await flushPromises()
    expect(wrapper.emitted('re-recognized')).toEqual([[record]])
    expect(wrapper.find('[data-testid="detail-recognizing"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-feedback"]').exists()).toBe(false)
    // Switching back shows no stale busy state either.
    await wrapper.setProps({ document: record })
    expect(wrapper.find('[data-testid="detail-recognizing"]').exists()).toBe(false)
  })

  it('重新识别前手动切换类别后按新模板提取', async () => {
    const { wrapper, record } = await setup()
    // SelectTrigger is stubbed as a fragment; the 手工分组 selects render
    // before the footer, so target the footer template select as the last one.
    const selects = wrapper.findAll('select')
    await selects[selects.length - 1].setValue('tpl-2')
    await wrapper.get('[data-testid="detail-re-recognize"]').trigger('click')
    await flushPromises()
    expect(stubStore.recognizeDocument).toHaveBeenCalledWith({
      templateId: 'tpl-2',
      file: { path: record.fileUris[0] },
      source: 'manual',
      documentId: 'd1'
    })
  })

  it('默认识别数据页不加载预览，切到源文件页懒加载并可手动重载', async () => {
    const { wrapper } = await setup()
    expect(stubStore.previewArchiveFile).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="detail-preview-image"]').exists()).toBe(false)
    await wrapper.get('[data-testid="detail-tab-files"]').trigger('click')
    await flushPromises()
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
    await wrapper.get('[data-testid="detail-tab-files"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="detail-preview-error"]').text()).toContain(
      'settings.documents.archive.previewFailed'
    )
  })

  it('PDF 预览改用 blob URL 加载并在卸载时释放', async () => {
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    const createObjectURL = vi.fn(() => 'blob:mock-pdf-url')
    const revokeObjectURL = vi.fn()
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL
    try {
      stubStore.previewArchiveFile.mockResolvedValueOnce({
        dataBase64: 'JVBERi0=',
        mimeType: 'application/pdf',
        name: 'a.pdf'
      })
      const { wrapper } = await setup()
      await wrapper.get('[data-testid="detail-tab-files"]').trigger('click')
      await flushPromises()
      expect(wrapper.get('[data-testid="detail-preview-pdf"]').attributes('src')).toBe(
        'blob:mock-pdf-url'
      )
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      const blobArg = createObjectURL.mock.calls[0]?.[0] as Blob
      expect(blobArg.type).toBe('application/pdf')
      wrapper.unmount()
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-pdf-url')
    } finally {
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
    }
  })

  describe('手工分组', () => {
    const categorySelectOf = (wrapper: Awaited<ReturnType<typeof setup>>['wrapper']) =>
      wrapper.get('[data-testid="detail-reimbursement-category"]').find('select')
    const groupSelectOf = (wrapper: Awaited<ReturnType<typeof setup>>['wrapper']) =>
      wrapper.get('[data-testid="detail-reimbursement-group"]').find('select')

    it('报销类型与分组初值来自单据快照', async () => {
      stubStore.reimbursementConfig = makeReimbursementConfig()
      const auto = await setup()
      expect(categorySelectOf(auto.wrapper).element.value).toBe('__auto__')
      expect(groupSelectOf(auto.wrapper).element.value).toBe('__none__')

      const overridden = await setup({
        reimbursementOverride: 'cat-a',
        reimbursementGroupOverride: 'grp-1'
      })
      expect(categorySelectOf(overridden.wrapper).element.value).toBe('cat-a')
      expect(groupSelectOf(overridden.wrapper).element.value).toBe('grp-1')

      const unassigned = await setup({ reimbursementOverride: 'unassigned' })
      expect(categorySelectOf(unassigned.wrapper).element.value).toBe('__unassigned__')
    })

    it('类别变更按映射调用 store 并以返回记录复位分组', async () => {
      stubStore.reimbursementConfig = makeReimbursementConfig()
      stubStore.setReimbursementOverride.mockResolvedValueOnce(
        makeRecord({ reimbursementOverride: 'cat-a', reimbursementGroupOverride: null })
      )
      const { wrapper } = await setup({
        reimbursementOverride: null,
        reimbursementGroupOverride: 'grp-1'
      })
      const category = categorySelectOf(wrapper)
      await category.setValue('cat-a')
      await flushPromises()
      expect(stubStore.setReimbursementOverride).toHaveBeenCalledWith('d1', 'cat-a')
      expect(category.element.value).toBe('cat-a')
      // 后端写类别时无条件清空分组覆盖，分组值以返回记录为准复位
      expect(groupSelectOf(wrapper).element.value).toBe('__none__')
    })

    it('__auto__ 映射为 null、__unassigned__ 映射为 unassigned', async () => {
      stubStore.reimbursementConfig = makeReimbursementConfig()
      const echoOverride = async (_id: string, categoryId: string | null) =>
        makeRecord({ reimbursementOverride: categoryId })
      stubStore.setReimbursementOverride.mockImplementationOnce(echoOverride)
      stubStore.setReimbursementOverride.mockImplementationOnce(echoOverride)
      const { wrapper } = await setup({ reimbursementOverride: 'cat-a' })
      const category = categorySelectOf(wrapper)
      await category.setValue('__auto__')
      await flushPromises()
      expect(stubStore.setReimbursementOverride).toHaveBeenCalledWith('d1', null)
      expect(category.element.value).toBe('__auto__')
      await category.setValue('__unassigned__')
      await flushPromises()
      expect(stubStore.setReimbursementOverride).toHaveBeenCalledWith('d1', 'unassigned')
      expect(category.element.value).toBe('__unassigned__')
    })

    it('分组变更按映射调用 store 并以返回记录为准', async () => {
      stubStore.reimbursementConfig = makeReimbursementConfig()
      stubStore.setReimbursementGroupOverride.mockResolvedValueOnce(
        makeRecord({ reimbursementOverride: 'cat-a', reimbursementGroupOverride: 'grp-2' })
      )
      const { wrapper } = await setup({ reimbursementOverride: 'cat-a' })
      const group = groupSelectOf(wrapper)
      await group.setValue('grp-1')
      await flushPromises()
      expect(stubStore.setReimbursementGroupOverride).toHaveBeenCalledWith('d1', 'grp-1')
      expect(group.element.value).toBe('grp-2')
    })

    it('__none__ 映射为 null 清除分组', async () => {
      stubStore.reimbursementConfig = makeReimbursementConfig()
      stubStore.setReimbursementGroupOverride.mockResolvedValueOnce(
        makeRecord({ reimbursementOverride: 'cat-a', reimbursementGroupOverride: null })
      )
      const { wrapper } = await setup({
        reimbursementOverride: 'cat-a',
        reimbursementGroupOverride: 'grp-1'
      })
      const group = groupSelectOf(wrapper)
      await group.setValue('__none__')
      await flushPromises()
      expect(stubStore.setReimbursementGroupOverride).toHaveBeenCalledWith('d1', null)
      expect(group.element.value).toBe('__none__')
    })

    it('类别设置失败时提示错误并回退两个选择值', async () => {
      stubStore.reimbursementConfig = makeReimbursementConfig()
      stubStore.setReimbursementOverride.mockRejectedValueOnce(new Error('boom'))
      const { wrapper } = await setup({
        reimbursementOverride: null,
        reimbursementGroupOverride: 'grp-1'
      })
      const category = categorySelectOf(wrapper)
      await category.setValue('cat-a')
      await flushPromises()
      expect(wrapper.get('[data-testid="detail-feedback"]').text()).toContain(
        'settings.documents.archive.reimbursementSetFailed'
      )
      expect(category.element.value).toBe('__auto__')
      expect(groupSelectOf(wrapper).element.value).toBe('grp-1')
    })

    it('分组设置失败时提示错误并回退选择值', async () => {
      stubStore.reimbursementConfig = makeReimbursementConfig()
      stubStore.setReimbursementGroupOverride.mockRejectedValueOnce(new Error('boom'))
      const { wrapper } = await setup({ reimbursementOverride: 'cat-a' })
      const group = groupSelectOf(wrapper)
      await group.setValue('grp-1')
      await flushPromises()
      expect(wrapper.get('[data-testid="detail-feedback"]').text()).toContain(
        'settings.documents.archive.reimbursementSetFailed'
      )
      expect(group.element.value).toBe('__none__')
    })

    it('config 为 null 时两个下拉禁用', async () => {
      stubStore.reimbursementConfig = null
      const { wrapper } = await setup()
      expect(categorySelectOf(wrapper).element.disabled).toBe(true)
      expect(groupSelectOf(wrapper).element.disabled).toBe(true)
    })

    it('弹窗打开且 config 为 null 时加载报销配置', async () => {
      stubStore.reimbursementConfig = null
      await setup()
      expect(stubStore.loadReimbursementConfig).toHaveBeenCalledTimes(1)
    })

    it('config 已加载时打开弹窗不重复加载', async () => {
      stubStore.reimbursementConfig = makeReimbursementConfig()
      await setup()
      expect(stubStore.loadReimbursementConfig).not.toHaveBeenCalled()
    })

    it('陈旧覆盖 id 播种为自动并按联动显示分组', async () => {
      stubStore.reimbursementConfig = makeReimbursementConfig()
      const { wrapper } = await setup({ reimbursementOverride: 'cat-stale' })
      expect(categorySelectOf(wrapper).element.value).toBe('__auto__')
      const group = groupSelectOf(wrapper)
      expect(group.findAll('option').map((option) => option.element.value)).toEqual([
        '__none__',
        'grp-2',
        'grp-1'
      ])
      expect(group.element.disabled).toBe(false)
    })

    it('强制未分类或 auto 未联动类别时分组禁用', async () => {
      stubStore.reimbursementConfig = makeReimbursementConfig()
      const unassigned = await setup({ reimbursementOverride: 'unassigned' })
      expect(categorySelectOf(unassigned.wrapper).element.disabled).toBe(false)
      expect(groupSelectOf(unassigned.wrapper).element.disabled).toBe(true)
      expect(
        unassigned.wrapper.get('[data-testid="detail-reimbursement-group"]').attributes('title')
      ).toBeUndefined()

      const unmapped = await setup({ typeKey: 'receipt' })
      expect(groupSelectOf(unmapped.wrapper).element.disabled).toBe(true)
    })

    it('生效类别无分组时分组禁用并显示 noGroupsHint', async () => {
      stubStore.reimbursementConfig = makeReimbursementConfig()
      const { wrapper } = await setup({ reimbursementOverride: 'cat-b' })
      const group = groupSelectOf(wrapper)
      expect(group.element.disabled).toBe(true)
      expect(wrapper.get('[data-testid="detail-reimbursement-group"]').attributes('title')).toBe(
        'settings.documents.reimbursement.noGroupsHint'
      )
    })

    it('写库 pending 期间两个下拉禁用', async () => {
      stubStore.reimbursementConfig = makeReimbursementConfig()
      let resolveSet!: (value: unknown) => void
      stubStore.setReimbursementGroupOverride.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSet = resolve
          })
      )
      const { wrapper } = await setup({ reimbursementOverride: 'cat-a' })
      const category = categorySelectOf(wrapper)
      const group = groupSelectOf(wrapper)
      await group.setValue('grp-1')
      // 乐观更新本地值，两个下拉在写库期间禁用
      expect(group.element.value).toBe('grp-1')
      expect(category.element.disabled).toBe(true)
      expect(group.element.disabled).toBe(true)
      resolveSet(
        makeRecord({ reimbursementOverride: 'cat-a', reimbursementGroupOverride: 'grp-1' })
      )
      await flushPromises()
      expect(category.element.disabled).toBe(false)
      expect(group.element.disabled).toBe(false)
      expect(group.element.value).toBe('grp-1')
    })
  })
})
