import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createConfigClient } from '../../api/ConfigClient'
import { createDigitalEmployeeClient } from '../../api/DigitalEmployeeClient'
import { createKnowledgeClient } from '../../api/KnowledgeClient'
import { useSessionStore } from './ui/session'
import type { ConfigEntryKey, DigitalEmployee } from '@shared/contracts/routes'
import type { QueryResult } from '@shared/types/knowledge'

export interface DigitalEmployeeConversationOptions {
  openingQuestion?: string
  availableMcpToolNames?: string[]
  knowledgeSnippets?: string
}

export const DIGITAL_EMPLOYEE_AGENT_ID = 'deepchat'

export function buildDigitalEmployeeSystemPrompt(
  employee: DigitalEmployee,
  options?: Pick<DigitalEmployeeConversationOptions, 'knowledgeSnippets'>
): string {
  const sections: string[] = [employee.systemPrompt]
  for (const sop of employee.sops) {
    sections.push(`## SOP：${sop.title}\n${sop.content}`)
  }
  if (employee.greeting) {
    sections.push(`## 开场白\n你的第一句回复必须以以下问候开始：\n${employee.greeting}`)
  }
  if (options?.knowledgeSnippets) {
    sections.push(`## 参考资料\n${options.knowledgeSnippets}`)
  }
  return sections.join('\n\n')
}

export function buildDisabledAgentTools(
  employee: DigitalEmployee,
  availableMcpToolNames: string[] | undefined
): string[] | undefined {
  // 白名单为空 = 不做收敛；无法获取可用工具列表时同样放弃收敛（宁多勿缺）
  if (employee.tools.length === 0 || !availableMcpToolNames || availableMcpToolNames.length === 0) {
    return undefined
  }
  const whitelist = new Set(employee.tools)
  const disabled = availableMcpToolNames.filter((name) => !whitelist.has(name))
  return disabled.length > 0 ? disabled : undefined
}

const FAVORITES_KEY = 'digitalEmployee.favorites'
const SESSION_BINDINGS_KEY = 'digitalEmployee.sessionBindings'
const CONFIG_HASHES_KEY = 'digitalEmployee.configHashes'

export const useDigitalEmployeeStore = defineStore('digitalEmployee', () => {
  const client = createDigitalEmployeeClient()
  const configClient = createConfigClient()
  const knowledgeClient = createKnowledgeClient()
  const sessionStore = useSessionStore()

  const employees = ref<DigitalEmployee[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const degraded = ref(false)
  const dataSource = ref<'http' | 'mock'>('mock')
  const hasConfigUpdates = ref(false)
  const selectedDigitalEmployeeId = ref<string | null>(null)
  const favorites = ref<string[]>([])
  const sessionBindings = ref<Record<string, string>>({})
  /** 已确认的 hash 基线；首次拉取只建立基线不提示，后续变化才置 hasConfigUpdates */
  let configHashBaseline: Record<string, string> | null = null

  const enabledEmployees = computed(() => employees.value.filter((employee) => employee.enabled))
  const selectedDigitalEmployee = computed(
    () => employees.value.find((employee) => employee.id === selectedDigitalEmployeeId.value) ?? null
  )

  const readStringArraySetting = async (key: ConfigEntryKey): Promise<string[]> => {
    try {
      const value = await configClient.getSetting(key)
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
    } catch {
      return []
    }
  }

  const readBindingsSetting = async (): Promise<Record<string, string>> => {
    try {
      const value = await configClient.getSetting(SESSION_BINDINGS_KEY)
      if (value === null || value === undefined || typeof value !== 'object') return {}
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    } catch {
      return {}
    }
  }

  const readConfigHashes = async (): Promise<Record<string, string>> => {
    try {
      const value = await configClient.getSetting(CONFIG_HASHES_KEY)
      if (value === null || value === undefined || typeof value !== 'object') return {}
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    } catch {
      return {}
    }
  }

  /**
   * 只有新旧都有 configHash 的员工才参与比较：首轮/新员工只建立基线，
   * 既有员工 hash 变化时置 hasConfigUpdates。
   */
  const applyConfigHashChanges = (nextEmployees: DigitalEmployee[]): void => {
    const current: Record<string, string> = {}
    for (const employee of nextEmployees) {
      if (employee.configHash) current[employee.id] = employee.configHash
    }

    if (configHashBaseline === null) {
      configHashBaseline = current
      hasConfigUpdates.value = false
      return
    }

    const changed = Object.entries(current).some(
      ([id, hash]) => configHashBaseline?.[id] !== undefined && configHashBaseline[id] !== hash
    )
    if (changed) hasConfigUpdates.value = true
  }

  async function fetchEmployees(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const result = await client.list()
      employees.value = result.employees
      degraded.value = result.degraded === true
      dataSource.value = result.source ?? 'mock'
      applyConfigHashChanges(result.employees)
    } catch (e) {
      error.value = `Failed to load digital employees: ${e}`
    } finally {
      loading.value = false
    }
  }

  /**
   * 确认配置更新：先持久化当前 hash 快照，成功后才清除提示；
   * 持久化失败时保留提示，避免用户漏看更新。
   */
  async function acknowledgeConfigUpdates(): Promise<void> {
    const snapshot: Record<string, string> = {}
    for (const employee of employees.value) {
      if (employee.configHash) snapshot[employee.id] = employee.configHash
    }
    try {
      await configClient.setSetting(CONFIG_HASHES_KEY, snapshot)
      configHashBaseline = snapshot
      hasConfigUpdates.value = false
    } catch {
      // 写入失败：保持提示，等待下次重试
    }
  }

  async function loadPersistedState(): Promise<void> {
    favorites.value = await readStringArraySetting(FAVORITES_KEY)
    sessionBindings.value = await readBindingsSetting()
    // 基线来自上次确认的持久化快照；无值时保持 null，由首轮拉取建立基线。
    const persistedHashes = await readConfigHashes()
    configHashBaseline = Object.keys(persistedHashes).length > 0 ? persistedHashes : null
  }

  function setSelectedDigitalEmployee(id: string | null): void {
    selectedDigitalEmployeeId.value = id
  }

  async function toggleFavorite(id: string): Promise<void> {
    favorites.value = favorites.value.includes(id)
      ? favorites.value.filter((item) => item !== id)
      : [...favorites.value, id]
    await configClient.setSetting(FAVORITES_KEY, [...favorites.value])
  }

  async function bindSession(sessionId: string, employeeId: string): Promise<void> {
    sessionBindings.value = { ...sessionBindings.value, [sessionId]: employeeId }
    await configClient.setSetting(SESSION_BINDINGS_KEY, { ...sessionBindings.value })
  }

  function employeeForSession(sessionId: string): DigitalEmployee | null {
    const employeeId = sessionBindings.value[sessionId]
    if (!employeeId) return null
    return employees.value.find((employee) => employee.id === employeeId) ?? null
  }

  async function loadInitialData(): Promise<void> {
    await Promise.all([fetchEmployees(), loadPersistedState()])
  }

  const initialized = ref(false)
  let ensureLoadedPromise: Promise<void> | null = null

  // 幂等加载：仅员工列表加载成功后置位 initialized；并发调用共享同一 promise；
  // 失败不抛出（error 已由 fetchEmployees 记录），下次调用可重试
  function ensureLoaded(): Promise<void> {
    if (initialized.value) return Promise.resolve()
    if (!ensureLoadedPromise) {
      ensureLoadedPromise = loadInitialData()
        .then(() => {
          if (!error.value) initialized.value = true
        })
        .catch(() => undefined)
        .finally(() => {
          ensureLoadedPromise = null
        })
    }
    return ensureLoadedPromise
  }

  async function startConversation(
    employee: DigitalEmployee,
    options?: DigitalEmployeeConversationOptions
  ): Promise<string> {
    setSelectedDigitalEmployee(employee.id)

    let knowledgeSnippets: string | undefined
    const openingQuestion = options?.openingQuestion?.trim()
    if (employee.knowledgeBaseIds.length > 0 && openingQuestion) {
      const snippetLists = await Promise.all(
        employee.knowledgeBaseIds.map((knowledgeBaseId) =>
          knowledgeClient
            .similarityQuery(knowledgeBaseId, openingQuestion)
            .catch(() => [] as QueryResult[])
        )
      )
      const lines = snippetLists
        .flat()
        .slice(0, 5)
        // QueryResult 的正文在 metadata.content（src/shared/types/knowledge.ts）
        .map((result, index) => `[${index + 1}] ${result.metadata?.content ?? ''}`.trim())
        .filter((line) => line.length > 4)
      if (lines.length > 0) {
        knowledgeSnippets = lines.join('\n')
      }
    }

    const disabledAgentTools = buildDisabledAgentTools(employee, options?.availableMcpToolNames)

    const result = await sessionStore.createSession({
      agentId: DIGITAL_EMPLOYEE_AGENT_ID,
      message: openingQuestion ?? '',
      ...(employee.skillIds.length > 0 ? { activeSkills: [...employee.skillIds] } : {}),
      ...(disabledAgentTools ? { disabledAgentTools } : {}),
      generationSettings: {
        systemPrompt: buildDigitalEmployeeSystemPrompt(employee, { knowledgeSnippets })
      }
    })

    // 绑定仅用于会话徽标等装饰性展示：会话已建立且导航已发生，持久化失败
    // 按 best-effort 降级（保留内存绑定），不得让已建立的会话流程失败
    await bindSession(result.session.id, employee.id).catch(() => undefined)
    return result.session.id
  }

  return {
    employees,
    loading,
    error,
    initialized,
    degraded,
    dataSource,
    hasConfigUpdates,
    selectedDigitalEmployeeId,
    favorites,
    sessionBindings,
    enabledEmployees,
    selectedDigitalEmployee,
    fetchEmployees,
    loadInitialData,
    ensureLoaded,
    acknowledgeConfigUpdates,
    setSelectedDigitalEmployee,
    toggleFavorite,
    bindSession,
    employeeForSession,
    startConversation
  }
})
