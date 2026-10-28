import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createConfigClient } from '../../api/ConfigClient'
import { createDigitalEmployeeClient } from '../../api/DigitalEmployeeClient'
import { createDigitalEmployeeSettingsClient } from '../../api/DigitalEmployeeSettingsClient'
import { createKnowledgeClient } from '../../api/KnowledgeClient'
import { createSkillClient } from '../../api/SkillClient'
import { useSessionStore } from './ui/session'
import { useMcpStore } from './mcp'
import type {
  BackflowEventInput,
  ConfigEntryKey,
  DigitalEmployee,
  DigitalEmployeeBackflowResult
} from '@shared/contracts/routes'
import type { DigitalEmployeeProvisionResult } from '@shared/contracts/routes'
import type { KnowledgePackageStatus } from '@shared/contracts/routes'
import type { QueryResult } from '@shared/types/knowledge'
import type { SkillMetadata } from '@shared/types/skill'

export interface DigitalEmployeeConversationOptions {
  openingQuestion?: string
  availableMcpToolNames?: string[]
  knowledgeSnippets?: string
  /**
   * 已装好的技能名（带员工前缀），来自 `provision` 的返回。
   *
   * 传了就用它，没传才退回 `employee.skillIds`——后者只有调用方先做过准备
   * 才和本地技能目录里的名字对得上，否则激活的是不存在的名字。
   */
  activeSkillNames?: string[]
}

/**
 * 对话页需要展示的知识状态：只保留「最需要处理的那一条」。
 *
 * 员工可能绑定多个知识库，但界面上一口气列 5 条过期提示没人会读；
 * 优先级按「用户能否自己解决」排序。
 */
export interface DigitalEmployeeKnowledgeNotice {
  knowledgeBaseId: string
  staleReason: string
  lastSyncAt: number
}

export const DIGITAL_EMPLOYEE_AGENT_ID = 'deepchat'

/**
 * 单条 SOP 直接注入提示词的正文上限。
 *
 * SOP 全文随同步进了本地知识库，可被 `de_knowledge_search` 检索；提示词里
 * 只保留开头部分让模型「知道有这么个流程」，超长内容检索时再看，避免
 * SOP 堆积把上下文顶爆。
 */
const SOP_PROMPT_LIMIT = 600

export function buildDigitalEmployeeSystemPrompt(
  employee: DigitalEmployee,
  options?: Pick<DigitalEmployeeConversationOptions, 'knowledgeSnippets'>
): string {
  const sections: string[] = [employee.systemPrompt]
  for (const sop of employee.sops) {
    const body =
      sop.content.length > SOP_PROMPT_LIMIT
        ? `${sop.content.slice(0, SOP_PROMPT_LIMIT)}…（truncated）`
        : sop.content
    sections.push(`## SOP：${sop.title}\n${body}`)
  }
  if (employee.sops.length > 0) {
    sections.push(
      '## SOP 全文\n以上 SOP 可能被截断。需要完整步骤时，用 `de_knowledge_search` 工具在本地知识库中检索 SOP 标题。'
    )
  }
  if (employee.greeting) {
    sections.push(`## 开场白\n你的第一句回复必须以以下问候开始：\n${employee.greeting}`)
  }
  if (options?.knowledgeSnippets) {
    sections.push(`## 参考资料\n${options.knowledgeSnippets}`)
  }
  return sections.join('\n\n')
}

/**
 * 每员工本地知识检索工具，由主进程的 per-employee in-memory server 暴露。
 *
 * 它不来自服务端分发的 `employee.tools`，白名单若只收敛那份列表就会把它
 * disable 掉——而它注册与否由 provision 决定，不在可用列表里时本函数
 * 天然不会误伤。
 */
const LOCAL_KNOWLEDGE_TOOL_NAME = 'de_knowledge_search'

export function buildDisabledAgentTools(
  employee: DigitalEmployee,
  availableMcpToolNames: string[] | undefined
): string[] | undefined {
  // 白名单为空 = 不做收敛；无法获取可用工具列表时同样放弃收敛（宁多勿缺）
  if (employee.tools.length === 0 || !availableMcpToolNames || availableMcpToolNames.length === 0) {
    return undefined
  }
  const whitelist = new Set([...employee.tools, LOCAL_KNOWLEDGE_TOOL_NAME])
  const disabled = availableMcpToolNames.filter((name) => !whitelist.has(name))
  return disabled.length > 0 ? disabled : undefined
}

const FAVORITES_KEY = 'digitalEmployee.favorites'
const SESSION_BINDINGS_KEY = 'digitalEmployee.sessionBindings'
const CONFIG_HASHES_KEY = 'digitalEmployee.configHashes'
/** 功能总开关；写入在设置窗口经专用路由持久化并广播，这里只读。 */
const FEATURE_ENABLED_KEY = 'digitalEmployee.featureEnabled'

export const useDigitalEmployeeStore = defineStore('digitalEmployee', () => {
  const client = createDigitalEmployeeClient()
  const configClient = createConfigClient()
  const knowledgeClient = createKnowledgeClient()
  const settingsClient = createDigitalEmployeeSettingsClient()
  const skillClient = createSkillClient()
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
  /**
   * 数字员工功能总开关。缺省（读失败/未设置）一律视为关闭：入口必须由用户
   * 显式打开后出现，而不是靠猜。
   */
  const featureEnabled = ref(false)
  /** 已确认的 hash 基线；首次拉取只建立基线不提示，后续变化才置 hasConfigUpdates */
  let configHashBaseline: Record<string, string> | null = null

  const enabledEmployees = computed(() => employees.value.filter((employee) => employee.enabled))
  const selectedDigitalEmployee = computed(
    () =>
      employees.value.find((employee) => employee.id === selectedDigitalEmployeeId.value) ?? null
  )

  const readStringArraySetting = async (key: ConfigEntryKey): Promise<string[]> => {
    try {
      const value = await configClient.getSetting(key)
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : []
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

  /**
   * 读取功能总开关。读失败按关闭处理：宁可入口暂时不可见（可从设置打开），
   * 不可在功能已被管理关闭时仍显示入口。
   */
  async function readFeatureEnabled(): Promise<void> {
    try {
      featureEnabled.value = (await configClient.getSetting(FEATURE_ENABLED_KEY)) === true
    } catch {
      featureEnabled.value = false
    }
  }

  async function loadPersistedState(): Promise<void> {
    favorites.value = await readStringArraySetting(FAVORITES_KEY)
    sessionBindings.value = await readBindingsSetting()
    await readFeatureEnabled()
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

  /**
   * 读员工的知识同步状态，返回最值得提示的一条；没问题或查询失败都返回 null。
   *
   * 优先级：用户能自己解决的（缺嵌入模型、鉴权失败）排在后台会自动重试的前面。
   * 状态查询失败绝不上抛——知识提示是锦上添花，不该打断对话。
   */
  async function loadKnowledgeStatus(
    employeeId: string
  ): Promise<DigitalEmployeeKnowledgeNotice | null> {
    let packages: KnowledgePackageStatus[]
    try {
      const result = await client.knowledgeStatus(employeeId)
      packages = result.packages
    } catch {
      return null
    }

    const actionable = (reason: string | null): number => {
      if (reason === 'NO_EMBEDDING_MODEL') return 0
      if (reason === 'HTTP_401' || reason === 'HTTP_403') return 1
      return 2
    }

    const stale = packages
      .filter((pkg) => pkg.stale && pkg.staleReason !== null)
      .sort((left, right) => {
        const delta = actionable(left.staleReason) - actionable(right.staleReason)
        if (delta !== 0) return delta
        // 同样可操作时先报更早同步的那条：它过期更久。
        return Date.parse(left.lastSyncAt) - Date.parse(right.lastSyncAt)
      })

    const target = stale[0]
    if (!target || target.staleReason === null) return null

    const parsed = Date.parse(target.lastSyncAt)
    return {
      knowledgeBaseId: target.knowledgeBaseId,
      staleReason: target.staleReason,
      lastSyncAt: Number.isFinite(parsed) ? parsed : Date.now()
    }
  }

  /**
   * 详情视图用：读员工全部知识包状态（loadKnowledgeStatus 只挑「最需要处理
   * 的一条」，详情页要的是全量清单）。失败返回空数组：知识状态是展示性的
   * 信息，不该打断详情查看。
   */
  async function listKnowledgePackages(employeeId: string): Promise<KnowledgePackageStatus[]> {
    try {
      return (await client.knowledgeStatus(employeeId)).packages
    } catch {
      return []
    }
  }

  /**
   * 详情视图用：读本地技能目录元数据（含 SKILL.md 描述）。数字员工的技能
   * 全部装在内置 `deepchat` Agent scope 下（见主进程 skillSync 的
   * SKILL_AGENT_ID），按本地安装名（员工前缀）匹配。失败返回空数组：描述
   * 是展示性信息，缺失时详情退化为只显示名称与 id。
   */
  async function listLocalSkillMetadata(): Promise<SkillMetadata[]> {
    try {
      return await skillClient.getMetadataList(DIGITAL_EMPLOYEE_AGENT_ID)
    } catch {
      return []
    }
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

    // remote：先分流再决定是否检索知识。服务端持有知识库与提示词，
    // 本地检索既拿不到结果（kb id 是服务端的），也会白跑一遍向量查询。
    if (employee.executionMode === 'remote') {
      const remote = await sessionStore.createSession({
        agentId: DIGITAL_EMPLOYEE_AGENT_ID,
        // 归属随会话一起交给主进程：首轮消息运行前写好绑定，
        // 本员工的 MCP 白名单才能在第一轮就生效。
        digitalEmployeeId: employee.id,
        message: ''
      })
      const sessionId = remote.session.id
      await client.bindRemoteSession({
        sessionId,
        employeeId: employee.id,
        ...(openingQuestion ? { openingQuestion } : {})
      })
      await bindSession(sessionId, employee.id).catch(() => undefined)
      return sessionId
    }

    // 只对本地执行分支检索知识：remote 分支前面已提前返回。
    //
    // 两个条件都要满足，用途不同：
    // - `knowledgeBaseIds` 判「服务端还配着知识吗」。清空后本地可能残留上次同步的
    //   库，只按本地 id 判会让用户检索到已下线的知识。
    // - `localKnowledgeBaseId` 是**寻址**用的 id。必须是本地库（`de-{employeeId}`），
    //   不是 payload 的 `knowledgeBaseIds`——后者是服务端 `kb_*` id，本地配置里
    //   没有这个库，`similarityQuery` 会抛 `Knowledge config not found`，然后被
    //   catch 成空数组，表现为「同步了一堆概念却永远召回不到」。两套 id 之间没有
    //   换算关系，见 `knowledgeRoutes.ts` 的 `readLocalKnowledgeBaseId`。
    const localKnowledgeBaseId =
      employee.knowledgeBaseIds.length > 0 && openingQuestion
        ? await client
            .knowledgeLocalBase(employee.id)
            .then((result) => result.knowledgeBaseId)
            // 查询失败不退化成远端 id：那必然查不到，只会多打一轮空检索。
            .catch(() => null)
        : null

    if (localKnowledgeBaseId && openingQuestion) {
      const snippets = await knowledgeClient
        .similarityQuery(localKnowledgeBaseId, openingQuestion)
        .catch(() => [] as QueryResult[])
      const lines = snippets
        .slice(0, 5)
        // QueryResult 的正文在 metadata.content（src/shared/types/knowledge.ts）
        .map((result, index) => `[${index + 1}] ${result.metadata?.content ?? ''}`.trim())
        .filter((line) => line.length > 4)
      if (lines.length > 0) {
        knowledgeSnippets = lines.join('\n')
      }
    }

    const disabledAgentTools = buildDisabledAgentTools(employee, options?.availableMcpToolNames)
    // 准备阶段返回的技能名优先：安装时名字被加了员工前缀，用 payload 的 slug
    // 激活会安静地匹配不到任何技能。
    const activeSkills = options?.activeSkillNames ?? employee.skillIds

    const result = await sessionStore.createSession({
      agentId: DIGITAL_EMPLOYEE_AGENT_ID,
      // 同 remote 分支：归属进主进程，首轮即生效本员工 MCP 白名单。
      digitalEmployeeId: employee.id,
      message: openingQuestion ?? '',
      ...(activeSkills.length > 0 ? { activeSkills: [...activeSkills] } : {}),
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

  /**
   * 让主进程把这个员工的远端工具与技能包准备好。
   *
   * 返回 `null` 只发生在 IPC 层异常（主进程已保证业务失败不抛）。调用方拿
   * 返回值里的 `skillNames` 作为会话的 `activeSkills`，不能再用 payload 的
   * slug——安装时名字带了员工前缀。
   */
  async function provisionEmployee(
    employeeId: string
  ): Promise<DigitalEmployeeProvisionResult | null> {
    try {
      const result = await client.provision(employeeId)
      // provision 会在主进程后台注册/清理员工 MCP server，而 MCP 中心的列表
      // 只在自己页面内操作后才重拉——这里必须主动失效，否则注册成功也要等
      // 重启应用才可见。注册与未注册（含清理旧注册）都会动配置，统一刷新。
      void useMcpStore().refreshServerMutationQueries()
      return result
    } catch (error) {
      // 准备工作失败只意味着能力少一点，不该让用户点不动开始按钮。
      console.warn('[digitalEmployee] provision failed', error)
      return null
    }
  }

  /**
   * 把一轮本地对话回流给 StaffDeck 归档。
   *
   * 只对**真正在本地执行**的会话上报。此处需要分清三件事：
   *
   * - `remote` 员工：对话本来就在服务端，重报会让管理端看到两条同样的消息。
   * - `hybrid` 员工：会话**可能**已经切到云端（`switchToRemote`）。那时本地只是
   *   在渲染服务端推回来的流，事件已经在服务端库里，再上报一次同样是双份。
   * - 其余（`local`、hybrid 尚未切换）：本地执行，必须上报，否则审计有缺口。
   *
   * hybrid 的具体状态只有主进程的绑定表知道，所以这里要查一次。查询失败时
   * 按「已绑定」处理——宁可漏一份归档，也不能凭空造出重复记录：前者是数据
   * 不全，后者会让管理端的统计口径直接失真，且无法事后区分。
   *
   * 永不抛错，也永不改动对话状态。上报是全量归档的附加动作，不是对话的一部分。
   */
  async function reportBackflow(input: {
    employeeId: string
    sessionId: string
    title?: string
    events: BackflowEventInput[]
  }): Promise<DigitalEmployeeBackflowResult | null> {
    if (input.events.length === 0) return null
    const employee = employees.value.find((item) => item.id === input.employeeId)
    if (!employee || employee.executionMode === 'remote') return null
    if (employee.executionMode === 'hybrid' && (await isBoundToRemote(input.sessionId))) {
      return null
    }
    try {
      // `title` 必须一路带到主进程：它只在首次建远端会话时用一次，漏了就不是
      // 「标题为空」而是「服务端那条会话永远没有标题」。
      return await client.backflow({
        employeeId: input.employeeId,
        sessionId: input.sessionId,
        ...(input.title ? { title: input.title } : {}),
        events: input.events
      })
    } catch (error) {
      console.warn('[digitalEmployee] backflow failed', error)
      return null
    }
  }

  /**
   * hybrid 会话是否已切到云端。
   *
   * 失败按 `true` 处理，与 `loadRemoteBinding` 相反：那里的乐观会让用户点到一个
   * 必失败的按钮（可见、可纠正），这里的乐观会让归档里出现重复消息（不可见、
   * 事后也分不清哪份是假的）。
   */
  async function isBoundToRemote(sessionId: string): Promise<boolean> {
    try {
      const status = await client.remoteStatus(sessionId)
      return status.bound
    } catch {
      return true
    }
  }

  /**
   * 这个会话是否已经绑到远端。
   *
   * 与员工的 `executionMode` 是两件事：员工配的是 `hybrid`，某个会话可能还在
   * 本地跑。绑定表在主进程，只有它能回答，所以这里必须查一次而不是推断。
   * 查询失败按「已绑定」处理——乐观地显示「可切换」会让用户点了才发现切不了。
   */
  async function loadRemoteBinding(sessionId: string): Promise<boolean> {
    try {
      const status = await client.remoteStatus(sessionId)
      return status.bound
    } catch {
      return true
    }
  }

  /**
   * 把当前本地会话显式切到云端执行（hybrid 员工的「可切换」那一半）。
   *
   * 切换**不可逆**：来回切会让「哪一段在哪个引擎执行」失去唯一答案，归档与
   * 回流也再对不上。所以这里只在会话未绑定时调用，绑定后由主进程拒绝。
   *
   * `contextSummary` 是远端「接上上下文」的唯一途径——服务端看不到本地历史。
   * 不传就只是建绑定，下一轮从空白上下文开始。
   */
  async function switchToRemote(input: {
    sessionId: string
    employeeId: string
    contextSummary?: string
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      // 先裁再判空：全空格等于没写，发出去只会让远端多收到一段空白上下文。
      const summary = input.contextSummary?.trim()
      await client.switchToRemote({
        sessionId: input.sessionId,
        employeeId: input.employeeId,
        ...(summary ? { contextSummary: summary } : {})
      })
      return { ok: true }
    } catch (error) {
      // 不静默：用户刚点了「切到云端」，什么都没发生必须有解释。
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // 设置窗口（独立 renderer 实例）改完总开关后由 main 广播；这里只关心开关
  // 本身，配置重载等已由广场页自己的订阅处理。随 store 存活，无需退订。
  settingsClient.onConfigurationChanged(() => {
    void readFeatureEnabled()
  })

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
    featureEnabled,
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
    loadKnowledgeStatus,
    listKnowledgePackages,
    listLocalSkillMetadata,
    provisionEmployee,
    reportBackflow,
    loadRemoteBinding,
    switchToRemote,
    startConversation
  }
})
