import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const dcButtonStub = defineComponent({
  name: 'DcButtonStub',
  props: ['variant', 'size', 'disabled', 'loading', 'active', 'label', 'icon'],
  template: '<button :disabled="disabled"><slot /></button>'
})

async function setup(props: Record<string, unknown>) {
  vi.resetModules()
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({ t: (key: string) => key })
  }))
  const ReviewButton = (
    await import('../../../../src/renderer/src/pages/resumeScreening/components/ReviewButton.vue')
  ).default
  return mount(ReviewButton, { props, global: { stubs: { DcButton: dcButtonStub } } })
}

const startDisabled = (wrapper: { get: (selector: string) => { element: Element } }) =>
  (wrapper.get('[data-testid="review-start"]').element as HTMLButtonElement).disabled

describe('ReviewButton', () => {
  it('不可审阅时开始按钮禁用', async () => {
    const wrapper = await setup({ canReview: false, isRunning: false, isCreating: false })
    expect(startDisabled(wrapper)).toBe(true)
  })

  it('可审阅时点击上抛 review', async () => {
    const wrapper = await setup({ canReview: true, isRunning: false, isCreating: false })
    expect(startDisabled(wrapper)).toBe(false)
    await wrapper.get('[data-testid="review-start"]').trigger('click')
    expect(wrapper.emitted('review')).toHaveLength(1)
  })

  it('创建中把 loading 传给开始按钮', async () => {
    const wrapper = await setup({ canReview: true, isRunning: false, isCreating: true })
    expect(wrapper.findComponent(dcButtonStub).props('loading')).toBe(true)
  })

  it('运行中渲染取消按钮并上抛 cancel', async () => {
    const wrapper = await setup({ canReview: false, isRunning: true, isCreating: false })
    expect(wrapper.find('[data-testid="review-start"]').exists()).toBe(false)
    await wrapper.get('[data-testid="review-cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })
})
