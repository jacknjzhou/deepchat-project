import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { ResumeScreeningResumeDto } from '@api/resumeScreeningTasks'

const t = (key: string) => key

vi.resetModules()
vi.doMock('vue-i18n', () => ({
  useI18n: () => ({ t })
}))

const DcBadgeStub = { name: 'DcBadge', template: '<span class="dc-badge-stub"><slot /></span>' }

async function setup(resume: ResumeScreeningResumeDto | null) {
  const { default: ResumeDetailPanel } =
    await import('@/pages/resumeScreening/components/ResumeDetailPanel.vue')
  const wrapper = mount(ResumeDetailPanel, {
    props: { resume },
    global: { stubs: { DcBadge: DcBadgeStub } }
  })
  return wrapper
}

function makeResume(overrides: Partial<ResumeScreeningResumeDto> = {}): ResumeScreeningResumeDto {
  return {
    id: 'resume-1',
    taskId: 'task-1',
    fileName: '张三.pdf',
    mimeType: 'application/pdf',
    size: 1024,
    candidateName: '张三',
    rawText: '张三的简历原文',
    resumeInfo: { 学历: '本科', 技能: ['Vue', 'TypeScript'] },
    screening: { score: 88, recommended: true, conclusion: '匹配度高', strengths: ['技术扎实'] },
    interview: { highlights: ['沟通顺畅'], risks: ['经验较浅'], questions: ['项目细节'] },
    hr: { finalSummary: '整体优秀', hrOpinion: '建议推进' },
    score: 88,
    recommended: true,
    status: 'done',
    error: null,
    createdAt: 1700000000000,
    updatedAt: 1700000060000,
    ...overrides
  }
}

describe('ResumeDetailPanel', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('resume 为 null 时显示空态', async () => {
    wrapper = await setup(null)
    expect(wrapper.find('[data-testid="detail-empty"]').exists()).toBe(true)
  })

  it('处理失败时显示错误信息', async () => {
    wrapper = await setup(makeResume({ status: 'failed', error: 'PDF 解析失败' }))
    expect(wrapper.find('[data-testid="detail-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-error"]').text()).toContain('PDF 解析失败')
  })

  it('默认显示基本信息 Tab，缺失的节不渲染对应 Tab', async () => {
    wrapper = await setup(makeResume({ screening: null, interview: null, hr: null }))
    expect(wrapper.find('[data-testid="detail-tab-profile"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-tab-screening"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-tab-interview"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-tab-hr"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="profile-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-info"]').text()).toContain('学历')
  })

  it('展示初筛评估节（点击 Tab 后：结论 + 优势 + 分数）', async () => {
    wrapper = await setup(makeResume())
    await wrapper.find('[data-testid="detail-tab-screening"]').trigger('click')
    const section = wrapper.find('[data-testid="screening-section"]')
    expect(section.exists()).toBe(true)
    expect(section.text()).toContain('匹配度高')
    expect(section.text()).toContain('技术扎实')
    expect(wrapper.find('[data-testid="profile-section"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('88')
  })

  it('Tab 间切换渲染对应内容节', async () => {
    wrapper = await setup(makeResume())
    await wrapper.find('[data-testid="detail-tab-interview"]').trigger('click')
    expect(wrapper.find('[data-testid="interview-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="interview-section"]').text()).toContain('项目细节')

    await wrapper.find('[data-testid="detail-tab-hr"]').trigger('click')
    expect(wrapper.find('[data-testid="hr-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="hr-section"]').text()).toContain('整体优秀')
    expect(wrapper.find('[data-testid="interview-section"]').exists()).toBe(false)
  })

  it('切换简历后回到基本信息 Tab', async () => {
    wrapper = await setup(makeResume())
    await wrapper.find('[data-testid="detail-tab-screening"]').trigger('click')
    await wrapper.setProps({ resume: makeResume({ id: 'resume-2', candidateName: '李四' }) })
    expect(wrapper.find('[data-testid="profile-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="screening-section"]').exists()).toBe(false)
  })

  it('展示 resumeInfo 键值对与 rawText', async () => {
    wrapper = await setup(makeResume())
    const info = wrapper.find('[data-testid="detail-info"]')
    expect(info.exists()).toBe(true)
    expect(info.text()).toContain('学历')
    expect(info.text()).toContain('本科')
    expect(info.text()).toContain('Vue、TypeScript')
    expect(wrapper.find('[data-testid="detail-rawtext"]').text()).toContain('张三的简历原文')
  })

  it('rawText 为 null 时不渲染原文节', async () => {
    wrapper = await setup(makeResume({ rawText: null }))
    expect(wrapper.find('[data-testid="detail-rawtext"]').exists()).toBe(false)
  })
})
