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

  it('展示 resumeInfo 键值对与源文件预览（pdf 内嵌 iframe）', async () => {
    wrapper = await setup(makeResume())
    const info = wrapper.find('[data-testid="detail-info"]')
    expect(info.exists()).toBe(true)
    expect(info.text()).toContain('学历')
    expect(info.text()).toContain('本科')
    expect(info.text()).toContain('Vue、TypeScript')
    const preview = wrapper.find('[data-testid="detail-preview"]')
    expect(preview.exists()).toBe(true)
    expect(preview.attributes('src')).toBe('resume-preview://task-1/resume-1.pdf')
  })

  it('基本信息按个人基础/其余字段分两栏展示', async () => {
    wrapper = await setup(
      makeResume({
        resumeInfo: {
          name: '黄桂茂',
          gender: '男',
          phone: '13530034871',
          university: '中国农业大学',
          major: '计算机网络技术',
          work_years: '8',
          recent_company: '深圳市宝深珠宝有限公司'
        }
      })
    )
    const groups = wrapper.findAll('[data-testid="detail-info-group"]')
    expect(groups).toHaveLength(2)
    expect(groups[0].text()).toContain('黄桂茂')
    expect(groups[0].text()).toContain('中国农业大学')
    expect(groups[1].text()).toContain('计算机网络技术')
    expect(groups[1].text()).toContain('深圳市宝深珠宝有限公司')
  })

  it('数组字段通栏显示，标量字段保持两栏', async () => {
    wrapper = await setup(
      makeResume({
        resumeInfo: {
          name: '黄桂茂',
          gender: '男',
          major: '计算机网络技术',
          skills: ['Linux', 'Docker'],
          work_history: [{ company: '阿里云', title: '项目经理' }],
          empty_list: []
        }
      })
    )
    const groups = wrapper.findAll('[data-testid="detail-info-group"]')
    expect(groups).toHaveLength(2)
    expect(groups[0].text()).toContain('黄桂茂')
    expect(groups[0].text()).not.toContain('Linux')
    expect(groups[1].text()).toContain('计算机网络技术')

    const wide = wrapper.findAll('[data-testid="detail-info-wide"]')
    expect(wide).toHaveLength(3)
    expect(wide[0].text()).toContain('Linux、Docker')
    expect(wide[1].text()).toContain('· company:阿里云，title:项目经理')
    expect(wide[2].text()).toContain('—')
  })

  it('对象数组渲染为键值文本而非 [object Object]', async () => {
    wrapper = await setup(
      makeResume({
        resumeInfo: {
          work_history: [
            { company: '阿里云', title: '项目经理' },
            { company: '海康威视', title: '研发工程师' }
          ],
          empty_list: []
        }
      })
    )
    const info = wrapper.find('[data-testid="detail-info"]')
    expect(info.text()).toContain('· company:阿里云，title:项目经理')
    expect(info.text()).toContain('· company:海康威视，title:研发工程师')
    expect(info.text()).not.toContain('[object Object]')
    expect(info.text()).toContain('—')
  })

  it('rawText 为 null 时源文件预览仍渲染（文件已存盘，预览不依赖解析文本）', async () => {
    wrapper = await setup(makeResume({ rawText: null }))
    expect(wrapper.find('[data-testid="detail-preview"]').exists()).toBe(true)
  })

  it('docx 等不可内嵌渲染的格式显示不支持提示', async () => {
    wrapper = await setup(makeResume({ fileName: '李四.docx' }))
    expect(wrapper.find('[data-testid="detail-preview"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-preview-unsupported"]').exists()).toBe(true)
  })
})
