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
  get enabledEmployees(): DigitalEmployee[] {
    return this.employees.filter((employee) => employee.enabled)
  },
  loadInitialData: vi.fn(async () => {}),
  toggleFavorite: vi.fn(async () => {}),
  acknowledgeConfigUpdates: vi.fn(async () => {}),
  fetchEmployees: vi.fn(async () => {}),
  startConversation: vi.fn(async () => '')
})

const configurationChangedListenerRef: { current: (() => void) | null } = { current: null }

const pushMock = vi.fn(async () => {})

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
  template: '<div><span class="dc-empty-title">{{ title }}</span><span class="dc-empty-description">{{ description }}</span><slot /></div>'
})

async function setup() {
  vi.resetModules()
  stubStore.employees = [
    makeEmployee(),
    makeEmployee({ id: 'emp-2', name: '数据分析师', role: '分析师', capabilities: ['数据分析'], sops: [], knowledgeBaseIds: [] }),
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
    useRouter: () => ({ push: pushMock })
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
        DialogContent: defineComponent({ name: 'DialogContentStub', template: '<div><slot /></div>' }),
        DialogHeader: defineComponent({ name: 'DialogHeaderStub', template: '<div><slot /></div>' }),
        DialogTitle: defineComponent({ name: 'DialogTitleStub', template: '<div><slot /></div>' }),
        DialogDescription: defineComponent({ name: 'DialogDescriptionStub', template: '<div><slot /></div>' })
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
    mcpStubStore.loadTools.mockClear()
    mcpStubStore.tools = []
    pushMock.mockClear()
  })

  it('renders all tab cards by default', async () => {
    const { wrapper } = await setup()
    expect(stubStore.loadInitialData).toHaveBeenCalled()
    expect(wrapper.find('[data-testid="digital-employee-card-emp-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="digital-employee-card-emp-2"]').exists()).toBe(true)
    // disabled 员工不渲染
    expect(wrapper.find('[data-testid="digital-employee-card-emp-3"]').exists()).toBe(false)
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
    expect(stubStore.startConversation).toHaveBeenCalledWith(stubStore.employees[0], {
      openingQuestion: undefined,
      availableMcpToolNames: []
    })
    expect(pushMock).toHaveBeenCalledWith({ name: 'chat' })
    // 弹层关闭
    expect(wrapper.find('[data-testid="digital-employee-detail-dialog"]').exists()).toBe(false)
  })

  it('start failure keeps dialog open, shows error, and disables button while busy', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="digital-employee-card-emp-1"]').trigger('click')
    await flushPromises()
    // 受控 promise：模拟 startConversation 长时间挂起后失败
    let rejectFn!: (error: Error) => void
    stubStore.startConversation.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectFn = reject })
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
    expect(wrapper.get('[data-testid="digital-employee-start-button"]').attributes('disabled')).toBeUndefined()
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
