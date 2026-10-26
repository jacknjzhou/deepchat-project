import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, reactive } from 'vue'
import type { DigitalEmployee } from '../../../../src/shared/contracts/routes'

const makeEmployee = (overrides: Partial<DigitalEmployee> = {}): DigitalEmployee => ({
  id: 'emp-1',
  name: '文案写手',
  role: '写手',
  description: '擅长文案创作',
  avatar: null,
  capabilities: ['文案写作', '内容策划'],
  greeting: null,
  systemPrompt: '你是文案写手',
  sops: [{ title: '公众号写作SOP', content: '步骤' }],
  knowledgeBaseIds: ['kb-1'],
  skillIds: ['skill-write'],
  tools: ['browser'],
  enabled: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides
})

// Reactive like the real pinia store: tab/search filters read store state
// across renders, so grid content only stays correct with reactivity.
const stubStore = reactive({
  employees: [] as DigitalEmployee[],
  loading: false,
  error: null as string | null,
  degraded: false,
  dataSource: 'mock' as 'http' | 'mock',
  hasConfigUpdates: false,
  selectedDigitalEmployeeId: null as string | null,
  favorites: [] as string[],
  sessionBindings: {} as Record<string, string>,
  // 页面用总开关判定去留；默认「已开启且已加载」，个别用例再翻转。
  featureEnabled: true,
  initialized: true,
  get enabledEmployees(): DigitalEmployee[] {
    return this.employees.filter((employee) => employee.enabled)
  },
  loadInitialData: vi.fn(async () => {}),
  toggleFavorite: vi.fn(async () => {}),
  acknowledgeConfigUpdates: vi.fn(async () => {}),
  fetchEmployees: vi.fn(async () => {}),
  // 本地执行前的准备：默认成功但不产生技能名，页面据此退回 payload 的 skillIds。
  provisionEmployee: vi.fn(async () => null),
  startConversation: vi.fn(async () => '')
})

const configurationChangedListenerRef: { current: (() => void) | null } = { current: null }

const pushMock = vi.fn(async () => {})

const replaceMock = vi.fn(async () => {})

const notifyRenderer = vi.hoisted(() => vi.fn())

const mcpStubStore = {
  tools: [] as Array<{ function: { name: string } }>,
  loadTools: vi.fn(async () => {})
}

const inputStub = defineComponent({
  name: 'InputStub',
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup(_, { emit }) {
    return {
      handleInput: (event: Event) => {
        emit('update:modelValue', (event.target as HTMLInputElement).value)
      }
    }
  },
  template: '<input :value="modelValue" @input="handleInput" />'
})

const dcButtonStub = defineComponent({
  name: 'DcButtonStub',
  props: ['variant', 'size', 'disabled', 'loading'],
  template: '<button :disabled="disabled"><slot /></button>'
})

const dcBadgeStub = defineComponent({
  name: 'DcBadgeStub',
  props: ['variant'],
  template: '<span><slot /></span>'
})

const dcEmptyStub = defineComponent({
  name: 'DcEmptyStub',
  props: ['icon', 'title', 'description'],
  template:
    '<div><span class="dc-empty-title">{{ title }}</span><span class="dc-empty-description">{{ description }}</span><slot /></div>'
})

async function setup() {
  vi.resetModules()
  notifyRenderer.mockClear()
  stubStore.employees = [
    makeEmployee(),
    makeEmployee({
      id: 'emp-2',
      name: '数据分析师',
      role: '分析师',
      capabilities: ['数据分析'],
      sops: [],
      knowledgeBaseIds: []
    }),
    makeEmployee({ id: 'emp-3', name: '代码助手', role: '程序员', enabled: false })
  ]
  stubStore.favorites = ['emp-1']
  stubStore.loading = false
  stubStore.degraded = false
  stubStore.hasConfigUpdates = false
  vi.doMock('@/stores/digitalEmployeeStore', () => ({
    useDigitalEmployeeStore: () => stubStore
  }))
  vi.doMock('@/stores/mcp', () => ({
    useMcpStore: () => mcpStubStore
  }))
  vi.doMock('@api/DigitalEmployeeSettingsClient', () => ({
    createDigitalEmployeeSettingsClient: () => ({
      onConfigurationChanged: (listener: () => void) => {
        configurationChangedListenerRef.current = listener
        return () => {}
      }
    })
  }))
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key
    })
  }))
  vi.doMock('vue-router', () => ({
    useRouter: () => ({ push: pushMock, replace: replaceMock })
  }))
  vi.doMock('@renderer-notifications/rendererNotificationPort', () => ({
    notifyRenderer
  }))
  const DigitalEmployeeSquarePage = (
    await import('../../../../src/renderer/src/pages/digitalEmployee/DigitalEmployeeSquarePage.vue')
  ).default

  const wrapper = mount(DigitalEmployeeSquarePage, {
    global: {
      stubs: {
        Icon: true,
        Input: inputStub,
        Skeleton: true,
        DcButton: dcButtonStub,
        DcBadge: dcBadgeStub,
        DcEmpty: dcEmptyStub,
        Dialog: defineComponent({ name: 'DialogStub', template: '<div><slot /></div>' }),
        DialogContent: defineComponent({
          name: 'DialogContentStub',
          template: '<div><slot /></div>'
        }),
        DialogHeader: defineComponent({
          name: 'DialogHeaderStub',
          template: '<div><slot /></div>'
        }),
        DialogTitle: defineComponent({ name: 'DialogTitleStub', template: '<div><slot /></div>' }),
        DialogDescription: defineComponent({
          name: 'DialogDescriptionStub',
          template: '<div><slot /></div>'
        })
      }
    }
  })
  await flushPromises()
  return { wrapper }
}

describe('DigitalEmployeeSquarePage', () => {
  beforeEach(() => {
    stubStore.loadInitialData.mockClear()
    stubStore.toggleFavorite.mockClear()
    stubStore.acknowledgeConfigUpdates.mockClear()
    stubStore.fetchEmployees.mockClear()
    configurationChangedListenerRef.current = null
    stubStore.startConversation.mockClear()
    stubStore.startConversation.mockResolvedValue('')
    stubStore.featureEnabled = true
    stubStore.initialized = true
    mcpStubStore.loadTools.mockClear()
    mcpStubStore.tools = []
    pushMock.mockClear()
    replaceMock.mockClear()
  })

  it('renders all tab cards by default', async () => {
    const { wrapper } = await setup()
    expect(stubStore.loadInitialData).toHaveBeenCalled()
    expect(wrapper.find('[data-testid="digital-employee-card-emp-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="digital-employee-card-emp-2"]').exists()).toBe(true)
    // disabled 员工不渲染
    expect(wrapper.find('[data-testid="digital-employee-card-emp-3"]').exists()).toBe(false)
  })

  it('leaves the page when the feature master switch turns off', async () => {
    // 总开关被关掉后（设置窗口改完广播回来），页面不能停留在已下线的功能里。
    await setup()
    expect(replaceMock).not.toHaveBeenCalled()

    stubStore.featureEnabled = false
    await flushPromises()

    expect(replaceMock).toHaveBeenCalledWith({ name: 'chat' })
  })

  it('search filters cards by name/capability', async () => {
    const { wrapper } = await setup()
    const input = wrapper.get('input[data-testid="digital-employee-search-input"]')
    await input.setValue('数据')
    await flushPromises()
    expect(wrapper.find('[data-testid="digital-employee-card-emp-1"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="digital-employee-card-emp-2"]').exists()).toBe(true)
    await input.setValue('不存在的关键词xyz')
    await flushPromises()
    expect(wrapper.find('[data-testid="digital-employee-card-emp-2"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('digitalEmployee.emptyTitle')
  })

  it('mine tab shows only favorites', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="digital-employee-tab-mine"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="digital-employee-card-emp-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="digital-employee-card-emp-2"]').exists()).toBe(false)
  })

  it('team tab shows placeholder empty state', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="digital-employee-tab-team"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('digitalEmployee.teamComingSoon')
    // team tab 不应同时出现「没有找到数字员工」空态
    expect(wrapper.text()).not.toContain('digitalEmployee.emptyTitle')
  })

  it('favorite star toggles favorite without opening detail dialog', async () => {
    const { wrapper } = await setup()
    // 未收藏卡片（emp-2）的星标：点击调用 toggleFavorite 且不冒泡打开详情弹层
    await wrapper.get('[data-testid="digital-employee-favorite-emp-2"]').trigger('click')
    await flushPromises()
    expect(stubStore.toggleFavorite).toHaveBeenCalledTimes(1)
    expect(stubStore.toggleFavorite).toHaveBeenCalledWith('emp-2')
    expect(wrapper.find('[data-testid="digital-employee-detail-dialog"]').exists()).toBe(false)
    // 已收藏卡片（emp-1）的星标同样只切换收藏
    await wrapper.get('[data-testid="digital-employee-favorite-emp-1"]').trigger('click')
    await flushPromises()
    expect(stubStore.toggleFavorite).toHaveBeenLastCalledWith('emp-1')
    expect(wrapper.find('[data-testid="digital-employee-detail-dialog"]').exists()).toBe(false)
  })

  it('detail dialog lists the four capability sections and navigates to chat on start', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="digital-employee-card-emp-1"]').trigger('click')
    await flushPromises()
    const dialog = wrapper.get('[data-testid="digital-employee-detail-dialog"]')
    // 四类配置清单
    expect(dialog.text()).toContain('digitalEmployee.sectionSops')
    expect(dialog.text()).toContain('公众号写作SOP')
    expect(dialog.text()).toContain('digitalEmployee.sectionSkills')
    expect(dialog.text()).toContain('digitalEmployee.sectionTools')
    expect(dialog.text()).toContain('digitalEmployee.sectionKnowledge')
    // 点开始按钮 → 先加载 MCP 工具列表，再调用 store 并跳转 chat 路由
    await wrapper.get('[data-testid="digital-employee-start-button"]').trigger('click')
    await flushPromises()
    expect(mcpStubStore.loadTools).toHaveBeenCalledTimes(1)
    // force 是必须的：refresh 在 30 秒 staleTime 内返回注册前的缓存。
    expect(mcpStubStore.loadTools).toHaveBeenCalledWith({ force: true })
    expect(stubStore.startConversation).toHaveBeenCalledWith(stubStore.employees[0], {
      openingQuestion: undefined,
      availableMcpToolNames: []
    })
    expect(pushMock).toHaveBeenCalledWith({ name: 'chat' })
    // 弹层关闭
    expect(wrapper.find('[data-testid="digital-employee-detail-dialog"]').exists()).toBe(false)
  })

  it('provisions before reading the tool list, so the allowlist sees staffdeck tools', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="digital-employee-card-emp-1"]').trigger('click')
    await flushPromises()

    const callOrder: string[] = []
    stubStore.provisionEmployee.mockImplementation(async () => {
      callOrder.push('provision')
      return {
        employeeId: 'emp-1',
        skipped: null,
        toolsReady: true,
        knowledgeToolReady: true,
        installedSkills: 1,
        failedSkills: [],
        failureReasons: {},
        skillNames: ['de-emp-1-writing'],
        failures: []
      }
    })
    mcpStubStore.loadTools.mockImplementation(async () => {
      callOrder.push('loadTools')
    })

    await wrapper.get('[data-testid="digital-employee-start-button"]').trigger('click')
    await flushPromises()

    // 顺序是硬要求：注册晚了，白名单就会把一个还没出现的工具当成「不存在」，
    // 第一轮对话里员工一个远端工具都用不上，而且没有重试机会。
    expect(callOrder).toEqual(['provision', 'loadTools'])
    expect(stubStore.provisionEmployee).toHaveBeenCalledWith('emp-1')
  })

  it('passes the installed skill names through to the conversation', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="digital-employee-card-emp-1"]').trigger('click')
    await flushPromises()

    stubStore.provisionEmployee.mockResolvedValue({
      employeeId: 'emp-1',
      skipped: null,
      toolsReady: true,
      knowledgeToolReady: true,
      installedSkills: 1,
      failedSkills: [],
      skillNames: ['de-emp-1-writing'],
      failures: []
    })

    await wrapper.get('[data-testid="digital-employee-start-button"]').trigger('click')
    await flushPromises()

    // 装出来的名字带员工前缀，payload 的 slug 在本地技能目录里不存在。
    expect(stubStore.startConversation).toHaveBeenCalledWith(
      stubStore.employees[0],
      expect.objectContaining({ activeSkillNames: ['de-emp-1-writing'] })
    )
  })

  it('shows the last provisioning result in the detail dialog', async () => {
    const { wrapper } = await setup()
    // 没准备过的员工不显示结果区块。
    await wrapper.get('[data-testid="digital-employee-card-emp-2"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="digital-employee-provision-result"]').exists()).toBe(false)

    await wrapper.get('[data-testid="digital-employee-card-emp-1"]').trigger('click')
    await flushPromises()

    stubStore.provisionEmployee.mockResolvedValue({
      employeeId: 'emp-1',
      skipped: null,
      toolsReady: true,
      knowledgeToolReady: true,
      installedSkills: 2,
      failedSkills: ['de-emp-1-broken'],
      failureReasons: { 'de-emp-1-broken': 'HTTP_401' },
      skillNames: ['de-emp-1-writing', 'de-emp-1-report'],
      failures: []
    })

    await wrapper.get('[data-testid="digital-employee-start-button"]').trigger('click')
    await flushPromises()

    // 弹层随跳转关闭；重新打开仍能看到最近一次准备的实际结果与失败原因。
    await wrapper.get('[data-testid="digital-employee-card-emp-1"]').trigger('click')
    await flushPromises()
    const result = wrapper.get('[data-testid="digital-employee-provision-result"]')
    expect(result.text()).toContain('digitalEmployee.provision.installedSkills')
    expect(result.text()).toContain('de-emp-1-writing')
    expect(result.text()).toContain('digitalEmployee.provision.skillInstallFailed')
    expect(result.text()).toContain('de-emp-1-broken')
    expect(result.text()).toContain('HTTP_401')
  })

  it('says nothing when provisioning was fully successful', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="digital-employee-card-emp-1"]').trigger('click')
    await flushPromises()

    stubStore.provisionEmployee.mockResolvedValue({
      employeeId: 'emp-1',
      skipped: null,
      toolsReady: true,
      knowledgeToolReady: true,
      installedSkills: 1,
      failedSkills: [],
      skillNames: ['de-emp-1-writing'],
      failures: []
    })

    await wrapper.get('[data-testid="digital-employee-start-button"]').trigger('click')
    await flushPromises()

    expect(notifyRenderer).not.toHaveBeenCalled()
  })

  it('warns when the cloud tools never registered', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="digital-employee-card-emp-1"]').trigger('click')
    await flushPromises()

    stubStore.provisionEmployee.mockResolvedValue({
      employeeId: 'emp-1',
      skipped: null,
      toolsReady: false,
      knowledgeToolReady: true,
      installedSkills: 1,
      failedSkills: [],
      failureReasons: {},
      skillNames: ['de-emp-1-writing'],
      failures: ['mcp']
    })

    await wrapper.get('[data-testid="digital-employee-start-button"]').trigger('click')
    await flushPromises()

    // 静默降级会让用户以为员工带着工具在跑，只觉得「它怎么不会用工具」。
    expect(notifyRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'warning',
        description: 'digitalEmployee.provision.degradedTools'
      })
    )
    expect(pushMock).toHaveBeenCalledWith({ name: 'chat' })
  })

  it('warns with the count when some skills failed to install', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="digital-employee-card-emp-1"]').trigger('click')
    await flushPromises()

    stubStore.provisionEmployee.mockResolvedValue({
      employeeId: 'emp-1',
      skipped: null,
      toolsReady: true,
      knowledgeToolReady: true,
      installedSkills: 1,
      failedSkills: ['broken-pkg'],
      failureReasons: { 'broken-pkg': 'HTTP 404' },
      skillNames: ['de-emp-1-writing'],
      failures: ['skills']
    })

    await wrapper.get('[data-testid="digital-employee-start-button"]').trigger('click')
    await flushPromises()

    expect(notifyRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'warning',
        description: expect.stringContaining('degradedSkills')
      })
    )
    // 原因必须随 toast 透出：HTTP 404 和安装器拒绝的处置完全不同。
    expect(notifyRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('broken-pkg: HTTP 404')
      })
    )
  })

  it('warns when the local knowledge search did not start', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="digital-employee-card-emp-1"]').trigger('click')
    await flushPromises()

    stubStore.provisionEmployee.mockResolvedValue({
      employeeId: 'emp-1',
      skipped: null,
      toolsReady: true,
      knowledgeToolReady: false,
      installedSkills: 1,
      failedSkills: [],
      failureReasons: {},
      skillNames: ['de-emp-1-writing'],
      failures: ['knowledgeTool']
    })

    await wrapper.get('[data-testid="digital-employee-start-button"]').trigger('click')
    await flushPromises()

    // 配了知识库但检索工具没起来：会话照常，但模型查不了知识，必须说出来。
    expect(notifyRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'warning',
        description: 'digitalEmployee.provision.knowledgeToolUnavailable'
      })
    )
  })

  it('stays quiet about the knowledge tool for an employee without knowledge bases', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="digital-employee-card-emp-2"]').trigger('click')
    await flushPromises()

    stubStore.provisionEmployee.mockResolvedValue({
      employeeId: 'emp-2',
      skipped: null,
      toolsReady: true,
      knowledgeToolReady: false,
      installedSkills: 0,
      failedSkills: [],
      failureReasons: {},
      skillNames: [],
      failures: []
    })

    await wrapper.get('[data-testid="digital-employee-start-button"]').trigger('click')
    await flushPromises()

    // 没配知识库的员工本来就没有检索工具（注册器按常态清理），不是降级。
    expect(notifyRenderer).not.toHaveBeenCalled()
  })

  it('keeps quiet when provisioning was skipped, which is not a degradation', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="digital-employee-card-emp-1"]').trigger('click')
    await flushPromises()

    stubStore.provisionEmployee.mockResolvedValue({
      employeeId: 'emp-1',
      skipped: 'NOT_LOCAL',
      toolsReady: false,
      installedSkills: 0,
      failedSkills: [],
      failureReasons: {},
      skillNames: [],
      failures: []
    })

    await wrapper.get('[data-testid="digital-employee-start-button"]').trigger('click')
    await flushPromises()

    // remote 员工本来就不在本地准备，`skipped` 不是降级信号。
    expect(notifyRenderer).not.toHaveBeenCalled()
  })

  it('starts the conversation even when provisioning throws', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="digital-employee-card-emp-1"]').trigger('click')
    await flushPromises()

    stubStore.provisionEmployee.mockRejectedValue(new Error('ipc down'))

    await wrapper.get('[data-testid="digital-employee-start-button"]').trigger('click')
    await flushPromises()

    // 准备工作失败只能是「能力少一点」，不能变成「点不动开始」。
    expect(stubStore.startConversation).toHaveBeenCalledTimes(1)
    expect(pushMock).toHaveBeenCalledWith({ name: 'chat' })
  })

  it('start failure keeps dialog open, shows error, and disables button while busy', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="digital-employee-card-emp-1"]').trigger('click')
    await flushPromises()
    // 受控 promise：模拟 startConversation 长时间挂起后失败
    let rejectFn!: (error: Error) => void
    stubStore.startConversation.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectFn = reject
        })
    )
    const startButton = wrapper.get('[data-testid="digital-employee-start-button"]')
    await startButton.trigger('click')
    await flushPromises()
    expect(stubStore.startConversation).toHaveBeenCalledTimes(1)
    // 忙碌中：按钮禁用（防双击重复建会话）
    expect(startButton.attributes('disabled')).toBeDefined()
    // 忙碌中的第二次点击被忽略
    await startButton.trigger('click')
    expect(stubStore.startConversation).toHaveBeenCalledTimes(1)
    rejectFn(new Error('boom'))
    await flushPromises()
    // 失败后：弹层保持打开、展示错误反馈、忙碌态清除（按钮恢复可用）
    expect(wrapper.find('[data-testid="digital-employee-detail-dialog"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="digital-employee-start-error"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('digitalEmployee.startConversationFailed')
    expect(
      wrapper.get('[data-testid="digital-employee-start-button"]').attributes('disabled')
    ).toBeUndefined()
    expect(pushMock).not.toHaveBeenCalled()
    // 错误恢复后可再次点击
    stubStore.startConversation.mockResolvedValue('session-1')
    await wrapper.get('[data-testid="digital-employee-start-button"]').trigger('click')
    await flushPromises()
    expect(pushMock).toHaveBeenCalledWith({ name: 'chat' })
    expect(wrapper.find('[data-testid="digital-employee-detail-dialog"]').exists()).toBe(false)
  })

  it('shows a degraded banner that states local mock data is being used', async () => {
    const { wrapper } = await setup()
    stubStore.degraded = true
    await flushPromises()

    const banner = wrapper.get('[data-testid="digital-employee-degraded-banner"]')
    expect(banner.text()).toContain('digitalEmployee.banner.degraded')
    // 不得把降级描述成缓存命中或仍然连接成功
    expect(banner.text()).not.toContain('digitalEmployee.banner.cache')
  })

  it('hides the degraded banner when the provider is healthy', async () => {
    const { wrapper } = await setup()
    expect(wrapper.find('[data-testid="digital-employee-degraded-banner"]').exists()).toBe(false)
  })

  it('shows the config-updated banner and acknowledges it', async () => {
    const { wrapper } = await setup()
    stubStore.hasConfigUpdates = true
    await flushPromises()

    expect(wrapper.get('[data-testid="digital-employee-config-updated-banner"]').text()).toContain(
      'digitalEmployee.banner.configUpdated'
    )

    await wrapper.get('[data-testid="digital-employee-ack-config-updates"]').trigger('click')
    await flushPromises()
    expect(stubStore.acknowledgeConfigUpdates).toHaveBeenCalledTimes(1)
  })

  it('hides the config-updated banner when there is nothing new', async () => {
    const { wrapper } = await setup()
    expect(wrapper.find('[data-testid="digital-employee-config-updated-banner"]').exists()).toBe(
      false
    )
  })

  it('shows the execution location badge per card', async () => {
    const { wrapper } = await setup()
    // setup() 每次都会重置 employees，因此在挂载后再改（stubStore 是 reactive 的）
    stubStore.employees = [
      makeEmployee({ executionMode: 'remote' }),
      makeEmployee({ id: 'emp-2', name: '本地助手', executionMode: 'local' })
    ]
    await flushPromises()

    // 卡片上必须能看出「跑在云端还是本地」：两者消息落库/审计位置不同
    expect(wrapper.get('[data-testid="digital-employee-mode-emp-1"]').text()).toContain(
      'digitalEmployee.remote.badge'
    )
    expect(wrapper.get('[data-testid="digital-employee-mode-emp-2"]').text()).toContain(
      'digitalEmployee.local.badge'
    )
  })

  it('treats a missing executionMode as local on the card', async () => {
    const { wrapper } = await setup()

    expect(wrapper.get('[data-testid="digital-employee-mode-emp-1"]').text()).toContain(
      'digitalEmployee.local.badge'
    )
  })

  it('refreshes employees when the main process reports a configuration change', async () => {
    await setup()
    expect(configurationChangedListenerRef.current).not.toBeNull()

    configurationChangedListenerRef.current?.()
    await flushPromises()

    // 设置页保存/清除密钥后无需手动重进页面
    expect(stubStore.fetchEmployees).toHaveBeenCalledTimes(1)
  })
})
