import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const switchStub = defineComponent({
  name: 'SwitchStub',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: '<button type="button" @click="$emit(\'update:modelValue\', !modelValue)" />'
})

const baseConfig = { generateExplanation: true, includeRawText: true }

async function setup(config: typeof baseConfig) {
  vi.resetModules()
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({ t: (key: string) => key })
  }))
  const ScreeningConfigCard = (
    await import('../../../../src/renderer/src/pages/resumeScreening/components/ScreeningConfigCard.vue')
  ).default
  return mount(ScreeningConfigCard, {
    props: { config },
    global: {
      stubs: {
        Switch: switchStub
      }
    }
  })
}

describe('ScreeningConfigCard', () => {
  it('只渲染两个开关（并发数已固定，不提供配置）', async () => {
    const wrapper = await setup(baseConfig)
    expect(wrapper.findAll('[data-testid="config-explanation"] button')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="config-raw-text"] button')).toHaveLength(1)
    expect(wrapper.find('select').exists()).toBe(false)
  })

  it('切换开关以不可变替换方式上抛完整配置', async () => {
    const wrapper = await setup(baseConfig)
    await wrapper.get('[data-testid="config-explanation"] button').trigger('click')
    expect(wrapper.emitted('update:config')?.[0]).toEqual([
      { generateExplanation: false, includeRawText: true }
    ])

    // 模拟父组件回灌新配置后，再切换原文开关（受控组件语义）
    await wrapper.setProps({ config: { generateExplanation: false, includeRawText: true } })
    await wrapper.get('[data-testid="config-raw-text"] button').trigger('click')
    expect(wrapper.emitted('update:config')?.[1]).toEqual([
      { generateExplanation: false, includeRawText: false }
    ])
  })
})
