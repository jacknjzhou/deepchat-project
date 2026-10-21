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
  createDigitalEmployeeClient: () => ({
    list: vi.fn().mockResolvedValue({
      employees: [
        {
          id: 'finance', name: '财务', role: '财务', description: '', avatar: null,
          capabilities: [], greeting: '你好，我是财务助手', systemPrompt: 'p',
          sops: [{ title: '报销流程', content: '先提交申请单' }],
          knowledgeBaseIds: ['kb-1'], skillIds: ['skill-a'], tools: ['filesystem_read'],
          enabled: true, updatedAt: '2026-10-21'
        },
        { id: 'hr', name: '人事', role: '人事', description: '', avatar: null, capabilities: [], greeting: null, systemPrompt: 'p', sops: [], knowledgeBaseIds: [], skillIds: [], tools: [], enabled: false, updatedAt: '2026-10-21' }
      ],
      fetchedAt: '2026-10-21T00:00:00.000Z'
    }),
    get: vi.fn()
  })
}))

vi.mock('../../../src/renderer/api/ConfigClient', () => ({
  createConfigClient: () => ({
    getSetting: vi.fn().mockResolvedValue(null),
    setSetting: vi.fn().mockResolvedValue(undefined)
  })
}))

const makeEmployee = (id: string): DigitalEmployee => ({
  id, name: id, role: id, description: '', avatar: null, capabilities: [], greeting: null,
  systemPrompt: 'p', sops: [], knowledgeBaseIds: [], skillIds: [], tools: [], enabled: true,
  updatedAt: '2026-10-21'
})

describe('digitalEmployeeStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStoreMock.createSession.mockReset()
    sessionStoreMock.createSession.mockResolvedValue({ session: { id: 'session-9' } })
    knowledgeClientMock.similarityQuery.mockReset()
    knowledgeClientMock.similarityQuery.mockResolvedValue([
      { id: 'k1', metadata: { from: '', filePath: '', content: '片段A' }, distance: 0.1 }
    ])
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
    expect(buildDisabledAgentTools(employee, ['filesystem_read', 'web_search'])).toEqual(['web_search'])
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
})
