import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const dcButtonStub = defineComponent({
  name: 'DcButtonStub',
  props: ['variant', 'size', 'disabled', 'loading', 'active', 'label', 'icon'],
  template: '<button :disabled="disabled"><slot /></button>'
})

const textareaStub = defineComponent({
  name: 'TextareaStub',
  props: ['modelValue', 'placeholder', 'maxlength'],
  emits: ['update:modelValue'],
  template:
    '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />'
})

async function setup(props: Record<string, unknown>) {
  vi.resetModules()
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({ t: (key: string) => key })
  }))
  const JdInputCard = (
    await import('../../../../src/renderer/src/pages/resumeScreening/components/JdInputCard.vue')
  ).default
  return mount(JdInputCard, {
    props,
    global: { stubs: { DcButton: dcButtonStub, Textarea: textareaStub } }
  })
}

const baseProps = { jdSource: 'text', jdText: '', jdFilePath: null, jdFileName: null }

describe('JdInputCard', () => {
  it('文本模式渲染输入框并上抛文本更新', async () => {
    const wrapper = await setup(baseProps)
    expect(wrapper.find('[data-testid="jd-text-input"]').exists()).toBe(true)
    await wrapper.get('textarea').setValue('前端工程师')
    expect(wrapper.emitted('update:jdText')?.[0]).toEqual(['前端工程师'])
  })

  it('点击文件页签切换 jdSource', async () => {
    const wrapper = await setup(baseProps)
    await wrapper.get('[data-testid="jd-tab-file"]').trigger('click')
    expect(wrapper.emitted('update:jdSource')?.[0]).toEqual(['file'])
  })

  it('文件模式未选文件时渲染选择按钮并上抛 pickFile', async () => {
    const wrapper = await setup({ ...baseProps, jdSource: 'file' })
    expect(wrapper.find('[data-testid="jd-text-input"]').exists()).toBe(false)
    await wrapper.get('[data-testid="jd-pick-file"]').trigger('click')
    expect(wrapper.emitted('pickFile')).toHaveLength(1)
  })

  it('文件模式已选文件时展示文件名并支持移除', async () => {
    const wrapper = await setup({
      ...baseProps,
      jdSource: 'file',
      jdFilePath: 'C:\\jd\\frontend.txt',
      jdFileName: 'frontend.txt'
    })
    expect(wrapper.get('[data-testid="jd-file-info"]').text()).toContain('frontend.txt')
    await wrapper.get('[data-testid="jd-clear-file"]').trigger('click')
    expect(wrapper.emitted('clearFile')).toHaveLength(1)
  })
})
