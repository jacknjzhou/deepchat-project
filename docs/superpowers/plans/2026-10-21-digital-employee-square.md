# 数字员工广场实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增「数字员工广场」：多 Tab 卡片广场页浏览数字员工（人设 + 四类内建能力：SOP/技能/工具/知识库），选中后创建会话并将四类能力注入现有对话链路。

**Architecture:** 数字员工 = 本地 Agent 的「人设 + 能力包」。主进程 Provider 层（mock 先行，预留 HTTP）暴露 zod 契约路由；renderer 独立 store + 顶级路由广场页；对话闭环复用现有会话创建契约——`generationSettings.systemPrompt` 注入人设+SOP、`activeSkills` 绑定技能、`disabledAgentTools`（工具白名单取补集）收敛工具、首条消息发送前 renderer 侧 `knowledgeClient.similarityQuery` 注入知识库检索片段。

**Tech Stack:** Electron + Vue3 + TS + zod 契约路由 + Pinia + vue-i18n + Vitest

**Spec:** `docs/superpowers/specs/2026-10-21-digital-employee-square-design.md`

## Global Constraints

- 禁止新增运行时依赖（zod/vue/pinia/i18n 均已有）；不改动现有 `agentStore`（deepchat/acp 体系零侵入）
- 契约必须走 zod route contract（`defineRouteContract`），main 侧 handler 用 `createRouteMap`，shared 注册在 `src/shared/contracts/routes.ts`
- 环境约束：pnpm shim 损坏——用 `node C:\Users\SRIBD\.workbuddy\binaries\node\versions\22.22.2-6\node.exe <path-to-bin>` 前缀运行 node_modules 内工具；**vitest 与 vue-tsc/oxlint 必须分开跑**（并行会 CPU 争抢产生 10s 超时假失败）
- lint 工具为 oxlint/oxfmt；测试目录镜像 src 结构（`test/main/...`、`test/renderer/...`）
- i18n：zh-CN 为源语言，en 同步；其余 18 locale 先复制 en 值（key 必须全量存在，避免缺 key 告警）
- 每个任务结束必须单独 commit（不 `--no-verify`）
- 阶段口径：M1=Task 1-2（契约+数据层），M2=Task 3（广场页），M3=Task 4（对话闭环），M4 随 Task 4 一并落地（四类能力注入）

---

### Task 1: 共享契约 + 主进程 Provider + 路由接线

**Files:**
- Create: `src/shared/contracts/routes/digitalEmployee.routes.ts`
- Modify: `src/shared/contracts/routes.ts`（import 块 + 注册 map，参照 documents.routes 的两处插入点：约 L406 import、L837 map entry）
- Create: `src/main/digital-employee/provider.ts`
- Create: `src/main/digital-employee/mockData.ts`
- Create: `src/main/digital-employee/routes.ts`
- Modify: `src/main/app/composition.ts`（参照 documentsRoutes：约 L226 import、L3284 create、L3718 合并）
- Test: `test/main/digital-employee/provider.test.ts`、`test/main/digital-employee/routes.test.ts`

**Interfaces:**
- Produces（后续任务依赖，签名逐字）:
  - `DigitalEmployee` 类型（z.infer 自 `digitalEmployeeSchema`）
  - `digitalEmployeeListRoute.name === 'digitalEmployee.list'`，output `{ employees: DigitalEmployee[]; fetchedAt: string }`
  - `digitalEmployeeGetRoute.name === 'digitalEmployee.get'`，input `{ id: string }`，output `{ employee: DigitalEmployee | null }`
  - `createDigitalEmployeeRoutes(provider: DigitalEmployeeProvider): DeepchatRouteMap`
  - `interface DigitalEmployeeProvider { list(): Promise<DigitalEmployee[]> }`

- [ ] **Step 1: 写共享契约路由文件**

`src/shared/contracts/routes/digitalEmployee.routes.ts`：

```ts
import { z } from 'zod'
import { defineRouteContract } from '../common'

export const sopDocumentSchema = z.object({
  title: z.string().min(1).max(100),
  content: z.string().min(1).max(20000)
})

export const digitalEmployeeSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(50),
  role: z.string().min(1).max(50),
  description: z.string().max(500),
  avatar: z.string().max(256).nullable(),
  capabilities: z.array(z.string().min(1).max(30)).max(20),
  greeting: z.string().max(500).nullable(),
  systemPrompt: z.string().min(1).max(10000),
  sops: z.array(sopDocumentSchema).max(20),
  knowledgeBaseIds: z.array(z.string().min(1)).max(10),
  skillIds: z.array(z.string().min(1)).max(20),
  tools: z.array(z.string().min(1)).max(50),
  enabled: z.boolean(),
  updatedAt: z.string().min(1)
})

export type DigitalEmployee = z.infer<typeof digitalEmployeeSchema>

export const digitalEmployeeListRoute = defineRouteContract({
  name: 'digitalEmployee.list',
  input: z.object({}).strict().default({}),
  output: z.object({
    employees: z.array(digitalEmployeeSchema),
    fetchedAt: z.string().min(1)
  })
})

export const digitalEmployeeGetRoute = defineRouteContract({
  name: 'digitalEmployee.get',
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ employee: digitalEmployeeSchema.nullable() })
})
```

- [ ] **Step 2: 在 `src/shared/contracts/routes.ts` 注册**

参照 documents.routes 的两处插入：
1. import 块（约 L406 附近，与其他 routes import 并列）：
```ts
import {
  digitalEmployeeGetRoute,
  digitalEmployeeListRoute
} from './routes/digitalEmployee.routes'
```
2. 注册 map（约 L837 `[documentsListRoute.name]: documentsListRoute,` 附近）：
```ts
[digitalEmployeeListRoute.name]: digitalEmployeeListRoute,
[digitalEmployeeGetRoute.name]: digitalEmployeeGetRoute,
```
3. 文件末尾 export 区（约 L711 `export * from './routes/documents.routes'` 旁）：
```ts
export * from './routes/digitalEmployee.routes'
```

- [ ] **Step 3: 写 mock 数据与 Provider**

`src/main/digital-employee/mockData.ts`：

```ts
import type { DigitalEmployee } from '@shared/contracts/routes'

const makeEmployee = (
  overrides: Pick<DigitalEmployee, 'id' | 'name' | 'role' | 'description'> &
    Partial<DigitalEmployee>
): DigitalEmployee => ({
  avatar: null,
  capabilities: [],
  greeting: null,
  systemPrompt: `# 角色：${overrides.role}\n你是「${overrides.name}」，一名专业的${overrides.role}数字员工。`,
  sops: [],
  knowledgeBaseIds: [],
  skillIds: [],
  tools: [],
  enabled: true,
  updatedAt: '2026-10-21T00:00:00.000Z',
  ...overrides
})

export const MOCK_DIGITAL_EMPLOYEES: DigitalEmployee[] = [
  makeEmployee({
    id: 'finance',
    name: '财务',
    role: '财务',
    description: '报销管家：费用报销、发票查验、预算查询、差旅标准咨询',
    capabilities: ['报销查询', '发票识别', '预算分析'],
    greeting: '您好，我是财务数字员工，可以帮您处理报销、发票与预算相关问题。',
    systemPrompt:
      '# 角色：报销管家\n你是「财务」数字员工，专注企业费用报销、发票查验与预算咨询。\n回答需引用具体制度条款，金额计算需给出明细。',
    sops: [
      {
        title: '报销单审核 SOP',
        content:
          '1. 核对发票抬头与税号\n2. 核对金额与税率\n3. 检查附件完整性\n4. 超过 5000 元需附审批单'
      }
    ],
    skillIds: ['invoice-summary'],
    tools: ['filesystem_read'],
    knowledgeBaseIds: []
  }),
  makeEmployee({
    id: 'hr',
    name: '人事',
    role: '人事',
    description: '入职引导、考勤假期、社保公积金、制度问答',
    capabilities: ['入转调离', '考勤假期', '制度问答'],
    systemPrompt:
      '# 角色：人事助手\n你是「人事」数字员工，熟悉员工全生命周期流程与公司制度。',
    sops: [
      {
        title: '入职办理 SOP',
        content: '1. 发放 offer 与入职材料清单\n2. 账号开通\n3. 入职培训预约\n4. 试用期目标设定'
      }
    ]
  }),
  makeEmployee({
    id: 'it',
    name: 'IT',
    role: 'IT 支持',
    description: '账号权限、设备报修、软件安装、网络问题排查',
    capabilities: ['账号权限', '设备报修'],
    systemPrompt: '# 角色：IT 支持专家\n你是「IT」数字员工，负责内部系统与设备支持。'
  })
  // 其余 7 个角色（销售/项目管理/采购/数据分析/法务/行政/市场）按同一致 makeEmployee 工厂补齐，
  // 每个至少含 id/name/role/description/capabilities/systemPrompt，sops 至少 1 条
]
```

注意：`// 其余 7 个角色...` 注释处必须**实际写全 10 个**（对齐截图：财务/销售/项目管理/人事/IT/采购/数据分析/法务/行政/市场），此注释仅说明生成方式，交付物中不得保留该注释。

`src/main/digital-employee/provider.ts`：

```ts
import type { DigitalEmployee } from '@shared/contracts/routes'
import { MOCK_DIGITAL_EMPLOYEES } from './mockData'

export interface DigitalEmployeeProvider {
  list(): Promise<DigitalEmployee[]>
}

export class MockDigitalEmployeeProvider implements DigitalEmployeeProvider {
  async list(): Promise<DigitalEmployee[]> {
    return MOCK_DIGITAL_EMPLOYEES.filter((employee) => employee.enabled)
  }
}

export class HttpDigitalEmployeeProvider implements DigitalEmployeeProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async list(): Promise<DigitalEmployee[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/employees`, {
      headers: { accept: 'application/json' }
    })
    if (!response.ok) {
      throw new Error(`[digitalEmployee] HTTP ${response.status} from ${this.baseUrl}`)
    }
    const payload = (await response.json()) as { employees: DigitalEmployee[] }
    return payload.employees
  }
}
```

- [ ] **Step 4: 写 main 路由 map**

`src/main/digital-employee/routes.ts`（参照 `src/main/documents/routes.ts:88-112` 的 createRouteMap 模式）：

```ts
import {
  digitalEmployeeGetRoute,
  digitalEmployeeListRoute
} from '@shared/contracts/routes'
import { createRouteMap, type DeepchatRouteMap } from '@/routes/routeRegistry'
import type { DigitalEmployeeProvider } from './provider'

export function createDigitalEmployeeRoutes(provider: DigitalEmployeeProvider): DeepchatRouteMap {
  return createRouteMap([
    [
      digitalEmployeeListRoute.name,
      async () => {
        const employees = await provider.list()
        return digitalEmployeeListRoute.output.parse({
          employees,
          fetchedAt: new Date().toISOString()
        })
      }
    ],
    [
      digitalEmployeeGetRoute.name,
      async (rawInput) => {
        const input = digitalEmployeeGetRoute.input.parse(rawInput)
        const employees = await provider.list()
        const employee = employees.find((item) => item.id === input.id) ?? null
        return digitalEmployeeGetRoute.output.parse({ employee })
      }
    ]
  ])
}
```

`src/main/app/composition.ts` 接线（三处，行号为当前参考值，以实际搜索为准）：
1. import 区（约 L226 旁）：
```ts
import { createDigitalEmployeeRoutes } from '@/digital-employee/routes'
import { MockDigitalEmployeeProvider } from '@/digital-employee/provider'
```
2. 创建（约 L3284 `const documentsRoutes = createDocumentsRoutes(` 旁）：
```ts
const digitalEmployeeRoutes = createDigitalEmployeeRoutes(new MockDigitalEmployeeProvider())
```
3. 合并进路由数组（约 L3718 `documentsRoutes,` 同一数组）：
```ts
digitalEmployeeRoutes,
```

- [ ] **Step 5: 写失败测试（先于实现验证 TDD，若实现已同步完成则直接跑通过）**

`test/main/digital-employee/provider.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { MockDigitalEmployeeProvider } from '../../../../src/main/digital-employee/provider'
import { digitalEmployeeSchema } from '../../../../src/shared/contracts/routes/digitalEmployee.routes'

describe('MockDigitalEmployeeProvider', () => {
  it('returns at least 10 enabled employees passing the shared contract', async () => {
    const provider = new MockDigitalEmployeeProvider()
    const employees = await provider.list()

    expect(employees.length).toBeGreaterThanOrEqual(10)
    for (const employee of employees) {
      expect(digitalEmployeeSchema.parse(employee)).toBeTruthy()
      expect(employee.enabled).toBe(true)
    }
  })

  it('covers the roles shown on the square page screenshot', async () => {
    const roles = (await new MockDigitalEmployeeProvider().list()).map((e) => e.role)
    for (const expected of ['财务', '人事', 'IT', '销售', '采购', '法务', '行政', '市场']) {
      expect(roles).toContain(expected)
    }
  })
})
```

`test/main/digital-employee/routes.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { MockDigitalEmployeeProvider } from '../../../../src/main/digital-employee/provider'
import { createDigitalEmployeeRoutes } from '../../../../src/main/digital-employee/routes'
import {
  digitalEmployeeGetRoute,
  digitalEmployeeListRoute
} from '../../../../src/shared/contracts/routes/digitalEmployee.routes'

describe('createDigitalEmployeeRoutes', () => {
  it('list returns contract-parsed employees with fetchedAt', async () => {
    const routes = createDigitalEmployeeRoutes(new MockDigitalEmployeeProvider())
    const handler = routes[digitalEmployeeListRoute.name]
    expect(handler).toBeDefined()

    const result = await handler({})
    expect(result.fetchedAt).toBeTruthy()
    expect(result.employees.length).toBeGreaterThanOrEqual(10)
  })

  it('get returns the employee by id and null for unknown id', async () => {
    const routes = createDigitalEmployeeRoutes(new MockDigitalEmployeeProvider())
    const handler = routes[digitalEmployeeGetRoute.name]

    expect((await handler({ id: 'finance' })).employee?.name).toBe('财务')
    expect((await handler({ id: 'nope' })).employee).toBeNull()
  })
})
```

- [ ] **Step 6: 运行测试**

```bash
cd D:/sync-workspace/traework/tools-market-project/deepchat-project
node C:/Users/SRIBD/.workbuddy/binaries/node/versions/22.22.2-6/node.exe node_modules/vitest/vitest.mjs run test/main/digital-employee --reporter=verbose
```
Expected: 2 files PASS

- [ ] **Step 7: oxlint 单目录 + commit**

```bash
node C:/Users/SRIBD/.workbuddy/binaries/node/versions/22.22.2-6/node.exe node_modules/oxlint/bin/oxlint src/main/digital-employee src/shared/contracts/routes/digitalEmployee.routes.ts test/main/digital-employee
git add src/main/digital-employee src/shared/contracts/routes/digitalEmployee.routes.ts src/shared/contracts/routes.ts src/main/app/composition.ts test/main/digital-employee
git commit -m "feat(digital-employee): add shared contract, mock provider and IPC routes"
```

---

### Task 2: Renderer Client + digitalEmployeeStore

**Files:**
- Create: `src/renderer/api/DigitalEmployeeClient.ts`
- Create: `src/renderer/src/stores/digitalEmployeeStore.ts`
- Test: `test/renderer/stores/digitalEmployeeStore.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `digitalEmployeeListRoute.name` / `DigitalEmployee` 类型
- Produces:
  - `createDigitalEmployeeClient(bridge?)` → `{ list(): Promise<{ employees: DigitalEmployee[]; fetchedAt: string }> }`
  - `useDigitalEmployeeStore()`（store id `'digitalEmployee'`）state/getters/actions：
    - state: `employees: Ref<DigitalEmployee[]>`、`loading: Ref<boolean>`、`error: Ref<string | null>`、`selectedDigitalEmployeeId: Ref<string | null>`、`favorites: Ref<string[]>`、`sessionBindings: Ref<Record<string, string>>`（sessionId → employeeId）
    - getters: `enabledEmployees`、`selectedDigitalEmployee`（ComputedRef<DigitalEmployee | null>）
    - actions: `fetchEmployees(): Promise<void>`、`setSelectedDigitalEmployee(id: string | null): void`、`toggleFavorite(id: string): Promise<void>`、`bindSession(sessionId: string, employeeId: string): Promise<void>`、`employeeForSession(sessionId: string): DigitalEmployee | null`、`startConversation(employee: DigitalEmployee, options?: { openingQuestion?: string }): Promise<string>`（返回 sessionId，Task 4 实现此 action）
  - 持久化键：`digitalEmployee.favorites`、`digitalEmployee.sessionBindings`（经 `configClient.setSetting`）

- [ ] **Step 1: 写 Client**

`src/renderer/api/DigitalEmployeeClient.ts`（模式对齐 `src/renderer/api/KnowledgeClient.ts:25`）：

```ts
import type { DeepchatBridge } from '@shared/contracts/bridge'
import { digitalEmployeeGetRoute, digitalEmployeeListRoute } from '@shared/contracts/routes'
import type { DigitalEmployee } from '@shared/contracts/routes'
import { getDeepchatBridge } from './core'

export function createDigitalEmployeeClient(bridge: DeepchatBridge = getDeepchatBridge()) {
  async function list(): Promise<{
    employees: DigitalEmployee[]
    fetchedAt: string
  }> {
    const result = await bridge.invoke(digitalEmployeeListRoute.name, {})
    return result as { employees: DigitalEmployee[]; fetchedAt: string }
  }

  async function get(id: string): Promise<DigitalEmployee | null> {
    const result = await bridge.invoke(digitalEmployeeGetRoute.name, { id })
    return (result as { employee: DigitalEmployee | null }).employee
  }

  return { list, get }
}

export type DigitalEmployeeClient = ReturnType<typeof createDigitalEmployeeClient>
```

- [ ] **Step 2: 写 store**

`src/renderer/src/stores/digitalEmployeeStore.ts`：

```ts
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createConfigClient } from '../../api/ConfigClient'
import { createDigitalEmployeeClient } from '../../api/DigitalEmployeeClient'
import type { DigitalEmployee } from '@shared/contracts/routes'

const FAVORITES_KEY = 'digitalEmployee.favorites'
const SESSION_BINDINGS_KEY = 'digitalEmployee.sessionBindings'

export const useDigitalEmployeeStore = defineStore('digitalEmployee', () => {
  const client = createDigitalEmployeeClient()
  const configClient = createConfigClient()

  const employees = ref<DigitalEmployee[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const selectedDigitalEmployeeId = ref<string | null>(null)
  const favorites = ref<string[]>([])
  const sessionBindings = ref<Record<string, string>>({})

  const enabledEmployees = computed(() => employees.value.filter((employee) => employee.enabled))
  const selectedDigitalEmployee = computed(
    () => employees.value.find((employee) => employee.id === selectedDigitalEmployeeId.value) ?? null
  )

  const readStringArraySetting = async (key: string): Promise<string[]> => {
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

  async function fetchEmployees(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const result = await client.list()
      employees.value = result.employees
    } catch (e) {
      error.value = `Failed to load digital employees: ${e}`
    } finally {
      loading.value = false
    }
  }

  async function loadPersistedState(): Promise<void> {
    favorites.value = await readStringArraySetting(FAVORITES_KEY)
    sessionBindings.value = await readBindingsSetting()
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

  return {
    employees,
    loading,
    error,
    selectedDigitalEmployeeId,
    favorites,
    sessionBindings,
    enabledEmployees,
    selectedDigitalEmployee,
    fetchEmployees,
    loadInitialData,
    setSelectedDigitalEmployee,
    toggleFavorite,
    bindSession,
    employeeForSession
  }
})
```

注意：`startConversation` 在本任务**不导出**（Task 4 加入）；若本任务测试需要引用该行为，仅断言上述导出成员。若 `configClient.getSetting` 的方法名不同（以 `src/renderer/api/ConfigClient.ts` 实际签名为准），修正为实际方法。

- [ ] **Step 3: 写失败测试**

`test/renderer/stores/digitalEmployeeStore.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDigitalEmployeeStore } from '../../../src/renderer/src/stores/digitalEmployeeStore'
import type { DigitalEmployee } from '../../../src/shared/contracts/routes/digitalEmployee.routes'

vi.mock('../../../src/renderer/api/DigitalEmployeeClient', () => ({
  createDigitalEmployeeClient: () => ({
    list: vi.fn().mockResolvedValue({
      employees: [
        { id: 'finance', name: '财务', role: '财务', description: '', avatar: null, capabilities: [], greeting: null, systemPrompt: 'p', sops: [], knowledgeBaseIds: [], skillIds: [], tools: [], enabled: true, updatedAt: '2026-10-21' },
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
})
```

- [ ] **Step 4: 运行测试**

```bash
node C:/Users/SRIBD/.workbuddy/binaries/node/versions/22.22.2-6/node.exe node_modules/vitest/vitest.mjs run test/renderer/stores/digitalEmployeeStore.test.ts --reporter=verbose
```
Expected: PASS（若 ConfigClient mock 的方法名与实际不符导致报错，先修正 Step 2 中的调用）

- [ ] **Step 5: oxlint + commit**

```bash
node C:/Users/SRIBD/.workbuddy/binaries/node/versions/22.22.2-6/node.exe node_modules/oxlint/bin/oxlint src/renderer/api/DigitalEmployeeClient.ts src/renderer/src/stores/digitalEmployeeStore.ts test/renderer/stores/digitalEmployeeStore.test.ts
git add src/renderer/api/DigitalEmployeeClient.ts src/renderer/src/stores/digitalEmployeeStore.ts test/renderer/stores/digitalEmployeeStore.test.ts
git commit -m "feat(digital-employee): add renderer client and pinia store"
```

---

### Task 3: 广场页 + 路由 + 侧边栏 + i18n

**Files:**
- Create: `src/renderer/src/pages/digitalEmployee/DigitalEmployeeSquarePage.vue`
- Modify: `src/renderer/src/router/index.ts`（`/documents` 路由对象后追加同级路由）
- Modify: `src/renderer/src/components/WindowSideBar.vue`（documents 按钮后追加，约 L203-225 模板 + L831 computed + L1048 handler）
- Modify: i18n locale 文件（先定位 `src/renderer/src/i18n` 或 locales 目录中 `routes.documents` 所在 json；zh-CN + en 全量新 key，其余 18 locale 复制 en）
- Test: `test/renderer/pages/digitalEmployee/DigitalEmployeeSquarePage.test.ts`

**Interfaces:**
- Consumes: Task 2 store 全部导出
- Produces: 路由 `{ path: '/digital-employees', name: 'digital-employees' }`；i18n key 前缀 `digitalEmployee.*`（清单见 Step 3）

- [ ] **Step 1: 路由与侧边栏入口**

`src/renderer/src/router/index.ts`，在 `/documents` 路由对象之后加：

```ts
{
  path: '/digital-employees',
  name: 'digital-employees',
  component: () => import('@/pages/digitalEmployee/DigitalEmployeeSquarePage.vue'),
  meta: {
    titleKey: 'routes.digitalEmployees',
    icon: 'lucide:users-round'
  }
},
```

`WindowSideBar.vue` 三处（完全镜像 documents 按钮）：
1. 模板：`app-documents-button` button 之后（约 L212 后）插入同结构 button——`data-testid="app-digital-employees-button"`、icon `lucide:users-round`、文本 `t('routes.digitalEmployees')`、class 绑定 `digitalEmployeesRouteActive`
2. script computed（约 L831 `documentsRouteActive` 旁）：
```ts
const digitalEmployeesRouteActive = computed(
  () => router?.currentRoute?.value?.name === 'digital-employees'
)
```
3. handler（约 L1048 `openDocuments` 旁）：
```ts
const openDigitalEmployees = () => {
  void router?.push({ name: 'digital-employees' })
}
```

- [ ] **Step 2: 广场页组件**

`src/renderer/src/pages/digitalEmployee/DigitalEmployeeSquarePage.vue`。结构要求（使用项目现有 dc-ui/shadcn 组件，参考 `DocumentsArchivePage.vue` 的页面骨架与 `AgentWelcomePage.vue` 的卡片 grid）：

```vue
<template>
  <div class="flex h-full flex-col overflow-hidden">
    <!-- 顶部：标题 + Tab -->
    <div class="shrink-0 border-b border-border/60 px-6 pt-4">
      <h1 class="text-lg font-semibold">{{ t('routes.digitalEmployees') }}</h1>
      <div class="mt-3 flex items-center gap-1">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          type="button"
          class="rounded-lg px-3 py-1.5 text-sm transition-colors"
          :class="activeTab === tab.key ? 'bg-accent/70 text-foreground' : 'text-muted-foreground hover:bg-accent/40'"
          :data-testid="`digital-employee-tab-${tab.key}`"
          @click="activeTab = tab.key"
        >
          {{ t(tab.labelKey) }}
        </button>
      </div>
    </div>

    <!-- 工具行：搜索 + 能力筛选 -->
    <div class="flex shrink-0 items-center gap-3 px-6 py-3">
      <Input
        v-model="searchQuery"
        type="search"
        data-testid="digital-employee-search-input"
        :placeholder="t('digitalEmployee.searchPlaceholder')"
        class="h-9 max-w-xs"
      />
      <div v-if="activeCapabilityFilter" class="flex items-center gap-1 text-xs text-muted-foreground">
        <DcBadge variant="active">{{ activeCapabilityFilter }}</DcBadge>
        <button type="button" class="ml-1 text-muted-foreground hover:text-foreground" @click="activeCapabilityFilter = null">
          <Icon icon="lucide:x" class="size-3.5" />
        </button>
      </div>
    </div>

    <!-- 内容区 -->
    <div class="flex-1 overflow-y-auto px-6 pb-6">
      <div v-if="store.loading" class="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
        <Skeleton v-for="i in 8" :key="i" class="h-36 rounded-xl" />
      </div>

      <DcEmpty v-else-if="visibleEmployees.length === 0" icon="lucide:users-round" :title="t('digitalEmployee.emptyTitle')" :description="t('digitalEmployee.emptyDescription')" />

      <div v-else class="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
        <button
          v-for="employee in visibleEmployees"
          :key="employee.id"
          type="button"
          class="flex flex-col items-start gap-2 rounded-xl border border-border/60 bg-card/50 p-4 text-left transition-colors hover:bg-accent/40"
          :data-testid="`digital-employee-card-${employee.id}`"
          @click="openDetail(employee)"
        >
          <div class="flex w-full items-center gap-2">
            <div class="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-sm font-semibold text-primary">
              {{ employee.name.slice(0, 1) }}
            </div>
            <div class="min-w-0">
              <div class="truncate text-sm font-medium">{{ employee.name }} <span class="text-xs text-muted-foreground">@{{ employee.role }}</span></div>
            </div>
            <Icon icon="lucide:star" class="ml-auto size-4 shrink-0" :class="store.favorites.includes(employee.id) ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40'" />
          </div>
          <p class="line-clamp-2 text-xs text-muted-foreground">{{ employee.description }}</p>
          <div class="flex flex-wrap gap-1">
            <span v-for="capability in employee.capabilities.slice(0, 3)" :key="capability" class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ capability }}</span>
          </div>
          <div class="mt-auto flex gap-3 text-[10px] text-muted-foreground/70">
            <span>{{ t('digitalEmployee.countSops', { count: employee.sops.length }) }}</span>
            <span>{{ t('digitalEmployee.countSkills', { count: employee.skillIds.length }) }}</span>
            <span>{{ t('digitalEmployee.countTools', { count: employee.tools.length }) }}</span>
          </div>
        </button>
      </div>

      <!-- 团队对话 Tab 空态 -->
      <DcEmpty v-if="activeTab === 'team'" icon="lucide:users" :title="t('digitalEmployee.teamComingSoon')" class="py-16" />
    </div>

    <!-- 详情弹层：四类配置清单 + 开场问题 + 开始对话 -->
    <Dialog :open="detailEmployee !== null" @update:open="(open: boolean) => { if (!open) detailEmployee = null }">
      <DialogContent v-if="detailEmployee" class="max-w-lg" data-testid="digital-employee-detail-dialog">
        <DialogHeader>
          <DialogTitle>{{ detailEmployee.name }} · {{ detailEmployee.role }}</DialogTitle>
          <DialogDescription>{{ detailEmployee.description }}</DialogDescription>
        </DialogHeader>
        <div class="max-h-[50vh] space-y-3 overflow-y-auto text-sm">
          <section v-if="detailEmployee.sops.length">
            <h3 class="text-xs font-semibold text-muted-foreground">{{ t('digitalEmployee.sectionSops') }}</h3>
            <ul class="mt-1 list-disc pl-4 text-xs">
              <li v-for="sop in detailEmployee.sops" :key="sop.title">{{ sop.title }}</li>
            </ul>
          </section>
          <section v-if="detailEmployee.skillIds.length">
            <h3 class="text-xs font-semibold text-muted-foreground">{{ t('digitalEmployee.sectionSkills') }}</h3>
            <p class="mt-1 text-xs">{{ detailEmployee.skillIds.join('、') }}</p>
          </section>
          <section v-if="detailEmployee.tools.length">
            <h3 class="text-xs font-semibold text-muted-foreground">{{ t('digitalEmployee.sectionTools') }}</h3>
            <p class="mt-1 text-xs">{{ detailEmployee.tools.join('、') }}</p>
          </section>
          <section v-if="detailEmployee.knowledgeBaseIds.length">
            <h3 class="text-xs font-semibold text-muted-foreground">{{ t('digitalEmployee.sectionKnowledge') }}</h3>
            <p class="mt-1 text-xs">{{ detailEmployee.knowledgeBaseIds.join('、') }}</p>
          </section>
        </div>
        <div class="space-y-2">
          <Input v-model="openingQuestion" type="text" data-testid="digital-employee-opening-question" :placeholder="t('digitalEmployee.openingQuestionPlaceholder')" />
          <DcButton class="w-full" data-testid="digital-employee-start-button" @click="startConversation">
            {{ t('digitalEmployee.startConversation') }}
          </DcButton>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
```

script setup 要点（完整实现，非伪代码）：

```ts
import { computed, onMounted, ref } from 'vue'
import { Icon } from '@iconify/vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Input } from '@shadcn/components/ui/input'
import { Skeleton } from '@shadcn/components/ui/skeleton'
import { DcBadge } from '@dc-ui/components/badge'
import { DcButton } from '@dc-ui/components/button'
import { DcEmpty } from '@dc-ui/components/empty'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shadcn/components/ui/dialog'
import { useDigitalEmployeeStore } from '@/stores/digitalEmployeeStore'
import type { DigitalEmployee } from '@shared/contracts/routes'

const TABS = [
  { key: 'all', labelKey: 'digitalEmployee.tabAll' },
  { key: 'mine', labelKey: 'digitalEmployee.tabMine' },
  { key: 'team', labelKey: 'digitalEmployee.tabTeam' },
  { key: 'square', labelKey: 'digitalEmployee.tabSquare' }
] as const

type TabKey = (typeof TABS)[number]['key']

const { t } = useI18n()
const router = useRouter()
const store = useDigitalEmployeeStore()
const activeTab = ref<TabKey>('all')
const searchQuery = ref('')
const activeCapabilityFilter = ref<string | null>(null)
const detailEmployee = ref<DigitalEmployee | null>(null)
const openingQuestion = ref('')

const matchesSearch = (employee: DigitalEmployee) => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return true
  return (
    employee.name.toLowerCase().includes(query) ||
    employee.role.toLowerCase().includes(query) ||
    employee.description.toLowerCase().includes(query) ||
    employee.capabilities.some((capability) => capability.toLowerCase().includes(query))
  )
}

const visibleEmployees = computed(() => {
  if (activeTab.value === 'team') return []
  let list = store.enabledEmployees
  if (activeTab.value === 'mine') {
    list = list.filter((employee) => store.favorites.includes(employee.id))
  }
  return list.filter(matchesSearch)
})

const openDetail = (employee: DigitalEmployee) => {
  detailEmployee.value = employee
  openingQuestion.value = ''
}

const startConversation = async () => {
  const employee = detailEmployee.value
  if (!employee) return
  const sessionId = await store.startConversation(employee, {
    openingQuestion: openingQuestion.value.trim() || undefined
  })
  detailEmployee.value = null
  await router.push({ name: 'chat' })
  void sessionId
}

// 能力标签点击筛选：卡片 capability chip 上加 @click.stop="activeCapabilityFilter = capability"
// square Tab 与 all Tab 的差异：square 额外显示能力筛选行（activeTab==='square' 时显示预聚合能力 chips 供点击）

onMounted(() => {
  void store.loadInitialData()
})
```

注意：`store.startConversation` 在 Task 4 才实现——本任务先在 store 中加入**最小骨架**（返回类型 `Promise<string>`，内部 `throw new Error('not implemented until Task 4')` 会破坏组件测试；因此本任务先实现为：不创建会话、直接 `router.push({ name: 'chat' })` 并返回空串 `''`，Task 4 替换实现。组件测试据此断言路由跳转而非 sessionId）。

- [ ] **Step 3: i18n keys（zh-CN 源 + en + 其余 locale 复制 en）**

先定位 `routes.documents` key 所在的 locale json（`Glob` `**/locales/**/*.json` 或 `**/i18n/**`，grep `"documents"`）。在**同一个 json**中追加：

```jsonc
// routes 段
"routes": { "digitalEmployees": "数字员工广场" } // en: "Digital Employees"
// 新增 digitalEmployee 段
"digitalEmployee": {
  "tabAll": "所有员工",          // en: "All"
  "tabMine": "我的数字员工",      // en: "My Employees"
  "tabTeam": "团队对话",          // en: "Team Chat"
  "tabSquare": "数字员工广场",    // en: "Square"
  "searchPlaceholder": "搜索姓名、角色或能力",  // en: "Search by name, role or capability"
  "emptyTitle": "没有找到数字员工",             // en: "No digital employees found"
  "emptyDescription": "调整搜索条件或稍后再试", // en: "Adjust your search or try again later"
  "teamComingSoon": "团队对话即将上线",         // en: "Team chat is coming soon"
  "countSops": "SOP {count}",    // en 同
  "countSkills": "技能 {count}", // en: "Skills {count}"
  "countTools": "工具 {count}",  // en: "Tools {count}"
  "sectionSops": "SOP 文档",     // en: "SOPs"
  "sectionSkills": "技能",       // en: "Skills"
  "sectionTools": "工具白名单",   // en: "Allowed tools"
  "sectionKnowledge": "知识库",  // en: "Knowledge bases"
  "openingQuestionPlaceholder": "（可选）输入你的第一个问题",  // en: "(Optional) your first question"
  "startConversation": "开始对话"                             // en: "Start conversation"
}
```

其余 18 个 locale：同 key、值复制 en（保证 key 全量存在）。

- [ ] **Step 4: 写组件测试**

`test/renderer/pages/digitalEmployee/DigitalEmployeeSquarePage.test.ts`：mock `digitalEmployeeStore`（vi.mock store 模块，提供 employees 3 条：含 favorites 命中 1 条、disabled 1 条）+ mock vue-router push。用例：

1. `renders all tab cards by default` — 断言 2 张启用卡片渲染、disabled 不渲染
2. `search filters cards by name/capability` — 输入搜索词后卡片数变化
3. `mine tab shows only favorites` — 切 Tab 后仅收藏卡片渲染
4. `team tab shows placeholder empty state` — 断言 `digitalEmployee.teamComingSoon` 文案
5. `detail dialog lists the four capability sections and navigates to chat on start` — 点卡片开弹层 → 断言 SOP/技能/工具/知识库 section → 点开始按钮断言 `router.push` 被以 `{ name: 'chat' }` 调用

测试挂载方式参照 `test/renderer/pages/documents/DocumentsArchivePage.test.ts` 现有 mount 模式（含 i18n 插桩与 pinia）。

- [ ] **Step 5: 运行测试（单独跑，不与 vue-tsc 并行）**

```bash
node C:/Users/SRIBD/.workbuddy/binaries/node/versions/22.22.2-6/node.exe node_modules/vitest/vitest.mjs run test/renderer/pages/digitalEmployee --reporter=verbose
```
Expected: PASS

- [ ] **Step 6: vue-tsc 类型检查（单独跑）+ commit**

```bash
node C:/Users/SRIBD/.workbuddy/binaries/node/versions/22.22.2-6/node.exe node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p tsconfig.web.json
git add src/renderer/src/pages/digitalEmployee src/renderer/src/router/index.ts src/renderer/src/components/WindowSideBar.vue <locale-jsons> test/renderer/pages/digitalEmployee src/renderer/src/stores/digitalEmployeeStore.ts
git commit -m "feat(digital-employee): add square page with tabs, search and detail dialog"
```
（若 tsconfig.web.json 不是项目实际配置名，用 `package.json` 中 typecheck script 的实际命令。）

---

### Task 4: 对话闭环——四类能力注入 + 徽标

**Files:**
- Modify: `src/renderer/src/stores/digitalEmployeeStore.ts`（实现 `startConversation`）
- Modify: 聊天页头部徽标（定位：`src/renderer/src/apps/chat-main/ChatTabView.vue` 的标题/header 区域；若该文件无独立 header，则加在 `ChatMainApp.vue` L535 `WindowSideBar` 相邻的主区域顶部）
- Test: 更新 `test/renderer/stores/digitalEmployeeStore.test.ts`

**Interfaces:**
- Consumes:
  - `sessionStore`（`@/stores/ui/session`）`createSession(input, options?)`（session.ts:1123）——input 满足 `CreateSessionInputSchema`（sessions.routes.ts:332）：`agentId`（必填，传 `'deepchat'`）、`message`、`activeSkills?: string[]`、`disabledAgentTools?: string[]`、`generationSettings?: SessionGenerationSettingsPatchSchema`（含 `systemPrompt`）
  - `knowledgeClient.similarityQuery(knowledgeBaseId, query)`（KnowledgeClient.ts:51）→ `QueryResult[]`
  - mcp store（`@/stores/mcp`）中可用工具名列表（在 mcp.ts 中定位 listTools/getToolList 类 action；若需 IPC 调用，用 `tools.routes.ts` 中现成 list 路由）
- Produces: `startConversation(employee, options?): Promise<string>`（返回 sessionId）；会话创建参数组装函数 `buildDigitalEmployeeSessionInput(employee, options)` 导出供测试

- [ ] **Step 1: 实现参数组装（纯函数，可测）**

`src/renderer/src/stores/digitalEmployeeStore.ts` 内新增并导出：

```ts
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
```

- [ ] **Step 2: store 内实现 startConversation**

```ts
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
      .map((result, index) => `[${index + 1}] ${result.content ?? ''}`.trim())
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
    generationSettings: { systemPrompt: buildDigitalEmployeeSystemPrompt(employee, { knowledgeSnippets }) }
  })

  await bindSession(result.session.id, employee.id)
  return result.session.id
}
```

依赖注入：store 顶部 `const knowledgeClient = createKnowledgeClient()`、`const sessionStore = useSessionStore()`。**QueryResult 的文本字段名以 `src/shared/types/knowledge` 实际定义为准**（可能是 `content`/`text`/`chunk`），实现时核对并修正 `.content` 取值行。

同时**移除 Task 3 的临时实现**（直接 push chat 的空实现），替换为本实现。广场页组件 `startConversation` 已 `router.push({ name: 'chat' })`，无需改动。

mcp 可用工具名获取：在广场页 `startConversation` 调用处（或 store 内）通过 mcp store 取工具列表；若取列表是异步 IPC，在 `startConversation` 前 `await`，传入 `options.availableMcpToolNames`。具体 action 名以 `src/renderer/src/stores/mcp.ts` 现有导出为准（该文件有 tools 相关状态与 query，实现时检索 `toolDefinitions|listTools|getTools`）。

- [ ] **Step 3: 聊天页徽标**

定位 `ChatTabView.vue` 中会话标题/header 渲染处（grep `activeSession` 或标题绑定）。在该节点旁追加：

```vue
<span
  v-if="boundDigitalEmployee"
  data-testid="chat-digital-employee-badge"
  class="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
>
  <Icon icon="lucide:users-round" class="size-3" />
  {{ boundDigitalEmployee.name }}
</span>
```

```ts
const digitalEmployeeStore = useDigitalEmployeeStore()
const boundDigitalEmployee = computed(() =>
  sessionStore.activeSessionId
    ? digitalEmployeeStore.employeeForSession(sessionStore.activeSessionId)
    : null
)
```

（组件名/变量名以实际文件为准；`sessionStore` 若未在该组件引入则补 `useSessionStore`。）

- [ ] **Step 4: 更新 store 测试**

在 `test/renderer/stores/digitalEmployeeStore.test.ts` 追加（sessionStore mock 为 `createSession: vi.fn().mockResolvedValue({ session: { id: 'session-9' } })`，knowledgeClient mock `similarityQuery` 返回 `[{ content: '片段A' }]`）：

```ts
it('buildDigitalEmployeeSystemPrompt composes persona, sops, greeting and knowledge', () => {
  const employee = makeEmployee('finance')
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
  const createInput = sessionStoreMock.createSession.mock.calls[0][0]
  expect(createInput.agentId).toBe('deepchat')
  expect(createInput.activeSkills).toEqual(employee.skillIds)
  expect(createInput.generationSettings.systemPrompt).toContain(employee.systemPrompt)
  expect(createInput.generationSettings.systemPrompt).toContain('[1] 片段A')
  expect(store.employeeForSession('session-9')?.id).toBe(employee.id)
})
```

（`sessionStoreMock` 通过 vi.mock `@/stores/ui/session` 提供；若 sessionStore 依赖链过重，可 mock 到 `useSessionStore` 返回 `{ createSession }` 最小面。）

- [ ] **Step 5: 运行测试 + 类型检查（分开跑）+ commit**

```bash
node C:/Users/SRIBD/.workbuddy/binaries/node/versions/22.22.2-6/node.exe node_modules/vitest/vitest.mjs run test/renderer/stores/digitalEmployeeStore.test.ts test/renderer/pages/digitalEmployee --reporter=verbose
node C:/Users/SRIBD/.workbuddy/binaries/node/versions/22.22.2-6/node.exe node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p tsconfig.web.json
git add src/renderer/src/stores/digitalEmployeeStore.ts src/renderer/src/apps/chat-main <badge-file> test/renderer/stores/digitalEmployeeStore.test.ts
git commit -m "feat(digital-employee): wire conversation loop with capability injection and chat badge"
```

---

### Task 5: 定向回归 + 全量 i18n 校验

**Files:**
- Test: 仅运行既有相关测试，不新增文件（若回归发现问题，修复并纳入本 commit）

**Interfaces:**
- Consumes: Task 1-4 全部产物
- Produces: 回归通过记录（写入任务报告）

- [ ] **Step 1: 定向回归（全部单独跑，禁止并行 vue-tsc）**

```bash
node C:/Users/SRIBD/.workbuddy/binaries/node/versions/22.22.2-6/node.exe node_modules/vitest/vitest.mjs run test/main/digital-employee test/renderer/stores/digitalEmployeeStore.test.ts test/renderer/pages/digitalEmployee --reporter=verbose
node C:/Users/SRIBD/.workbuddy/binaries/node/versions/22.22.2-6/node.exe node_modules/vitest/vitest.mjs run test/renderer/components/WindowSideBar.test.ts --reporter=verbose
node C:/Users/SRIBD/.workbuddy/binaries/node/versions/22.22.2-6/node.exe node_modules/vitest/vitest.mjs run test/renderer/pages/documents --reporter=verbose
```
Expected: 全部 PASS（WindowSideBar.test.ts 若不存在则跳过；documents 测试为改动路由文件后的邻近回归）

已知存量失败（与本特性无关，不修）：`test/renderer/.../DeepChatAgentsSettings.test.ts` 2 个（超时 + listAgents spy 调用 2 次，基线对照已确认）。

- [ ] **Step 2: 类型检查与 lint（分开跑）**

```bash
node C:/Users/SRIBD/.workbuddy/binaries/node/versions/22.22.2-6/node.exe node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p tsconfig.web.json
node C:/Users/SRIBD/.workbuddy/binaries/node/versions/22.22.2-6/node.exe node_modules/oxlint/bin/oxlint src/main/digital-employee src/shared/contracts/routes/digitalEmployee.routes.ts src/renderer/api/DigitalEmployeeClient.ts src/renderer/src/stores/digitalEmployeeStore.ts src/renderer/src/pages/digitalEmployee src/renderer/src/router/index.ts src/renderer/src/components/WindowSideBar.vue
```
Expected: 0 errors（warnings 逐条归因，存量可豁免）

- [ ] **Step 3: i18n key 完整性抽查**

在 locale 目录 grep 确认 20 个 locale 文件均含 `digitalEmployees` 与 `digitalEmployee` key（脚本：`grep -L "digitalEmployees" <locales>/*.json` 应输出空）。

- [ ] **Step 4: commit（如有修复）+ 任务报告**

```bash
git add -A
git commit -m "test(digital-employee): regression pass and fixes"
```

回归结果（通过/失败清单、i18n 检查结果）写入执行报告，交回主会话。

---

## Self-Review 记录

1. **Spec 覆盖**：§3 契约→Task 1；§4.1 Provider/IPC→Task 1；§4.2 Client→Task 2；§4.3 Store→Task 2/4；§4.4 广场页/路由/侧边栏/i18n→Task 3；§4.5 对话闭环四类能力→Task 4；§5 i18n→Task 3；§6 测试→各任务+Task 5；§7 里程碑 M1-M5→Task 1-5（M5 i18n 校验并入 Task 5）。团队对话占位→Task 3 team tab。收藏持久化→Task 2。greeting→Task 4 system prompt 开场白指令（v1 无独立助手首消息，spec 已按此口径）。知识库 v1 限制（仅开场问题检索注入）为有意收窄，与 spec「实现锚点提示」一致。
2. **占位扫描**：无 TBD/TODO；mock 数据第 3 个示例后的 7 个角色有明确生成工厂 + 必须写全的显式指令；`QueryResult` 字段名、mcp 工具列表 action 名、locale json 路径三处标注「以实际代码为准并核对」，均为实现期核对点而非占位。
3. **类型一致性**：`startConversation(employee, options?): Promise<string>` 在 Task 2/3/4 间一致；`DigitalEmployeeConversationOptions` 定义与使用一致；`DIGITAL_EMPLOYEE_AGENT_ID='deepchat'` 与测试断言一致；路由 name `'digital-employees'` 在 router/sidebar/测试一致。
