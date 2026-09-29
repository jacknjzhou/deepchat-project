import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { ResumeScreeningTaskDto } from '@api/resumeScreeningTasks'

const t = (key: string) => key

vi.resetModules()
vi.doMock('vue-i18n', () => ({
  useI18n: () => ({ t })
}))

const DcBadgeStub = { name: 'DcBadge', template: '<span class="dc-badge-stub"><slot /></span>' }

async function setup(props: {
  tasks: ResumeScreeningTaskDto[]
  tasksLoaded: boolean
  selectedId: string | null
}) {
  const { default: TaskHistoryList } =
    await import('@/pages/resumeScreening/components/TaskHistoryList.vue')
  const wrapper = mount(TaskHistoryList, {
    props,
    global: { stubs: { DcBadge: DcBadgeStub } }
  })
  return wrapper
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

describe('TaskHistoryList', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('任务列表为空且已加载时显示空态', async () => {
    wrapper = await setup({ tasks: [], tasksLoaded: true, selectedId: null })
    expect(wrapper.find('[data-testid="history-empty"]').exists()).toBe(true)
  })

  it('渲染任务条目（状态徽标 + 进度 + 时间）', async () => {
    wrapper = await setup({
      tasks: [
        makeTask({ id: 'task-1' }),
        makeTask({ id: 'task-2', status: 'running', total: 5, succeeded: 2, failed: 0 })
      ],
      tasksLoaded: true,
      selectedId: null
    })
    const items = wrapper.findAll('li')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('resumeScreening.statusCompleted')
    expect(items[0].text()).toContain('2/2')
    expect(items[1].text()).toContain('resumeScreening.statusRunning')
    expect(items[1].text()).toContain('2/5')
  })

  it('选中项带高亮样式', async () => {
    wrapper = await setup({
      tasks: [makeTask({ id: 'task-1' })],
      tasksLoaded: true,
      selectedId: 'task-1'
    })
    expect(wrapper.find('[data-testid="history-item-task-1"]').classes()).toContain('bg-muted')
  })

  it('点击条目上抛 select(taskId)', async () => {
    wrapper = await setup({
      tasks: [makeTask({ id: 'task-1' })],
      tasksLoaded: true,
      selectedId: null
    })
    await wrapper.find('[data-testid="history-item-task-1"]').trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual(['task-1'])
  })

  it('单页时不显示翻页控件', async () => {
    wrapper = await setup({
      tasks: [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' })],
      tasksLoaded: true,
      selectedId: null
    })
    expect(wrapper.find('[data-testid="history-pagination"]').exists()).toBe(false)
  })

  it('超过每页条数时分页显示，首页禁用上一页', async () => {
    wrapper = await setup({
      tasks: Array.from({ length: 6 }, (_, i) => makeTask({ id: `task-${i + 1}` })),
      tasksLoaded: true,
      selectedId: null
    })
    expect(wrapper.findAll('li')).toHaveLength(4)
    expect(wrapper.find('[data-testid="history-prev"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="history-next"]').attributes('disabled')).toBeUndefined()
  })

  it('点击下一页显示剩余条目并禁用下一页，上一页可返回', async () => {
    wrapper = await setup({
      tasks: Array.from({ length: 6 }, (_, i) => makeTask({ id: `task-${i + 1}` })),
      tasksLoaded: true,
      selectedId: null
    })
    await wrapper.find('[data-testid="history-next"]').trigger('click')
    expect(wrapper.findAll('li')).toHaveLength(2)
    expect(wrapper.find('[data-testid="history-item-task-5"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="history-next"]').attributes('disabled')).toBeDefined()

    await wrapper.find('[data-testid="history-prev"]').trigger('click')
    expect(wrapper.findAll('li')).toHaveLength(4)
    expect(wrapper.find('[data-testid="history-item-task-1"]').exists()).toBe(true)
  })

  it('列表收缩后页码越界时收敛到最后一页', async () => {
    wrapper = await setup({
      tasks: Array.from({ length: 6 }, (_, i) => makeTask({ id: `task-${i + 1}` })),
      tasksLoaded: true,
      selectedId: null
    })
    await wrapper.find('[data-testid="history-next"]').trigger('click')
    await wrapper.setProps({ tasks: [makeTask({ id: 'task-1' })] })
    expect(wrapper.findAll('li')).toHaveLength(1)
    expect(wrapper.find('[data-testid="history-item-task-1"]').exists()).toBe(true)
  })
})
