import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const dcButtonStub = defineComponent({
  name: 'DcButtonStub',
  props: ['variant', 'size', 'disabled', 'loading', 'active', 'label', 'icon'],
  template: '<button :disabled="disabled"><slot /></button>'
})

async function setup(resumes: Array<{ path: string; name: string }>) {
  vi.resetModules()
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key
    })
  }))
  vi.doMock('@/stores/resumeScreening', () => ({ RESUME_LIMIT: 20 }))
  const ResumeUploadCard = (
    await import('../../../../src/renderer/src/pages/resumeScreening/components/ResumeUploadCard.vue')
  ).default
  return mount(ResumeUploadCard, {
    props: { resumes },
    global: { stubs: { DcButton: dcButtonStub } }
  })
}

describe('ResumeUploadCard', () => {
  it('空列表渲染空态与计数', async () => {
    const wrapper = await setup([])
    expect(wrapper.get('[data-testid="resume-empty"]').text()).toContain('resumeEmpty')
    expect(wrapper.get('[data-testid="resume-count"]').text()).toContain('"current":0')
  })

  it('渲染文件列表并在移除时上抛路径', async () => {
    const wrapper = await setup([
      { path: 'C:\\a.pdf', name: 'a.pdf' },
      { path: 'C:\\b.docx', name: 'b.docx' }
    ])
    expect(wrapper.find('[data-testid="resume-empty"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="resume-item-0"]').text()).toContain('a.pdf')
    await wrapper.get('[data-testid="resume-remove-1"]').trigger('click')
    expect(wrapper.emitted('remove')?.[0]).toEqual(['C:\\b.docx'])
  })

  it('达到上限时添加按钮禁用并提示', async () => {
    const resumes = Array.from({ length: 20 }, (_, i) => ({
      path: `C:\\r${i}.pdf`,
      name: `r${i}.pdf`
    }))
    const wrapper = await setup(resumes)
    expect(
      (wrapper.get('[data-testid="resume-pick-files"]').element as HTMLButtonElement).disabled
    ).toBe(true)
    expect(wrapper.get('[data-testid="resume-limit-hint"]').text()).toContain('resumeLimitReached')
  })
})
