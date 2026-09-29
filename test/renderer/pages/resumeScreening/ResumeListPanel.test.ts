import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { ResumeScreeningResumeDto } from '@api/resumeScreeningTasks'

const t = (key: string) => key

vi.resetModules()
vi.doMock('vue-i18n', () => ({
  useI18n: () => ({ t })
}))

const DcBadgeStub = { name: 'DcBadge', template: '<span class="dc-badge-stub"><slot /></span>' }

async function setup(props: { resumes: ResumeScreeningResumeDto[]; selectedId: string | null }) {
  const { default: ResumeListPanel } =
    await import('@/pages/resumeScreening/components/ResumeListPanel.vue')
  const wrapper = mount(ResumeListPanel, {
    props,
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
    rawText: null,
    resumeInfo: null,
    screening: null,
    interview: null,
    hr: null,
    score: 85,
    recommended: true,
    status: 'done',
    error: null,
    createdAt: 1700000000000,
    updatedAt: 1700000060000,
    ...overrides
  }
}

describe('ResumeListPanel', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('渲染简历条目（候选人名 + 状态徽标 + 分数）', async () => {
    wrapper = await setup({
      resumes: [
        makeResume(),
        makeResume({ id: 'resume-2', candidateName: null, status: 'running', score: null })
      ],
      selectedId: null
    })
    const items = wrapper.findAll('li')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('张三')
    expect(items[0].text()).toContain('85')
    expect(items[0].text()).toContain('resumeScreening.statusDone')
    expect(items[1].text()).toContain('张三.pdf')
    expect(items[1].text()).toContain('resumeScreening.statusRunning')
  })

  it('推荐简历显示推荐标记', async () => {
    wrapper = await setup({
      resumes: [
        makeResume({ recommended: true }),
        makeResume({ id: 'resume-2', recommended: false })
      ],
      selectedId: null
    })
    expect(wrapper.find('[data-testid="recommended-mark"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="recommended-mark"]')).toHaveLength(1)
  })

  it('点击条目上抛 select(resumeId)', async () => {
    wrapper = await setup({ resumes: [makeResume()], selectedId: null })
    await wrapper.find('[data-testid="result-item-resume-1"]').trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual(['resume-1'])
  })
})
