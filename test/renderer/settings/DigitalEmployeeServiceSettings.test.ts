import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const passthrough = (name: string) => defineComponent({ name, template: '<div><slot /></div>' })

const baseState = {
  enabled: false,
  baseUrl: '',
  externalUserId: 'user-1',
  apiKeyConfigured: true
}

let clientMock: {
  get: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  testConnection: ReturnType<typeof vi.fn>
  clearApiKey: ReturnType<typeof vi.fn>
}

async function setup() {
  vi.resetModules()
  clientMock = {
    get: vi.fn(async () => ({ ...baseState })),
    save: vi.fn(async (draft: Record<string, unknown>) => ({
      ...baseState,
      enabled: draft.enabled as boolean,
      baseUrl: draft.baseUrl as string,
      externalUserId: draft.externalUserId as string,
      apiKeyConfigured: Boolean(draft.apiKey) || baseState.apiKeyConfigured
    })),
    testConnection: vi.fn(async () => ({ ok: true, messageCode: 'ok' })),
    clearApiKey: vi.fn(async () => ({ apiKeyConfigured: false }))
  }

  vi.doMock('@api/DigitalEmployeeSettingsClient', () => ({
    createDigitalEmployeeSettingsClient: () => clientMock
  }))
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key
    })
  }))

  const Component = (
    await import('../../../src/renderer/settings/components/DigitalEmployeeServiceSettings.vue')
  ).default

  const wrapper = mount(Component, {
    global: {
      stubs: {
        SettingsPageShell: passthrough('SettingsPageShell'),
        SettingsSectionCard: passthrough('SettingsSectionCard'),
        Icon: true,
        Spinner: true,
        Alert: defineComponent({
          name: 'AlertStub',
          props: ['variant'],
          template: '<div class="alert" :data-variant="variant"><slot /></div>'
        }),
        AlertTitle: passthrough('AlertTitle'),
        AlertDescription: passthrough('AlertDescription'),
        Label: passthrough('Label'),
        Input: defineComponent({
          name: 'InputStub',
          props: ['modelValue', 'placeholder', 'type', 'disabled', 'id'],
          emits: ['update:modelValue'],
          methods: {
            onInput(event: Event) {
              this.$emit('update:modelValue', (event.target as HTMLInputElement).value)
            }
          },
          template:
            '<input :id="id" :type="type" :placeholder="placeholder" :disabled="disabled" :value="modelValue" @input="onInput" />'
        }),
        Switch: defineComponent({
          name: 'SwitchStub',
          props: ['modelValue'],
          emits: ['update:modelValue'],
          template:
            '<button data-testid="switch" @click="$emit(\'update:modelValue\', !modelValue)">{{ modelValue }}</button>'
        }),
        DcButton: defineComponent({
          name: 'DcButtonStub',
          props: ['variant', 'size', 'disabled'],
          emits: ['click'],
          template:
            '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>'
        }),
        DcInlineError: defineComponent({
          name: 'DcInlineErrorStub',
          props: ['error'],
          template: '<span class="inline-error">{{ error }}</span>'
        }),
        DcConfirmDialog: defineComponent({
          name: 'DcConfirmDialogStub',
          props: ['open', 'title', 'description', 'confirmLabel'],
          emits: ['update:open', 'confirm'],
          template:
            '<div v-if="open" data-testid="confirm-dialog"><button data-testid="confirm" @click="$emit(\'confirm\')">ok</button></div>'
        })
      }
    }
  })

  await flushPromises()
  return wrapper
}

const findButton = (wrapper: ReturnType<typeof mount>, label: string) =>
  wrapper.findAll('button').find((button) => button.text().includes(label))!

describe('DigitalEmployeeServiceSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads config and keeps the api key input empty while showing configured state', async () => {
    const wrapper = await setup()

    const keyInput = wrapper.get('[data-testid="digital-employee-api-key-input"]')
    expect((keyInput.element as HTMLInputElement).value).toBe('')
    expect(wrapper.get('[data-testid="digital-employee-api-key-state"]').text()).toContain(
      'digitalEmployee.service.apiKeyConfigured'
    )
    expect(clientMock.get).toHaveBeenCalledTimes(1)
  })

  it('defaults to local mock mode when StaffDeck is disabled', async () => {
    const wrapper = await setup()
    expect(wrapper.get('[data-testid="digital-employee-mode"]').text()).toContain(
      'digitalEmployee.service.modeMock'
    )
  })

  it('toggles api key visibility', async () => {
    const wrapper = await setup()
    const keyInput = wrapper.get('[data-testid="digital-employee-api-key-input"]')
    expect((keyInput.element as HTMLInputElement).type).toBe('password')

    await wrapper.get('[data-testid="digital-employee-toggle-api-key"]').trigger('click')
    await flushPromises()

    expect((keyInput.element as HTMLInputElement).type).toBe('text')
  })

  it('reports a successful connection test', async () => {
    const wrapper = await setup()
    await findButton(wrapper, 'digitalEmployee.service.testConnection').trigger('click')
    await flushPromises()

    expect(clientMock.testConnection).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="digital-employee-test-result"]').text()).toContain(
      'digitalEmployee.service.testResults.ok'
    )
  })

  it('reports an auth failure from the connection test', async () => {
    const wrapper = await setup()
    clientMock.testConnection.mockResolvedValueOnce({ ok: false, messageCode: 'unauthorized' })

    await findButton(wrapper, 'digitalEmployee.service.testConnection').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="digital-employee-test-result"]').text()).toContain(
      'digitalEmployee.service.testResults.unauthorized'
    )
  })

  it('saves the draft, clears the key input and refreshes the state', async () => {
    const wrapper = await setup()
    await wrapper.get('[data-testid="digital-employee-base-url-input"]').setValue('https://sd.example')
    await wrapper.get('[data-testid="digital-employee-api-key-input"]').setValue('sd_live_new')

    await findButton(wrapper, 'digitalEmployee.service.save').trigger('click')
    await flushPromises()

    expect(clientMock.save).toHaveBeenCalledWith({
      enabled: false,
      baseUrl: 'https://sd.example',
      externalUserId: 'user-1',
      apiKey: 'sd_live_new'
    })
    expect(
      (wrapper.get('[data-testid="digital-employee-api-key-input"]').element as HTMLInputElement)
        .value
    ).toBe('')
    expect(wrapper.find('[data-testid="digital-employee-saved"]').exists()).toBe(true)
  })

  it('does not send a save request for an invalid url', async () => {
    const wrapper = await setup()
    await wrapper.get('[data-testid="digital-employee-base-url-input"]').setValue('ftp://sd.example')

    expect(wrapper.find('[data-testid="digital-employee-base-url-error"]').exists()).toBe(true)
    const saveButton = findButton(wrapper, 'digitalEmployee.service.save')
    expect(saveButton.attributes('disabled')).toBeDefined()
    await saveButton.trigger('click')
    await flushPromises()

    expect(clientMock.save).not.toHaveBeenCalled()
  })

  it('surfaces a save failure without clearing the entered values', async () => {
    const wrapper = await setup()
    clientMock.save.mockRejectedValueOnce(new Error('disk full'))
    await wrapper.get('[data-testid="digital-employee-base-url-input"]').setValue('https://sd.example')
    await wrapper.get('[data-testid="digital-employee-api-key-input"]').setValue('sd_live_new')

    await findButton(wrapper, 'digitalEmployee.service.save').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="digital-employee-save-error"]').exists()).toBe(true)
    expect(
      (wrapper.get('[data-testid="digital-employee-api-key-input"]').element as HTMLInputElement)
        .value
    ).toBe('sd_live_new')
  })

  it('requires confirmation before clearing the api key', async () => {
    const wrapper = await setup()

    await findButton(wrapper, 'digitalEmployee.service.clearApiKey').trigger('click')
    await flushPromises()
    expect(clientMock.clearApiKey).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="digital-employee-clear-api-key-dialog"]').exists()).toBe(true)

    await wrapper.get('[data-testid="confirm"]').trigger('click')
    await flushPromises()

    expect(clientMock.clearApiKey).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="digital-employee-api-key-state"]').text()).toContain(
      'digitalEmployee.service.apiKeyNotConfigured'
    )
  })
})
