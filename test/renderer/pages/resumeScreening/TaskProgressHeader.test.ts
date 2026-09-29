import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { ResumeScreeningTaskDto } from '@api/resumeScreeningTasks'

const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key} ${JSON.stringify(params)}` : key

vi.resetModules()
vi.doMock('vue-i18n', () => ({
  useI18n: () => ({ t })
}))

const DcBadgeStub = { name: 'DcBadge', template: '<span class="dc-badge-stub"><slot /></span>' }

async function setup(props: { task: ResumeScreeningTaskDto }) {
  const { default: TaskProgressHeader } =
    await import('@/pages/resumeScreening/components/TaskProgressHeader.vue')
  return mount(TaskProgressHeader, {
    props,
    global: { stubs: { DcBadge: DcBadgeStub } }
  })
}

function makeTask(overrides: Partial<ResumeScreeningTaskDto> = {}): ResumeScreeningTaskDto {
  return {
    id: 'task-1',
    status: 'completed',
    jdSource: 'text',
    jdText: '前端工程师',
    jdFileName: null,
    jdAnalysis: null,
    config: { generateExplanation: true, includeRawText: false, maxConcurrency: 3 },
    providerId: 'openai',
    modelId: 'gpt-4o',
    total: 2,
    succeeded: 1,
    failed: 1,
    avgScore: 78.5,
    recommendedCount: 1,
    createdByName: '张三',
    createdByEmail: 'zhang@example.com',
    startedAt: 1700000000000,
    finishedAt: 1700000060000,
    createdAt: 1700000000000,
    updatedAt: 1700000060000,
    ...overrides
  }
}

describe('TaskProgressHeader', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('total=0 时进度条为 0% 避免除零', async () => {
    wrapper = await setup({
      task: makeTask({
        status: 'queued',
        total: 0,
        succeeded: 0,
        failed: 0,
        avgScore: null,
        recommendedCount: 0
      })
    })
    expect(wrapper.get('[data-testid="progress-total"]').text()).toContain('0')
    expect(wrapper.get('.h-full').attributes('style')).toContain('width: 0%')
  })

  it('avgScore 为 null 时显示占位符破折号', async () => {
    wrapper = await setup({ task: makeTask({ avgScore: null }) })
    expect(wrapper.get('[data-testid="progress-avg-score"]').text()).toContain('—')
  })

  it('展示提交人与起止时间，时间经 toLocaleString 格式化', async () => {
    wrapper = await setup({ task: makeTask() })
    expect(wrapper.get('[data-testid="progress-submitter"]').text()).toContain('张三')
    const timestamps = wrapper.get('[data-testid="progress-timestamps"]').text()
    expect(timestamps).toContain(new Date(1700000000000).toLocaleString())
    expect(timestamps).toContain(new Date(1700000060000).toLocaleString())
  })

  it('startedAt/finishedAt 为 null 时显示占位破折号', async () => {
    wrapper = await setup({ task: makeTask({ startedAt: null, finishedAt: null }) })
    expect(wrapper.get('[data-testid="progress-timestamps"]').text()).toContain('—')
  })

  it('正常任务渲染统计数字、状态徽标与 100% 进度条', async () => {
    wrapper = await setup({ task: makeTask() })
    expect(wrapper.get('.dc-badge-stub').text()).toBe('resumeScreening.statusCompleted')
    expect(wrapper.get('[data-testid="progress-total"]').text()).toContain('2')
    expect(wrapper.get('[data-testid="progress-succeeded"]').text()).toContain('1')
    expect(wrapper.get('[data-testid="progress-failed"]').text()).toContain('1')
    expect(wrapper.get('[data-testid="progress-avg-score"]').text()).toContain('78.5')
    expect(wrapper.get('[data-testid="progress-recommended"]').text()).toContain('1')
    expect(wrapper.get('.h-full').attributes('style')).toContain('width: 100%')
  })
})
