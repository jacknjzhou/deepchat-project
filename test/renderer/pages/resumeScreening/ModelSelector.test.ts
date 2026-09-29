import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

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

const models = [
  {
    providerId: 'openai',
    providerName: 'OpenAI',
    modelId: 'gpt-4o',
    modelName: 'GPT-4o',
    isDefault: true
  },
  {
    providerId: 'anthropic',
    providerName: 'Anthropic',
    modelId: 'claude',
    modelName: 'Claude',
    isDefault: false
  }
]

async function setup(props: Record<string, unknown>) {
  vi.resetModules()
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({ t: (key: string) => key })
  }))
  const ModelSelector = (
    await import('../../../../src/renderer/src/pages/resumeScreening/components/ModelSelector.vue')
  ).default
  return mount(ModelSelector, {
    props,
    global: {
      stubs: {
        Select: selectStub,
        SelectTrigger: selectTriggerStub,
        SelectValue: selectValueStub,
        SelectContent: selectContentStub,
        SelectItem: selectItemStub
      }
    }
  })
}

describe('ModelSelector', () => {
  it('渲染 provider/model 组合的选项', async () => {
    const wrapper = await setup({ models, modelKey: 'openai::gpt-4o' })
    const options = wrapper.findAll('option')
    expect(options).toHaveLength(2)
    expect(options[0].element.value).toBe('openai::gpt-4o')
    expect(options[1].text()).toContain('Anthropic / Claude')
  })

  it('选择模型上抛 modelKey', async () => {
    const wrapper = await setup({ models, modelKey: 'openai::gpt-4o' })
    await wrapper.find('select').setValue('anthropic::claude')
    expect(wrapper.emitted('update:modelKey')?.[0]).toEqual(['anthropic::claude'])
  })
})
