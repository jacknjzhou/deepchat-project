import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSettingMock = vi.fn()
const setSettingMock = vi.fn()

vi.mock('@api/ConfigClient', () => ({
  createConfigClient: () => ({
    getSetting: (...args: unknown[]) => getSettingMock(...args),
    setSetting: (...args: unknown[]) => setSettingMock(...args)
  })
}))

const managedStatus = {
  value: { documentsLocked: true, providerIds: ['managed-corp-gw'] }
}

vi.mock('@/stores/managedStore', () => ({
  useManagedStore: () => ({
    get documentsLocked() {
      return managedStatus.value.documentsLocked
    },
    load: vi.fn(),
    refreshConfig: vi.fn(),
    isManagedProvider: (id: string) => managedStatus.value.providerIds.includes(id)
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

describe('DocumentsModelsSettings (managed)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    managedStatus.value = { documentsLocked: true, providerIds: ['managed-corp-gw'] }
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
})
