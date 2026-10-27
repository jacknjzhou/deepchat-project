import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, reactive } from 'vue'
import type {
  DigitalEmployee,
  DigitalEmployeeProvisionResult
} from '../../../../src/shared/contracts/routes'

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

const makeProvisionResult = (
  overrides: Partial<DigitalEmployeeProvisionResult> = {}
): DigitalEmployeeProvisionResult => ({
  employeeId: 'emp-1',
  skipped: null,
  toolsReady: true,
  knowledgeToolReady: true,
  installedSkills: 1,
  failedSkills: [],
  failureReasons: {},
  skillNames: ['emp-1:skill-write'],
  failures: [],
  ...overrides
})

const stubStore = reactive({
  listKnowledgePackages: vi.fn(async () => []),
  provisionEmployee: vi.fn(async () => null)
})

const slotStub = (name: string) => defineComponent({ name, template: '<div><slot /></div>' })

async function setup(options: {
  employee: DigitalEmployee | null
  provisionResult?: DigitalEmployeeProvisionResult | null
  open?: boolean
}) {
  vi.resetModules()
  stubStore.listKnowledgePackages.mockClear()
  stubStore.provisionEmployee.mockClear()
  vi.doMock('@/stores/digitalEmployeeStore', () => ({
    useDigitalEmployeeStore: () => stubStore
  }))
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key
    })
  }))
  const DigitalEmployeeDetailSheet = (
    await import('../../../../src/renderer/src/pages/digitalEmployee/DigitalEmployeeDetailSheet.vue')
  ).default
  const wrapper = mount(DigitalEmployeeDetailSheet, {
    props: {
      employee: options.employee,
      provisionResult: options.provisionResult ?? null,
      open: options.open ?? true
    },
    global: {
      stubs: {
        Sheet: slotStub('SheetStub'),
        SheetContent: slotStub('SheetContentStub'),
        SheetHeader: slotStub('SheetHeaderStub'),
        SheetTitle: slotStub('SheetTitleStub'),
        SheetDescription: slotStub('SheetDescriptionStub')
      }
    }
  })
  await flushPromises()
  return { wrapper }
}

describe('DigitalEmployeeDetailSheet', () => {
  beforeEach(() => {
    stubStore.listKnowledgePackages.mockResolvedValue([])
  })

  it('renders all four sections for a fully configured employee', async () => {
    const { wrapper } = await setup({
      employee: makeEmployee({
        skills: [{ id: 'skill-write', name: '写作技能', downloadUrl: 'https://x/skill' }]
      }),
      provisionResult: makeProvisionResult()
    })
    expect(wrapper.find('[data-testid="detail-overview"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-sops"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-knowledge"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-skills"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-tools"]').exists()).toBe(true)
    // 技能：服务端明细 + 本地安装状态
    expect(wrapper.text()).toContain('写作技能')
    expect(wrapper.text()).toContain('emp-1:skill-write')
    // 工具：名单 + 就绪徽标
    expect(wrapper.text()).toContain('browser')
    expect(wrapper.text()).toContain('digitalEmployee.detail.toolsReady')
    expect(wrapper.text()).toContain('digitalEmployee.detail.knowledgeToolReady')
  })

  it('shows SOP full content without the 600-char prompt truncation', async () => {
    const longContent = 'x'.repeat(700)
    const { wrapper } = await setup({
      employee: makeEmployee({ sops: [{ title: '长SOP', content: longContent }] })
    })
    expect(wrapper.find('[data-testid="detail-sop-content-长SOP"]').text()).toBe(longContent)
  })

  it('renders knowledge package status cards', async () => {
    stubStore.listKnowledgePackages.mockResolvedValue([
      {
        knowledgeBaseId: 'kb-1',
        stale: false,
        staleReason: null,
        lastSyncAt: '2026-01-01T08:00:00.000Z',
        conceptCount: 5
      },
      {
        knowledgeBaseId: 'kb-2',
        stale: true,
        staleReason: 'NO_EMBEDDING_MODEL',
        lastSyncAt: '',
        conceptCount: 0
      }
    ])
    const { wrapper } = await setup({ employee: makeEmployee() })
    expect(stubStore.listKnowledgePackages).toHaveBeenCalledWith('emp-1')
    expect(wrapper.find('[data-testid="detail-knowledge-kb-1"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('digitalEmployee.detail.knowledgeFresh')
    expect(wrapper.text()).toContain(
      'digitalEmployee.detail.knowledgeStale:{"reason":"NO_EMBEDDING_MODEL"}'
    )
    expect(wrapper.text()).toContain('digitalEmployee.detail.knowledgeMeta:')
  })

  it('shows the unavailable placeholder when status fetch yields nothing', async () => {
    const { wrapper } = await setup({ employee: makeEmployee() })
    expect(wrapper.find('[data-testid="detail-knowledge-unavailable"]').exists()).toBe(true)
  })

  it('shows empty-state copy for unconfigured sections', async () => {
    const { wrapper } = await setup({
      employee: makeEmployee({ sops: [], knowledgeBaseIds: [], tools: [], skillIds: [] })
    })
    expect(wrapper.text()).toContain('digitalEmployee.detail.emptySops')
    expect(wrapper.text()).toContain('digitalEmployee.detail.emptyKnowledge')
    expect(wrapper.text()).toContain('digitalEmployee.detail.emptySkills')
    expect(wrapper.text()).toContain('digitalEmployee.detail.emptyTools')
    // 未绑定知识库时不发状态请求
    expect(stubStore.listKnowledgePackages).not.toHaveBeenCalled()
  })

  it('shows the not-provisioned hint for local employees only', async () => {
    const local = await setup({ employee: makeEmployee(), provisionResult: null })
    expect(local.wrapper.find('[data-testid="detail-not-provisioned"]').exists()).toBe(true)

    const remote = await setup({
      employee: makeEmployee({ id: 'emp-2', executionMode: 'remote' }),
      provisionResult: null
    })
    expect(remote.wrapper.find('[data-testid="detail-not-provisioned"]').exists()).toBe(false)
  })

  it('lists failed skills with reasons', async () => {
    const { wrapper } = await setup({
      employee: makeEmployee(),
      provisionResult: makeProvisionResult({
        failedSkills: ['skill-broken'],
        failureReasons: { 'skill-broken': 'HTTP 401' }
      })
    })
    expect(wrapper.find('[data-testid="detail-failed-skills"]').text()).toContain('skill-broken')
    expect(wrapper.find('[data-testid="detail-failed-skills"]').text()).toContain('HTTP 401')
  })

  it('is read-only: no inputs and provisioning is never triggered', async () => {
    const { wrapper } = await setup({
      employee: makeEmployee(),
      provisionResult: makeProvisionResult()
    })
    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.find('button').exists()).toBe(false)
    expect(stubStore.provisionEmployee).not.toHaveBeenCalled()
  })

  it('does not render content when closed', async () => {
    const { wrapper } = await setup({ employee: makeEmployee(), open: false })
    expect(wrapper.find('[data-testid="detail-sops"]').exists()).toBe(false)
  })
})
