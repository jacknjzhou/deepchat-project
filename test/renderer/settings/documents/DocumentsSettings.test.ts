import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, reactive } from 'vue'

const passthrough = (name: string) => defineComponent({ name, template: '<div><slot /></div>' })

const builtinContract = {
  id: 'tpl_contract',
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
}
const builtinInvoice = {
  ...builtinContract,
  id: 'tpl_invoice',
  typeKey: 'invoice_special',
  name: 'Invoice',
  category: '发票类'
}
const customTemplate = {
  ...builtinContract,
  id: 'tpl_custom',
  typeKey: 'custom_doc',
  name: 'Custom',
  isBuiltin: false
}

// Reactive like the real pinia store: template lists render inside child
// component slots (SettingsSectionCard), so slot content re-renders only when
// the underlying data is reactive.
const stubStore = reactive({
  templates: [builtinContract, builtinInvoice, customTemplate] as Array<typeof builtinContract>,
  isLoading: false,
  loadError: null as string | null,
  builtinTemplates: [builtinContract, builtinInvoice] as Array<typeof builtinContract>,
  customTemplates: [customTemplate] as Array<typeof builtinContract>,
  loadTemplates: vi.fn(async () => {
    stubStore.templates = [builtinContract, builtinInvoice, customTemplate]
    stubStore.builtinTemplates = [builtinContract, builtinInvoice]
    stubStore.customTemplates = [customTemplate]
  }),
  isTypeKeyTaken: vi.fn(),
  attemptDelete: vi.fn(async (id: string) => {
    stubStore.templates = stubStore.templates.filter((t) => t.id !== id)
    stubStore.customTemplates = stubStore.customTemplates.filter((t) => t.id !== id)
    return { kind: 'deleted' }
  }),
  saveTemplate: vi.fn(),
  testExtract: vi.fn()
})

async function setup(forceConfirm = false) {
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
  // test/setup.renderer.ts globally mocks vue-router; restore the real one so
  // navigation assertions against currentRoute params work.
  vi.doMock(
    'vue-router',
    async () => await vi.importActual<typeof import('vue-router')>('vue-router')
  )
  const DocumentsSettings = (
    await import('../../../../src/renderer/settings/components/DocumentsSettings.vue')
  ).default

  const { createMemoryHistory, createRouter } =
    await vi.importActual<typeof import('vue-router')>('vue-router')
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/documents', name: 'settings-documents', component: DocumentsSettings },
      {
        path: '/documents/template/:id',
        name: 'settings-documents-template',
        component: { template: '<div />' }
      }
    ]
  })
  await router.push('/documents')
  await router.isReady()

  const wrapper = mount(DocumentsSettings, {
    attachTo: forceConfirm ? document.body : undefined,
    global: {
      plugins: [router],
      stubs: {
        SettingsPageShell: passthrough('SettingsPageShell'),
        SettingsSectionCard: defineComponent({
          name: 'SettingsSectionCardStub',
          props: ['title', 'description'],
          template: '<div><div class="card-title">{{ title }}</div><slot /></div>'
        }),
        Icon: true,
        DcButton: defineComponent({
          name: 'DcButtonStub',
          props: ['variant', 'size', 'disabled'],
          template: '<button :disabled="disabled" data-testid="dc-button"><slot /></button>'
        }),
        Badge: passthrough('Badge'),
        Alert: passthrough('Alert'),
        AlertDescription: passthrough('AlertDescription'),
        Spinner: true,
        AlertDialog: forceConfirm
          ? false
          : defineComponent({
              name: 'AlertDialogStub',
              props: { open: Boolean },
              template: '<div v-if="open"><slot /></div>'
            }),
        AlertDialogContent: forceConfirm ? false : passthrough('AlertDialogContent'),
        AlertDialogHeader: forceConfirm ? false : passthrough('AlertDialogHeader'),
        AlertDialogTitle: forceConfirm ? false : passthrough('AlertDialogTitle'),
        AlertDialogDescription: forceConfirm ? false : passthrough('AlertDialogDescription'),
        AlertDialogFooter: forceConfirm ? false : passthrough('AlertDialogFooter'),
        AlertDialogCancel: forceConfirm
          ? false
          : defineComponent({
              name: 'AlertDialogCancelStub',
              template: '<button data-testid="delete-cancel"><slot /></button>'
            }),
        AlertDialogAction: forceConfirm
          ? defineComponent({
              name: 'AlertDialogActionStub',
              props: ['disabled'],
              emits: ['click'],
              template:
                '<button data-testid="delete-confirm" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>'
            })
          : defineComponent({
              name: 'AlertDialogActionStub',
              props: ['disabled'],
              template: '<button :disabled="disabled"><slot /></button>'
            }),
        AlertDialogAsyncAction: forceConfirm
          ? false
          : defineComponent({
              name: 'AlertDialogAsyncActionStub',
              template: '<button><slot /></button>'
            })
      }
    }
  })
  await flushPromises()
  return { wrapper, router }
}

describe('DocumentsSettings', () => {
  beforeEach(() => {
    stubStore.templates = [builtinContract, builtinInvoice, customTemplate]
    stubStore.builtinTemplates = [builtinContract, builtinInvoice]
    stubStore.customTemplates = [customTemplate]
    stubStore.loadTemplates.mockClear()
    stubStore.attemptDelete.mockClear()
  })

  it('renders builtin templates grouped by category', async () => {
    const { wrapper } = await setup()
    expect(wrapper.findAll('[data-testid="builtin-group"]')).toHaveLength(2)
    expect(wrapper.text()).toContain('settings.documents.category.contract')
    expect(wrapper.text()).toContain('settings.documents.category.invoice')
  })

  it('renders custom templates section with edit button', async () => {
    const { wrapper } = await setup()
    expect(wrapper.get('[data-testid="custom-group"]').exists()).toBe(true)
    const editButtons = wrapper.findAll('[data-testid="template-edit"]')
    expect(editButtons).toHaveLength(1)
  })

  it('does not render edit/delete for builtin templates', async () => {
    const { wrapper } = await setup()
    expect(wrapper.findAll('[data-testid="template-edit"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="template-delete"]')).toHaveLength(1)
  })

  it('shows fork button for builtin templates', async () => {
    const { wrapper } = await setup()
    expect(wrapper.findAll('[data-testid="template-fork"]')).toHaveLength(2)
  })

  it('navigates to editor on edit button click', async () => {
    const { wrapper, router } = await setup()
    await wrapper.get('[data-testid="template-edit"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.params.id).toBe('tpl_custom')
  })

  it('navigates to new template on create button', async () => {
    const { wrapper, router } = await setup()
    await wrapper.get('[data-testid="template-create"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.params.id).toBe('new')
  })

  it('deletes custom template after confirmation', async () => {
    const { wrapper } = await setup(true)
    await wrapper.get('[data-testid="template-delete"]').trigger('click')
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-testid="delete-confirm"]')!.click()
    await flushPromises()
    expect(stubStore.attemptDelete).toHaveBeenCalledWith('tpl_custom', {})
    expect(wrapper.text()).not.toContain('Custom')
  })

  it('keeps delete dialog open and shows rejection message when delete is rejected', async () => {
    const { wrapper } = await setup(true)
    stubStore.attemptDelete.mockResolvedValueOnce({
      kind: 'rejected',
      messageKey: 'settings.documents.templates.deleteFailed'
    })
    await wrapper.get('[data-testid="template-delete"]').trigger('click')
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-testid="delete-confirm"]')!.click()
    await flushPromises()
    expect(stubStore.attemptDelete).toHaveBeenCalledWith('tpl_custom', {})
    expect(document.querySelector('[data-testid="delete-confirm"]')).not.toBeNull()
    const errorElement = document.querySelector('[data-testid="delete-error"]')
    expect(errorElement).not.toBeNull()
    expect(errorElement!.textContent).toContain('settings.documents.templates.deleteFailed')
    expect(wrapper.text()).toContain('Custom')
  })
})
