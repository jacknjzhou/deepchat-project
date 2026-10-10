import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import ReimbursementConfigPage from '../../../../src/renderer/settings/components/documents/ReimbursementConfigPage.vue'
import { rendererNotificationManager } from '@renderer-notifications/rendererNotificationRuntime'
import { useDocumentsStore } from '@/stores/documents'
import type { ReimbursementConfig } from '@shared/contracts/routes'

// test/setup.renderer.ts mocks a lightweight pinia globally; restore the real one
// so the test store and the mounted component share the same pinia instance.
vi.mock('pinia', async () => vi.importActual<typeof import('pinia')>('pinia'))

// The page talks to the default documents client; replace the whole client
// factory so documentsApi (created at module load) becomes the fake below.
const fakeClient = vi.hoisted(() => ({
  reimbursementGetConfig: vi.fn(),
  reimbursementSetConfig: vi.fn(),
  reimbursementTree: vi.fn(),
  reimbursementSetOverride: vi.fn(),
  reimbursementExport: vi.fn()
}))
vi.mock('@api/DocumentsClient', () => ({ createDocumentsClient: () => fakeClient }))

const passthrough = (name: string) => defineComponent({ name, template: '<div><slot /></div>' })

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

const dcButtonStub = defineComponent({
  name: 'DcButtonStub',
  props: ['variant', 'size', 'disabled'],
  template: '<button :disabled="disabled"><slot /></button>'
})

const minimalConfig: ReimbursementConfig = {
  version: 1,
  categories: [
    { id: 'cat-a', name: '会议费', requiredMaterials: [], linkedTypeKeys: [], sortOrder: 1 },
    {
      id: 'cat-b',
      name: '交通费',
      requiredMaterials: [{ name: '出租车票', linkedTypeKeys: ['trip_date'] }],
      linkedTypeKeys: ['taxi'],
      sortOrder: 2
    }
  ],
  personFieldKeys: ['buyer_name'],
  dateFieldKeys: ['invoice_date'],
  amountFieldKeys: ['total_amount'],
  dateGrouping: 'month'
}

let notifySpy: MockInstance

beforeEach(() => {
  notifySpy = vi.spyOn(rendererNotificationManager, 'notify').mockImplementation(() => undefined)
})

async function mountPage() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useDocumentsStore()
  const wrapper = mount(ReimbursementConfigPage, {
    global: {
      plugins: [pinia],
      stubs: {
        SettingsPageShell: passthrough('SettingsPageShell'),
        SettingsSectionCard: passthrough('SettingsSectionCard'),
        Icon: true,
        Input: inputStub,
        Alert: passthrough('Alert'),
        AlertDescription: passthrough('AlertDescription'),
        DcButton: dcButtonStub
      }
    }
  })
  await flushPromises()
  return { wrapper, store }
}

describe('ReimbursementConfigPage', () => {
  it('fills the draft from the loaded config on mount', async () => {
    fakeClient.reimbursementGetConfig.mockResolvedValue({ config: minimalConfig })
    const { wrapper } = await mountPage()
    expect(fakeClient.reimbursementGetConfig).toHaveBeenCalledTimes(1)
    const names = wrapper.findAll('[data-testid="reimbursement-category-name"]')
    expect(names).toHaveLength(2)
    expect((names[0].element as HTMLInputElement).value).toBe('会议费')
    expect((names[1].element as HTMLInputElement).value).toBe('交通费')
    expect(
      (wrapper.get('[data-testid="reimbursement-global-person"]').element as HTMLInputElement).value
    ).toBe('buyer_name')
    expect(
      (
        wrapper.get('select[data-testid="reimbursement-date-grouping"]')
          .element as HTMLSelectElement
      ).value
    ).toBe('month')
  })

  it('shows validation error and blocks save when a category name is blank', async () => {
    fakeClient.reimbursementGetConfig.mockResolvedValue({ config: minimalConfig })
    const { wrapper } = await mountPage()
    await wrapper.findAll('[data-testid="reimbursement-category-name"]')[0].setValue('   ')
    expect(wrapper.find('[data-testid="reimbursement-config-error"]').exists()).toBe(true)
    expect(
      wrapper.get('[data-testid="reimbursement-config-save"]').attributes('disabled')
    ).toBeDefined()
    await wrapper.get('[data-testid="reimbursement-config-save"]').trigger('click')
    await flushPromises()
    expect(fakeClient.reimbursementSetConfig).not.toHaveBeenCalled()
  })

  it('flags invalid type keys and recovers once every key is valid', async () => {
    fakeClient.reimbursementGetConfig.mockResolvedValue({ config: minimalConfig })
    const { wrapper } = await mountPage()
    await wrapper
      .findAll('[data-testid="reimbursement-category-linked"]')[0]
      .setValue('trip_date, TRIP')
    expect(wrapper.find('[data-testid="reimbursement-config-error"]').exists()).toBe(true)
    expect(
      wrapper.get('[data-testid="reimbursement-config-save"]').attributes('disabled')
    ).toBeDefined()
    await wrapper
      .findAll('[data-testid="reimbursement-category-linked"]')[0]
      .setValue('trip_date, hotel_invoice')
    expect(wrapper.find('[data-testid="reimbursement-config-error"]').exists()).toBe(false)
    expect(
      wrapper.get('[data-testid="reimbursement-config-save"]').attributes('disabled')
    ).toBeUndefined()
  })

  it('renumbers sortOrder to 1..n after remove and move', async () => {
    const config: ReimbursementConfig = {
      version: 1,
      categories: [
        { id: 'cat-a', name: '会议费', requiredMaterials: [], linkedTypeKeys: [], sortOrder: 1 },
        { id: 'cat-b', name: '交通费', requiredMaterials: [], linkedTypeKeys: [], sortOrder: 2 },
        { id: 'cat-c', name: '住宿费', requiredMaterials: [], linkedTypeKeys: [], sortOrder: 3 }
      ],
      personFieldKeys: [],
      dateFieldKeys: [],
      amountFieldKeys: [],
      dateGrouping: 'month'
    }
    fakeClient.reimbursementGetConfig.mockResolvedValue({ config })
    fakeClient.reimbursementSetConfig.mockImplementation(async (sent: ReimbursementConfig) => ({
      config: sent
    }))
    const { wrapper } = await mountPage()
    await wrapper.findAll('[data-testid="reimbursement-category-remove"]')[0].trigger('click')
    await wrapper.findAll('[data-testid="reimbursement-category-move-up"]')[1].trigger('click')
    await wrapper.get('[data-testid="reimbursement-config-save"]').trigger('click')
    await flushPromises()
    const sent = fakeClient.reimbursementSetConfig.mock.calls[0][0] as ReimbursementConfig
    expect(sent.categories.map((category) => category.id)).toEqual(['cat-c', 'cat-b'])
    expect(sent.categories.map((category) => category.sortOrder)).toEqual([1, 2])
  })

  it('saves the reordered config, updates the store and notifies success', async () => {
    fakeClient.reimbursementGetConfig.mockResolvedValue({ config: minimalConfig })
    fakeClient.reimbursementSetConfig.mockImplementation(async (sent: ReimbursementConfig) => ({
      config: sent
    }))
    const { wrapper, store } = await mountPage()
    await wrapper.get('[data-testid="reimbursement-config-save"]').trigger('click')
    await flushPromises()
    expect(fakeClient.reimbursementSetConfig).toHaveBeenCalledTimes(1)
    const sent = fakeClient.reimbursementSetConfig.mock.calls[0][0] as ReimbursementConfig
    expect(sent.categories.map((category) => category.sortOrder)).toEqual([1, 2])
    expect(sent.version).toBe(1)
    expect(store.reimbursementConfig).toEqual(sent)
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'success', code: 'documents.reimbursement.configSaved' })
    )
  })

  it('notifies an error when saving fails', async () => {
    fakeClient.reimbursementGetConfig.mockResolvedValue({ config: minimalConfig })
    fakeClient.reimbursementSetConfig.mockRejectedValue(new Error('boom'))
    const { wrapper } = await mountPage()
    await wrapper.get('[data-testid="reimbursement-config-save"]').trigger('click')
    await flushPromises()
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', code: 'documents.reimbursement.configSaveFailed' })
    )
  })

  it('shows the load-error block and keeps save disabled when loading fails', async () => {
    fakeClient.reimbursementGetConfig.mockRejectedValue(new Error('boom'))
    const { wrapper } = await mountPage()
    expect(wrapper.find('[data-testid="reimbursement-config-load-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="reimbursement-config-retry"]').exists()).toBe(true)
    expect(
      wrapper.get('[data-testid="reimbursement-config-save"]').attributes('disabled')
    ).toBeDefined()
    expect(
      wrapper.get('[data-testid="reimbursement-config-reset"]').attributes('disabled')
    ).toBeDefined()
  })

  it('recovers after a successful retry', async () => {
    fakeClient.reimbursementGetConfig
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ config: minimalConfig })
    const { wrapper } = await mountPage()
    expect(wrapper.find('[data-testid="reimbursement-config-load-error"]').exists()).toBe(true)
    await wrapper.get('[data-testid="reimbursement-config-retry"]').trigger('click')
    await flushPromises()
    expect(fakeClient.reimbursementGetConfig).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="reimbursement-config-load-error"]').exists()).toBe(false)
    expect(
      wrapper.get('[data-testid="reimbursement-config-save"]').attributes('disabled')
    ).toBeUndefined()
  })
})
