import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { describe, expect, it, vi } from 'vitest'

// test/setup.renderer.ts 全局把 vue-i18n mock 成「t 直接返回 key」。
// 这里还原真实实现，否则无法验证「未知错误码不泄露原始 code」。
vi.mock('vue-i18n', async () => ({
  ...(await vi.importActual<typeof import('vue-i18n')>('vue-i18n'))
}))

import KnowledgeStaleBanner from '@/components/chat/KnowledgeStaleBanner.vue'
import zhCN from '@/i18n/zh-CN/digitalEmployee.json'

/**
 * 提示条只做一件事：把「知识可能过期」和「该怎么修」讲清楚。
 *
 * 三种原因对应三种用户动作，措辞不能混：
 * - NO_EMBEDDING_MODEL → 去设置里配嵌入模型（用户可自行解决）
 * - HTTP_401 / HTTP_403 → 检查 StaffDeck 的 API Key（用户可自行解决）
 * - 其他 → 后台会自动重试（用户无需动作）
 */

function createWrapper(props: {
  staleReason: string | null
  knowledgeBaseId?: string
  dfFrom?: number
}) {
  const i18n = createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: { 'zh-CN': { digitalEmployee: zhCN } }
  })
  return mount(KnowledgeStaleBanner, {
    props: {
      knowledgeBaseId: props.knowledgeBaseId ?? 'kb-1',
      staleReason: props.staleReason,
      lastSyncAt: props.dfFrom ?? 1_700_000_000_000
    },
    global: { plugins: [i18n] }
  })
}

describe('KnowledgeStaleBanner', () => {
  it('asks the user to configure an embedding model', () => {
    const wrapper = createWrapper({ staleReason: 'NO_EMBEDDING_MODEL' })

    const text = wrapper.text()
    expect(wrapper.get('[data-testid="knowledge-stale-banner"]').exists()).toBe(true)
    // 这是唯一「用户必须动手」的原因，必须明确指向设置页。
    expect(text).toContain('嵌入模型')
  })

  it('points at the api key when authentication failed', () => {
    const wrapper = createWrapper({ staleReason: 'HTTP_401' })

    expect(wrapper.text()).toContain('API Key')
  })

  it('says it will retry on its own for transient failures', () => {
    const wrapper = createWrapper({ staleReason: 'PARTIAL' })

    // 用户无需动作时不该让用户去找按钮。
    expect(wrapper.text()).toContain('重试')
    expect(wrapper.find('[data-testid="knowledge-stale-action"]').exists()).toBe(false)
  })

  it('never renders a raw stale reason code', () => {
    const wrapper = createWrapper({ staleReason: 'SOMETHING_NEW_FROM_THE_FUTURE' })

    // 未知码必须走兜底文案：直接显示原始码等于把内部实现泄露给用户。
    expect(wrapper.text()).not.toContain('SOMETHING_NEW_FROM_THE_FUTURE')
    expect(wrapper.text()).toContain('知识可能已过期')
  })

  it('renders nothing when the reason is null', () => {
    const wrapper = createWrapper({ staleReason: null })

    expect(wrapper.find('[data-testid="knowledge-stale-banner"]').exists()).toBe(false)
  })
})
