import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { ResumeScreeningTaskDto } from '@api/resumeScreeningTasks'

const t = (key: string) => key

vi.resetModules()
vi.doMock('vue-i18n', () => ({
  useI18n: () => ({ t })
}))

const DcButtonStub = {
  name: 'DcButton',
  template: '<button class="dc-button-stub"><slot /></button>'
}

async function setup(jdAnalysis: ResumeScreeningTaskDto['jdAnalysis']) {
  const { default: JdContentTabs } =
    await import('@/pages/resumeScreening/components/JdContentTabs.vue')
  return mount(JdContentTabs, {
    props: { jdAnalysis },
    global: { stubs: { DcButton: DcButtonStub } }
  })
}

function makeAnalysis() {
  return {
    responsibilities: ['负责前端开发', '参与需求评审'],
    requirements: ['3 年以上经验'],
    preferred: ['有 Electron 经验']
  }
}

describe('JdContentTabs', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('jdAnalysis 为 null 时显示整体空态且不渲染内容面板', async () => {
    wrapper = await setup(null)
    expect(wrapper.find('[data-testid="jd-analysis-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="jd-content-panel-responsibilities"]').exists()).toBe(false)
  })

  it('默认展示工作职责段内容', async () => {
    wrapper = await setup(makeAnalysis())
    const panel = wrapper.get('[data-testid="jd-content-panel-responsibilities"]')
    expect(panel.text()).toContain('负责前端开发')
    expect(panel.text()).toContain('参与需求评审')
  })

  it('点击岗位要求/加分项 Tab 切换对应内容', async () => {
    wrapper = await setup(makeAnalysis())
    await wrapper.get('[data-testid="jd-content-tab-requirements"]').trigger('click')
    expect(wrapper.get('[data-testid="jd-content-panel-requirements"]').text()).toContain(
      '3 年以上经验'
    )

    await wrapper.get('[data-testid="jd-content-tab-preferred"]').trigger('click')
    expect(wrapper.get('[data-testid="jd-content-panel-preferred"]').text()).toContain(
      '有 Electron 经验'
    )
  })

  it('当前段为空数组时显示段空态占位', async () => {
    wrapper = await setup({ ...makeAnalysis(), preferred: [] })
    await wrapper.get('[data-testid="jd-content-tab-preferred"]').trigger('click')
    expect(wrapper.find('[data-testid="jd-content-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="jd-content-panel-preferred"]').exists()).toBe(false)
  })
})
