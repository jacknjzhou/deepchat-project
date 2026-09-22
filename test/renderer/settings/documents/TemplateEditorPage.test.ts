import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const passthrough = (name: string) => defineComponent({ name, template: '<div><slot /></div>' })

const builtinTemplate = {
  id: 'tpl_contract',
  typeKey: 'contract',
  name: 'Contract',
  icon: null,
  category: '合同类',
  fields: [
    {
      key: 'party_a',
      label: 'Party A',
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

const customTemplate = {
  ...builtinTemplate,
  id: 'tpl_custom',
  typeKey: 'custom_doc',
  name: 'Custom Doc',
  isBuiltin: false
}

const stubStore = {
  templates: [builtinTemplate, customTemplate],
  isLoading: false,
  loadError: null,
  builtinTemplates: [builtinTemplate],
  customTemplates: [customTemplate],
  loadTemplates: vi.fn(),
  isTypeKeyTaken: vi.fn((typeKey: string, excludeId?: string) => {
    if (excludeId === 'tpl_custom' && typeKey === 'custom_doc') return false
    return typeKey === 'contract' || typeKey === 'custom_doc'
  }),
  attemptDelete: vi.fn(),
  saveTemplate: vi.fn(),
  testExtract: vi.fn()
}

const settingsLeaveGuardStub = {
  register: vi.fn(() => ({
    setRisk: vi.fn(),
    release: vi.fn()
  }))
}

const inputStub = defineComponent({
  name: 'InputStub',
  props: ['modelValue', 'disabled', 'placeholder'],
  emits: ['update:modelValue'],
  setup(_, { emit }) {
    return {
      handleInput: (event: Event) => {
        emit('update:modelValue', (event.target as HTMLInputElement).value)
      }
    }
  },
  template:
    '<input :value="modelValue" :disabled="disabled" :placeholder="placeholder" @input="handleInput" />'
})

const textareaStub = defineComponent({
  name: 'TextareaStub',
  props: ['modelValue', 'disabled', 'placeholder'],
  emits: ['update:modelValue'],
  setup(_, { emit }) {
    return {
      handleInput: (event: Event) => {
        emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
      }
    }
  },
  template:
    '<textarea :value="modelValue" :disabled="disabled" :placeholder="placeholder" @input="handleInput" />'
})

async function setup(
  routePath: string,
  initialRoutes: Array<{ path: string; name: string; component: any }>
) {
  vi.resetModules()
  vi.doMock('@/stores/documents', () => ({
    useDocumentsStore: () => stubStore
  }))
  vi.doMock('../../../../src/renderer/settings/services/settingsLeaveGuard', () => ({
    settingsLeaveGuard: settingsLeaveGuardStub
  }))
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key
    })
  }))
  // test/setup.renderer.ts globally mocks vue-router; restore the real one for
  // this suite so the editor can use actual route params and navigation.
  vi.doMock(
    'vue-router',
    async () => await vi.importActual<typeof import('vue-router')>('vue-router')
  )
  const { createMemoryHistory, createRouter } =
    await vi.importActual<typeof import('vue-router')>('vue-router')
  const TemplateEditorPage = (
    await import('../../../../src/renderer/settings/components/documents/TemplateEditorPage.vue')
  ).default

  const router = createRouter({
    history: createMemoryHistory(),
    routes: initialRoutes
  })
  await router.push(routePath)
  await router.isReady()

  const wrapper = mount(TemplateEditorPage, {
    global: {
      plugins: [router],
      stubs: {
        SettingsPageShell: passthrough('SettingsPageShell'),
        SettingsSectionCard: passthrough('SettingsSectionCard'),
        Icon: true,
        Input: inputStub,
        Textarea: textareaStub,
        Switch: defineComponent({
          name: 'SwitchStub',
          props: { modelValue: Boolean, disabled: Boolean },
          emits: ['update:modelValue'],
          template:
            '<button :disabled="disabled" :data-model-value="String(modelValue)" @click="$emit(\'update:modelValue\', !modelValue)" />'
        }),
        Select: passthrough('Select'),
        SelectTrigger: passthrough('SelectTrigger'),
        SelectValue: passthrough('SelectValue'),
        SelectContent: passthrough('SelectContent'),
        SelectItem: passthrough('SelectItem'),
        DcButton: defineComponent({
          name: 'DcButtonStub',
          props: ['variant', 'size', 'disabled'],
          template: '<button :disabled="disabled"><slot /></button>'
        }),
        Badge: passthrough('Badge'),
        Alert: passthrough('Alert'),
        AlertDescription: passthrough('AlertDescription'),
        TemplateFieldsEditor: defineComponent({
          name: 'TemplateFieldsEditorStub',
          props: ['fields', 'readonly'],
          emits: ['update:fields', 'add'],
          template: '<div data-testid="fields-editor"><slot /></div>'
        }),
        TemplateTestExtract: defineComponent({
          name: 'TemplateTestExtractStub',
          props: ['templateId'],
          template: '<div data-testid="test-extract" />'
        })
      }
    }
  })
  await flushPromises()
  return { wrapper, router }
}

describe('TemplateEditorPage', () => {
  beforeEach(() => {
    stubStore.loadTemplates.mockClear()
    stubStore.saveTemplate.mockClear()
    stubStore.isTypeKeyTaken.mockClear()
    settingsLeaveGuardStub.register.mockClear()
  })

  it('loads existing custom template and shows save button', async () => {
    const { wrapper } = await setup('/documents/template/tpl_custom', [
      {
        path: '/documents/template/:id',
        name: 'settings-documents-template',
        component: { template: '<div />' }
      }
    ])
    expect(wrapper.get('[data-testid="template-name"]').attributes('value')).toBe('Custom Doc')
    expect(wrapper.find('[data-testid="template-save"]').exists()).toBe(true)
  })

  it('renders builtin template as readonly with fork CTA', async () => {
    const { wrapper } = await setup('/documents/template/tpl_contract', [
      {
        path: '/documents/template/:id',
        name: 'settings-documents-template',
        component: { template: '<div />' }
      }
    ])
    expect(wrapper.find('[data-testid="template-save"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="builtin-fork-cta"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="template-name"]').attributes('disabled')).toBeDefined()
  })

  it('renders new template form with empty fields', async () => {
    const { wrapper } = await setup('/documents/template/new', [
      {
        path: '/documents/template/:id',
        name: 'settings-documents-template',
        component: { template: '<div />' }
      }
    ])
    expect(wrapper.get('[data-testid="template-name"]').attributes('value')).toBe('')
    expect(wrapper.get('[data-testid="template-save"]').exists()).toBe(true)
  })

  it('prefills draft from forkFrom source template and stays editable', async () => {
    const { wrapper } = await setup('/documents/template/new?forkFrom=tpl_contract', [
      {
        path: '/documents/template/:id',
        name: 'settings-documents-template',
        component: { template: '<div />' }
      }
    ])
    expect(wrapper.get('[data-testid="template-name"]').attributes('value')).toBe('Contract')
    // typeKey cleared for user to choose
    expect(wrapper.get('[data-testid="template-type-key"]').attributes('value')).toBe('')
    // a fork is always a custom template: editable, no readonly affordances
    expect(wrapper.find('[data-testid="template-save"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="builtin-fork-cta"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="template-name"]').attributes('disabled')).toBeUndefined()
  })

  it('saves forked template with builtinSourceId of the source', async () => {
    stubStore.saveTemplate.mockResolvedValueOnce({
      ...customTemplate,
      id: 'tpl_forked',
      typeKey: 'contract_copy',
      name: 'Contract Copy'
    })
    const { wrapper } = await setup('/documents/template/new?forkFrom=tpl_contract', [
      {
        path: '/documents/template/:id',
        name: 'settings-documents-template',
        component: { template: '<div />' }
      }
    ])
    await wrapper.get('[data-testid="template-name"]').setValue('Contract Copy')
    await wrapper.get('[data-testid="template-type-key"]').setValue('contract_copy')
    await wrapper.get('[data-testid="template-save"]').trigger('click')
    await flushPromises()
    expect(stubStore.saveTemplate).toHaveBeenCalledTimes(1)
    expect(stubStore.saveTemplate.mock.calls[0][0].builtinSourceId).toBe('tpl_contract')
  })

  it('blocks save when name is empty', async () => {
    const { wrapper } = await setup('/documents/template/new', [
      {
        path: '/documents/template/:id',
        name: 'settings-documents-template',
        component: { template: '<div />' }
      }
    ])
    await wrapper.get('[data-testid="template-save"]').trigger('click')
    await flushPromises()
    expect(stubStore.saveTemplate).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('settings.documents.editor.nameRequired')
  })

  it('blocks save when typeKey is already taken', async () => {
    const { wrapper } = await setup('/documents/template/new', [
      {
        path: '/documents/template/:id',
        name: 'settings-documents-template',
        component: { template: '<div />' }
      }
    ])
    await wrapper.get('[data-testid="template-name"]').setValue('New Template')
    await wrapper.get('[data-testid="template-type-key"]').setValue('contract')
    await wrapper.get('[data-testid="template-save"]').trigger('click')
    await flushPromises()
    expect(stubStore.saveTemplate).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('settings.documents.editor.typeKeyTaken')
  })

  it('saves valid new template and clears dirty state', async () => {
    stubStore.saveTemplate.mockResolvedValueOnce({
      ...customTemplate,
      id: 'tpl_new',
      typeKey: 'new_doc',
      name: 'New Template'
    })
    const { wrapper } = await setup('/documents/template/new', [
      {
        path: '/documents/template/:id',
        name: 'settings-documents-template',
        component: { template: '<div />' }
      }
    ])
    await wrapper.get('[data-testid="template-name"]').setValue('New Template')
    await wrapper.get('[data-testid="template-type-key"]').setValue('new_doc')
    await wrapper.get('[data-testid="template-save"]').trigger('click')
    await flushPromises()
    expect(stubStore.saveTemplate).toHaveBeenCalledTimes(1)
    expect(stubStore.saveTemplate.mock.calls[0][0].name).toBe('New Template')
  })

  it('navigates back to documents tab on back button', async () => {
    const { wrapper, router } = await setup('/documents/template/tpl_custom', [
      {
        path: '/documents/template/:id',
        name: 'settings-documents-template',
        component: { template: '<div />' }
      },
      { path: '/documents', name: 'settings-documents', component: { template: '<div />' } }
    ])
    await wrapper.get('[data-testid="template-back"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('settings-documents')
  })

  it('registers with settings leave guard', async () => {
    await setup('/documents/template/tpl_custom', [
      {
        path: '/documents/template/:id',
        name: 'settings-documents-template',
        component: { template: '<div />' }
      }
    ])
    expect(settingsLeaveGuardStub.register).toHaveBeenCalledTimes(1)
  })
})
