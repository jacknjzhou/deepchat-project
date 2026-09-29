import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const switchStub = defineComponent({
  name: 'SwitchStub',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: '<button type="button" @click="$emit(\'update:modelValue\', !modelValue)" />'
})

const selectStub = defineComponent({
  name: 'SelectStub',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><slot /></select>'
})

const selectTriggerStub = defineComponent({
  name: 'SelectTrigger',
  template: '<div><slot /></div>'
})
const selectValueStub = defineComponent({ name: 'SelectValue', template: '<slot />' })
const selectContentStub = defineComponent({ name: 'SelectContent', template: '<slot />' })
const selectItemStub = defineComponent({
  name: 'SelectItem',
  props: ['value'],
  template: '<option :value="value"><slot /></option>'
})

const baseConfig = { generateExplanation: true, includeRawText: false, maxConcurrency: 3 }

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
        Switch: switchStub,
        Select: selectStub,
        SelectTrigger: selectTriggerStub,
        SelectValue: selectValueStub,
        SelectContent: selectContentStub,
        SelectItem: selectItemStub
      }
    }
  })
}

describe('ScreeningConfigCard', () => {
  it('切换开关以不可变替换方式上抛完整配置', async () => {
    const wrapper = await setup(baseConfig)
    await wrapper.get('[data-testid="config-explanation"] button').trigger('click')
    expect(wrapper.emitted('update:config')?.[0]).toEqual([
      { generateExplanation: false, includeRawText: false, maxConcurrency: 3 }
    ])
  })

  it('选择并发数上抛数值型配置', async () => {
    const wrapper = await setup(baseConfig)
    await wrapper.find('select').setValue('2')
    expect(wrapper.emitted('update:config')?.[0]).toEqual([
      { generateExplanation: true, includeRawText: false, maxConcurrency: 2 }
    ])
  })

  it('渲染 5 个并发选项', async () => {
    const wrapper = await setup(baseConfig)
    expect(wrapper.findAll('option')).toHaveLength(5)
  })
})
