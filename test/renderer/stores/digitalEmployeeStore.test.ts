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
  switchToRemote: vi.fn(),
  knowledgeStatus: vi.fn(),
  knowledgeLocalBase: vi.fn(),
  provision: vi.fn(),
  backflow: vi.fn()
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
    digitalEmployeeClientMock.knowledgeLocalBase
      .mockReset()
      .mockResolvedValue({ knowledgeBaseId: 'de-finance' })
    digitalEmployeeClientMock.provision.mockReset().mockResolvedValue({
      employeeId: 'finance',
      skipped: null,
      toolsReady: true,
      installedSkills: 0,
      failedSkills: [],
      skillNames: [],
      failures: []
    })
    digitalEmployeeClientMock.backflow
      .mockReset()
      .mockResolvedValue({ ok: true, reason: null, delivered: 1 })
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
    // 检索必须打本地库 id，不能打 payload 的服务端 `kb-*`：本地没有那个库，
    // similarityQuery 会抛错并被吞成空结果（知识永远召回不到）。
    expect(digitalEmployeeClientMock.knowledgeLocalBase).toHaveBeenCalledWith('finance')
    expect(knowledgeClientMock.similarityQuery).toHaveBeenCalledWith('de-finance', '帮我查报销进度')
    expect(knowledgeClientMock.similarityQuery).not.toHaveBeenCalledWith(
      'kb-1',
      expect.anything()
    )
    expect(store.employeeForSession('session-9')?.id).toBe(employee.id)
  })

  it('skips knowledge retrieval when the employee has no local knowledge base', async () => {
    // 未同步 / 无嵌入模型 / 用户删了库：main 返回 null，此时不得回退到远端 id。
    digitalEmployeeClientMock.knowledgeLocalBase.mockResolvedValue({ knowledgeBaseId: null })
    const store = useDigitalEmployeeStore()
    await store.fetchEmployees()

    await store.startConversation(store.employees[0], { openingQuestion: '帮我查报销进度' })

    expect(knowledgeClientMock.similarityQuery).not.toHaveBeenCalled()
    expect(sessionStoreMock.createSession.mock.calls[0][0].generationSettings.systemPrompt).not
      .toContain('## 参考资料')
  })

  it('skips knowledge retrieval when the local base lookup fails', async () => {
    digitalEmployeeClientMock.knowledgeLocalBase.mockRejectedValue(new Error('ipc boom'))
    const store = useDigitalEmployeeStore()
    await store.fetchEmployees()

    await expect(
      store.startConversation(store.employees[0], { openingQuestion: '帮我查报销进度' })
    ).resolves.toBe('session-9')
    expect(knowledgeClientMock.similarityQuery).not.toHaveBeenCalled()
  })

  it('does not look up a local knowledge base when the question is empty', async () => {
    const store = useDigitalEmployeeStore()
    await store.fetchEmployees()

    await store.startConversation(store.employees[0])

    // 没有开场问题就没有查询文本，白跑一次 IPC + 一次向量查询没有意义。
    expect(digitalEmployeeClientMock.knowledgeLocalBase).not.toHaveBeenCalled()
    expect(knowledgeClientMock.similarityQuery).not.toHaveBeenCalled()
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

  it('provisionEmployee returns the main-process result', async () => {
    const store = useDigitalEmployeeStore()
    digitalEmployeeClientMock.provision.mockResolvedValue({
      employeeId: 'finance',
      skipped: null,
      toolsReady: true,
      installedSkills: 2,
      failedSkills: [],
      skillNames: ['de-finance-invoice'],
      failures: []
    })

    const result = await store.provisionEmployee('finance')

    expect(digitalEmployeeClientMock.provision).toHaveBeenCalledWith('finance')
    expect(result?.skillNames).toEqual(['de-finance-invoice'])
  })

  it('provisionEmployee swallows IPC errors and reports null', async () => {
    const store = useDigitalEmployeeStore()
    digitalEmployeeClientMock.provision.mockRejectedValue(new Error('ipc down'))

    // 准备失败只能是「能力少一点」，不能中断会话流程，因此这里不抛。
    await expect(store.provisionEmployee('finance')).resolves.toBeNull()
  })

  it('reportBackflow forwards local events for a locally executed employee', async () => {
    const store = useDigitalEmployeeStore()
    await store.fetchEmployees()
    const local = store.employees.find((item) => item.executionMode !== 'remote')!

    await store.reportBackflow({
      employeeId: local.id,
      sessionId: 'session-1',
      events: [{ type: 'message', eventId: 'e1', role: 'user', content: 'hi' }]
    })

    expect(digitalEmployeeClientMock.backflow).toHaveBeenCalledWith({
      employeeId: local.id,
      sessionId: 'session-1',
      events: [{ type: 'message', eventId: 'e1', role: 'user', content: 'hi' }]
    })
  })

  it('reportBackflow passes the title so the remote session gets a name', async () => {
    // 标题只在首次建远端会话时用一次；store 吞掉它就等于服务端那条会话永远没名字。
    const store = useDigitalEmployeeStore()
    await store.fetchEmployees()

    await store.reportBackflow({
      employeeId: 'finance',
      sessionId: 'session-1',
      title: '报销查询',
      events: [{ type: 'message', eventId: 'e1', role: 'user', content: 'hi' }]
    })

    expect(digitalEmployeeClientMock.backflow).toHaveBeenCalledWith(
      expect.objectContaining({ title: '报销查询' })
    )
  })

  it('reportBackflow omits the title rather than sending an empty string', async () => {
    const store = useDigitalEmployeeStore()
    await store.fetchEmployees()

    await store.reportBackflow({
      employeeId: 'finance',
      sessionId: 'session-1',
      events: [{ type: 'message', eventId: 'e1', role: 'user', content: 'hi' }]
    })

    // 传空串会让服务端建出一条无标题会话，界面上看起来像「标题丢了」。
    const payload = digitalEmployeeClientMock.backflow.mock.calls.at(-1)?.[0]
    expect(payload).not.toHaveProperty('title')
  })

  it('reportBackflow never reports a remote employee', async () => {
    // A remote conversation already lives on the server; filing it again would
    // show the operator two copies of every message.
    const store = useDigitalEmployeeStore()
    await store.fetchEmployees()

    await store.reportBackflow({
      employeeId: 'remote-employee',
      sessionId: 'session-1',
      events: [{ type: 'message', eventId: 'e1', role: 'user', content: 'hi' }]
    })

    expect(digitalEmployeeClientMock.backflow).not.toHaveBeenCalled()
  })

  it('reportBackflow does not call the client for an empty round', async () => {
    const store = useDigitalEmployeeStore()
    await store.fetchEmployees()

    await store.reportBackflow({ employeeId: 'finance', sessionId: 'session-1', events: [] })

    expect(digitalEmployeeClientMock.backflow).not.toHaveBeenCalled()
  })

  it('reportBackflow swallows failures so a round is never blocked', async () => {
    const store = useDigitalEmployeeStore()
    await store.fetchEmployees()
    digitalEmployeeClientMock.backflow.mockRejectedValue(new Error('offline'))

    await expect(
      store.reportBackflow({
        employeeId: 'finance',
        sessionId: 'session-1',
        events: [{ type: 'message', eventId: 'e1', role: 'user', content: 'hi' }]
      })
    ).resolves.toBeNull()
  })

  it('startConversation prefers the installed skill names over the payload slugs', async () => {
    const store = useDigitalEmployeeStore()
    await store.fetchEmployees()
    const employee = store.employees[0] // skillIds: ['skill-a']

    await store.startConversation(employee, {
      activeSkillNames: ['de-finance-skill-a']
    })

    // 本地技能目录里只有带前缀的名字，slug 传进去会静默匹配不到。
    const createInput = sessionStoreMock.createSession.mock.calls[0][0]
    expect(createInput.activeSkills).toEqual(['de-finance-skill-a'])
  })

  it('startConversation falls back to skillIds when nothing was provisioned', async () => {
    const store = useDigitalEmployeeStore()
    await store.fetchEmployees()
    const employee = store.employees[0]

    await store.startConversation(employee, {})

    const createInput = sessionStoreMock.createSession.mock.calls[0][0]
    expect(createInput.activeSkills).toEqual(['skill-a'])
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

  describe('switch to remote (hybrid)', () => {
    it('forwards the session, employee and trimmed summary to the main process', async () => {
      const store = useDigitalEmployeeStore()
      await store.fetchEmployees()
      digitalEmployeeClientMock.switchToRemote.mockResolvedValue({ remoteSessionId: 'remote-1' })

      const result = await store.switchToRemote({
        sessionId: 'session-9',
        employeeId: 'hybrid-hr',
        contextSummary: '  已确认报销单号 R-1  '
      })

      expect(result).toEqual({ ok: true })
      expect(digitalEmployeeClientMock.switchToRemote).toHaveBeenCalledWith({
        sessionId: 'session-9',
        employeeId: 'hybrid-hr',
        contextSummary: '已确认报销单号 R-1'
      })
    })

    it('omits the summary field entirely when it is blank', async () => {
      const store = useDigitalEmployeeStore()
      await store.fetchEmployees()
      digitalEmployeeClientMock.switchToRemote.mockResolvedValue({ remoteSessionId: 'remote-1' })

      await store.switchToRemote({
        sessionId: 'session-9',
        employeeId: 'hybrid-hr',
        contextSummary: '   '
      })

      // 空串会让契约校验多一个无意义的字段；不传才表示「没有摘要」。
      expect(digitalEmployeeClientMock.switchToRemote).toHaveBeenCalledWith({
        sessionId: 'session-9',
        employeeId: 'hybrid-hr'
      })
    })

    it('reports the failure instead of throwing so the dialog can explain it', async () => {
      const store = useDigitalEmployeeStore()
      await store.fetchEmployees()
      digitalEmployeeClientMock.switchToRemote.mockRejectedValue(
        new Error('session is already bound to remote execution')
      )

      const result = await store.switchToRemote({
        sessionId: 'session-9',
        employeeId: 'hybrid-hr'
      })

      // 用户刚点了「切到云端」，什么都没发生必须有解释，不能静默成功。
      expect(result.ok).toBe(false)
      expect(result).toHaveProperty('error', 'session is already bound to remote execution')
    })
  })

  describe('remote binding lookup', () => {
    it('reports whether the session is already bound remotely', async () => {
      const store = useDigitalEmployeeStore()
      await store.fetchEmployees()
      digitalEmployeeClientMock.remoteStatus.mockResolvedValue({
        bound: true,
        remoteSessionId: 'remote-1',
        employeeId: 'hybrid-hr',
        runId: null,
        awaitingInput: null
      })

      await expect(store.loadRemoteBinding('session-9')).resolves.toBe(true)
      expect(digitalEmployeeClientMock.remoteStatus).toHaveBeenCalledWith('session-9')
    })

    it('treats an unbound session as switchable', async () => {
      const store = useDigitalEmployeeStore()
      await store.fetchEmployees()
      digitalEmployeeClientMock.remoteStatus.mockResolvedValue({
        bound: false,
        remoteSessionId: null,
        employeeId: null,
        runId: null,
        awaitingInput: null
      })

      await expect(store.loadRemoteBinding('session-9')).resolves.toBe(false)
    })

    it('assumes bound when the lookup fails so the button stays hidden', async () => {
      const store = useDigitalEmployeeStore()
      await store.fetchEmployees()
      digitalEmployeeClientMock.remoteStatus.mockRejectedValue(new Error('bridge down'))

      // 乐观地显示「可切换」会让用户点了才发现切不了；查不到就别给入口。
      await expect(store.loadRemoteBinding('session-9')).resolves.toBe(true)
    })
  })

  describe('knowledge status', () => {
    it('surfaces the first stale package for the bound session', async () => {
      digitalEmployeeClientMock.knowledgeStatus.mockResolvedValue({
        packages: [
          {
            knowledgeBaseId: 'kb-1',
            stale: false,
            staleReason: null,
            lastSyncAt: '2026-10-23T00:00:00.000Z',
            conceptCount: 3
          },
          {
            knowledgeBaseId: 'kb-2',
            stale: true,
            staleReason: 'NO_EMBEDDING_MODEL',
            lastSyncAt: '2026-10-23T00:00:00.000Z',
            conceptCount: 0
          }
        ]
      })
      const store = useDigitalEmployeeStore()
      await store.fetchEmployees()

      const status = await store.loadKnowledgeStatus('agent_1')

      // 提示条只需要一条最需要处理的原因，多条堆叠只会让界面变吵。
      expect(status).toEqual({
        knowledgeBaseId: 'kb-2',
        staleReason: 'NO_EMBEDDING_MODEL',
        lastSyncAt: 1_792_713_600_000
      })
    })

    it('returns null when every package is clean', async () => {
      digitalEmployeeClientMock.knowledgeStatus.mockResolvedValue({
        packages: [
          {
            knowledgeBaseId: 'kb-1',
            stale: false,
            staleReason: null,
            lastSyncAt: '2026-10-23T00:00:00.000Z',
            conceptCount: 3
          }
        ]
      })
      const store = useDigitalEmployeeStore()
      await store.fetchEmployees()

      expect(await store.loadKnowledgeStatus('agent_1')).toBeNull()
    })

    it('returns null instead of throwing when the status call fails', async () => {
      digitalEmployeeClientMock.knowledgeStatus.mockRejectedValue(new Error('network'))
      const store = useDigitalEmployeeStore()
      await store.fetchEmployees()

      // 状态查询失败不该打断对话：知识提示是锦上添花，不是关键路径。
      await expect(store.loadKnowledgeStatus('agent_1')).resolves.toBeNull()
    })
  })
})
