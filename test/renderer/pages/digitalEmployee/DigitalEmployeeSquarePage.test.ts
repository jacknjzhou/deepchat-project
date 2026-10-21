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
  selectedDigitalEmployeeId: null as string | null,
  favorites: [] as string[],
  sessionBindings: {} as Record<string, string>,
  get enabledEmployees(): DigitalEmployee[] {
    return this.employees.filter((employee) => employee.enabled)
  },
  loadInitialData: vi.fn(async () => {}),
  startConversation: vi.fn(async () => '')
})

const pushMock = vi.fn(async () => {})

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
  props: ['variant', 'size', 'disabled'],
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
  vi.doMock('@/stores/digitalEmployeeStore', () => ({
    useDigitalEmployeeStore: () => stubStore
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
    stubStore.startConversation.mockClear()
    stubStore.startConversation.mockResolvedValue('')
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
    // 点开始按钮 → 调用 store 并跳转 chat 路由
    await wrapper.get('[data-testid="digital-employee-start-button"]').trigger('click')
    await flushPromises()
    expect(stubStore.startConversation).toHaveBeenCalledWith(
      stubStore.employees[0],
      { openingQuestion: undefined }
    )
    expect(pushMock).toHaveBeenCalledWith({ name: 'chat' })
    // 弹层关闭
    expect(wrapper.find('[data-testid="digital-employee-detail-dialog"]').exists()).toBe(false)
  })
})
