import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSettingMock = vi.fn()
const setSettingMock = vi.fn()

vi.mock('@api/ConfigClient', () => ({
  createConfigClient: () => ({
    getSetting: (...args: unknown[]) => getSettingMock(...args),
    setSetting: (...args: unknown[]) => setSettingMock(...args)
  })
}))

const managedStatus = reactive({
  documentsLocked: true,
  providerIds: ['managed-corp-gw'],
  loading: false
})

let pendingLoad: { promise: Promise<void>; resolve: () => void } | null = null

const deferLoad = () => {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  pendingLoad = { promise, resolve }
  return pendingLoad
}

vi.mock('@/stores/managedStore', () => ({
  useManagedStore: () => ({
    get documentsLocked() {
      return managedStatus.documentsLocked
    },
    get loading() {
      return managedStatus.loading
    },
    load: () => {
      managedStatus.loading = true
      const pending = pendingLoad?.promise ?? Promise.resolve()
      return pending.finally(() => {
        managedStatus.loading = false
      })
    },
    refreshConfig: vi.fn(),
    isManagedProvider: (id: string) => managedStatus.providerIds.includes(id)
  })
}))

vi.mock('@/stores/providerStore', () => ({
  useProviderStore: () => ({
    sortedProviders: [
      {
        id: 'managed-corp-gw',
        name: '企业网关',
        enable: true,
        managed: true,
        baseProviderId: 'new-api'
      }
    ],
    providers: [
      {
        id: 'managed-corp-gw',
        name: '企业网关',
        enable: true,
        managed: true,
        baseProviderId: 'new-api'
      }
    ]
  })
}))

vi.mock('@/stores/modelStore', () => ({
  useModelStore: () => ({
    allProviderModels: [
      {
        providerId: 'managed-corp-gw',
        models: [
          { id: 'deepseek-v3', name: 'DeepSeek V3', endpointType: 'openai' },
          { id: 'gpt-4o', name: 'GPT-4o', vision: true, endpointType: 'openai' }
        ]
      }
    ],
    enabledModels: []
  })
}))

import DocumentsModelsSettings from '../../../src/renderer/settings/components/DocumentsModelsSettings.vue'

const mountPage = () => mount(DocumentsModelsSettings)

const lockedControls = [
  'documents-temperature-input',
  'documents-max-tokens-input',
  'documents-vision-model-trigger',
  'documents-text-model-trigger'
]

describe('DocumentsModelsSettings (managed)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    managedStatus.documentsLocked = true
    managedStatus.providerIds = ['managed-corp-gw']
    managedStatus.loading = false
    pendingLoad = null
    getSettingMock.mockImplementation((key: string) => {
      if (key === 'documents.textModel') {
        return { providerId: 'managed-corp-gw', modelId: 'deepseek-v3', endpointType: 'openai' }
      }
      if (key === 'documents.visionModel') {
        return { providerId: 'managed-corp-gw', modelId: 'gpt-4o' }
      }
      return undefined
    })
  })

  it('renders the page in read-only mode when documents are locked', async () => {
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.find('[data-testid="documents-models-managed-badge"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="documents-models-save"]').exists()).toBe(false)
    expect(
      wrapper.find('[data-testid="documents-concurrency-input"]').attributes('disabled')
    ).toBeDefined()
  })

  it('does not write settings on mount when locked', async () => {
    mountPage()
    await flushPromises()
    expect(setSettingMock).not.toHaveBeenCalled()
  })

  it('disables every editable control when documents are locked', async () => {
    const wrapper = mountPage()
    await flushPromises()

    for (const testId of lockedControls) {
      expect(wrapper.get(`[data-testid="${testId}"]`).attributes('disabled')).toBeDefined()
    }
  })

  it('keeps the model selectors closed when documents are locked', async () => {
    const wrapper = mountPage()
    await flushPromises()

    const trigger = wrapper.get('[data-testid="documents-text-model-trigger"]')
    expect(trigger.attributes('aria-expanded')).toBe('false')

    await trigger.trigger('click')
    await flushPromises()

    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(document.body.querySelector('[data-slot="popover-content"]')).toBeNull()
  })

  it('stays locked until the managed status finishes loading', async () => {
    const deferred = deferLoad()
    const wrapper = mountPage()
    await flushPromises()

    // 加载未返回：loading 门控生效，控件仍不可编辑
    for (const testId of lockedControls) {
      expect(wrapper.get(`[data-testid="${testId}"]`).attributes('disabled')).toBeDefined()
    }
    expect(wrapper.find('[data-testid="documents-models-save"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="documents-models-managed-badge"]').exists()).toBe(true)

    deferred.resolve()
    await flushPromises()

    expect(wrapper.find('[data-testid="documents-models-managed-badge"]').exists()).toBe(true)
    expect(
      wrapper.get('[data-testid="documents-temperature-input"]').attributes('disabled')
    ).toBeDefined()
  })

  it('releases the loading lock for unmanaged installs once loading finishes', async () => {
    managedStatus.documentsLocked = false
    const deferred = deferLoad()
    const wrapper = mountPage()
    await flushPromises()

    expect(
      wrapper.get('[data-testid="documents-temperature-input"]').attributes('disabled')
    ).toBeDefined()
    expect(wrapper.find('[data-testid="documents-models-save"]').exists()).toBe(false)

    deferred.resolve()
    await flushPromises()

    expect(
      wrapper.get('[data-testid="documents-temperature-input"]').attributes('disabled')
    ).toBeUndefined()
    expect(wrapper.find('[data-testid="documents-models-save"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="documents-models-managed-badge"]').exists()).toBe(false)
  })
})
