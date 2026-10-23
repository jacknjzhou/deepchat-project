import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// test/setup.renderer.ts 全局 stub 了 pinia（defineStore 返回 {}），须还原真实实现
vi.mock('pinia', async () => vi.importActual<typeof import('pinia')>('pinia'))

const sessionStoreMock = vi.hoisted(() => ({
  createSession: vi.fn()
}))

const knowledgeClientMock = vi.hoisted(() => ({
  similarityQuery: vi.fn()
}))

const digitalEmployeeClientMock = vi.hoisted(() => ({
  list: vi.fn(),
  bindRemoteSession: vi.fn(),
  remoteStatus: vi.fn(),
  switchToRemote: vi.fn()
}))

const configClientMock = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn()
}))

vi.mock('../../../src/renderer/src/stores/ui/session', () => ({
  useSessionStore: () => sessionStoreMock
}))

vi.mock('../../../src/renderer/api/KnowledgeClient', () => ({
  createKnowledgeClient: () => knowledgeClientMock
}))

import {
  DIGITAL_EMPLOYEE_AGENT_ID,
  buildDigitalEmployeeSystemPrompt,
  buildDisabledAgentTools,
  useDigitalEmployeeStore
} from '../../../src/renderer/src/stores/digitalEmployeeStore'
import type { DigitalEmployee } from '../../../src/shared/contracts/routes/digitalEmployee.routes'

vi.mock('../../../src/renderer/api/DigitalEmployeeClient', () => ({
  createDigitalEmployeeClient: () => digitalEmployeeClientMock
}))

vi.mock('../../../src/renderer/api/ConfigClient', () => ({
  createConfigClient: () => configClientMock
}))

const makeEmployee = (id: string, overrides: Partial<DigitalEmployee> = {}): DigitalEmployee => ({
  id,
  name: id,
  role: id,
  description: '',
  avatar: null,
  capabilities: [],
  greeting: null,
  systemPrompt: 'p',
  sops: [],
  knowledgeBaseIds: [],
  skillIds: [],
  tools: [],
  enabled: true,
  updatedAt: '2026-10-21',
  executionMode: 'local',
  ...overrides
})

describe('digitalEmployeeStore', () => {
  const mockEmployees = () => {
    digitalEmployeeClientMock.list.mockResolvedValue({
      employees: [
        {
          id: 'finance',
          name: '财务',
          role: '财务',
          description: '',
          avatar: null,
          capabilities: [],
          greeting: '你好，我是财务助手',
          systemPrompt: 'p',
          sops: [{ title: '报销流程', content: '先提交申请单' }],
          knowledgeBaseIds: ['kb-1'],
          skillIds: ['skill-a'],
          tools: ['filesystem_read'],
          enabled: true,
          updatedAt: '2026-10-21'
        },
        {
          id: 'hr',
          name: '人事',
          role: '人事',
          description: '',
          avatar: null,
          capabilities: [],
          greeting: null,
          systemPrompt: 'p',
          sops: [],
          knowledgeBaseIds: [],
          skillIds: [],
          tools: [],
          enabled: false,
          updatedAt: '2026-10-21'
        }
      ],
      fetchedAt: '2026-10-21T00:00:00.000Z'
    })
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStoreMock.createSession.mockReset()
    sessionStoreMock.createSession.mockResolvedValue({ session: { id: 'session-9' } })
    knowledgeClientMock.similarityQuery.mockReset()
    knowledgeClientMock.similarityQuery.mockResolvedValue([
      { id: 'k1', metadata: { from: '', filePath: '', content: '片段A' }, distance: 0.1 }
    ])
    digitalEmployeeClientMock.list.mockReset()
    mockEmployees()
    configClientMock.getSetting.mockReset().mockResolvedValue(null)
    configClientMock.setSetting.mockReset().mockResolvedValue(undefined)
    digitalEmployeeClientMock.bindRemoteSession.mockReset().mockResolvedValue({
      remoteSessionId: 'remote-9',
      runId: 'run-9'
    })
    digitalEmployeeClientMock.remoteStatus.mockReset()
    digitalEmployeeClientMock.switchToRemote.mockReset()
  })

  it('ensureLoaded fetches the client only once across repeated invocations', async () => {
    const store = useDigitalEmployeeStore()
    await Promise.all([store.ensureLoaded(), store.ensureLoaded()])
    await store.ensureLoaded()
    expect(digitalEmployeeClientMock.list).toHaveBeenCalledTimes(1)
    expect(store.employees).toHaveLength(2)
    expect(store.initialized).toBe(true)
  })

  it('ensureLoaded swallows fetch errors and allows retry on next call', async () => {
    const store = useDigitalEmployeeStore()
    digitalEmployeeClientMock.list.mockRejectedValueOnce(new Error('boom'))
    await expect(store.ensureLoaded()).resolves.toBeUndefined()
    expect(store.error).toContain('Failed to load digital employees')
    expect(store.initialized).toBe(false)
    await store.ensureLoaded()
    expect(digitalEmployeeClientMock.list).toHaveBeenCalledTimes(2)
    expect(store.employees).toHaveLength(2)
    expect(store.initialized).toBe(true)
  })

  it('fetchEmployees loads list and filters enabledEmployees', async () => {
    const store = useDigitalEmployeeStore()
    await store.fetchEmployees()
    expect(store.employees).toHaveLength(2)
    expect(store.enabledEmployees.map((e) => e.id)).toEqual(['finance'])
  })

  it('toggleFavorite persists and toggles', async () => {
    const store = useDigitalEmployeeStore()
    await store.toggleFavorite('finance')
    expect(store.favorites).toEqual(['finance'])
    await store.toggleFavorite('finance')
    expect(store.favorites).toEqual([])
  })

  it('bindSession records binding and employeeForSession resolves', async () => {
    const store = useDigitalEmployeeStore()
    await store.fetchEmployees()
    await store.bindSession('session-1', 'finance')
    expect(store.employeeForSession('session-1')?.id).toBe('finance')
    expect(store.employeeForSession('unknown')).toBeNull()
  })

  it('buildDigitalEmployeeSystemPrompt composes persona, sops, greeting and knowledge', () => {
    const employee = {
      ...makeEmployee('finance'),
      sops: [{ title: '报销流程', content: '先提交申请单' }]
    }
    const prompt = buildDigitalEmployeeSystemPrompt(employee, { knowledgeSnippets: '[1] 片段A' })
    expect(prompt).toContain(employee.systemPrompt)
    expect(prompt).toContain('## SOP：')
    expect(prompt).toContain('[1] 片段A')
  })

  it('buildDisabledAgentTools returns complement of whitelist and undefined for empty whitelist', () => {
    const employee = { ...makeEmployee('finance'), tools: ['filesystem_read'] }
    expect(buildDisabledAgentTools(employee, ['filesystem_read', 'web_search'])).toEqual([
      'web_search'
    ])
    expect(buildDisabledAgentTools(employee, ['filesystem_read'])).toBeUndefined()
    expect(buildDisabledAgentTools({ ...employee, tools: [] }, ['web_search'])).toBeUndefined()
    expect(buildDisabledAgentTools(employee, undefined)).toBeUndefined()
  })

  it('startConversation creates session with capability bindings and records binding', async () => {
    const store = useDigitalEmployeeStore()
    await store.fetchEmployees()
    const employee = store.employees[0] // mock 中含 skillIds/tools/systemPrompt/sops
    const sessionId = await store.startConversation(employee, {
      openingQuestion: '帮我查报销进度',
      availableMcpToolNames: ['filesystem_read', 'web_search']
    })
    expect(sessionId).toBe('session-9')
    expect(store.selectedDigitalEmployeeId).toBe('finance')
    expect(DIGITAL_EMPLOYEE_AGENT_ID).toBe('deepchat')
    const createInput = sessionStoreMock.createSession.mock.calls[0][0]
    expect(createInput.agentId).toBe('deepchat')
    expect(createInput.activeSkills).toEqual(employee.skillIds)
    expect(createInput.disabledAgentTools).toEqual(['web_search'])
    expect(createInput.generationSettings.systemPrompt).toContain(employee.systemPrompt)
    expect(createInput.generationSettings.systemPrompt).toContain('[1] 片段A')
    expect(createInput.generationSettings.systemPrompt).toContain('你好，我是财务助手')
    expect(knowledgeClientMock.similarityQuery).toHaveBeenCalledWith('kb-1', '帮我查报销进度')
    expect(store.employeeForSession('session-9')?.id).toBe(employee.id)
  })

  it('startConversation resolves sessionId even when bindSession persistence rejects', async () => {
    const store = useDigitalEmployeeStore()
    await store.fetchEmployees()
    const employee = store.employees[0]
    // 持久化失败一次：绑定是徽标级的装饰性数据，不得让已建立的会话流程失败
    configClientMock.setSetting.mockRejectedValueOnce(new Error('persist boom'))
    await expect(
      store.startConversation(employee, { openingQuestion: '帮我查报销进度' })
    ).resolves.toBe('session-9')
    // 内存中的绑定仍按 best-effort 记录
    expect(store.employeeForSession('session-9')?.id).toBe(employee.id)
  })

  it('exposes the degraded flag from the list result', async () => {
    const store = useDigitalEmployeeStore()
    digitalEmployeeClientMock.list.mockResolvedValue({
      employees: [makeEmployee('e1')],
      fetchedAt: 't',
      degraded: true,
      source: 'mock'
    })

    await store.fetchEmployees()

    expect(store.degraded).toBe(true)
    expect(store.dataSource).toBe('mock')
  })

  it('clears the degraded flag once the provider recovers', async () => {
    const store = useDigitalEmployeeStore()
    digitalEmployeeClientMock.list.mockResolvedValueOnce({
      employees: [makeEmployee('e1')],
      fetchedAt: 't1',
      degraded: true,
      source: 'mock'
    })
    await store.fetchEmployees()
    expect(store.degraded).toBe(true)

    digitalEmployeeClientMock.list.mockResolvedValueOnce({
      employees: [makeEmployee('e1')],
      fetchedAt: 't2',
      degraded: false,
      source: 'http'
    })
    await store.fetchEmployees()

    expect(store.degraded).toBe(false)
    expect(store.dataSource).toBe('http')
  })

  it('flags config updates when a configHash changes and clears on acknowledge', async () => {
    const store = useDigitalEmployeeStore()

    // 首轮只建立基线，不提示
    digitalEmployeeClientMock.list.mockResolvedValue({
      employees: [makeEmployee('e1', { configHash: 'h1' })],
      fetchedAt: 't1'
    })
    await store.fetchEmployees()
    expect(store.hasConfigUpdates).toBe(false)

    digitalEmployeeClientMock.list.mockResolvedValue({
      employees: [makeEmployee('e1', { configHash: 'h2' })],
      fetchedAt: 't2'
    })
    await store.fetchEmployees()
    expect(store.hasConfigUpdates).toBe(true)

    await store.acknowledgeConfigUpdates()

    expect(store.hasConfigUpdates).toBe(false)
    expect(configClientMock.setSetting).toHaveBeenCalledWith('digitalEmployee.configHashes', {
      e1: 'h2'
    })
  })

  it('keeps the config update flag when persisting the acknowledgement fails', async () => {
    const store = useDigitalEmployeeStore()
    digitalEmployeeClientMock.list.mockResolvedValue({
      employees: [makeEmployee('e1', { configHash: 'h1' })],
      fetchedAt: 't1'
    })
    await store.fetchEmployees()
    digitalEmployeeClientMock.list.mockResolvedValue({
      employees: [makeEmployee('e1', { configHash: 'h2' })],
      fetchedAt: 't2'
    })
    await store.fetchEmployees()
    expect(store.hasConfigUpdates).toBe(true)

    configClientMock.setSetting.mockRejectedValueOnce(new Error('persist boom'))
    await store.acknowledgeConfigUpdates()

    // 写入失败时提示必须保留，避免用户漏看配置变化
    expect(store.hasConfigUpdates).toBe(true)
  })

  it('ignores employees without a configHash and new employees', async () => {
    const store = useDigitalEmployeeStore()
    digitalEmployeeClientMock.list.mockResolvedValue({
      employees: [makeEmployee('e1', { configHash: 'h1' })],
      fetchedAt: 't1'
    })
    await store.fetchEmployees()

    // 新员工 e2 只建立基线，无 hash 员工不参与比较 → 不提示
    digitalEmployeeClientMock.list.mockResolvedValue({
      employees: [
        makeEmployee('e1', { configHash: 'h1' }),
        makeEmployee('e2', { configHash: 'h9' }),
        makeEmployee('e3')
      ],
      fetchedAt: 't2'
    })
    await store.fetchEmployees()

    expect(store.hasConfigUpdates).toBe(false)
  })

  it('restores the persisted baseline so changes are detected across sessions', async () => {
    configClientMock.getSetting.mockImplementation(async (key: string) =>
      key === 'digitalEmployee.configHashes' ? { e1: 'h1' } : null
    )
    const store = useDigitalEmployeeStore()
    await store.loadInitialData()
    digitalEmployeeClientMock.list.mockResolvedValue({
      employees: [makeEmployee('e1', { configHash: 'h2' })],
      fetchedAt: 't2'
    })
    await store.fetchEmployees()

    expect(store.hasConfigUpdates).toBe(true)
  })

  describe('remote execution', () => {
    it('creates an empty local session then binds it remotely', async () => {
      const store = useDigitalEmployeeStore()
      await store.fetchEmployees()

      const sessionId = await store.startConversation(
        makeEmployee('remote-hr', { executionMode: 'remote' }),
        { openingQuestion: '帮我查年假' }
      )

      expect(sessionId).toBe('session-9')
      // 关键：本地会话必须为空——正文由 main 的 runner 直接写，避免两条用户消息。
      expect(sessionStoreMock.createSession).toHaveBeenCalledWith({
        agentId: DIGITAL_EMPLOYEE_AGENT_ID,
        message: ''
      })
      expect(digitalEmployeeClientMock.bindRemoteSession).toHaveBeenCalledWith({
        sessionId: 'session-9',
        employeeId: 'remote-hr',
        openingQuestion: '帮我查年假'
      })
    })

    it('does not inject system prompt, SOPs or knowledge for remote employees', async () => {
      const store = useDigitalEmployeeStore()
      await store.fetchEmployees()

      await store.startConversation(
        makeEmployee('remote-hr', {
          executionMode: 'remote',
          knowledgeBaseIds: ['kb-1'],
          skillIds: ['skill-a'],
          sops: [{ title: 's', content: 'c' }]
        }),
        { openingQuestion: '问题' }
      )

      // 服务端持有配置；本地注入既无效（system_prompt 会被剥离）又会产生两套真相。
      expect(knowledgeClientMock.similarityQuery).not.toHaveBeenCalled()
      const createArgs = sessionStoreMock.createSession.mock.calls[0][0]
      expect(createArgs.generationSettings).toBeUndefined()
      expect(createArgs.activeSkills).toBeUndefined()
    })

    it('binds without an opening question when none is provided', async () => {
      const store = useDigitalEmployeeStore()
      await store.fetchEmployees()

      await store.startConversation(makeEmployee('remote-hr', { executionMode: 'remote' }))

      expect(digitalEmployeeClientMock.bindRemoteSession).toHaveBeenCalledWith({
        sessionId: 'session-9',
        employeeId: 'remote-hr'
      })
    })

    it('keeps the local injection path for local employees', async () => {
      const store = useDigitalEmployeeStore()
      await store.fetchEmployees()

      await store.startConversation(makeEmployee('finance', { executionMode: 'local' }), {
        openingQuestion: '报销'
      })

      expect(digitalEmployeeClientMock.bindRemoteSession).not.toHaveBeenCalled()
      const createArgs = sessionStoreMock.createSession.mock.calls[0][0]
      expect(createArgs.generationSettings?.systemPrompt).toContain('p')
    })

    it('propagates a bind failure so the caller does not navigate into a broken session', async () => {
      const store = useDigitalEmployeeStore()
      await store.fetchEmployees()
      digitalEmployeeClientMock.bindRemoteSession.mockRejectedValue(
        new Error('digitalEmployee.remote.requestFailed:INSUFFICIENT_SCOPE')
      )

      await expect(
        store.startConversation(makeEmployee('remote-hr', { executionMode: 'remote' }))
      ).rejects.toThrow(/INSUFFICIENT_SCOPE/)
    })
  })
})
