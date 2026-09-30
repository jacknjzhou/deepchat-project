import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

const passthrough = (name: string) =>
  defineComponent({
    name,
    template: '<div><slot /></div>'
  })

const ButtonStub = defineComponent({
  name: 'Button',
  props: {
    disabled: { type: Boolean, default: false }
  },
  emits: ['click'],
  template:
    '<button v-bind="$attrs" :disabled="disabled" @click="$emit(\'click\', $event)"><slot /></button>'
})

const InputStub = defineComponent({
  name: 'Input',
  props: {
    modelValue: { type: [String, Number], default: '' }
  },
  emits: ['update:modelValue'],
  template:
    '<input v-bind="$attrs" :value="modelValue ?? \'\'" @input="$emit(\'update:modelValue\', $event.target.value)" />'
})

const ModelSelectStub = defineComponent({
  name: 'ModelSelect',
  props: {
    type: { type: Array, default: undefined },
    visionOnly: { type: Boolean, default: false },
    selectedProviderId: { type: String, default: '' },
    selectedModelId: { type: String, default: '' }
  },
  emits: ['update:model'],
  template: '<div data-testid="model-select-stub"></div>'
})

const mountPage = async (options: {
  settings?: Record<string, unknown>
  providers?: Array<{ id: string; name: string; enable: boolean }>
  providerModels?: Array<{
    providerId: string
    models: Array<{ id: string; name: string; vision?: boolean }>
  }>
}) => {
  vi.resetModules()

  const store: Record<string, unknown> = { ...(options.settings ?? {}) }
  const configClient = {
    getSetting: vi.fn((key: string) => Promise.resolve(store[key])),
    setSetting: vi.fn((key: string, value: unknown) => {
      store[key] = value
      return Promise.resolve(value)
    })
  }
  const providerStore = {
    providers: options.providers ?? [],
    sortedProviders: (options.providers ?? []).filter((provider) => provider.enable)
  }
  const modelStore = {
    allProviderModels: options.providerModels ?? [],
    enabledModels: (options.providerModels ?? []).map((entry) => ({
      providerId: entry.providerId,
      models: entry.models.filter((model) => model.vision !== false)
    }))
  }

  vi.doMock('@api/ConfigClient', () => ({
    createConfigClient: () => configClient
  }))
  vi.doMock('@/stores/providerStore', () => ({
    useProviderStore: () => providerStore
  }))
  vi.doMock('@/stores/modelStore', () => ({
    useModelStore: () => modelStore
  }))
  vi.doMock('@/stores/managedStore', () => ({
    useManagedStore: () => ({
      documentsLocked: false,
      load: vi.fn().mockResolvedValue(undefined),
      refreshConfig: vi.fn().mockResolvedValue(undefined),
      isManagedProvider: () => false,
      providerIds: []
    })
  }))
  vi.doMock('@/components/ModelSelect.vue', () => ({
    default: ModelSelectStub
  }))
  vi.doMock('@iconify/vue', () => ({
    Icon: { name: 'Icon', template: '<span />' }
  }))

  const DocumentsModelsSettings = (
    await import('../../../src/renderer/settings/components/DocumentsModelsSettings.vue')
  ).default

  // vue-i18n is globally mocked in test/setup.renderer.ts so missing keys render
  // as key names; no i18n plugin registration is needed (or supported) here.
  const wrapper = mount(DocumentsModelsSettings, {
    global: {
      stubs: {
        DcButton: ButtonStub,
        Popover: passthrough('Popover'),
        PopoverContent: passthrough('PopoverContent'),
        PopoverTrigger: passthrough('PopoverTrigger'),
        Input: InputStub,
        Icon: true
      }
    }
  })

  await flushPromises()

  const viewModel = wrapper.vm as unknown as Record<string, unknown>

  return { wrapper, configClient, viewModel }
}

const getModelSelects = (wrapper: Awaited<ReturnType<typeof mountPage>>['wrapper']) =>
  wrapper.findAllComponents({ name: 'ModelSelect' }).map((component) => ({
    visionOnly: component.props('visionOnly') as boolean,
    emit: (model: unknown, providerId: string) =>
      component.vm.$emit('update:model', model, providerId)
  }))

const textSelect = (wrapper: Awaited<ReturnType<typeof mountPage>>['wrapper']) =>
  getModelSelects(wrapper).find((select) => !select.visionOnly)!

const visionSelect = (wrapper: Awaited<ReturnType<typeof mountPage>>['wrapper']) =>
  getModelSelects(wrapper).find((select) => select.visionOnly)!

const enabledProvider = { id: 'prov-a', name: 'Provider A', enable: true }
const visionProvider = { id: 'prov-b', name: 'Provider B', enable: true }

const fullSetup = {
  providers: [
    enabledProvider,
    visionProvider,
    { id: 'prov-disabled', name: 'Disabled Provider', enable: false }
  ],
  providerModels: [
    {
      providerId: 'prov-a',
      models: [
        { id: 'model-a1', name: 'Model A1', vision: false },
        { id: 'model-a2', name: 'Model A2', vision: true }
      ]
    },
    {
      providerId: 'prov-b',
      models: [{ id: 'model-b1', name: 'Model B1', vision: true }]
    },
    {
      providerId: 'prov-disabled',
      models: [{ id: 'model-x', name: 'Model X', vision: false }]
    }
  ]
}

describe('DocumentsModelsSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads saved settings', async () => {
    const { wrapper, configClient, viewModel } = await mountPage({
      settings: {
        'documents.textModel': { providerId: 'prov-a', modelId: 'model-a1' },
        'documents.visionModel': { providerId: 'prov-b', modelId: 'model-b1' },
        'documents.concurrency': 6
      },
      ...fullSetup
    })

    const readKeys = configClient.getSetting.mock.calls.map((call) => call[0])
    expect(readKeys).toEqual([
      'documents.textModel',
      'documents.visionModel',
      'documents.concurrency',
      'documents.temperature',
      'documents.maxTokens'
    ])

    expect(viewModel.savedTextModel).toEqual({ providerId: 'prov-a', modelId: 'model-a1' })
    expect(viewModel.savedVisionModel).toEqual({ providerId: 'prov-b', modelId: 'model-b1' })
    expect(viewModel.concurrency).toBe(6)
    expect(viewModel.canSave).toBe(true)
    expect(viewModel.textInvalidReason).toBeNull()
    expect(viewModel.visionInvalidReason).toBeNull()
    expect((viewModel.savedTextModel as { providerId: string }).providerId).toBe('prov-a')

    const concurrencyInput = wrapper.get('[data-testid="documents-concurrency-input"]')
    expect((concurrencyInput.element as HTMLInputElement).value).toBe('6')

    wrapper.unmount()
  })

  it('disables save when text model missing', async () => {
    const { wrapper, viewModel } = await mountPage({
      settings: {},
      ...fullSetup
    })

    expect(viewModel.savedTextModel).toBeNull()
    expect(viewModel.textInvalidReason).toBeNull()
    expect(viewModel.canSave).toBe(false)

    const saveButton = wrapper.get('[data-testid="documents-models-save"]')
    expect(saveButton.attributes('disabled')).toBeDefined()

    wrapper.unmount()
  })

  it('flags invalid provider row', async () => {
    const { wrapper, viewModel } = await mountPage({
      settings: {
        'documents.textModel': { providerId: 'prov-disabled', modelId: 'model-x' }
      },
      ...fullSetup
    })

    expect(viewModel.textInvalidReason).toBe('providerDisabled')
    expect(viewModel.canSave).toBe(false)

    const invalidNotice = wrapper.get('[data-testid="documents-text-model-invalid"]')
    expect(invalidNotice.text()).toBe('settings.documentsModels.invalid.providerDisabled')

    const trigger = wrapper.get('[data-testid="documents-text-model-trigger"]')
    expect(trigger.classes()).toContain('border-destructive')

    wrapper.unmount()
  })

  it('saves on save', async () => {
    const { wrapper, configClient, viewModel } = await mountPage({
      settings: {
        'documents.concurrency': 6
      },
      ...fullSetup
    })

    textSelect(wrapper).emit({ id: 'model-a1', name: 'Model A1' }, 'prov-a')
    visionSelect(wrapper).emit({ id: 'model-b1', name: 'Model B1' }, 'prov-b')
    await flushPromises()

    expect(viewModel.canSave).toBe(true)

    const concurrencyInput = wrapper.get('[data-testid="documents-concurrency-input"]')
    await concurrencyInput.setValue('3')

    await (viewModel.save as () => Promise<void>)()
    await flushPromises()

    const calls = configClient.setSetting.mock.calls
    const findCall = (key: string) => calls.find((call) => call[0] === key)

    expect(findCall('documents.textModel')).toEqual([
      'documents.textModel',
      { providerId: 'prov-a', modelId: 'model-a1' }
    ])
    expect(findCall('documents.visionModel')).toEqual([
      'documents.visionModel',
      { providerId: 'prov-b', modelId: 'model-b1' }
    ])
    expect(findCall('documents.concurrency')).toEqual(['documents.concurrency', 3])
    expect(findCall('documents.temperature')).toEqual(['documents.temperature', null])
    expect(findCall('documents.maxTokens')).toEqual(['documents.maxTokens', null])

    expect(viewModel.savedTextModel).toEqual({ providerId: 'prov-a', modelId: 'model-a1' })
    expect(viewModel.savedVisionModel).toEqual({ providerId: 'prov-b', modelId: 'model-b1' })

    wrapper.unmount()
  })
})
