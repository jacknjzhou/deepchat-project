import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedImagePromptTemplate } from '@shared/imagePromptTemplates'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key
  })
}))

const mountCards = async (templates: ResolvedImagePromptTemplate[]) => {
  const { default: ImagePromptTemplateCards } =
    await import('@/components/chat-input/ImagePromptTemplateCards.vue')
  return mount(ImagePromptTemplateCards, { props: { templates } })
}

describe('ImagePromptTemplateCards', () => {
  it('空数组不渲染', async () => {
    const wrapper = await mountCards([])
    expect(wrapper.find('[data-testid="image-template-cards"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('点击范本发出仅含存在字段的 apply-template', async () => {
    const wrapper = await mountCards([
      { id: 'a', title: 'Design', prompt: 'design prompt', size: '1024x1024', quality: 'high' },
      { id: 'b', title: 'Mine', prompt: 'my prompt' }
    ])
    const chips = wrapper.findAll('[data-testid="image-template-card"]')
    expect(chips).toHaveLength(2)
    await chips[0].trigger('click')
    await chips[1].trigger('click')
    expect(wrapper.emitted('apply-template')).toEqual([
      [{ prompt: 'design prompt', size: '1024x1024', quality: 'high' }],
      [{ prompt: 'my prompt' }]
    ])
    wrapper.unmount()
  })
})
