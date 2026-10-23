# StaffDeck 接入 D1：HttpDigitalEmployeeProvider 完整实现 Plan

> **实施顺序修订（本次实施时确认）**：原计划按 Task 1→2→3→4 排列，但 Task 2 要求「save/clear 成功后替换 `DigitalEmployeeProviderHolder` 并通知列表刷新」，而 holder 与配置驱动 Provider 在 Task 3 才建立、配置变更事件在 Task 4 才定义。为不引入临时的平行实现，实际按 **Task 1 → Task 3 → Task 2 → Task 4** 实施；Task 2 的 `composition` 接线在本轮一并完成，Task 4 的范围收敛为 store/页面/i18n 与事件订阅。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 将数字员工广场的 mock Provider 扩展为可配置、可安全维护的 StaffDeck HTTP Provider（鉴权/ETag 缓存/zod 校验/降级），并在广场页清楚展示远端不可用和员工配置更新状态。

**Architecture:** 契约层扩展 StaffDeck 可选字段（zod 默认 strip 未知字段）；应用设置页管理 StaffDeck Base URL、部署级 API Key、External User ID，凭证仅由主进程 `SecretStore` 加密保存。主进程持有 `DigitalEmployeeProviderHolder`，数字员工 routes 通过 holder 的稳定代理读取当前 Provider；设置保存/清除后 holder 原子替换 Provider，并清理旧 ETag 缓存，再通知 renderer 刷新列表。HTTP 失败回退 mock 并标记 degraded，renderer store 消费 degraded/configHash 信号渲染横幅。远端执行（D2）、知识同步（D3）、技能/MCP 工具（D4）、回流上报（D5）见文末骨架，待 StaffDeck 对应里程碑交付后各写独立 plan。

**Tech Stack:** Electron main + zod 契约路由 + Pinia + Vitest + vue-i18n（20 locale）

## Global Constraints

- 禁止新增运行时依赖（HTTP 用全局 fetch；SSE 将来用 fetch ReadableStream 手写解析）
- 不改动现有 agentStore（deepchat/acp 体系零侵入）
- 契约走 zod route contract（`defineRouteContract`），main handler 用 `createRouteMap`
- 测试目录镜像 src 结构；测试文件 import 深度：`test/main/**` 用 `../../../src/`，`test/renderer/**` 用 `../../../src/`（stores）或 `../../../../src/`（pages）
- pnpm shim 损坏——直接执行 exe：`C:\Users\SRIBD\.workbuddy\binaries\node\versions\22.22.2-6\node.exe node_modules/vitest/vitest.mjs run <path>`（不要在 exe 前加 `node`）
- vitest 与 vue-tsc（tsconfig.app.json）/oxlint 必须分开跑（并行会 CPU 争抢产生 10s 超时假失败）
- Lint = oxlint；每任务单独 commit，不 `--no-verify`
- i18n：zh-CN 为源语言，en 同步真实翻译，其余 18 locale 复制 en 值
- StaffDeck 协议约定：Bearer `sd_live_` 密钥、请求必带 `external_user_id`、`GET /api/v1/digital-employees` 支持 ETag/If-None-Match；具体 external_user_id 的 header 名以 StaffDeck OpenAPI v1 为准，实施前核对，不得把暂定 header 名当作已锁定协议。

## 评估结论（spec vs 当前代码，已逐项核实）

| spec 假设 | 实际状态 | 处理 |
|---|---|---|
| `provider.ts` HTTP 骨架预留 | ✅ 存在，但仅 19 行（无鉴权/ETag/zod 校验/降级），`composition.ts:3295` 硬编码 Mock | Task 3 完整重写；Task 4 接线 |
| 「复用现有 fetch 降级逻辑」 | ❌ 不存在 | Task 3 新建 `ResilientDigitalEmployeeProvider` |
| 「对齐 docs/managed 构建期端点注入惯例」 | ❌ `docs/managed` 目录不存在 | 不以环境变量作为运行时主配置；新增应用设置页 + 主进程 settings routes，API Key 存 `SecretStore`，baseUrl/userId 存设置库；env 仅允许作为首启默认值并可由用户保存覆盖 |
| zod「非严格模式忽略未知字段」 | ✅ `z.object` 默认 strip | 无需处理 |
| schema 字段上限 | ⚠️ 代码为 skillIds max(20)/tools max(50)，spec 文档写 max(10)/max(20) | 以代码为准；金样测试按代码版 |
| D4 技能导入走现有导入能力 | ⚠️ 现有 `AgentSkillImportService` 是外部工具扫描导入；`SkillServicePort.installImportedSkill`（skill/index.ts:3297）可复用为落库点 | D4 需新建 zip 下载→解包→installImportedSkill 适配器 |
| D4 MCP streamable HTTP | ✅ 现有 `type: 'http'` server 支持（mcprouterManager/settings.ts:274） | D4 程序化注册即可 |
| D3 知识本地副本重建 | ✅ `KnowledgeClient.addFile(knowledgeBaseId, filePath)` 管线可复用 | D3 同步器落文档到本地再走 addFile |
| D2 SSE | ⚠️ main 无通用 SSE 消费先例 | D2 新建 fetch ReadableStream 解析器 + 事件转发 renderer |

---

### Task 1: 契约扩展（StaffDeck superset 字段）+ 金样 fixture 测试

**Files:**
- Modify: `src/shared/contracts/routes/digitalEmployee.routes.ts`
- Modify: `src/main/digital-employee/mockData.ts`（补 executionMode）
- Test: `test/main/contracts/digitalEmployeeSchema.test.ts`（新建；Vitest projects 不收集 `test/shared/**`）

**Interfaces:**
- Produces（后续任务与 StaffDeck 金样共用）:
  - `digitalEmployeeSchema` 新增可选字段：`executionMode?: 'local'|'remote'|'hybrid'`（默认 `'local'`）、`configHash?: string`、`skills?: { id, name, downloadUrl }[]`（max 20）、`knowledgePackagesUrl?: string`
  - `digitalEmployeeListRoute.output` 新增可选：`degraded?: boolean`、`source?: 'http'|'mock'`

- [x] **Step 1: 写失败测试**

```ts
// test/main/contracts/digitalEmployeeSchema.test.ts
import { describe, expect, it } from 'vitest'
import { digitalEmployeeListRoute, digitalEmployeeSchema } from '../../../src/shared/contracts/routes/digitalEmployee.routes'

const baseEmployee = {
  id: 'emp-finance', name: '财务', role: '财务', description: '报销管家',
  avatar: null, capabilities: ['报销'], greeting: null, systemPrompt: '#角色：报销管家',
  sops: [], knowledgeBaseIds: [], skillIds: [], tools: [], enabled: true,
  updatedAt: '2026-10-22T00:00:00Z'
}

describe('digitalEmployeeSchema (StaffDeck superset)', () => {
  it('accepts StaffDeck extended fields', () => {
    const parsed = digitalEmployeeSchema.parse({
      ...baseEmployee,
      executionMode: 'hybrid',
      configHash: 'abc123',
      skills: [{ id: 'sk-1', name: 'staffdeck-api', downloadUrl: 'https://sd/api/v1/digital-employees/emp-finance:export-skill' }],
      knowledgePackagesUrl: 'https://sd/api/v1/digital-employees/emp-finance/knowledge-packages'
    })
    expect(parsed.executionMode).toBe('hybrid')
    expect(parsed.skills).toHaveLength(1)
  })

  it('defaults executionMode to local and strips unknown fields', () => {
    const parsed = digitalEmployeeSchema.parse({ ...baseEmployee, unknownFutureField: 'x' })
    expect(parsed.executionMode).toBe('local')
    expect((parsed as Record<string, unknown>).unknownFutureField).toBeUndefined()
  })

  it('rejects invalid executionMode', () => {
    expect(() => digitalEmployeeSchema.parse({ ...baseEmployee, executionMode: 'serverless' })).toThrow()
  })

  it('list output tolerates degraded/source markers', () => {
    const out = digitalEmployeeListRoute.output.parse({ employees: [baseEmployee], fetchedAt: 't', degraded: true, source: 'mock' })
    expect(out.degraded).toBe(true)
    expect(out.source).toBe('mock')
  })
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `C:\Users\SRIBD\.workbuddy\binaries\node\versions\22.22.2-6\node.exe node_modules/vitest/vitest.mjs run test/main/contracts/digitalEmployeeSchema.test.ts`
Expected: FAIL（executionMode/未知字段断言不通过）

- [x] **Step 3: 实现契约扩展**

`digitalEmployee.routes.ts` 中 `digitalEmployeeSchema` 追加（保持既有字段不动）：

```ts
  executionMode: z.enum(['local', 'remote', 'hybrid']).default('local'),
  configHash: z.string().max(128).optional(),
  skills: z.array(z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(100),
    downloadUrl: z.string().min(1).max(512)
  })).max(20).optional(),
  knowledgePackagesUrl: z.string().max(512).optional()
```

`digitalEmployeeListRoute.output` 追加：`degraded: z.boolean().optional()`、`source: z.enum(['http', 'mock']).optional()`。

`mockData.ts`：每个员工对象加 `executionMode: 'local'`。

- [x] **Step 4: 跑测试确认通过 + 回归**

Run: 同 Step 1（PASS），再 `C:\Users\SRIBD\.workbuddy\binaries\node\versions\22.22.2-6\node.exe node_modules/vitest/vitest.mjs run test/main/digital-employee test/renderer/stores/digitalEmployeeStore.test.ts`（回归 PASS，mock 加字段不破坏既有断言）

- [x] **Step 5: Commit**

```bash
git add src/shared/contracts/routes/digitalEmployee.routes.ts src/main/digital-employee/mockData.ts test/main/contracts/digitalEmployeeSchema.test.ts
git commit -m "feat(digital-employee): extend contract with StaffDeck superset fields"
```

---

### Task 2: 应用设置页管理 StaffDeck 连接配置（含密钥安全存储）

**Files:**
- Create: `src/shared/contracts/routes/digitalEmployeeSettings.routes.ts`（get/save/test/clear 路由契约）
- Modify: `src/shared/contracts/routes.ts`（契约导入、注册、导出）
- Modify: `src/main/app/settingsRoutes.ts`（在 `createAppSettingsRoutes(deps)` 集中注册新 handlers；依赖从 deps 获取 settings、SecretStore、fetch）
- Modify: `src/main/app/composition.ts`（将现有 `dependencies.secretStore` 透传 settings routes，并注册 DigitalEmployeeProvider lifecycle）
- Modify: `src/shared/settingsNavigation.ts`（新增 route item）+ `src/renderer/settings/settingsRouteComponents.ts`（组件映射）+ `src/renderer/settings/App.vue`（route label 映射）+ `src/shared/contracts/routes/config.routes.ts`（若 `enabled/baseUrl/externalUserId` 通过通用 config schema 存储，注册新键；API Key 严禁进入通用 config entries）
- Create: `src/renderer/settings/components/DigitalEmployeeServiceSettings.vue`
- Modify: 对应 settings route labels 的 20 locale json
- Test: Create `test/main/app/settingsRoutes.digitalEmployee.test.ts`（仅测试新增 route handlers；`settingsRoutes.ts` 当前无专用测试文件），并创建 `test/renderer/settings/DigitalEmployeeServiceSettings.test.ts`

**Interfaces:**
- Produces: `digitalEmployeeSettings.get` 返回 `{ enabled: boolean; baseUrl: string; externalUserId: string; apiKeyConfigured: boolean }`，永不返回密钥明文
- Produces: 页面入口 route key 建议 `settings-digital-employee-service`；route catalog 使用 `getSettingsRouteItems`（`src/shared/settingsNavigation.ts`）
- Produces: `digitalEmployeeSettings.save` 接收 `{ enabled: boolean; baseUrl: string; externalUserId: string; apiKey?: string }`；`apiKey` 为空表示保留现有密钥，独立 clear 路由负责删除；成功后返回安全状态
- Produces: `digitalEmployeeSettings.testConnection` 接收临时/已保存配置，主进程发起轻量 authenticated GET `/api/v1/digital-employees`，校验 HTTP 成功及 payload schema，但不更新 Provider 缓存；返回 `{ ok: boolean; messageCode: string }`，不把原始响应体/密钥透传 renderer
- Produces: `digitalEmployeeSettings.clearApiKey` 删除 SecretStore 中 key，返回 `{ apiKeyConfigured: false }`
- Settings route 由 main 调用 `SecretStore.wrap()` + `setWrapped()`；若 safeStorage 不可用则返回可识别错误，不能回退明文。持久化非密钥字段前先完成所有 schema/URL 校验与密钥 wrap；若后续 `SettingsStore.set` 失败，恢复旧密钥 wrapped 值，使整次保存不留下半更新。首次 `externalUserId` 为空时，由 main 在 get 初始化阶段生成 `randomUUID()` 并持久化；生成必须幂等，不能每次 get 重置。

- [x] **Step 1: 写失败测试**

在 `test/main/app/settingsRoutes.digitalEmployee.test.ts` 用 `createAppSettingsRoutes` 的最小 deps fixture（其余既有依赖以 `vi.fn()` stub，SettingsStore mock 实现 `get/set`，SecretStore mock 实现 `wrap/setWrapped/restoreWrapped/getWrapped`），提取并调用 `digitalEmployeeSettings.get/save/testConnection/clearApiKey` handler。逐例断言：

```ts
it('does not expose the API key in get output', async () => {
  const result = await handlers.get(undefined)
  expect(result).toEqual({ enabled: false, baseUrl: '', externalUserId: 'user-1', apiKeyConfigured: true })
  expect(JSON.stringify(result)).not.toContain('sd_live_secret')
})

it('preserves the stored key when save omits apiKey and normalizes the URL', async () => {
  await handlers.save({ enabled: true, baseUrl: 'https://sd.example///', externalUserId: ' user-1 ' })
  expect(secretStore.setWrapped).not.toHaveBeenCalled()
  expect(settings.set).toHaveBeenCalledWith('digitalEmployee.staffdeckBaseUrl', 'https://sd.example')
  expect(settings.set).toHaveBeenCalledWith('digitalEmployee.externalUserId', 'user-1')
})
```

另外写用例验证拒绝非 http(s)/userinfo URL、非空 apiKey 先 wrap 再 setWrapped、clear 调用 `restoreWrapped('digitalEmployee.staffdeckApiKey', undefined)`；safeStorage unavailable 时无普通 settings 写入；SettingsStore.set 失败时恢复旧 wrapped 密钥；testConnection 对 200+合法 employees payload 返回 `{ok:true}`，对 401/网络异常/JSON/schema 错误返回稳定 `messageCode`，且 holder 未被 replace。

在 `test/renderer/settings/DigitalEmployeeServiceSettings.test.ts` 覆盖：载入后 API Key 输入仍为空但显示已配置状态；输入显示/隐藏；测试连接成功/失败状态；保存成功清空输入并刷新状态；清除密钥需确认；无效 URL 不发 save 请求。

- [x] **Step 2: 跑定向测试确认失败**

Run: `C:\Users\SRIBD\.workbuddy\binaries\node\versions\22.22.2-6\node.exe node_modules/vitest/vitest.mjs run test/main/app/settingsRoutes.digitalEmployee.test.ts test/renderer/settings/DigitalEmployeeServiceSettings.test.ts`
Expected: FAIL（route/component 尚未实现）。

- [x] **Step 3: 实现主进程配置接口**

- 配置字段还包含 `enabled: boolean`（显式启用 StaffDeck 远端分发；默认 false，确保未配置前仍走 mock）。设置键固定为 `digitalEmployee.staffdeckEnabled`、`digitalEmployee.staffdeckBaseUrl`、`digitalEmployee.externalUserId`；API key 存储键固定为 `digitalEmployee.staffdeckApiKey`，只由 main `SecretStore` 读写。
- shared settings route 的 get/save payload 包含 `enabled`；页面明确展示当前配置模式「本地 Mock / StaffDeck 服务」，另以独立降级状态表明本次请求实际回退到 Mock，不可将降级描述成仍连接成功。
- `get` 只返回 URL、用户 ID、`apiKeyConfigured`；renderer 的配置表单 `apiKey` 初始永远为空，不得调用通用 configClient 读密钥。
- `save` 校验 URL scheme 为 http/https，禁止 URL userinfo（避免账号密码塞 URL），规范移除末尾 `/`；External User ID trim 且非空；新 apiKey 非空时 `SecretStore.wrap` 后 `setWrapped`，空/未提供不覆盖原值。批量更新需先完成全部校验与 wrap，再写 store，确保失败时不留下半更新。
- `clearApiKey` 调 `SecretStore.restoreWrapped('digitalEmployee.staffdeckApiKey', undefined)`；不删除 baseUrl/userId。
- `testConnection` 使用传入的未保存草稿优先、否则使用已保存 config；key 仅在 main 内取用。调用 GET `/api/v1/digital-employees`，带 `Authorization: Bearer ...` 与 `external_user_id`（按 StaffDeck 已确认协议 header 名；若 OpenAPI 实际要求 query/body，联调前以 OpenAPI 为准，计划中设为 `x-external-user-id` header），超时 10 秒；仅检查 2xx + employees 列表可解析，不写 ETag/cache。
- `composition.ts` 已拥有 `dependencies.secretStore`，新增 `digitalEmployeeSettings` deps（`settings: Pick<SettingsStore, 'get' | 'set'>`、`secretStore`、`providerHolder`、`fetchImpl`），在 `createAppSettingsRoutes` 内为专用 `digitalEmployeeSettings.*` route name 注册 handlers，并复用现有 `createRouteMap`；禁止 renderer 直接访问 Electron `safeStorage`。
- `DigitalEmployeeProviderHolder` 接口锁定为 `current(): DigitalEmployeeProvider`、`replace(next: DigitalEmployeeProvider): void`。`createDigitalEmployeeRoutes(holder)` 在每次 list/get 调用时读取 `holder.current()`；composition 创建一个 holder 并同时传给数字员工 routes 与 settings routes。重建 Provider 即清除旧实例 ETag/cache；不在 route contract 或 renderer 暴露 Provider 实例。
- `DigitalEmployeeProviderHolder` 在 `src/main/digital-employee/providerFactory.ts` 导出 `createDigitalEmployeeProviderHolder(initial)` 工厂返回 `{ current, replace }`；初始 Provider 在 composition 从持久化设置读取并 factory 构造（空配置则 Mock），不再硬编码永远使用 Mock。

- [x] **Step 4: 实现设置页与路由**

- 新设置页入口名称「数字员工服务」，归入现有设置导航；按 `settingsRouteComponents.ts` 与 settings route catalog 现有模式注册页面。
- 主进程通过 `DigitalEmployeeProviderHolder.current()/replace()` 管理运行期 Provider；save/clear 成功后重建并替换 Provider（清空 ETag/cache），发配置变更事件让 store 刷新。测试连接使用临时实例，不改当前 Provider/缓存/启用状态。
- 禁用 StaffDeck 或配置不全时，页面明确显示「本地 Mock」模式；StaffDeck 启用后 API 故障可降级回本地 Mock，显示「服务暂不可用，当前使用本地数据」状态；恢复连接后自动清除 degraded。
- 表单字段：StaffDeck Base URL、API Key（password input，输入前 placeholder 提示「留空则保留已保存密钥」，保存成功立即清空输入框）、External User ID（首启由主进程生成并持久化 UUID，可编辑）。
- 按钮：测试连接、保存配置、清除 API Key（有确认 dialog）。测试按钮在请求中 disabled 并显示 loading；显示成功/鉴权失败/网络失败状态，不在 renderer console 或 UI 输出密钥。
- 默认值：运行时以用户设置为权威，不能静默读取 env 覆盖。External User ID 首次无值则由 main `randomUUID()` 一次性生成并写设置库。可选的部署初值导入必须单独显式实现，并且 API key 只允许 main process 读取后立即迁入 SecretStore；不得进入 renderer bundle。
- Settings label 全 locale 补齐；zh-CN 为源、en 翻译，其余 locale 复制 en。

- [x] **Step 5: 跑测试、类型检查与 lint（分开）**

Run 定向 Vitest：`C:\Users\SRIBD\.workbuddy\binaries\node\versions\22.22.2-6\node.exe node_modules/vitest/vitest.mjs run test/main/app/settingsRoutes.digitalEmployee.test.ts test/renderer/settings/DigitalEmployeeServiceSettings.test.ts`（PASS）；再运行项目安装的 `vue-tsc -p tsconfig.app.json --noEmit`（PASS；若经包管理器 shim 失败，直接运行 `node_modules/vue-tsc/bin/vue-tsc.js -p tsconfig.app.json --noEmit`）；最后运行 `node_modules/.bin/oxlint <本任务改动的 TS/Vue 文件路径...>`（PASS）。三类命令依次执行，不并行。

- [x] **Step 6: Commit**

```bash
git add src/shared/contracts/routes/digitalEmployeeSettings.routes.ts src/shared/contracts/routes.ts src/main/app/settingsRoutes.ts src/main/app/composition.ts src/renderer/settings/settingsRouteComponents.ts src/renderer/settings/components/DigitalEmployeeServiceSettings.vue src/renderer/settings/**/locales test/main/app test/renderer/settings
git commit -m "feat(digital-employee): add StaffDeck service settings and secure credentials"
```

---

### Task 3: HttpDigitalEmployeeProvider 完整实现 + 降级 + factory

**Files:**
- Modify: `src/main/digital-employee/provider.ts`
- Create: `src/main/digital-employee/providerFactory.ts`
- Modify: `src/main/digital-employee/routes.ts`（list 输出透传 degraded/source）
- Test: `test/main/digital-employee/provider.test.ts`（扩展）、`test/main/digital-employee/providerFactory.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `digitalEmployeeListRoute.output`（zod 校验响应）、`DigitalEmployee` 类型
- Produces:
  - `DigitalEmployeeProvider` 接口新增可选只读属性 `readonly degraded?: boolean`（Mock/HTTP 不设 → undefined；Resilient 提供）
  - `class HttpDigitalEmployeeProvider { constructor(config: HttpProviderConfig, fetchImpl?: typeof fetch) }`，`HttpProviderConfig = { baseUrl: string; apiKey: string; externalUserId: string }`
  - `class ResilientDigitalEmployeeProvider { constructor(primary: DigitalEmployeeProvider, fallback: DigitalEmployeeProvider) }`，`list()` 失败回落 fallback 并置 `degraded = true`；成功一次后恢复 `degraded = false`；若 fallback 自身失败则继续抛错
  - `createDigitalEmployeeProvider(config: DigitalEmployeeConnectionConfig, fallback: DigitalEmployeeProvider): DigitalEmployeeProvider`（enabled 且 URL/key/userId 齐全 → Resilient(Http, fallback)；disabled 或配置不完整 → fallback）

- [x] **Step 1: 写失败测试（provider.test.ts 追加）**

```ts
// 追加到 test/main/digital-employee/provider.test.ts
describe('HttpDigitalEmployeeProvider', () => {
  const config = { baseUrl: 'https://sd.example', apiKey: 'sd_live_k1', externalUserId: 'user-1' }
  const makeEmployee = () => ({ /* 与契约 baseEmployee 同形（Task 1 fixture），含 executionMode: 'local' */ })

  it('sends bearer auth and external user id headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { employees: [makeEmployee()] }))
    await new HttpDigitalEmployeeProvider(config, fetchMock).list()
    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers.authorization).toBe('Bearer sd_live_k1')
    expect(headers['x-external-user-id']).toBe('user-1')
    expect(fetchMock.mock.calls[0][0]).toBe('https://sd.example/api/v1/digital-employees')
  })

  it('returns 304 cache without refetch and updates etag on 200', async () => {
    const employee = makeEmployee()
    let call = 0
    const fetchMock = vi.fn().mockImplementation(() => {
      call += 1
      if (call === 1) return Promise.resolve(jsonResponse(200, { employees: [employee] }, { etag: '"v1"' }))
      return Promise.resolve(new Response(null, { status: 304 }))
    })
    const provider = new HttpDigitalEmployeeProvider(config, fetchMock)
    expect(await provider.list()).toEqual([employee])
    const second = await provider.list()
    expect(second).toEqual([employee]) // 304 → 本地缓存
    expect(fetchMock.mock.calls[1][1].headers['if-none-match']).toBe('"v1"')
  })

  it('rejects payloads failing zod validation and non-2xx responses', async () => {
    const bad = new HttpDigitalEmployeeProvider(config, vi.fn().mockResolvedValue(jsonResponse(200, { employees: [{ id: '' }] })))
    await expect(bad.list()).rejects.toThrow()
    const err = new HttpDigitalEmployeeProvider(config, vi.fn().mockResolvedValue(new Response('boom', { status: 500 })))
    await expect(err.list()).rejects.toThrow('HTTP 500')
  })
})

describe('ResilientDigitalEmployeeProvider', () => {
  it('falls back to mock and marks degraded when primary fails', async () => {
    const failing = { list: vi.fn().mockRejectedValue(new Error('network down')) }
    const mock = new MockDigitalEmployeeProvider()
    const provider = new ResilientDigitalEmployeeProvider(failing, mock)
    const employees = await provider.list()
    expect(provider.degraded).toBe(true)
    expect(employees).toEqual(await mock.list())
  })
  it('recovers to live after a successful primary call', async () => {
    const employee = { /* baseEmployee 同形 */ }
    const primary = { list: vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue([employee]) }
    const provider = new ResilientDigitalEmployeeProvider(primary, new MockDigitalEmployeeProvider())
    await provider.list()
    expect(provider.degraded).toBe(true)
    await provider.list()
    expect(provider.degraded).toBe(false)
  })
})
```

（`jsonResponse` 为测试文件内已有/新增 helper：`new Response(JSON.stringify(body), { status, headers })`。）

- [x] **Step 2: 跑测试确认失败**

Run: `C:\Users\SRIBD\.workbuddy\binaries\node\versions\22.22.2-6\node.exe node_modules/vitest/vitest.mjs run test/main/digital-employee/provider.test.ts`
Expected: FAIL（新构造签名/行为未实现）

- [x] **Step 3: 实现**

`provider.ts` 重写要点（保留 `DigitalEmployeeProvider`/`MockDigitalEmployeeProvider` 不动）：

```ts
export interface HttpProviderConfig { baseUrl: string; apiKey: string; externalUserId: string }

export class HttpDigitalEmployeeProvider implements DigitalEmployeeProvider {
  private etag: string | null = null
  private cache: DigitalEmployee[] = []
  constructor(private readonly config: HttpProviderConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async list(): Promise<DigitalEmployee[]> {
    const url = `${this.config.baseUrl}/api/v1/digital-employees`
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.config.apiKey}`,
      'x-external-user-id': this.config.externalUserId
    }
    if (this.etag) headers['if-none-match'] = this.etag
    const response = await this.fetchImpl(url, { headers })
    if (response.status === 304 && this.cache.length > 0) return this.cache
    if (!response.ok) throw new Error(`[digitalEmployee] HTTP ${response.status} from ${url}`)
    const body = (await response.json()) as Record<string, unknown>
    const payload = digitalEmployeeListRoute.output.parse({
      ...body,
      employees: body.employees,
      fetchedAt: typeof body.fetchedAt === 'string' && body.fetchedAt ? body.fetchedAt : new Date().toISOString()
    })
    this.etag = response.headers.get('etag')
    this.cache = payload.employees
    return this.cache
  }
}
```

实现注意：响应体若无 `fetchedAt`，parse 前补 `fetchedAt: new Date().toISOString()`；`DigitalEmployeeProvider` 接口加 `readonly degraded?: boolean`。

`ResilientDigitalEmployeeProvider`：包装 primary/fallback，初始 `degraded = false`；try primary 成功 → `degraded = false` 并返回远端结果；catch → `degraded = true` 并返回 fallback.list()。若 fallback.list() 自身失败，原错误继续向上抛出，route 不伪造空列表。

`providerFactory.ts`：

```ts
export interface DigitalEmployeeConnectionConfig {
  enabled: boolean
  baseUrl: string
  apiKey: string
  externalUserId: string
}

export function createDigitalEmployeeProvider(
  config: DigitalEmployeeConnectionConfig,
  fallback: DigitalEmployeeProvider
): DigitalEmployeeProvider {
  if (!config.enabled || !config.baseUrl || !config.apiKey || !config.externalUserId) return fallback
  return new ResilientDigitalEmployeeProvider(
    new HttpDigitalEmployeeProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey, externalUserId: config.externalUserId }),
    fallback
  )
}
```

`routes.ts`：list handler 输出追加 `degraded: provider.degraded === true`、`source: provider instanceof HttpDigitalEmployeeProvider || provider instanceof ResilientDigitalEmployeeProvider ? 'http' : 'mock'`（实现时用 `'source' in provider` 或 status 判断，避免反向 instanceof——以现有 handler 结构为准，保持 zod output 契约一致）。

factory 测试（providerFactory.test.ts）：disabled → fallback；enabled 且配置齐 → Resilient 且 primary 为 Http；enabled 但缺关键字段 → fallback。配置由后述 settings service 提供，不允许在 factory 内读取 env 或 renderer 全局。

- [x] **Step 4: 跑测试确认通过**

Run: `C:\Users\SRIBD\.workbuddy\binaries\node\versions\22.22.2-6\node.exe node_modules/vitest/vitest.mjs run test/main/digital-employee`（全绿）

- [x] **Step 5: Commit**

```bash
git add src/main/digital-employee/provider.ts src/main/digital-employee/providerFactory.ts src/main/digital-employee/routes.ts test/main/digital-employee/provider.test.ts test/main/digital-employee/providerFactory.test.ts
git commit -m "feat(digital-employee): full http provider with etag cache, auth and resilient fallback"
```

---

### Task 4: composition 接线 + store 横幅状态 + 广场页 UI + i18n

**Files:**
- Modify: `src/main/app/composition.ts:3295`（provider lifecycle：settings/config changed 后重建 provider 并清理缓存）
- Modify: `src/main/digital-employee/providerFactory.ts`（新增 `DigitalEmployeeProviderHolder`，封装 `current()/replace()` 稳定代理；routes 在每个请求时从 holder 读取当前 Provider）
- Modify: `src/renderer/src/stores/digitalEmployeeStore.ts`（degraded/hasConfigUpdates）
- Modify: `src/shared/contracts/routes/config.routes.ts` + `src/main/app/settingsRoutes.ts`（注册持久化键 `digitalEmployee.configHashes`，仿 favorites/bindings 的三处注册）
- Modify: `src/renderer/src/pages/digitalEmployee/DigitalEmployeeSquarePage.vue`（横幅）
- Modify: 20 个 locale json（`digitalEmployee.banner.degraded` / `digitalEmployee.banner.configUpdated`）
- Test: `test/renderer/stores/digitalEmployeeStore.test.ts`（扩展）、`test/renderer/pages/digitalEmployee/DigitalEmployeeSquarePage.test.ts`（横幅 2 例）

**Interfaces:**
- Consumes: Task 1 `digitalEmployeeListRoute.output.degraded/source`；Task 2 factory
- Produces（store 新增导出，后续 D2-D5 依赖）: state `degraded: boolean`、`hasConfigUpdates: boolean`、`acknowledgeConfigUpdates()`（清 hasConfigUpdates 并把当前 hash 快照写入持久化）

- [x] **Step 1: 写失败测试**

```ts
// digitalEmployeeStore.test.ts 追加
it('exposes degraded flag from list result', async () => {
  clientMock.list.mockResolvedValue({ employees: [makeEmployee()], fetchedAt: 't', degraded: true, source: 'mock' })
  await store.fetchEmployees()
  expect(store.degraded).toBe(true)
})

it('flags config updates when configHash changes and clears on acknowledge', async () => {
  clientMock.list.mockResolvedValue({ employees: [makeEmployee({ id: 'e1', configHash: 'h1' })], fetchedAt: 't' })
  await store.fetchEmployees()
  expect(store.hasConfigUpdates).toBe(false) // 首次建立基线
  clientMock.list.mockResolvedValue({ employees: [makeEmployee({ id: 'e1', configHash: 'h2' })], fetchedAt: 't2' })
  await store.fetchEmployees()
  expect(store.hasConfigUpdates).toBe(true)
  store.acknowledgeConfigUpdates()
  expect(store.hasConfigUpdates).toBe(false)
})
```

页面测试追加：`degraded=true` 时渲染明确写出当前展示本地 Mock 员工数据的横幅（不能声称是缓存）；`hasConfigUpdates=true` 时渲染「有员工的配置已更新」横幅。

- [x] **Step 2: 跑测试确认失败**

Run: `C:\Users\SRIBD\.workbuddy\binaries\node\versions\22.22.2-6\node.exe node_modules/vitest/vitest.mjs run test/renderer/stores/digitalEmployeeStore.test.ts test/renderer/pages/digitalEmployee`
Expected: FAIL

- [x] **Step 3: 实现**

- composition.ts:3295：从 SettingsStore + SecretStore 读取已保存配置，调用 `createDigitalEmployeeProvider(config, new MockDigitalEmployeeProvider())` 作为 holder 初值；创建 `DigitalEmployeeProviderHolder`（`current(): DigitalEmployeeProvider`、`replace(next): void`）并传入 `createDigitalEmployeeRoutes(providerHolder)`。设置 save/clear handler 成功后重读最新配置、构造 Provider 并 `providerHolder.replace(next)`；rebuild 自然清空 ETag。随后通过既有 `publishEvent` 发 `digitalEmployee.configurationChanged`，renderer 收到后调用 store `fetchEmployees()`。连接测试用新建临时 HttpProvider，不调用 replace。
- store：`fetchEmployees` 读取 `result.degraded`/`result.source` 写入 `degraded` ref；读取 `digitalEmployee.configHashes` 作为 `Record<string, string>` 基线（无值按 `{}` 处理），仅比较新旧均有 `configHash` 的员工；首轮/新员工建立基线但不提示，既有员工 hash 改变时设 `hasConfigUpdates=true`。`acknowledgeConfigUpdates()` 将当前有效员工的 hash 快照通过现有 `configClient.updateEntries({ 'digitalEmployee.configHashes': snapshot })` 持久化并清除提示；若写入失败保持提示。`fetchEmployees` 只在首次基线建立时保存快照，不提前覆盖旧基线，否则后续无法显示更新提示。
- 页面：卡片网格上方加条件横幅（`v-if="store.degraded || store.hasConfigUpdates"`，DcBanner 或现有提示样式——以项目现有 alert/横幅组件为准，无则用带图标的简单 div + i18n 文案）。
- i18n：zh-CN「StaffDeck 服务不可用，当前展示本地 Mock 数字员工」/「部分员工配置已更新」；en 同步；其余 18 locale 复制 en。

- [x] **Step 4: 跑测试 + vue-tsc（分开）+ oxlint**

Run: `C:\Users\SRIBD\.workbuddy\binaries\node\versions\22.22.2-6\node.exe node_modules/vitest/vitest.mjs run test/renderer/stores/digitalEmployeeStore.test.ts test/renderer/pages/digitalEmployee test/main/digital-employee`（全绿）；再 `vue-tsc -p tsconfig.app.json --noEmit`；再 `node_modules/.bin/oxlint <本任务改动的 TS/Vue 文件路径...>`。三类命令依次执行，不并行。

- [x] **Step 5: Commit**

```bash
git add -A src/main/app/composition.ts src/renderer/src/stores/digitalEmployeeStore.ts src/shared/contracts/routes/config.routes.ts src/main/app/settingsRoutes.ts src/renderer/src/pages/digitalEmployee src/renderer/src/locales
git commit -m "feat(digital-employee): wire http provider with degraded and config-update banners"
```

---

## D2-D5 后续里程碑骨架（StaffDeck 依赖就绪后各写独立 plan）

| 里程碑 | deepchat 任务拆分（预沟通接口） | 外部依赖 | 触发条件 |
|---|---|---|---|
| **D2 远端执行** | ① 契约：`digitalEmployeeRemote.routes.ts`（createRemoteSession / streamRun input/output zod）② main SSE client（fetch ReadableStream 解析 `run.output.delta/replace/completed`、Last-Event-ID 续传、awaiting_input）③ 事件转发 renderer（复用现有事件系统）④ store `startConversation` 按 executionMode 分流 ⑤ ChatTopBar 徽标 local/remote 标识 ⑥ hybrid 按 SOP execution_hint 路由 + 切换时上下文摘要注入 | StaffDeck M5（远端字段补齐）+ OpenAPI 样本 | StaffDeck M5 交付、拿到真实 SSE 事件样本后写 plan（SSE 事件名/payload 需以真实样本锁定，避免臆测） |
| **D3 知识同步** | ① main 同步器（worker 化）：`GET /{id}/knowledge-packages` 清单 → hash 对比 → `:export-manifest`/`:download` ② 落盘 → 复用 `KnowledgeClient.addFile` 管线重建本地副本索引 ③ stale 标记 + 广场/对话 UI 提示 ④ 定时重试（`STAFFDECK_SYNC_INTERVAL`） | StaffDeck M3 | M3 端点交付后写 plan |
| **D4 技能 + MCP 工具** | ① zip 下载→解包 SKILL.md→`SkillServicePort.installImportedSkill` 适配器（装进 `digital-employee:<id>` 目录）② `staffdeck:*` 工具注册为 `type:'http'` MCP server（指向 `/api/v1/mcp`，Bearer 复用 ProviderConfig）③ 会话白名单补集逻辑不变 | StaffDeck M2（export-skill）+ M4（MCP 网关） | M2/M4 交付后写 plan；可选内置 `skills/staffdeck-api-*` 4 包 |
| **D5 回流上报** | ① SQLite 队列表（better-sqlite3，幂等 external_session_id）② `POST /external-sessions` + `events:batch` 组批上报（指数退避，409=已上报）③ 触点：local 会话每轮结束 ④ 设置开关（默认开，关闭留本地审计日志）⑤ STAFFDECK_API_KEY 迁 `SecretStore`（src/main/config/secretStore.ts） | StaffDeck M6 | M6 交付后写 plan |

D1 完成后 D2-D4 可并行派发；D5 最后。所有 D2-D5 任务共享 D1 的 ProviderConfig 与契约 fixture 模式。

## Plan 自审

- spec §3 契约 superset / §5.1 HTTP Provider / §6 降级 / §7 契约与 Provider 测试 / §8 D1 里程碑：覆盖于 Task 1、3、4。
- 新增「服务地址与凭据可在应用设置维护」：覆盖于 Task 2（设置导航、表单、连接测试、保存/清除、SecretStore、安全 IPC、热更新 provider）。
- D2 远端执行与 SSE、D3 知识同步、D4 技能/MCP、D5 审计回流：均作为明确后续独立计划骨架列出；当前 D1 不提前实现未交付协议。
- 安全约束：API Key 不进入 renderer state/通用 config entries/日志；URL 禁止 userinfo；safeStorage 不可用时拒绝保存；测试连接用临时实例；配置保存后不要求重启。
- 文档无 TBD/TODO 等占位项；协议不确定的 `external_user_id` header 名明确标出需按 StaffDeck OpenAPI 联调确认，不把猜测当作锁定契约。

---

## 实施结果（D1 完成记录）

**提交**（分支 `202610211551`，5 个提交）：

| 提交 | 内容 |
|---|---|
| `9334911a` | 契约扩展：`executionMode`/`configHash`/`skills`/`knowledgePackagesUrl` + list `degraded`/`source` |
| `ad4086f5` | `HttpDigitalEmployeeProvider`（Bearer/ETag/zod 校验）+ `ResilientDigitalEmployeeProvider` + `providerFactory` |
| `628c794d` | 设置页 + 四个专用 settings route + SecretStore 密钥安全 + store 状态 + 广场横幅 + 20 locale |
| `4233e1a6` | spec 与 plan 文档 |
| `0f62c44b` | 修复 save 中途失败的普通设置回滚（见下） |

**实施中修正的两个问题**（均已修复并有测试覆盖）：

1. **任务依赖顺序**：Task 2 依赖 Task 3 的 holder 与 Task 4 的事件，实际按 Task 1 → 3 → 2 → 4 执行。
2. **保存原子性缺陷**：原实现失败时只回滚密钥，`enabled`/`baseUrl`/`externalUserId` 已写入不回滚，会留下「已启用 + 新地址 + 旧密钥」的半更新配置，下次启动据此构造 Provider。现改为写入前快照三个普通键、失败时一并恢复（原本不存在的键用 `settings.delete` 删掉），新增 2 个用例覆盖「首次保存失败不留键」和「已有旧值恢复旧值」。

**验证**：

- 定向回归：13 文件 / **133 tests 全通过**（含设置路由 29 例）。
- `vue-tsc -p tsconfig.app.json --noEmit`：exit 0。`tsc -p tsconfig.node.json`：exit 0。
- oxlint 改动文件：0 warning / 0 error；oxfmt 格式检查通过。
- 全量 `test/main`（`vitest.config.ts`）：582 文件通过 / 49 文件失败（104 例）。**与 D1 无关**：失败集中在 `sessionPaths.test.ts`（断言 POSIX `\Users\...`，实际 `D:\Users\...`）、`systemPromptBuilder.test.ts`（env working directory `/tmp` vs `D:\tmp`）等 Windows 平台路径断言，这些文件在 `9ca022c2..HEAD` 零差异，且 D1 未触碰 `test/main/agent/**`。
- 全量 `test/renderer`（`vitest.config.renderer.ts`）：默认并发在本机 OOM（`Reached heap limit` / `Fatal process out of memory: Zone`），需 `--maxWorkers=2 --minWorkers=1`；降并发后 309 文件通过 / 5 文件失败（20 例），失败为 `providerStore` 的 `providerClient.getProviderGroups is not a function` 等既有问题（同样在基线上复现，与 D1 无关）。

**原"唯一开放项"已结案：`external_user_id` 对分发端点无需传递。**

联调前假设该值应以 `x-external-user-id` header 传给 `GET /api/v1/digital-employees`，需要确认 header / query / body 三种载体。跨仓库联调（真实 deepchat Provider → 真实 StaffDeck 服务）后的实测结论是：**分发端点完全不消费这个字段**，三种载体都不必改。

依据：

- 分发端点用 Bearer 凭证鉴权，租户由凭证反推（`auth.py::_api_key_principal`），与"谁在使用"无关。
- 全后端 `Header(...)` 只有 7 处：`If-None-Match` / `If-Match` / `Last-Event-ID`。**没有任何地方读取 `x-external-user-id`**。
- `external_user_id` 仅出现在 `POST /agents/{id}/sessions` 与 `POST /agents/{id}/runs*` 的 JSON body（`schemas.py:124`、`schemas.py:140`），且类型为 `str | None = None`，即**可选字段**。
- 实测：不带该 header 返回 200；带任意值、或两个不同用户值，响应 body（除 `fetchedAt`）与 ETag 完全一致，即该 header 是惰性的。

因此 D1 代码保持原样，`EXTERNAL_USER_ID_HEADER` 保留无害。真正的传递点在 **D2 远端执行**：届时把 `externalUserId` 放进 `POST /agents/{id}/runs:stream` 的 body，而不是 header。设置页保留该字段是为 D2 预留。

修复此项不需要改任何 TS 代码，仅更新本节结论即可。

**后续**：D2 已基于同一批源码核实结果写出独立计划 `docs/superpowers/plans/2026-10-23-staffdeck-d2-remote-execution.md`（含 SSE 帧格式、终止事件集合、`awaiting_input` 真实来源、`run.output.replace` 无产生点等 4 处 spec 偏差的修订）。
