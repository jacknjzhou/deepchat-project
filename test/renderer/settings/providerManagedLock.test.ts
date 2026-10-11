import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { LLM_PROVIDER } from '@shared/types/provider'

// test/setup.renderer.ts 全局 mock 了 pinia，这里恢复真实实现以便使用 setActivePinia
vi.mock('pinia', async () => await vi.importActual<typeof import('pinia')>('pinia'))

import providerManagedBadge from '../../../src/renderer/settings/components/ProviderManagedBadge.vue'
import ProviderApiConfig from '../../../src/renderer/settings/components/ProviderApiConfig.vue'

const createProvider = (overrides?: Partial<LLM_PROVIDER>): LLM_PROVIDER => ({
  id: 'managed-new-api',
  name: 'New API',
  apiType: 'openai-completions',
  apiKey: 'sk-corp',
  baseUrl: 'https://corp.example.com',
  enable: true,
  custom: true,
  ...overrides
})

const mountForm = (managed: boolean, overrides?: Partial<LLM_PROVIDER>) =>
  mount(ProviderApiConfig, {
    props: {
      provider: createProvider(overrides),
      managed
    }
  })

describe('ProviderManagedBadge', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('renders the organization badge for managed providers', () => {
    const wrapper = mount(providerManagedBadge, { props: { managed: true } })
    expect(wrapper.find('[data-testid="provider-managed-badge"]').exists()).toBe(true)
  })

  it('renders nothing for user providers', () => {
    const wrapper = mount(providerManagedBadge, { props: { managed: false } })
    expect(wrapper.find('[data-testid="provider-managed-badge"]').exists()).toBe(false)
  })
})

describe('managed provider editing lock', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('locks the base url and api key of a managed provider', () => {
    const wrapper = mountForm(true, { apiKey: '' })

    expect(wrapper.find('[data-testid="provider-managed-hint"]').exists()).toBe(true)
    expect(wrapper.get('input#managed-new-api-url').attributes('disabled')).toBeDefined()
    expect(wrapper.get('input#managed-new-api-apikey').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="provider-update-key-button"]').exists()).toBe(false)
    expect(
      wrapper.findAll('button').some((button) => button.text().includes('settings.provider.delete'))
    ).toBe(false)
  })

  it('keeps a user-owned instance alongside it editable', () => {
    const wrapper = mountForm(false, { apiKey: '' })

    expect(wrapper.find('[data-testid="provider-managed-hint"]').exists()).toBe(false)
    expect(wrapper.get('input#managed-new-api-url').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('input#managed-new-api-apikey').attributes('disabled')).toBeUndefined()
  })
})
