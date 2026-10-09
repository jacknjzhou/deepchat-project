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

type ManagedModelRefLike = { providerId: string; modelId: string; endpointType?: string }
type ManagedDocuments = {
  textModel: ManagedModelRefLike | null
  visionModel: ManagedModelRefLike | null
  concurrency: number | null
  temperature: number | null
  maxTokens: number | null
}

const managedStatus = reactive<{
  documentsLocked: boolean
  providerIds: string[]
  loading: boolean
  documents: ManagedDocuments | null
}>({
  documentsLocked: true,
  providerIds: ['managed-corp-gw'],
  loading: false,
  documents: null
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
    get documents() {
      return managedStatus.documents
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
    managedStatus.documents = null
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

  it('shows the effective managed documents values when locked', async () => {
    // 用户键（A）与托管值（B）刻意不同：锁定态只读页必须展示托管生效值 B
    managedStatus.documents = {
      textModel: { providerId: 'managed-corp-gw', modelId: 'gpt-4o' },
      visionModel: { providerId: 'managed-corp-gw', modelId: 'gpt-4o' },
      concurrency: 8,
      temperature: 0.7,
      maxTokens: 2048
    }
    getSettingMock.mockImplementation((key: string) => {
      if (key === 'documents.textModel') {
        return { providerId: 'managed-corp-gw', modelId: 'deepseek-v3' }
      }
      if (key === 'documents.visionModel') {
        return { providerId: 'managed-corp-gw', modelId: 'deepseek-v3' }
      }
      if (key === 'documents.concurrency') return 2
      if (key === 'documents.temperature') return 1.5
      if (key === 'documents.maxTokens') return 999
      return undefined
    })

    const wrapper = mountPage()
    await flushPromises()

    // 标签解析对托管 provider 的模型生效（企业网关 / GPT-4o）
    expect(wrapper.get('[data-testid="documents-text-model-trigger"]').text()).toContain('GPT-4o')
    expect(wrapper.get('[data-testid="documents-vision-model-trigger"]').text()).toContain('GPT-4o')

    expect(
      (wrapper.get('[data-testid="documents-concurrency-input"]').element as HTMLInputElement).value
    ).toBe('8')
    expect(
      (wrapper.get('[data-testid="documents-temperature-input"]').element as HTMLInputElement).value
    ).toBe('0.7')
    expect(
      (wrapper.get('[data-testid="documents-max-tokens-input"]').element as HTMLInputElement).value
    ).toBe('2048')

    // 锁定态下展示用的托管值不会被写回用户键
    expect(setSettingMock).not.toHaveBeenCalled()
  })

  it('falls back to user keys when the managed documents section is absent', async () => {
    managedStatus.documents = null
    getSettingMock.mockImplementation((key: string) => {
      if (key === 'documents.textModel') {
        return { providerId: 'managed-corp-gw', modelId: 'deepseek-v3' }
      }
      if (key === 'documents.visionModel') {
        return { providerId: 'managed-corp-gw', modelId: 'deepseek-v3' }
      }
      if (key === 'documents.concurrency') return 2
      return undefined
    })

    const wrapper = mountPage()
    await flushPromises()

    expect(wrapper.get('[data-testid="documents-text-model-trigger"]').text()).toContain(
      'DeepSeek V3'
    )
    expect(wrapper.get('[data-testid="documents-vision-model-trigger"]').text()).toContain(
      'DeepSeek V3'
    )
    expect(
      (wrapper.get('[data-testid="documents-concurrency-input"]').element as HTMLInputElement).value
    ).toBe('2')
  })
})
