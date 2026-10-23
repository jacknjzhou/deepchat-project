import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

// test/setup.renderer.ts 全局把 vue-i18n mock 成「t 直接返回 key」。
// 这里还原真实实现，才能验证插值与默认文案是否真的进入 DOM。
vi.mock('vue-i18n', async () => vi.importActual<typeof import('vue-i18n')>('vue-i18n'))

import { createI18n } from 'vue-i18n'
import RemoteAwaitingInputPanel from '@/components/chat/RemoteAwaitingInputPanel.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  missingWarn: false,
  fallbackWarn: false,
  messages: {
    'zh-CN': {
      digitalEmployee: {
        remote: {
          awaitingTitle: '需要补充信息',
          awaitingFields: '请提供：{fields}',
          awaitingHint: '在下方输入框继续回答，将发往云端执行。'
        }
      }
    }
  }
})

function mountPanel(props: Record<string, unknown>) {
  return mount(RemoteAwaitingInputPanel, {
    props,
    global: { plugins: [i18n] }
  })
}

describe('RemoteAwaitingInputPanel', () => {
  it('renders nothing when there is no awaiting input', () => {
    const wrapper = mountPanel({ awaitingInput: null })
    expect(wrapper.find('[data-testid="remote-awaiting-panel"]').exists()).toBe(false)
  })

  it('shows the question summary from the server', () => {
    const wrapper = mountPanel({
      awaitingInput: { task_id: 't1', question_summary: '请提供报销金额' }
    })

    expect(wrapper.text()).toContain('请提供报销金额')
  })

  it('lists the expected fields', () => {
    const wrapper = mountPanel({
      awaitingInput: { task_id: 't1', expected_fields: ['金额', '事由'] }
    })

    expect(wrapper.text()).toContain('金额')
    expect(wrapper.text()).toContain('事由')
  })

  it('falls back to a title-only panel when the server sends no detail', () => {
    // awaiting_input 可能只有 task_id（agent_loop.py:1000-1006 的宽松形状）。
    const wrapper = mountPanel({ awaitingInput: { task_id: 't1' } })

    expect(wrapper.find('[data-testid="remote-awaiting-panel"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('需要补充信息')
  })

  it('does not render the input box itself', () => {
    // 输入仍复用现有 ChatInputBox：这里只做提示，避免出现两个输入框。
    const wrapper = mountPanel({ awaitingInput: { task_id: 't1', expected_fields: ['金额'] } })

    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.find('input').exists()).toBe(false)
  })
})
