# 企业托管服务商配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让企业通过一个 HTTP 接口按登录用户名下发服务商配置（地址 + API Key + 供应商类型 + 智能信息提取的模型与参数），客户端启动时拉取并固化：服务商「可见但禁用」，智能信息提取的模型「完全锁定」，用户仍可自由新增自己的服务商。

**Architecture:** 主进程新增 `src/main/managed/` 模块（领域类型 + HTTP client + 缓存 + 应用器），在 `composition.ts` 启动链中于 provider 初始化之后、documents 迁移之前执行「拉取 → 缓存 → 应用」。托管服务商按项目既有的**多实例模式**写入：新建独立 provider 实例（id = `managed-<key>`），`baseProviderId` 指向该供应商类型对应的内置条目（如 `new-api`），因此同一个服务商可以存在多个配置实例。托管 id 集合另存一个 settings 键用于**写保护**与 UI 锁定，不新增数据库列。智能信息提取解析链改为「托管优先」。

**Tech Stack:** Electron 主进程（TypeScript、zod、全局 fetch）、设置持久化 `getSetting/setSetting`、typed IPC 契约（`src/shared/contracts/routes/`）、Vue 3 + pinia 渲染端、Vitest（main 需 Electron 运行时）+ Vue Test Utils、vue-i18n 20 locale。

---

## 设计契约（含在 plan 内，服务端待建）

### 1. HTTP 接口契约

**端点来源优先级**：环境变量 `DEEPCHAT_MANAGED_CONFIG_URL` > 未配置则跳过托管流程（个人用户路径完全不变）。

```
GET {endpoint}?username=<urlencoded>&domain=<urlencoded>&hostname=<urlencoded>&sid=<urlencoded>
Headers:
  Accept: application/json
  X-DeepChat-Client: <app version>
  X-DeepChat-Device-Id: <sid>
```

成功响应 `200 application/json`（示例以 `new-api` 网关为默认供应商类型）：

```json
{
  "version": 1,
  "defaultProviderKey": "corp-gw",
  "providers": [
    {
      "key": "corp-gw",
      "name": "企业网关",
      "apiType": "new-api",
      "baseUrl": "https://gw.corp.example.com",
      "apiKey": "sk-corp-xxxx",
      "enabled": true,
      "instanceLabel": "企业网关"
    }
  ],
  "agentModels": {
    "chat": "deepseek-v3",
    "assistant": "gpt-4o-mini",
    "vision": "gpt-4o",
    "imageGeneration": "gpt-image-2"
  },
  "documents": {
    "textModel": { "providerKey": "corp-gw", "modelId": "deepseek-v3", "endpointType": "openai" },
    "visionModel": { "providerKey": "corp-gw", "modelId": "gpt-4o", "endpointType": "openai" },
    "concurrency": 4,
    "temperature": null,
    "maxTokens": null
  }
}
```

字段语义：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `providers[].key` | 是 | 服务端稳定业务 key，仅允许 `[A-Za-z0-9._-]`；本地映射为 provider id `managed-<key>` |
| `providers[].name` | 是 | 服务商显示名 |
| `providers[].apiType` | 是 | **供应商类型**，取值必须命中内置服务商列表的 `apiType`（见 §1.2）；默认场景为 `new-api`。未命中则该条被跳过并记日志 |
| `providers[].baseUrl` | 是 | 服务商地址。按该类型的既有约定填写——`new-api` 不带 `/v1` 后缀（内置默认值为 `https://www.newapi.ai`），路径由客户端按 endpointType 拼接 |
| `providers[].apiKey` | 是 | API Key。渲染端已有 UI 脱敏（只显示 `••••••••` + 末 4 位），无需额外处理 |
| `providers[].enabled` | 否 | 默认 `true`；`false` 时写入但停用（用户仍不可启用） |
| `providers[].instanceLabel` | 否 | 同类型多实例的区分标签，缺省用 `name` |
| `defaultProviderKey` | 否 | `agentModels` 匹配时的**优先级锚点**（不是强制归属，匹配不到仍会去其它托管 provider 找）；缺省用 `providers[0].key`。见 §1.4 |
| `agentModels` | 否 | 内置 Agent 设置页「模型默认值」四项，**只下发模型 id 字符串**（不下发 provider、不下发推理参数）。归属 provider 由「哪个托管 provider 的模型列表包含该 id」匹配得出，锚点 provider 优先。**仅作默认值预填**，用户改过后不再覆盖（见 §1.4） |
| `agentModels.chat` / `.assistant` / `.vision` / `.imageGeneration` | 否 | 各自的模型 id，如 `"deepseek-v3"`；缺省则该字段不预填 |
| `documents` | 否 | 智能信息提取的文本/视觉模型与推理参数，**完全锁定**；为 `null`/缺省表示该企业不锁定此项 |
| `documents.textModel` / `.visionModel` | 否 | `{ providerKey, modelId, endpointType? }`；`providerKey` 必须命中 `providers[].key`，未命中则该项按 `null` 处理 |
| `documents.concurrency` | 否 | 1–10，越界收敛到边界；缺省沿用用户值 |
| `documents.temperature` / `.maxTokens` | 否 | 字段**存在且为数字**时覆盖为用户该值；**为 `null` 或缺省**时一律表示「用 provider 默认」并清空用户值。注意：归一化后无法区分「显式 null」与「字段缺省」，两者行为相同（Task 5 已按此实现并由测试固定） |

**不下发的内容（明确）**：模型清单（由客户端实时从 provider 拉取）、`providers[].defaultModelId`、Agent 四项模型的 provider 归属与推理参数（只给 id）。

**状态码语义**：
- `200` → 应用配置，进入托管模式
- `204` / `404` → 该用户名无托管配置，退出托管模式（清除本地托管配置与 id 集合，用户恢复自由配置）
- `401` / `403` → 鉴权失败，退出托管模式并记录日志（不阻断启动）
- 网络错误 / `5xx` / JSON 解析失败 → **保留本地缓存与托管模式**（离线可用），记录日志

### 1.1 `endpointType` 为什么可选且只出现在 `documents`

`new-api` 是多协议聚合网关：同一模型 id 在不同协议下走不同路径，项目里由模型的 `endpointType` / `supportedEndpointTypes` 表达，取值域为 `NEW_API_ENDPOINT_TYPES`（`src/shared/model.ts:20`）：

```
openai | openai-response | anthropic | gemini | image-generation | video-generation
```

`ModelConfigDialog.vue` 对 `new-api` 专门渲染 endpoint 选择器。因此：

- 托管下发 `documents` 的模型引用时，**可以**带 `endpointType` 明确协议；不带时由客户端从实时拉取的模型列表推断（`new-api` 模型自带 `supportedEndpointTypes`，缺省取 `openai`）
- 写入 `documents.textModel` / `visionModel` 时，`endpointType` 为**可选第三字段**：有则一并写入，无则省略（与既有 `documents.*` 键形状向后兼容）
- 托管 provider 本身不需要 `endpointType`（那是模型级概念），只需要 `apiType`

### 1.2 供应商类型校验来源（修正）

项目里**没有 `ProviderType` 枚举**——`LLM_PROVIDER.apiType` 是 `string`（`src/shared/types/provider.ts:78`），有效值的唯一来源是内置服务商注册表 `DEFAULT_PROVIDERS`（`src/main/provider/defaults.ts:63`，其中 `new-api` 条目见 `defaults.ts:373`）。因此：

```ts
// 允许的供应商类型 = 内置注册表的 apiType 集合
const knownProviderTypes = DEFAULT_PROVIDERS.map((provider) => provider.apiType)

// apiType → 内置 provider id（用于写入 baseProviderId，实现多实例归属）
const builtinIdByApiType = Object.fromEntries(
  DEFAULT_PROVIDERS.map((provider) => [provider.apiType, provider.id])
)
```

`new-api` 的 `apiType` 与内置 `id` 同名（均为 `new-api`），故托管实例的 `baseProviderId` 为 `new-api`。

### 1.3 多实例写入方式（复用既有机制）

项目已支持「同一个服务商多个配置项」：`LLM_PROVIDER` 的 `baseProviderId` 表示逻辑家族归属，`instanceLabel` 是实例展示名，UI 用 `baseProviderId ?? id` 作为分组键（`src/shared/types/provider.ts:90-105`）。

托管实例写入字段：

| 字段 | 值 |
| --- | --- |
| `id` | `managed-<key>`（如 `managed-corp-gw`） |
| `baseProviderId` | 该 `apiType` 对应的内置 provider id（`new-api` → `new-api`） |
| `instanceLabel` | `providers[].instanceLabel ?? providers[].name` |
| `name` / `apiType` / `baseUrl` / `apiKey` | 直接取下发值 |
| `enable` | `providers[].enabled ?? true` |
| `custom` | `false`（避免 UI 因 `custom` 放开 baseUrl 编辑；实现时须核对 `custom` 对 `ProviderApiConfig.vue:328-333`、`providerStore` 分组展示的其它影响） |

**不接管内置条目**：内置 `new-api`（`enable: false` 的官方 newapi.ai 条目）保持原样不动，托管项是它的一个独立实例。因此设置页的 `new-api` 分组下会同时出现「官方条目」与「企业托管实例」，这与项目既有的多实例展示一致。

### 1.4 `agentModels` 的 id 归属解析与「默认值跟随」语义

Agent 设置页「模型默认值」四项实际写入的是**内置 Agent（id = `deepchat`）的配置**（`DeepChatAgentConfig`，经 `agentSettings.updateDeepChatAgent(BUILTIN_DEEPCHAT_AGENT_ID, {...})` 持久化），字段类型是 `ModelSelectionSchema = { providerId, modelId }`（`src/shared/contracts/domainSchemas.ts:32`，**不含 endpointType**）：

| 接口字段 | agent config 字段 | 界面文案 |
| --- | --- | --- |
| `agentModels.chat` | `defaultModelPreset` | 默认对话模型 |
| `agentModels.assistant` | `assistantModel` | 助手模型 |
| `agentModels.vision` | `visionModel` | 视觉模型 |
| `agentModels.imageGeneration` | `imageGenerationModel` | 图像生成模型 |

因为只下发模型 id（字符串），归属 provider 由**模型列表匹配**得出，而不是猜：

1. 启动时先对本次下发的每个托管 provider 主动拉取一次模型列表（`providerRuntime.refreshModels(providerId)`，复用既有刷新机制；逐个 best-effort，单个失败只记日志、不阻断，也不影响其它 provider）
2. 然后按 id 在各托管 provider 的模型列表中匹配，**优先级顺序**：锚点 provider（`defaultProviderKey` 命中的，缺省 `providers[0]`）排在最前，其余按下发 `providers` 数组顺序
3. 第一个「模型列表包含该 id」的 provider 即为命中项，写入 `{ providerId: <该托管实例的本地 id>, modelId: <下发的 id> }`
4. **都没命中**（id 不在任何托管 provider 的模型列表中）→ 跳过该字段，保持用户当前值，记 warning 与日志（便于服务端排查 id 写错）
5. 因此 `defaultProviderKey` 是「匹配优先级锚点」而非「强制归属」；只在下发的托管 provider 之间匹配，用户自建的 provider 不参与
6. 匹配发生在模型列表拉取之后，所以启动时会多一次网关 `/models` 请求（离线/失败时模型列表可能为空 → 全部跳过，用户当前值不受影响）
7. `new-api` 的 agent 侧模型走哪个协议（`endpointType`）由模型配置本身承载，不在 preset 里，故无需下发

**语义（默认值跟随，用户优先）**：托管值只作默认值预填，不锁定。每次成功下发后按下述规则逐字段决定是否写入：

1. 当前 agent 值为空 → 写入托管值
2. 当前 agent 值 == 上次写入的托管值（说明用户没改过）→ 用新托管值覆盖（跟随企业变更）
3. 当前 agent 值 != 上次写入的托管值（说明用户改过，例如换成了自有 provider 的模型）→ **保持用户值**，不覆盖

为判定规则 2/3，需记录「上次写入的托管值」，存 settings 键 `managed.agentModelApplied`。

注意：不写全局 `defaultModel` / `assistantModel` settings 键（旧的 `DefaultModelSettingsSection.vue` 已无引用，属 zero-inbound 死路径），避免出现两个真相源。

### 2. 本地存储键（新增，均走既有 `getSetting/setSetting`）

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `managed.config` | `ManagedConfigPayload \| null` | 最近一次成功拉取并规范化后的配置 |
| `managed.meta` | `{ fetchedAt: number; username: string; endpoint: string } \| null` | 拉取元信息，用于设置页展示与排障 |
| `managed.providerIds` | `string[]` | 托管 provider 的本地 id 集合，**写保护与 UI 锁定的唯一依据** |
| `managed.agentModelApplied` | `Partial<Record<AgentModelKey, { providerId: string; modelId: string }>>` | 上一次写入内置 Agent 的托管模型值，用于判定「用户是否改过」（见 §1.4） |

不新增数据库列：`providers` 表沿用既有列（含 `capability_provider_id`、`provider_json`），托管身份由 `managed.providerIds` 表达。

### 3. 锁定语义汇总

| 位置 | 托管时的行为 |
| --- | --- |
| 服务商设置页 | 托管实例显示「由企业统一配置」徽章；名称/地址/API Key/类型输入框禁用；删除、复制、停用按钮隐藏 |
| 主进程 provider 写操作 | `update/add/remove/setById/reorder` 涉及托管 id 一律拒绝 |
| 智能信息提取模型页 | 整页只读（模型、并发、推理参数全部禁用），显示徽章与说明；无「保存」按钮 |
| 智能信息提取运行时 | 解析链**托管优先**：即便用户绕过 UI 写了 `documents.*` 键，运行时仍用托管值 |
| 内置 Agent 设置页「模型默认值」四项 | 每次成功下发后按 §1.4 的「默认值跟随，用户优先」规则逐字段预填：用户没改过则跟随企业变更，改过则保留用户值。页面本身不锁定 |
| 用户自定义 provider | 完全并存：可自由新增/编辑/删除，与托管实例互不影响（含同 `new-api` 类型的自有实例） |

### 4. 文件结构

**新建**
- `src/main/managed/types.ts` — 领域类型 + zod schema + `toLocalProviderId` 等纯函数
- `src/main/managed/client.ts` — HTTP 拉取与响应规范化
- `src/main/managed/store.ts` — 四个 settings 键的读写封装
- `src/main/managed/apply.ts` — 把 payload 应用到 providerSettings（多实例写入）
- `src/main/managed/applyAgentModels.ts` — 按模型列表匹配 id，并按「默认值跟随，用户优先」预填内置 Agent 的模型默认值
- `src/main/managed/index.ts` — 编排入口 `syncManagedConfig()`
- `src/shared/contracts/routes/managed.routes.ts` — 渲染端查询/刷新契约
- `src/renderer/api/ManagedClient.ts` — 渲染端 client
- `src/renderer/src/stores/managedStore.ts` — 渲染端状态
- `test/main/managed/*.test.ts`、`test/renderer/**/*.test.ts`（各 Task 内指定）

**修改**
- `src/main/app/composition.ts` — 启动链插入 `syncManagedConfig()`；documents 解析链托管优先
- `src/main/provider/routes.ts` — 写保护
- `src/shared/contracts/routes/providers.routes.ts` — provider 输出加 `managed: boolean`
- `src/shared/types/provider.ts` — `LLM_PROVIDER` 加可选 `managed?: boolean`
- `src/shared/contracts/routes/config.routes.ts` + `src/main/app/settingsRoutes.ts` — `managed.*` 只读键
- `src/renderer/settings/components/` 下的服务商设置页组件与 `DocumentsModelsSettings.vue`
- i18n：`settings.json`（20 locale）

---

## Task 1: 托管配置领域模型与 HTTP client（TDD）

**Files:**
- Create: `src/main/managed/types.ts`
- Create: `src/main/managed/client.ts`
- Test: `test/main/managed/client.test.ts`

**背景**：主进程测试须用 Electron 运行时；`test/setup.ts` 全局 mock 了 `fs`/`path`，新测试文件顶部需 `vi.unmock`；vitest main 别名 `@/` 映射 `src/main/`。

- [ ] **Step 1: 写失败测试**

```ts
// test/main/managed/client.test.ts
import { describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import { fetchManagedConfig, toLocalProviderId } from '@/managed/client'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

// 与内置注册表一致的类型集合（测试用最小集，避免耦合全部内置项）
const knownProviderTypes = ['openai', 'new-api', 'anthropic']
const builtinIdByApiType = { openai: 'openai', 'new-api': 'new-api', anthropic: 'anthropic' }

describe('toLocalProviderId', () => {
  it('prefixes and keeps safe characters', () => {
    expect(toLocalProviderId('corp-gw')).toBe('managed-corp-gw')
    expect(toLocalProviderId('a.b_c-1')).toBe('managed-a.b_c-1')
  })

  it('replaces unsafe characters with dash', () => {
    expect(toLocalProviderId('corp gw/主')).toBe('managed-corp-gw--')
  })
})

describe('fetchManagedConfig', () => {
  const device = { username: 'zhangsan', domain: 'CORP', hostname: 'PC-01', sid: 'S-1-5-21' }
  const base = { endpoint: 'https://cfg.corp/api', device, knownProviderTypes, builtinIdByApiType }

  it('normalizes a new-api provider into a managed instance', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [
          {
            key: 'corp-gw',
            name: '企业网关',
            apiType: 'new-api',
            baseUrl: 'https://gw.corp.example.com',
            apiKey: 'sk-x',
            enabled: true,
            instanceLabel: '企业网关'
          }
        ],
        documents: {
          textModel: { providerKey: 'corp-gw', modelId: 'deepseek-v3', endpointType: 'openai' },
          visionModel: { providerKey: 'corp-gw', modelId: 'gpt-4o' },
          concurrency: 4
        }
      })
    )
    const result = await fetchManagedConfig({ ...base, fetchImpl })
    expect(result.status).toBe('applied')
    expect(result.config?.providers[0]).toEqual({
      id: 'managed-corp-gw',
      key: 'corp-gw',
      name: '企业网关',
      apiType: 'new-api',
      baseProviderId: 'new-api',
      instanceLabel: '企业网关',
      baseUrl: 'https://gw.corp.example.com',
      apiKey: 'sk-x',
      enabled: true
    })
    expect(result.config?.documents).toEqual({
      textModel: { providerId: 'managed-corp-gw', modelId: 'deepseek-v3', endpointType: 'openai' },
      visionModel: { providerId: 'managed-corp-gw', modelId: 'gpt-4o' },
      concurrency: 4,
      temperature: null,
      maxTokens: null
    })
    const calledUrl = fetchImpl.mock.calls[0][0] as string
    expect(calledUrl).toContain('username=zhangsan')
    expect(calledUrl).toContain('domain=CORP')
  })

  it('defaults instanceLabel to name and enabled to true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [
          { key: 'k', name: '网关', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' }
        ]
      })
    )
    const result = await fetchManagedConfig({ ...base, fetchImpl })
    expect(result.config?.providers[0]).toMatchObject({
      instanceLabel: '网关',
      enabled: true,
      baseProviderId: 'new-api'
    })
  })

  it('keeps agentModels as bare model ids and records the anchor provider id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        defaultProviderKey: 'corp-gw',
        providers: [
          { key: 'other', name: 'Other', apiType: 'new-api', baseUrl: 'https://o', apiKey: 'k' },
          { key: 'corp-gw', name: '企业网关', apiType: 'new-api', baseUrl: 'https://gw', apiKey: 'sk' }
        ],
        agentModels: {
          chat: 'deepseek-v3',
          assistant: 'gpt-4o-mini',
          vision: 'gpt-4o',
          imageGeneration: 'gpt-image-2'
        }
      })
    )
    const result = await fetchManagedConfig({ ...base, fetchImpl })
    expect(result.config?.defaultProviderId).toBe('managed-corp-gw')
    expect(result.config?.agentModels).toEqual({
      chat: 'deepseek-v3',
      assistant: 'gpt-4o-mini',
      vision: 'gpt-4o',
      imageGeneration: 'gpt-image-2'
    })
  })

  it('omits empty agentModels entries and nulls the block when nothing is left', async () => {
    const partial = await fetchManagedConfig({
      ...base,
      fetchImpl: vi.fn().mockResolvedValue(
        jsonResponse({
          version: 1,
          providers: [{ key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' }],
          agentModels: { chat: 'm1', assistant: '', vision: null }
        })
      )
    })
    expect(partial.config?.agentModels).toEqual({ chat: 'm1' })

    const empty = await fetchManagedConfig({
      ...base,
      fetchImpl: vi.fn().mockResolvedValue(
        jsonResponse({
          version: 1,
          providers: [{ key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' }],
          agentModels: { chat: '', assistant: null }
        })
      )
    })
    expect(empty.config?.agentModels).toBeNull()
  })

  it('falls back to the first provider as the anchor when defaultProviderKey is missing or unknown', async () => {
    const body = (defaultProviderKey?: string) => ({
      version: 1,
      ...(defaultProviderKey ? { defaultProviderKey } : {}),
      providers: [
        { key: 'first', name: 'First', apiType: 'new-api', baseUrl: 'https://f', apiKey: 'k' },
        { key: 'second', name: 'Second', apiType: 'new-api', baseUrl: 'https://s', apiKey: 'k' }
      ]
    })

    const withoutAnchor = await fetchManagedConfig({
      ...base,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(body()))
    })
    expect(withoutAnchor.config?.defaultProviderId).toBe('managed-first')

    const unknownAnchor = await fetchManagedConfig({
      ...base,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(body('nope')))
    })
    expect(unknownAnchor.config?.defaultProviderId).toBe('managed-first')
    expect(unknownAnchor.warnings.some((w) => w.includes('defaultProviderKey not found'))).toBe(true)
  })

  it('keeps the agentModels ids even when no provider survives normalization', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [
          { key: 'bad', name: 'Bad', apiType: 'not-a-real-type', baseUrl: 'https://b', apiKey: 'k' }
        ],
        agentModels: { chat: 'm1' }
      })
    )
    const result = await fetchManagedConfig({ ...base, fetchImpl })
    expect(result.config?.providers).toEqual([])
    expect(result.config?.agentModels).toEqual({ chat: 'm1' })
    expect(result.config?.defaultProviderId).toBeNull()
  })

  it('returns absent on 404 and 204', async () => {
    const notFound = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    expect((await fetchManagedConfig({ ...base, fetchImpl: notFound })).status).toBe('absent')
    const noContent = vi.fn().mockResolvedValue(new Response('', { status: 204 }))
    expect((await fetchManagedConfig({ ...base, fetchImpl: noContent })).status).toBe('absent')
  })

  it('returns denied on 401/403', async () => {
    const denied = vi.fn().mockResolvedValue(new Response('', { status: 403 }))
    expect((await fetchManagedConfig({ ...base, fetchImpl: denied })).status).toBe('denied')
  })

  it('returns unavailable on network error, 5xx and invalid json', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    expect((await fetchManagedConfig({ ...base, fetchImpl: boom })).status).toBe('unavailable')
    const five = vi.fn().mockResolvedValue(new Response('oops', { status: 502 }))
    expect((await fetchManagedConfig({ ...base, fetchImpl: five })).status).toBe('unavailable')
    const badJson = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }))
    expect((await fetchManagedConfig({ ...base, fetchImpl: badJson })).status).toBe('unavailable')
  })

  it('drops providers with unknown apiType or missing required fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [
          { key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' },
          { key: 'bad-type', name: 'X', apiType: 'not-a-real-type', baseUrl: 'https://b', apiKey: 'k' },
          { key: 'no-url', name: 'Y', apiType: 'new-api', apiKey: 'k' }
        ]
      })
    )
    const result = await fetchManagedConfig({ ...base, fetchImpl })
    expect(result.config?.providers.map((p) => p.key)).toEqual(['ok'])
    expect(result.warnings.some((w) => w.includes('not-a-real-type'))).toBe(true)
  })

  it('ignores documents refs whose providerKey is unknown', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [{ key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' }],
        documents: {
          textModel: { providerKey: 'missing', modelId: 'm' },
          visionModel: { providerKey: 'ok', modelId: 'm2' }
        }
      })
    )
    const result = await fetchManagedConfig({ ...base, fetchImpl })
    expect(result.config?.documents?.textModel).toBeNull()
    expect(result.config?.documents?.visionModel).toEqual({
      providerId: 'managed-ok',
      modelId: 'm2'
    })
  })

  it('drops invalid endpointType from a model ref', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [{ key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' }],
        documents: {
          textModel: { providerKey: 'ok', modelId: 'm', endpointType: 'not-a-real-endpoint' },
          visionModel: { providerKey: 'ok', modelId: 'm2', endpointType: 'anthropic' }
        }
      })
    )
    const result = await fetchManagedConfig({ ...base, fetchImpl })
    expect(result.config?.documents?.textModel).toEqual({
      providerId: 'managed-ok',
      modelId: 'm'
    })
    expect(result.config?.documents?.visionModel).toEqual({
      providerId: 'managed-ok',
      modelId: 'm2',
      endpointType: 'anthropic'
    })
  })

  it('clamps documents concurrency into 1-10', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [{ key: 'ok', name: 'OK', apiType: 'new-api', baseUrl: 'https://a', apiKey: 'k' }],
        documents: {
          textModel: { providerKey: 'ok', modelId: 'm' },
          visionModel: { providerKey: 'ok', modelId: 'm2' },
          concurrency: 99
        }
      })
    )
    const result = await fetchManagedConfig({ ...base, fetchImpl })
    expect(result.config?.documents?.concurrency).toBe(10)
  })

  it('skips the request entirely when endpoint is empty', async () => {
    const fetchImpl = vi.fn()
    const result = await fetchManagedConfig({ ...base, endpoint: '', fetchImpl })
    expect(result.status).toBe('skipped')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run（PowerShell）:
```
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/managed/client.test.ts --config vitest.config.ts
```
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/main/managed/types.ts`**

```ts
import { z } from 'zod'
import { NEW_API_ENDPOINT_TYPES, type NewApiEndpointType } from '@shared/model'

const PROVIDER_KEY_PATTERN = /^[A-Za-z0-9._-]+$/

export const ManagedProviderSpecSchema = z.object({
  key: z.string().regex(PROVIDER_KEY_PATTERN),
  name: z.string().min(1),
  apiType: z.string().min(1),
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  enabled: z.boolean().optional(),
  instanceLabel: z.string().min(1).optional()
})

export const ManagedModelRefSchema = z.object({
  providerKey: z.string().regex(PROVIDER_KEY_PATTERN),
  modelId: z.string().min(1),
  endpointType: z.enum(NEW_API_ENDPOINT_TYPES).optional()
})

export const ManagedDocumentsSchema = z.object({
  textModel: ManagedModelRefSchema.nullish(),
  visionModel: ManagedModelRefSchema.nullish(),
  concurrency: z.number().nullish(),
  temperature: z.number().nullish(),
  maxTokens: z.number().nullish()
})

/** 只下发模型 id 字符串；归属 provider 由 defaultProviderKey / providers[0] 决定 */
export const ManagedAgentModelsSchema = z.object({
  chat: z.string().min(1).nullish(),
  assistant: z.string().min(1).nullish(),
  vision: z.string().min(1).nullish(),
  imageGeneration: z.string().min(1).nullish()
})

export const ManagedConfigPayloadSchema = z.object({
  version: z.number().int().positive(),
  defaultProviderKey: z.string().min(1).optional(),
  providers: z.array(ManagedProviderSpecSchema),
  agentModels: ManagedAgentModelsSchema.nullish(),
  documents: ManagedDocumentsSchema.nullish()
})

export type ManagedProviderSpec = z.infer<typeof ManagedProviderSpecSchema>

/** 规范化后的托管服务商（已解析出本地 id 与 baseProviderId） */
export interface ManagedProvider {
  /** 本地 provider id，形如 managed-corp-gw */
  id: string
  /** 服务端业务 key，用于回显与排障 */
  key: string
  name: string
  /** 供应商类型，如 new-api */
  apiType: string
  /** 该供应商类型对应的内置 provider id，用于多实例归属 */
  baseProviderId: string | null
  instanceLabel: string
  baseUrl: string
  apiKey: string
  enabled: boolean
}

export interface ManagedModelRef {
  providerId: string
  modelId: string
  /** 仅 new-api 等聚合网关需要；缺省由客户端按实时模型列表推断 */
  endpointType?: NewApiEndpointType
}

export interface ManagedDocumentsConfig {
  textModel: ManagedModelRef | null
  visionModel: ManagedModelRef | null
  concurrency: number | null
  temperature: number | null
  maxTokens: number | null
}

export const AGENT_MODEL_KEYS = ['chat', 'assistant', 'vision', 'imageGeneration'] as const

export type AgentModelKey = (typeof AGENT_MODEL_KEYS)[number]

/** 托管模型键 → 内置 Agent 配置字段名（见契约 §1.4） */
export const MANAGED_AGENT_MODEL_FIELDS: Record<AgentModelKey, string> = {
  chat: 'defaultModelPreset',
  assistant: 'assistantModel',
  vision: 'visionModel',
  imageGeneration: 'imageGenerationModel'
}

/** 下发来的 agent 模型 id（未解析 provider，靠模型列表匹配确定归属） */
export type ManagedAgentModelIds = Partial<Record<AgentModelKey, string>>

/** 匹配落地后的 agent 模型值（已确定 providerId） */
export type ManagedAgentModels = Record<AgentModelKey, ManagedModelRef | null>

export interface ManagedConfigPayload {
  version: number
  providers: ManagedProvider[]
  /**
   * agentModels 匹配时的优先级锚点（由下发的 defaultProviderKey 解析出的本地 provider id）；
   * null 表示缺省用 providers[0]
   */
  defaultProviderId: string | null
  /** 下发的 agent 模型 id；未命中的 id 在应用阶段被跳过（见契约 §1.4） */
  agentModels: ManagedAgentModelIds | null
  documents: ManagedDocumentsConfig | null
}

export interface ManagedConfigMeta {
  fetchedAt: number
  username: string
  endpoint: string
}

export type SyncStatus = 'applied' | 'absent' | 'denied' | 'unavailable' | 'skipped'

export interface SyncResult {
  status: SyncStatus
  config: ManagedConfigPayload | null
  /** 丢弃原因（未知 apiType / 未知 providerKey / 非法 endpointType），用于日志 */
  warnings: string[]
}

export const MANAGED_PROVIDER_ID_PREFIX = 'managed-'

export function toLocalProviderId(key: string): string {
  return `${MANAGED_PROVIDER_ID_PREFIX}${key.replace(/[^A-Za-z0-9._-]/g, '-')}`
}

export function clampManagedConcurrency(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(10, Math.max(1, Math.round(value)))
}
```

- [ ] **Step 4: 实现 `src/main/managed/client.ts`**

```ts
import { isNewApiEndpointType, type NewApiEndpointType } from '@shared/model'
import {
  AGENT_MODEL_KEYS,
  ManagedConfigPayloadSchema,
  clampManagedConcurrency,
  toLocalProviderId,
  type ManagedAgentModelIds,
  type ManagedConfigPayload,
  type ManagedDocumentsConfig,
  type ManagedModelRef,
  type ManagedProvider,
  type SyncResult
} from './types'

export interface ManagedDeviceInfo {
  username: string
  domain: string
  hostname: string
  sid: string
}

export interface FetchManagedConfigOptions {
  endpoint: string
  device: ManagedDeviceInfo
  /** 内置注册表的 apiType 集合（DEFAULT_PROVIDERS.map(p => p.apiType)） */
  knownProviderTypes: readonly string[]
  /** apiType → 内置 provider id 的映射，用于写入 baseProviderId */
  builtinIdByApiType: Record<string, string>
  clientVersion?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 8000

function buildUrl(endpoint: string, device: ManagedDeviceInfo): string {
  const url = new URL(endpoint)
  url.searchParams.set('username', device.username)
  url.searchParams.set('domain', device.domain)
  url.searchParams.set('hostname', device.hostname)
  url.searchParams.set('sid', device.sid)
  return url.toString()
}

function normalizeModelRef(
  raw: unknown,
  localIdByKey: Map<string, string>,
  warnings: string[]
): ManagedModelRef | null {
  if (!raw || typeof raw !== 'object') return null
  const ref = raw as { providerKey?: unknown; modelId?: unknown; endpointType?: unknown }
  if (typeof ref.providerKey !== 'string' || typeof ref.modelId !== 'string') return null

  const providerId = localIdByKey.get(ref.providerKey)
  if (!providerId) {
    warnings.push(`model ref references unknown providerKey: ${ref.providerKey}`)
    return null
  }

  let endpointType: NewApiEndpointType | undefined
  if (ref.endpointType !== undefined) {
    if (isNewApiEndpointType(ref.endpointType)) {
      endpointType = ref.endpointType
    } else {
      warnings.push(`invalid endpointType dropped: ${String(ref.endpointType)}`)
    }
  }

  return {
    providerId,
    modelId: ref.modelId,
    ...(endpointType ? { endpointType } : {})
  }
}

function normalizeDocuments(
  raw: Record<string, unknown> | null | undefined,
  localIdByKey: Map<string, string>,
  warnings: string[]
): ManagedDocumentsConfig | null {
  if (!raw) return null
  return {
    textModel: normalizeModelRef(raw.textModel, localIdByKey, warnings),
    visionModel: normalizeModelRef(raw.visionModel, localIdByKey, warnings),
    concurrency: clampManagedConcurrency(raw.concurrency as number | null | undefined),
    temperature: typeof raw.temperature === 'number' ? raw.temperature : null,
    maxTokens: typeof raw.maxTokens === 'number' ? raw.maxTokens : null
  }
}

function resolveAnchorProviderId(
  defaultProviderKey: string | undefined,
  localIdByKey: Map<string, string>,
  warnings: string[]
): string | null {
  if (defaultProviderKey) {
    const byKey = localIdByKey.get(defaultProviderKey)
    if (byKey) return byKey
    warnings.push(`defaultProviderKey not found, falling back to first provider: ${defaultProviderKey}`)
  }
  const first = localIdByKey.values().next()
  return first.done ? null : first.value
}

/** 只保留非空模型 id；归属 provider 由应用阶段的模型列表匹配决定（见契约 §1.4） */
function normalizeAgentModelIds(
  raw: Record<string, unknown> | null | undefined
): ManagedAgentModelIds | null {
  if (!raw) return null
  const result: ManagedAgentModelIds = {}
  let hasAny = false
  for (const key of AGENT_MODEL_KEYS) {
    const modelId = raw[key]
    if (typeof modelId === 'string' && modelId.length > 0) {
      result[key] = modelId
      hasAny = true
    }
  }
  return hasAny ? result : null
}

export async function fetchManagedConfig(
  options: FetchManagedConfigOptions
): Promise<SyncResult> {
  const { endpoint, device, clientVersion, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const warnings: string[] = []

  if (!endpoint) {
    return { status: 'skipped', config: null, warnings }
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(buildUrl(endpoint, device), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-DeepChat-Client': clientVersion ?? 'unknown',
        'X-DeepChat-Device-Id': device.sid
      },
      signal: controller.signal
    })

    if (response.status === 204 || response.status === 404) {
      return { status: 'absent', config: null, warnings }
    }
    if (response.status === 401 || response.status === 403) {
      return { status: 'denied', config: null, warnings }
    }
    if (!response.ok) {
      return { status: 'unavailable', config: null, warnings }
    }

    const json = (await response.json()) as unknown
    const parsed = ManagedConfigPayloadSchema.safeParse(json)
    if (!parsed.success) {
      return { status: 'unavailable', config: null, warnings: ['invalid payload shape'] }
    }

    const knownTypes = new Set(options.knownProviderTypes)
    const providers: ManagedProvider[] = []
    const localIdByKey = new Map<string, string>()

    for (const spec of parsed.data.providers) {
      if (!knownTypes.has(spec.apiType)) {
        warnings.push(`unknown apiType skipped: ${spec.apiType}`)
        continue
      }
      const id = toLocalProviderId(spec.key)
      localIdByKey.set(spec.key, id)
      providers.push({
        id,
        key: spec.key,
        name: spec.name,
        apiType: spec.apiType,
        baseProviderId: options.builtinIdByApiType[spec.apiType] ?? null,
        instanceLabel: spec.instanceLabel ?? spec.name,
        baseUrl: spec.baseUrl,
        apiKey: spec.apiKey,
        enabled: spec.enabled ?? true
      })
    }

    const config: ManagedConfigPayload = {
      version: parsed.data.version,
      providers,
      defaultProviderId: resolveAnchorProviderId(
        parsed.data.defaultProviderKey,
        localIdByKey,
        warnings
      ),
      agentModels: normalizeAgentModelIds(
        (parsed.data.agentModels ?? null) as Record<string, unknown> | null
      ),
      documents: normalizeDocuments(
        (parsed.data.documents ?? null) as Record<string, unknown> | null,
        localIdByKey,
        warnings
      )
    }

    return { status: 'applied', config, warnings }
  } catch {
    return { status: 'unavailable', config: null, warnings }
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: 同 Step 2
Expected: PASS（全部用例）

- [ ] **Step 6: 提交**

```bash
git add src/main/managed/types.ts src/main/managed/client.ts test/main/managed/client.test.ts
git commit -m "feat(managed): add managed config schema and client"
```

---

## Task 2: 托管配置缓存与应用器（TDD）

**Files:**
- Create: `src/main/managed/store.ts`
- Create: `src/main/managed/apply.ts`
- Create: `src/main/managed/applyAgentModels.ts`
- Test: `test/main/managed/apply.test.ts`
- Test: `test/main/managed/applyAgentModels.test.ts`

**背景**：`providerSettings` 是 `src/main/provider/settings.ts` 导出的类实例（composition.ts 中变量名 `providerSettings`）。应用器只通过其公开方法写 provider。**先读 `settings.ts` 找到「新增/更新单个 provider」的方法名与签名**（形如 `setProvider`/`addProvider`/`updateProvider`），并确认能否一次写入 `baseProviderId` / `instanceLabel` / `enable` / `custom` —— 若既有方法只支持部分字段，用「写入后再 update」的两步方式，**不要新增方法**。

- [ ] **Step 1: 写失败测试**

```ts
// test/main/managed/apply.test.ts
import { describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import { applyManagedConfig } from '@/managed/apply'
import type { ManagedConfigPayload } from '@/managed/types'

const payload = (overrides: Partial<ManagedConfigPayload> = {}): ManagedConfigPayload => ({
  version: 1,
  providers: [
    {
      id: 'managed-corp-gw',
      key: 'corp-gw',
      name: '企业网关',
      apiType: 'new-api',
      baseProviderId: 'new-api',
      instanceLabel: '企业网关',
      baseUrl: 'https://gw.corp.example.com',
      apiKey: 'sk-x',
      enabled: true
    }
  ],
  agentModels: null,
  documents: null,
  ...overrides
})

const createSettings = (existing: Array<Record<string, unknown>> = []) => {
  const store = [...existing]
  return {
    store,
    getProviders: vi.fn(() => store.map((p) => ({ ...p }))),
    setProvider: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const index = store.findIndex((p) => p.id === id)
      if (index >= 0) store[index] = { ...store[index], ...patch }
      else store.push({ id, ...patch })
    })
  }
}

describe('applyManagedConfig', () => {
  it('inserts a managed instance carrying baseProviderId and instanceLabel', async () => {
    const settings = createSettings()
    const ids = await applyManagedConfig(payload(), settings as never)
    expect(ids).toEqual(['managed-corp-gw'])
    expect(settings.setProvider).toHaveBeenCalledWith(
      'managed-corp-gw',
      expect.objectContaining({
        apiType: 'new-api',
        baseProviderId: 'new-api',
        instanceLabel: '企业网关',
        baseUrl: 'https://gw.corp.example.com',
        apiKey: 'sk-x',
        enable: true,
        custom: false
      })
    )
  })

  it('overwrites an existing managed instance (idempotent refresh)', async () => {
    const settings = createSettings([
      { id: 'managed-corp-gw', name: 'Old', baseUrl: 'https://old', apiKey: 'sk-old' }
    ])
    await applyManagedConfig(payload(), settings as never)
    const entry = settings.store.find((p) => p.id === 'managed-corp-gw') as Record<string, unknown>
    expect(entry.baseUrl).toBe('https://gw.corp.example.com')
    expect(entry.apiKey).toBe('sk-x')
  })

  it('does not touch the builtin new-api entry', async () => {
    const settings = createSettings([
      { id: 'new-api', name: 'New API', apiType: 'new-api', baseUrl: 'https://www.newapi.ai', apiKey: '', enable: false }
    ])
    await applyManagedConfig(payload(), settings as never)
    const builtin = settings.store.find((p) => p.id === 'new-api') as Record<string, unknown>
    expect(builtin.apiKey).toBe('')
    expect(builtin.enable).toBe(false)
    expect(settings.store).toHaveLength(2)
  })

  it('does not touch user providers', async () => {
    const settings = createSettings([
      { id: 'my-newapi', name: 'My Gateway', apiType: 'new-api', apiKey: 'sk-mine' }
    ])
    await applyManagedConfig(payload(), settings as never)
    const entry = settings.store.find((p) => p.id === 'my-newapi') as Record<string, unknown>
    expect(entry.apiKey).toBe('sk-mine')
  })

  it('writes enabled=false for disabled managed providers', async () => {
    const settings = createSettings()
    await applyManagedConfig(
      payload({ providers: [{ ...payload().providers[0], enabled: false }] }),
      settings as never
    )
    const entry = settings.store.find((p) => p.id === 'managed-corp-gw') as Record<string, unknown>
    expect(entry.enable).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run:
```
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/managed/apply.test.ts --config vitest.config.ts
```
Expected: FAIL

- [ ] **Step 3: 实现 `src/main/managed/store.ts`**

```ts
import { getSetting, setSetting } from '../config/settingsStore'
import type { ManagedAgentModels, ManagedConfigMeta, ManagedConfigPayload } from './types'

export const MANAGED_SETTINGS_KEYS = {
  config: 'managed.config',
  meta: 'managed.meta',
  providerIds: 'managed.providerIds',
  agentModelApplied: 'managed.agentModelApplied'
} as const

export interface ManagedConfigStore {
  readConfig(): ManagedConfigPayload | null
  writeConfig(config: ManagedConfigPayload | null): void
  readMeta(): ManagedConfigMeta | null
  writeMeta(meta: ManagedConfigMeta | null): void
  readProviderIds(): string[]
  writeProviderIds(ids: string[]): void
  /** 上一次写入内置 Agent 的托管模型值，用于判定「用户是否改过」（见契约 §1.4） */
  readAgentModelApplied(): Partial<ManagedAgentModels>
  writeAgentModelApplied(applied: Partial<ManagedAgentModels>): void
}

export function createManagedConfigStore(): ManagedConfigStore {
  return {
    readConfig: () => getSetting<ManagedConfigPayload | null>(MANAGED_SETTINGS_KEYS.config) ?? null,
    writeConfig: (config) => setSetting(MANAGED_SETTINGS_KEYS.config, config),
    readMeta: () => getSetting<ManagedConfigMeta | null>(MANAGED_SETTINGS_KEYS.meta) ?? null,
    writeMeta: (meta) => setSetting(MANAGED_SETTINGS_KEYS.meta, meta),
    readProviderIds: () => getSetting<string[]>(MANAGED_SETTINGS_KEYS.providerIds) ?? [],
    writeProviderIds: (ids) => setSetting(MANAGED_SETTINGS_KEYS.providerIds, ids),
    readAgentModelApplied: () =>
      getSetting<Partial<ManagedAgentModels>>(MANAGED_SETTINGS_KEYS.agentModelApplied) ?? {},
    writeAgentModelApplied: (applied) =>
      setSetting(MANAGED_SETTINGS_KEYS.agentModelApplied, applied)
  }
}
```

> 实现提示：确认 `src/main/config/settingsStore.ts` 导出的读写函数名（可能是 `getSetting/setSetting`，也可能需传入 store 实例）；按实际导出调整 import，其余逻辑不变。

- [ ] **Step 4: 实现 `src/main/managed/apply.ts`**

```ts
import type { ManagedConfigPayload } from './types'

export interface ManagedProviderWriter {
  getProviders(): Array<Record<string, unknown>>
  setProvider(id: string, patch: Record<string, unknown>): Promise<void> | void
}

/**
 * 把托管配置写入 provider 存储（多实例模式），返回本次托管的 provider id 列表。
 * 幂等：每次启动重复调用只覆盖托管实例，不触碰内置条目与用户自建 provider。
 */
export async function applyManagedConfig(
  config: ManagedConfigPayload,
  writer: ManagedProviderWriter
): Promise<string[]> {
  for (const provider of config.providers) {
    await writer.setProvider(provider.id, {
      id: provider.id,
      name: provider.name,
      apiType: provider.apiType,
      ...(provider.baseProviderId ? { baseProviderId: provider.baseProviderId } : {}),
      instanceLabel: provider.instanceLabel,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      enable: provider.enabled,
      custom: false
    })
  }
  return config.providers.map((provider) => provider.id)
}
```

- [ ] **Step 5: 写 `applyAgentModels` 失败测试**

```ts
// test/main/managed/applyAgentModels.test.ts
import { describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import { applyManagedAgentModels } from '@/managed/applyAgentModels'
import type { ManagedConfigPayload, ManagedProvider } from '@/managed/types'

const provider = (id: string, key = id): ManagedProvider => ({
  id,
  key,
  name: key,
  apiType: 'new-api',
  baseProviderId: 'new-api',
  instanceLabel: key,
  baseUrl: 'https://gw',
  apiKey: 'sk',
  enabled: true
})

const config = (overrides: Partial<ManagedConfigPayload> = {}): ManagedConfigPayload => ({
  version: 1,
  providers: [provider('managed-a'), provider('managed-b')],
  defaultProviderId: 'managed-a',
  agentModels: null,
  documents: null,
  ...overrides
})

const createLookup = (byProvider: Record<string, string[]>) => ({
  listModelIds: vi.fn(async (providerId: string) => byProvider[providerId] ?? [])
})

const createAgentSettings = (initial: Record<string, unknown> = {}) => {
  let current = { ...initial }
  return {
    getCurrent: () => current,
    api: {
      getDeepChatAgentConfig: vi.fn(async () => ({ ...current })),
      updateDeepChatAgent: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
        current = { ...current, ...patch }
        return current
      })
    }
  }
}

const createStore = (applied: Record<string, unknown> = {}) => {
  let stored = { ...applied }
  return {
    getApplied: () => stored,
    api: {
      readAgentModelApplied: () => stored as never,
      writeAgentModelApplied: (next: Record<string, unknown>) => {
        stored = next
      }
    }
  }
}

describe('applyManagedAgentModels', () => {
  it('selects the managed provider whose model list contains the id', async () => {
    const agent = createAgentSettings()
    const store = createStore()
    const lookup = createLookup({
      'managed-a': ['other-model'],
      'managed-b': ['deepseek-v3', 'gpt-4o']
    })
    await applyManagedAgentModels(
      config({ agentModels: { chat: 'deepseek-v3' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.api.updateDeepChatAgent).toHaveBeenCalledWith('deepchat', {
      defaultModelPreset: { providerId: 'managed-b', modelId: 'deepseek-v3' }
    })
  })

  it('prefers the anchor provider when several offer the same id', async () => {
    const agent = createAgentSettings()
    const store = createStore()
    const lookup = createLookup({
      'managed-a': ['deepseek-v3'],
      'managed-b': ['deepseek-v3']
    })
    await applyManagedAgentModels(
      config({ agentModels: { chat: 'deepseek-v3' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.api.updateDeepChatAgent).toHaveBeenCalledWith('deepchat', {
      defaultModelPreset: { providerId: 'managed-a', modelId: 'deepseek-v3' }
    })
  })

  it('falls back to provider order when the anchor does not offer the id', async () => {
    const agent = createAgentSettings()
    const store = createStore()
    const lookup = createLookup({ 'managed-a': ['nope'], 'managed-b': ['deepseek-v3'] })
    await applyManagedAgentModels(
      config({ agentModels: { chat: 'deepseek-v3' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.api.updateDeepChatAgent).toHaveBeenCalledWith('deepchat', {
      defaultModelPreset: { providerId: 'managed-b', modelId: 'deepseek-v3' }
    })
  })

  it('skips ids no managed provider offers and keeps the user value', async () => {
    const userPick = { providerId: 'my-newapi', modelId: 'my-model' }
    const agent = createAgentSettings({ visionModel: userPick })
    const store = createStore()
    const lookup = createLookup({ 'managed-a': [], 'managed-b': [] })
    const result = await applyManagedAgentModels(
      config({ agentModels: { vision: 'ghost-model' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.api.updateDeepChatAgent).not.toHaveBeenCalled()
    expect(agent.getCurrent().visionModel).toEqual(userPick)
    expect(result.warnings.some((w) => w.includes('ghost-model'))).toBe(true)
  })

  it('follows a new managed value when the user has not changed it', async () => {
    const agent = createAgentSettings({
      defaultModelPreset: { providerId: 'managed-a', modelId: 'old' }
    })
    const store = createStore({ chat: { providerId: 'managed-a', modelId: 'old' } })
    const lookup = createLookup({ 'managed-a': ['new'], 'managed-b': [] })
    await applyManagedAgentModels(
      config({ agentModels: { chat: 'new' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.getCurrent().defaultModelPreset).toEqual({
      providerId: 'managed-a',
      modelId: 'new'
    })
  })

  it('keeps the user value when it differs from the last applied managed value', async () => {
    const userPick = { providerId: 'my-newapi', modelId: 'my-model' }
    const agent = createAgentSettings({ visionModel: userPick })
    const store = createStore({ vision: { providerId: 'managed-a', modelId: 'v1' } })
    const lookup = createLookup({ 'managed-a': ['v2'], 'managed-b': [] })
    await applyManagedAgentModels(
      config({ agentModels: { vision: 'v2' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.getCurrent().visionModel).toEqual(userPick)
    expect(store.getApplied().vision).toEqual(userPick)
  })

  it('does nothing when the payload has no agentModels', async () => {
    const agent = createAgentSettings()
    const store = createStore()
    const lookup = createLookup({ 'managed-a': ['m1'] })
    const result = await applyManagedAgentModels(
      config({ agentModels: null }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.api.updateDeepChatAgent).not.toHaveBeenCalled()
    expect(lookup.listModelIds).not.toHaveBeenCalled()
    expect(result.applied).toEqual({})
  })

  it('does nothing when there is no managed provider to match against', async () => {
    const agent = createAgentSettings()
    const store = createStore()
    const lookup = createLookup({})
    const result = await applyManagedAgentModels(
      config({ providers: [], defaultProviderId: null, agentModels: { chat: 'm1' } }),
      agent.api as never,
      store.api as never,
      lookup as never,
      'deepchat'
    )
    expect(agent.api.updateDeepChatAgent).not.toHaveBeenCalled()
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 6: 运行确认失败**

Run:
```
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/managed/applyAgentModels.test.ts --config vitest.config.ts
```
Expected: FAIL

- [ ] **Step 7: 实现 `src/main/managed/applyAgentModels.ts`**

```ts
import {
  AGENT_MODEL_KEYS,
  MANAGED_AGENT_MODEL_FIELDS,
  type ManagedAgentModels,
  type ManagedConfigPayload,
  type ManagedModelRef
} from './types'

export interface ManagedAgentSettingsWriter {
  getDeepChatAgentConfig(agentId: string): Promise<Record<string, unknown> | null>
  updateDeepChatAgent(agentId: string, patch: Record<string, unknown>): Promise<unknown>
}

export interface ManagedAgentAppliedStore {
  readAgentModelApplied(): Partial<ManagedAgentModels>
  writeAgentModelApplied(applied: Partial<ManagedAgentModels>): void
}

/** 读取某 provider 当前可用的模型 id 列表（调用方接 providerSettings.getProviderModels） */
export interface ManagedProviderModelLookup {
  listModelIds(providerId: string): string[] | Promise<string[]>
}

export interface ApplyManagedAgentModelsResult {
  applied: Partial<ManagedAgentModels>
  warnings: string[]
}

function sameRef(a: unknown, b: unknown): boolean {
  if (!a || !b) return false
  const left = a as { providerId?: unknown; modelId?: unknown }
  const right = b as { providerId?: unknown; modelId?: unknown }
  return left.providerId === right.providerId && left.modelId === right.modelId
}

/** 匹配优先级：锚点 provider 最前，其余按下发顺序（见契约 §1.4） */
function orderedProviderIds(config: ManagedConfigPayload): string[] {
  const ids = config.providers.map((provider) => provider.id)
  const anchor = config.defaultProviderId
  if (!anchor || !ids.includes(anchor)) return ids
  return [anchor, ...ids.filter((id) => id !== anchor)]
}

/**
 * 按「模型列表匹配 + 默认值跟随、用户优先」把托管模型默认值写入内置 Agent 配置（见契约 §1.4）。
 * 匹配不到的 id 被跳过并记入 warnings，保持用户当前值。
 */
export async function applyManagedAgentModels(
  config: ManagedConfigPayload,
  agentSettings: ManagedAgentSettingsWriter,
  store: ManagedAgentAppliedStore,
  lookup: ManagedProviderModelLookup,
  agentId: string
): Promise<ApplyManagedAgentModelsResult> {
  const desiredIds = config.agentModels
  const warnings: string[] = []
  if (!desiredIds) {
    return { applied: store.readAgentModelApplied(), warnings }
  }

  const order = orderedProviderIds(config)
  const modelIdsByProvider = new Map<string, Set<string>>()
  for (const providerId of order) {
    modelIdsByProvider.set(providerId, new Set(await lookup.listModelIds(providerId)))
  }

  const resolved: ManagedAgentModels = {
    chat: null,
    assistant: null,
    vision: null,
    imageGeneration: null
  }
  for (const key of AGENT_MODEL_KEYS) {
    const modelId = desiredIds[key]
    if (!modelId) continue
    const providerId = order.find((id) => modelIdsByProvider.get(id)?.has(modelId))
    if (!providerId) {
      warnings.push(
        `agentModels.${key}: model id not offered by any managed provider, skipped: ${modelId}`
      )
      continue
    }
    resolved[key] = { providerId, modelId }
  }

  const current = (await agentSettings.getDeepChatAgentConfig(agentId)) ?? {}
  const applied: Partial<ManagedAgentModels> = { ...store.readAgentModelApplied() }
  const patch: Record<string, unknown> = {}

  for (const key of AGENT_MODEL_KEYS) {
    const target = resolved[key]
    if (!target) continue

    const field = MANAGED_AGENT_MODEL_FIELDS[key]
    const currentValue = current[field]
    const lastApplied = applied[key]

    if (!currentValue || sameRef(currentValue, lastApplied)) {
      // 未配置 或 用户没改过 → 写入（或跟随）托管值
      patch[field] = target
      applied[key] = target
    } else {
      // 用户改过 → 保留用户值，并记录以便下次仍不覆盖
      applied[key] = currentValue as ManagedModelRef
    }
  }

  if (Object.keys(patch).length > 0) {
    await agentSettings.updateDeepChatAgent(agentId, patch)
  }
  store.writeAgentModelApplied(applied)
  return { applied, warnings }
}
```

- [ ] **Step 8: 运行确认通过**

Run:
```
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/managed --config vitest.config.ts
```
Expected: PASS（apply / applyAgentModels 均通过）

- [ ] **Step 9: 提交**

```bash
git add src/main/managed/store.ts src/main/managed/apply.ts src/main/managed/applyAgentModels.ts test/main/managed/apply.test.ts test/main/managed/applyAgentModels.test.ts
git commit -m "feat(managed): add config store, provider and agent model appliers"
```

---

## Task 3: 启动编排 `syncManagedConfig`（TDD）

**Files:**
- Create: `src/main/managed/index.ts`
- Modify: `src/main/app/composition.ts`（启动链插入调用）
- Modify: `test/main/app/compositionBoundaries.test.ts`（边界断言）
- Test: `test/main/managed/sync.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// test/main/managed/sync.test.ts
import { describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import { syncManagedConfig } from '@/managed'
import type { ManagedConfigStore } from '@/managed/store'
import type { ManagedConfigPayload } from '@/managed/types'

const payload: ManagedConfigPayload = {
  version: 1,
  providers: [
    {
      id: 'managed-corp-gw',
      key: 'corp-gw',
      name: '企业网关',
      apiType: 'new-api',
      baseProviderId: 'new-api',
      instanceLabel: '企业网关',
      baseUrl: 'https://gw.corp.example.com',
      apiKey: 'sk-x',
      enabled: true
    }
  ],
  defaultProviderId: 'managed-corp-gw',
  agentModels: { chat: 'deepseek-v3' },
  documents: {
    textModel: { providerId: 'managed-corp-gw', modelId: 'deepseek-v3', endpointType: 'openai' },
    visionModel: { providerId: 'managed-corp-gw', modelId: 'gpt-4o' },
    concurrency: 4,
    temperature: null,
    maxTokens: null
  }
}

const createStore = (initial?: { config?: ManagedConfigPayload | null }) => {
  let config = initial?.config ?? null
  let meta: unknown = null
  let ids: string[] = []
  let agentModelApplied: Record<string, unknown> = {}
  const store: ManagedConfigStore = {
    readConfig: () => config,
    writeConfig: (next) => {
      config = next
    },
    readMeta: () => meta as never,
    writeMeta: (next) => {
      meta = next
    },
    readProviderIds: () => ids,
    writeProviderIds: (next) => {
      ids = next
    },
    readAgentModelApplied: () => agentModelApplied as never,
    writeAgentModelApplied: (next) => {
      agentModelApplied = next as Record<string, unknown>
    }
  }
  return { store, getConfig: () => config, getIds: () => ids, getMeta: () => meta }
}

const baseOptions = {
  endpoint: 'https://cfg',
  device: { username: 'u', domain: 'd', hostname: 'h', sid: 's' },
  knownProviderTypes: ['new-api'],
  builtinIdByApiType: { 'new-api': 'new-api' }
}

const appliedBody = {
  version: 1,
  providers: [
    { key: 'corp-gw', name: '企业网关', apiType: 'new-api', baseUrl: 'https://gw', apiKey: 'sk-x' }
  ]
}

describe('syncManagedConfig', () => {
  it('skips entirely when no endpoint configured', async () => {
    const store = createStore()
    const fetchImpl = vi.fn()
    const result = await syncManagedConfig({
      ...baseOptions,
      endpoint: '',
      store: store.store,
      writer: { getProviders: () => [], setProvider: vi.fn() } as never,
      fetchImpl
    })
    expect(result.status).toBe('skipped')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(store.getConfig()).toBeNull()
  })

  it('persists config, ids and meta on applied', async () => {
    const store = createStore()
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(appliedBody), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    const result = await syncManagedConfig({
      ...baseOptions,
      store: store.store,
      writer: { getProviders: () => [], setProvider: vi.fn(async () => {}) } as never,
      fetchImpl
    })
    expect(result.status).toBe('applied')
    expect(store.getIds()).toEqual(['managed-corp-gw'])
    expect(store.getConfig()?.providers).toHaveLength(1)
    expect(store.getMeta()).toMatchObject({ username: 'u', endpoint: 'https://cfg' })
  })

  it('keeps cached config and managed mode when fetch is unavailable', async () => {
    const store = createStore({ config: payload })
    const result = await syncManagedConfig({
      ...baseOptions,
      store: store.store,
      writer: { getProviders: () => [], setProvider: vi.fn(async () => {}) } as never,
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline'))
    })
    expect(result.status).toBe('unavailable')
    expect(store.getConfig()).toEqual(payload)
  })

  it('re-applies cached config when unavailable so instances survive a wiped db', async () => {
    const store = createStore({ config: payload })
    const setProvider = vi.fn(async () => {})
    await syncManagedConfig({
      ...baseOptions,
      store: store.store,
      writer: { getProviders: () => [], setProvider } as never,
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline'))
    })
    expect(setProvider).toHaveBeenCalledWith(
      'managed-corp-gw',
      expect.objectContaining({ apiKey: 'sk-x', baseProviderId: 'new-api' })
    )
  })

  it('clears managed state on absent', async () => {
    const store = createStore({ config: payload })
    const result = await syncManagedConfig({
      ...baseOptions,
      store: store.store,
      writer: { getProviders: () => [], setProvider: vi.fn() } as never,
      fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    })
    expect(result.status).toBe('absent')
    expect(store.getConfig()).toBeNull()
    expect(store.getIds()).toEqual([])
    expect(store.getMeta()).toBeNull()
  })

  it('clears managed state on denied', async () => {
    const store = createStore({ config: payload })
    const result = await syncManagedConfig({
      ...baseOptions,
      store: store.store,
      writer: { getProviders: () => [], setProvider: vi.fn() } as never,
      fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    })
    expect(result.status).toBe('denied')
    expect(store.getConfig()).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run:
```
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/managed/sync.test.ts --config vitest.config.ts
```
Expected: FAIL

- [ ] **Step 3: 实现 `src/main/managed/index.ts`**

```ts
import { fetchManagedConfig, type ManagedDeviceInfo } from './client'
import { applyManagedConfig, type ManagedProviderWriter } from './apply'
import { createManagedConfigStore, type ManagedConfigStore } from './store'
import type { SyncResult } from './types'

export { MANAGED_SETTINGS_KEYS, createManagedConfigStore } from './store'
export { toLocalProviderId } from './types'
export type { ManagedConfigPayload, ManagedConfigMeta, SyncStatus, SyncResult } from './types'

export interface SyncManagedConfigOptions {
  endpoint: string
  device: ManagedDeviceInfo
  store: ManagedConfigStore
  writer: ManagedProviderWriter
  knownProviderTypes: readonly string[]
  builtinIdByApiType: Record<string, string>
  clientVersion?: string
  fetchImpl?: typeof fetch
}

/**
 * 启动时的托管配置同步：拉取 → 缓存 → 应用。
 * 拉取失败保留缓存；服务端明确「无配置/拒绝」则清除托管态。
 */
export async function syncManagedConfig(
  options: SyncManagedConfigOptions
): Promise<SyncResult> {
  const { endpoint, device, store, writer } = options

  if (!endpoint) {
    return { status: 'skipped', config: store.readConfig(), warnings: [] }
  }

  const result = await fetchManagedConfig({
    endpoint,
    device,
    knownProviderTypes: options.knownProviderTypes,
    builtinIdByApiType: options.builtinIdByApiType,
    ...(options.clientVersion ? { clientVersion: options.clientVersion } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  })

  if (result.status === 'unavailable') {
    const cached = store.readConfig()
    if (cached) {
      // 缓存存在：重新应用一次，覆盖被清空或被改动过的托管实例
      const ids = await applyManagedConfig(cached, writer)
      store.writeProviderIds(ids)
    }
    return { status: 'unavailable', config: cached, warnings: result.warnings }
  }

  if (result.status === 'absent' || result.status === 'denied') {
    store.writeConfig(null)
    store.writeProviderIds([])
    store.writeMeta(null)
    return { status: result.status, config: null, warnings: result.warnings }
  }

  const config = result.config
  if (!config) {
    return { status: 'unavailable', config: store.readConfig(), warnings: result.warnings }
  }

  const ids = await applyManagedConfig(config, writer)
  store.writeConfig(config)
  store.writeProviderIds(ids)
  store.writeMeta({ fetchedAt: Date.now(), username: device.username, endpoint })
  return { status: 'applied', config, warnings: result.warnings }
}
```

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2 → Expected: PASS

- [ ] **Step 5: 在 composition.ts 启动链接线**

先读 `src/main/app/composition.ts` 找到 documents 迁移调用点（`migrateDocumentsModelSettings(providerSettings)`）与 provider 初始化位置。**必须插在 provider 初始化完成之后、documents 迁移之前**，这样 documents 迁移能读到已固化的托管 provider。同时确认 `DEFAULT_PROVIDERS` 的导入来源（`src/main/provider/defaults.ts`）。

在 `migrateDocumentsModelSettings(providerSettings)` 之前插入：

```ts
  // 企业托管配置：启动时按登录用户名拉取并固化（失败保留缓存）
  const managedStore = createManagedConfigStore()
  const managedResult = await syncManagedConfig({
    endpoint: resolveManagedConfigEndpoint(),
    device: toManagedDeviceInfo(await getDeviceInfo()),
    store: managedStore,
    writer: providerSettings,
    knownProviderTypes: getKnownProviderTypes(),
    builtinIdByApiType: getBuiltinIdByApiType(),
    clientVersion: app.getVersion()
  }).catch((error) => {
    console.warn('[managed] sync failed, continuing with cached state', error)
    return null
  })

  // 内置 Agent「模型默认值」四项：先拉取托管 provider 的模型列表，再按 id 匹配预填（见契约 §1.4）
  if (managedResult?.config) {
    const managedConfig = managedResult.config

    for (const provider of managedConfig.providers) {
      await providerRuntime.refreshModels(provider.id).catch((error) => {
        console.warn(`[managed] model refresh failed for ${provider.id}:`, error)
      })
    }

    await applyManagedAgentModels(
      managedConfig,
      agentSettings,
      managedStore,
      {
        listModelIds: (providerId) =>
          providerSettings.getProviderModels(providerId).map((model) => model.id)
      },
      BUILTIN_DEEPCHAT_AGENT_ID
    )
      .then(({ warnings }) => {
        for (const warning of warnings) console.warn(`[managed] ${warning}`)
      })
      .catch((error) => {
        console.warn('[managed] agent model prefill failed', error)
      })
  }
```

同文件补充三个本地辅助函数（放在模块级，imports 之后）：

```ts
function resolveManagedConfigEndpoint(): string {
  return process.env.DEEPCHAT_MANAGED_CONFIG_URL ?? ''
}

function toManagedDeviceInfo(info: Awaited<ReturnType<typeof getDeviceInfo>>): ManagedDeviceInfo {
  return {
    username: info.winAccount?.username ?? '',
    domain: info.winAccount?.domain ?? '',
    hostname: info.winAccount?.hostname ?? '',
    sid: info.winAccount?.sid ?? ''
  }
}

/** 允许的供应商类型 = 内置服务商注册表的 apiType 集合 */
function getKnownProviderTypes(): string[] {
  return DEFAULT_PROVIDERS.map((provider) => provider.apiType)
}

/** apiType → 内置 provider id，用于托管实例的 baseProviderId 归属 */
function getBuiltinIdByApiType(): Record<string, string> {
  return Object.fromEntries(DEFAULT_PROVIDERS.map((provider) => [provider.apiType, provider.id]))
}
```

> 实现提示：`getDeviceInfo()` 的返回结构以 `src/main/device/index.ts` 为准（必须含 `winAccount{username,domain,hostname,sid}`，非 Windows 平台该字段可能为空——空值时 `username` 为空串，接口调用仍可发出，由服务端决定是否返回配置）。`DEFAULT_PROVIDERS` 直接从 `src/main/provider/defaults.ts` 导入（composition.ts 很可能已导入 `PROVIDER_GROUPS` 或 `DEFAULT_PROVIDERS`，先检查）。`agentSettings`、`BUILTIN_DEEPCHAT_AGENT_ID`、`providerRuntime`、`providerSettings` 在 composition.ts 中均已存在，直接引用即可；**`providerRuntime` 在 composition.ts:1097 才创建，`applyManagedAgentModels` 那段必须放在它创建之后**（与 documents 迁移同区段即可）。`providerRuntime.refreshModels(providerId)` 是既有公开方法（`src/main/provider/index.ts:1039`），内部会先做 provider DB 同步再刷新模型并发 `MODEL_LIST_CHANGED`，因此**刷新后 `providerSettings.getProviderModels(providerId)` 即可读到最新列表**。imports 需补 `syncManagedConfig`、`createManagedConfigStore`、`applyManagedAgentModels`、`getDeviceInfo`、`ManagedDeviceInfo`、`DEFAULT_PROVIDERS`、`BUILTIN_DEEPCHAT_AGENT_ID`。

- [ ] **Step 6: 补 composition 边界断言 + 验证 + 提交**

在既有 `test/main/app/compositionBoundaries.test.ts` 中追加一条源码断言，防止后续重构把托管接线删掉（沿用该文件既有的源码文本断言模式；`compositionPath` / `readFileSync` 若已存在则复用，不要重复引入）：

```ts
it('wires managed config sync and agent model prefill before documents migration', () => {
  const source = readFileSync(compositionPath, 'utf8')
  expect(source).toContain('syncManagedConfig(')
  expect(source).toContain('applyManagedAgentModels(')
  expect(source).toContain('migrateDocumentsModelSettings(')
  expect(source.indexOf('syncManagedConfig(')).toBeLessThan(
    source.indexOf('migrateDocumentsModelSettings(')
  )
})
```

Run:
```
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/managed test/main/app --config vitest.config.ts
pnpm run typecheck:node
```
Expected: PASS

```bash
git add src/main/managed/index.ts test/main/managed/sync.test.ts src/main/app/composition.ts test/main/app/compositionBoundaries.test.ts
git commit -m "feat(managed): sync managed config on startup"
```

---

## Task 4: 主进程 provider 写保护

**Files:**
- Create: `src/main/provider/managedGuard.ts`
- Modify: `src/main/provider/routes.ts`
- Test: `test/main/provider/managedWriteGuard.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// test/main/provider/managedWriteGuard.test.ts
import { describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import { assertProviderWritable } from '@/provider/managedGuard'

describe('assertProviderWritable', () => {
  const readProviderIds = vi.fn(() => ['managed-corp-gw'])

  it('throws for managed provider on update', () => {
    expect(() => assertProviderWritable('managed-corp-gw', 'update', readProviderIds)).toThrow(
      /\[managed\.providerLocked:managed-corp-gw\]/
    )
  })

  it('throws for managed provider on remove', () => {
    expect(() => assertProviderWritable('managed-corp-gw', 'remove', readProviderIds)).toThrow(
      /\[managed\.providerLocked:managed-corp-gw\]/
    )
  })

  it('allows the builtin new-api entry', () => {
    expect(() => assertProviderWritable('new-api', 'update', readProviderIds)).not.toThrow()
  })

  it('allows user-created instances of the same apiType', () => {
    expect(() => assertProviderWritable('my-newapi', 'remove', readProviderIds)).not.toThrow()
    expect(() => assertProviderWritable('managed-corp-gw-2', 'remove', readProviderIds)).not.toThrow()
    expect(() => assertProviderWritable('MANAGED-CORP-GW', 'remove', readProviderIds)).not.toThrow()
  })

  it('allows everything when nothing is managed', () => {
    expect(() => assertProviderWritable('managed-corp-gw', 'update', () => [])).not.toThrow()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run:
```
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/provider/managedWriteGuard.test.ts --config vitest.config.ts
```
Expected: FAIL

- [ ] **Step 3: 实现 `src/main/provider/managedGuard.ts`**

```ts
export type ProviderWriteAction = 'update' | 'remove' | 'reorder'

export class ManagedProviderLockedError extends Error {
  constructor(readonly providerId: string) {
    super(
      `[managed.providerLocked:${providerId}] This provider is managed by your organization and cannot be changed.`
    )
    this.name = 'ManagedProviderLockedError'
  }
}

export function assertProviderWritable(
  providerId: string,
  _action: ProviderWriteAction,
  readManagedProviderIds: () => string[]
): void {
  if (readManagedProviderIds().includes(providerId)) {
    throw new ManagedProviderLockedError(providerId)
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2 → Expected: PASS

- [ ] **Step 5: 接入 routes.ts 写操作**

先读 `src/main/provider/routes.ts:214-364`（`providers.setById` / `update` / `add` / `remove` / `reorder` 实现）。对每个会修改**既有** provider 的 handler，在处理体最前面插入守卫：

```ts
    assertProviderWritable(providerId, 'update', () => createManagedConfigStore().readProviderIds())
```

具体位置：
- `update` / `setById`：以被修改的 `id` 调用，action `'update'`
- `remove`：以被删除的 `id` 调用，action `'remove'`
- `reorder`：对入参中的每个 id 逐个调用，action `'reorder'`（只校验托管项顺序不被改）
- `add`：若入参 id 命中托管集合则拒绝（防止伪造同 id 覆盖托管实例），action `'update'`

注意：**不要拦「新增同 apiType 的普通实例」**——用户仍可新建自己的 `new-api` 实例，这是需求明确要保留的。

imports 补：

```ts
import { assertProviderWritable } from './managedGuard'
import { createManagedConfigStore } from '../managed/store'
```

- [ ] **Step 6: 验证 + 提交**

Run:
```
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/provider --config vitest.config.ts
```
Expected: PASS（含既有 provider 测试不回归）

```bash
git add src/main/provider/managedGuard.ts src/main/provider/routes.ts test/main/provider/managedWriteGuard.test.ts
git commit -m "feat(managed): block writes to managed providers"
```

---

## Task 5: 智能信息提取模型「托管优先」解析

**Files:**
- Modify: `src/main/documents/modelSettings.ts`（新增托管优先解析辅助）
- Modify: `src/main/app/composition.ts`（解析链接入）
- Test: `test/main/documents/managedOverride.test.ts`

**契约要点**：`documents` 段为 `null` 表示企业未锁定该项，完全沿用用户设置；否则逐字段「托管值优先，字段级回退用户值」。`endpointType` 是模型引用的可选第三字段，解析时随模型引用一并透传。

- [ ] **Step 1: 写失败测试**

```ts
// test/main/documents/managedOverride.test.ts
import { describe, expect, it } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import { resolveDocumentsModelSettings } from '@/documents/modelSettings'
import type { ManagedConfigPayload } from '@/managed/types'

const userSettings = {
  textModel: { providerId: 'openai', modelId: 'gpt-4o-mini' },
  visionModel: { providerId: 'openai', modelId: 'gpt-4o' },
  concurrency: 6,
  temperature: 0.7,
  maxTokens: 1024
}

const managed: ManagedConfigPayload = {
  version: 1,
  providers: [],
  agentModels: null,
  documents: {
    textModel: {
      providerId: 'managed-corp-gw',
      modelId: 'deepseek-v3',
      endpointType: 'openai'
    },
    visionModel: { providerId: 'managed-corp-gw', modelId: 'corp-vision' },
    concurrency: 4,
    temperature: null,
    maxTokens: null
  }
}

describe('resolveDocumentsModelSettings', () => {
  it('uses user settings when nothing is managed', () => {
    expect(resolveDocumentsModelSettings(userSettings, null)).toEqual(userSettings)
  })

  it('managed models win and keep endpointType', () => {
    const resolved = resolveDocumentsModelSettings(userSettings, managed)
    expect(resolved.textModel).toEqual({
      providerId: 'managed-corp-gw',
      modelId: 'deepseek-v3',
      endpointType: 'openai'
    })
    expect(resolved.visionModel).toEqual({
      providerId: 'managed-corp-gw',
      modelId: 'corp-vision'
    })
  })

  it('managed concurrency and params win; null means provider default', () => {
    const resolved = resolveDocumentsModelSettings(userSettings, managed)
    expect(resolved.concurrency).toBe(4)
    expect(resolved.temperature).toBeNull()
    expect(resolved.maxTokens).toBeNull()
  })

  it('falls back per field when the managed field is null', () => {
    const partial: ManagedConfigPayload = {
      ...managed,
      documents: { ...managed.documents!, concurrency: null, temperature: 0.2 }
    }
    const resolved = resolveDocumentsModelSettings(userSettings, partial)
    expect(resolved.concurrency).toBe(6)
    expect(resolved.temperature).toBe(0.2)
  })

  it('keeps user value when the managed documents section is absent', () => {
    const resolved = resolveDocumentsModelSettings(userSettings, { ...managed, documents: null })
    expect(resolved).toEqual(userSettings)
  })

  it('falls back to the user model when the managed ref is null', () => {
    const partial: ManagedConfigPayload = {
      ...managed,
      documents: { ...managed.documents!, textModel: null }
    }
    const resolved = resolveDocumentsModelSettings(userSettings, partial)
    expect(resolved.textModel).toEqual(userSettings.textModel)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run:
```
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/managedOverride.test.ts --config vitest.config.ts
```
Expected: FAIL

- [ ] **Step 3: 实现 `resolveDocumentsModelSettings`**

在 `src/main/documents/modelSettings.ts` 末尾追加（复用该文件既有的 `DocumentsModelRef` 类型）：

```ts
import type { ManagedConfigPayload } from '../managed/types'

/**
 * 计算 documents 生效设置：托管值优先（企业锁定），字段级回退到用户值。
 * documents 段为 null 表示企业未锁定该项，完全沿用用户设置。
 */
export function resolveDocumentsModelSettings<T extends {
  textModel: DocumentsModelRef | null
  visionModel: DocumentsModelRef | null
  concurrency: number
  temperature: number | null
  maxTokens: number | null
}>(userSettings: T, managed: ManagedConfigPayload | null): T {
  const managedDocuments = managed?.documents
  if (!managedDocuments) return userSettings

  return {
    ...userSettings,
    textModel: managedDocuments.textModel ?? userSettings.textModel,
    visionModel: managedDocuments.visionModel ?? userSettings.visionModel,
    concurrency: managedDocuments.concurrency ?? userSettings.concurrency,
    temperature: managedDocuments.temperature ?? userSettings.temperature,
    maxTokens: managedDocuments.maxTokens ?? userSettings.maxTokens
  }
}
```

> 实现提示：若 `DocumentsModelRef` 目前不含可选 `endpointType`，给它补上 `endpointType?: NewApiEndpointType`（从 `@shared/model` 导入类型），保证托管模型引用携带的协议字段能一路透传到 provider 调用层；`readDocumentsModelSettings` 的 zod 校验若对未知字段做 strip，需同步放开该字段。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2 → Expected: PASS

- [ ] **Step 5: 在 composition.ts 接入**

在 `composition.ts` 中找到 documents 抽取器构建处与 `resolveVisionTarget` / `resolveTextTarget` / RecognitionTaskManager 并发注入处。**保留 `readDocumentsModelSettings(providerSettings)` 原调用不动**，只在其结果外层套一层托管优先解析。

在模块级（或工厂函数内一次性）读取托管配置并缓存为常量，避免每次解析都读盘：

```ts
  // 企业托管配置（启动时已同步落盘）；documents 解析链托管优先
  const managedDocumentsConfig = createManagedConfigStore().readConfig()
```

然后把每个消费点的

```ts
  const settings = readDocumentsModelSettings(providerSettings)
```

改为

```ts
  const settings = resolveDocumentsModelSettings(
    readDocumentsModelSettings(providerSettings),
    managedDocumentsConfig
  )
```

涉及消费点（逐一核对现场代码）：
1. `resolveVisionTarget` 内部读取 visionModel 处
2. `resolveTextTarget` 内部读取 textModel 处
3. RecognitionTaskManager 注入 `concurrency` 处
4. `generateCompletion` 实时读取 `temperature` / `maxTokens` 处（该处要求实时，故同样用 `resolveDocumentsModelSettings` 包裹实时读取结果）

imports 补：

```ts
import { createManagedConfigStore } from '../managed/store'
import { resolveDocumentsModelSettings } from '../documents/modelSettings'
```

- [ ] **Step 6: 验证 + 提交**

Run:
```
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents test/main/app --config vitest.config.ts
```
Expected: PASS（含既有 documents 205 用例不回归）

```bash
git add src/main/documents/modelSettings.ts src/main/app/composition.ts test/main/documents/managedOverride.test.ts
git commit -m "feat(managed): let managed config override documents models"
```

---

## Task 6: IPC 契约与渲染端 client

**Files:**
- Create: `src/shared/contracts/routes/managed.routes.ts`
- Modify: `src/shared/contracts/routes/index.ts`（注册新路由）
- Modify: `src/shared/types/provider.ts`（`LLM_PROVIDER` 加 `managed?: boolean`）
- Modify: `src/main/provider/routes.ts`（list/listSummaries 输出填充 managed）
- Modify: `src/main/app/settingsRoutes.ts`（注册 managed handler）
- Create: `src/renderer/api/ManagedClient.ts`
- Create: `src/renderer/src/stores/managedStore.ts`
- Test: `test/renderer/stores/managedStore.test.ts`

- [ ] **Step 1: 契约 `managed.routes.ts`**

```ts
import { z } from 'zod'
import { defineRoute } from '../defineRoute'

export const ManagedConfigStatusSchema = z.object({
  managed: z.boolean(),
  username: z.string(),
  endpoint: z.string(),
  fetchedAt: z.number().int().nullable(),
  providerIds: z.array(z.string()),
  documentsLocked: z.boolean()
})

export const managedRoutes = {
  getStatus: defineRoute({
    input: z.object({}).default({}),
    output: ManagedConfigStatusSchema
  }),
  refresh: defineRoute({
    input: z.object({}).default({}),
    output: ManagedConfigStatusSchema
  })
}
```

> 实现提示：`defineRoute` 的实际辅助名、导入路径与路由聚合方式以 `src/shared/contracts/routes/providers.routes.ts` 的既有写法为准，照抄该模式，并在 `routes/index.ts` 中按既有方式注册。

- [ ] **Step 2: 主进程 handler**

在 `src/main/app/settingsRoutes.ts`（或与 provider 路由同文件的路由注册区）注册两个 handler：

```ts
function readManagedStatus() {
  const store = createManagedConfigStore()
  const meta = store.readMeta()
  const config = store.readConfig()
  return {
    managed: store.readProviderIds().length > 0,
    username: meta?.username ?? '',
    endpoint: meta?.endpoint ?? '',
    fetchedAt: meta?.fetchedAt ?? null,
    providerIds: store.readProviderIds(),
    documentsLocked: Boolean(config?.documents)
  }
}
```

- `managed.getStatus` → 返回 `readManagedStatus()`
- `managed.refresh` → 复用 Task 3 的 `syncManagedConfig(...)`（endpoint/device/writer 取自 composition 暴露的同一实例），完成后返回 `readManagedStatus()`

> 实现提示：若 composition 未把 `providerSettings` / device 获取能力暴露给路由层，把 `syncManagedConfig` 的调用封装成一个 `refreshManagedConfig()` 并在 composition 中注册给路由（用既有依赖注入方式），不要在路由层重新 new provider settings。

- [ ] **Step 3: provider 输出带 managed 标记**

`src/shared/types/provider.ts` 的 `LLM_PROVIDER` 增加：

```ts
  /** 是否由企业统一配置（托管），true 时本地不可修改 */
  managed?: boolean
```

`src/main/provider/routes.ts` 的 `list` / `listSummaries` 返回处，一次读取托管集合后逐条注入：

```ts
  const managedProviderIds = createManagedConfigStore().readProviderIds()
  // ...每条 provider 输出时
  managed: managedProviderIds.includes(provider.id)
```

- [ ] **Step 4: 渲染端 client 与 store**

```ts
// src/renderer/api/ManagedClient.ts
```

> 实现提示：渲染端 client 的建法照抄 `src/renderer/api/ProviderClient.ts` 的既有模式（同一个 rpc 调用封装），只暴露 `getStatus()` 与 `refresh()`。

```ts
// src/renderer/src/stores/managedStore.ts
// 注意（Task 6 实施后的实际形状）：store 提供 load()（读 getStatus 快照，页面初始化用）
// 与 refreshConfig()（调 client.refresh() 触发服务端重拉）；内部 catch + console.error，不重抛。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { createManagedClient } from '@api/ManagedClient'

export const useManagedStore = defineStore('managed', () => {
  const managed = ref(false)
  const providerIds = ref<string[]>([])
  const documentsLocked = ref(false)
  const username = ref('')
  const endpoint = ref('')
  const loading = ref(false)

  const client = createManagedClient()

  async function load() {
    loading.value = true
    try {
      const status = await client.getStatus()
      managed.value = status.managed
      providerIds.value = status.providerIds
      documentsLocked.value = status.documentsLocked
      username.value = status.username
      endpoint.value = status.endpoint
    } catch (error) {
      console.error('[managed] load status failed', error)
    } finally {
      loading.value = false
    }
  }

  async function refreshConfig() {
    loading.value = true
    try {
      const status = await client.refresh()
      managed.value = status.managed
      providerIds.value = status.providerIds
      documentsLocked.value = status.documentsLocked
      username.value = status.username
      endpoint.value = status.endpoint
    } catch (error) {
      console.error('[managed] refresh failed', error)
    } finally {
      loading.value = false
    }
  }

  function isManagedProvider(providerId: string) {
    return providerIds.value.includes(providerId)
  }

  return {
    managed,
    providerIds,
    documentsLocked,
    username,
    endpoint,
    loading,
    load,
    refreshConfig,
    isManagedProvider
  }
})
```

- [ ] **Step 5: 测试**

```ts
// test/renderer/stores/managedStore.test.ts
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getStatusMock = vi.fn()

vi.mock('@api/ManagedClient', () => ({
  createManagedClient: () => ({ getStatus: getStatusMock, refresh: vi.fn() })
}))

import { useManagedStore } from '@/stores/managedStore'

describe('managedStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('loads status into state', async () => {
    getStatusMock.mockResolvedValue({
      managed: true,
      providerIds: ['managed-corp-gw'],
      documentsLocked: true,
      username: 'zhangsan',
      endpoint: 'https://cfg',
      fetchedAt: 1
    })
    const store = useManagedStore()
    await store.refresh()
    expect(store.managed).toBe(true)
    expect(store.documentsLocked).toBe(true)
    expect(store.isManagedProvider('managed-corp-gw')).toBe(true)
    expect(store.isManagedProvider('new-api')).toBe(false)
    expect(store.isManagedProvider('my-newapi')).toBe(false)
  })

  it('defaults to unmanaged when the call fails', async () => {
    getStatusMock.mockRejectedValue(new Error('boom'))
    const store = useManagedStore()
    await expect(store.refresh()).rejects.toThrow()
    expect(store.managed).toBe(false)
  })
})
```

- [ ] **Step 6: 验证 + 提交**

Run:
```
pnpm run typecheck:web
pnpm run typecheck:node
pnpm exec vitest run test/renderer/stores/managedStore.test.ts
```
Expected: PASS

```bash
git add src/shared/contracts/routes src/shared/types/provider.ts src/main/provider/routes.ts src/main/app/settingsRoutes.ts src/renderer/api/ManagedClient.ts src/renderer/src/stores/managedStore.ts test/renderer/stores/managedStore.test.ts
git commit -m "feat(managed): expose managed status over ipc"
```

---

## Task 7: 服务商设置页锁定 UI（多实例分组）

**Files:**
- Create: `src/renderer/settings/components/ProviderManagedBadge.vue`
- Modify: 服务商设置页组件（先定位：`src/renderer/settings/components/` 下渲染 provider 列表与编辑表单的组件，如 `ModelProviderSettings.vue` / `ModelProviderSettingsDetail.vue`；以现场为准）
- Test: `test/renderer/settings/providerManagedLock.test.ts`

**背景**：托管项要「可见但禁用」。注意多实例：同一 `baseProviderId`（`new-api`）分组下会同时出现内置条目与托管实例，**只锁托管那一条，同组其它条目照常可编辑**。

- [ ] **Step 1: 写失败测试**

```ts
// test/renderer/settings/providerManagedLock.test.ts
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import ProviderManagedBadge from '@/settings/components/ProviderManagedBadge.vue'

describe('ProviderManagedBadge', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('renders the organization badge for managed providers', () => {
    const wrapper = mount(ProviderManagedBadge, { props: { managed: true } })
    expect(wrapper.find('[data-testid="provider-managed-badge"]').exists()).toBe(true)
  })

  it('renders nothing for user providers', () => {
    const wrapper = mount(ProviderManagedBadge, { props: { managed: false } })
    expect(wrapper.find('[data-testid="provider-managed-badge"]').exists()).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run test/renderer/settings/providerManagedLock.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `ProviderManagedBadge.vue`**

```vue
<template>
  <span
    v-if="managed"
    data-testid="provider-managed-badge"
    class="inline-flex items-center rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400"
  >
    {{ t('settings.managed.providerBadge') }}
  </span>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{ managed: boolean }>()

const { t } = useI18n()
</script>
```

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2 → Expected: PASS

- [ ] **Step 5: 接入服务商设置页**

在服务商设置页组件中（实际文件名以现场为准）：

1. 引入 `ProviderManagedBadge` 与 `useManagedStore`，`onMounted` 中调用 `managedStore.load()`（读快照；若要主动重拉用 `refreshConfig()`）
2. provider 列表项渲染处，名称旁插入 `<ProviderManagedBadge :managed="provider.managed ?? false" />`
3. 编辑表单：当 `provider.managed === true` 时，名称 / 地址 / API Key / 类型输入框加 `:disabled="true"`（按现场输入组件的实际 prop 名，可能为 `disabled` 或 `readonly`）
4. 操作按钮：`v-if="!isManaged"` 隐藏「删除」「复制」「停用/启用」按钮，其中 `isManaged` 取 `managedStore.isManagedProvider(provider.id)`
5. 表单顶部（托管时）加说明行：

```vue
<p v-if="isManaged" class="text-xs text-muted-foreground" data-testid="provider-managed-hint">
  {{ t('settings.managed.providerHint') }}
</p>
```

6. **不要**在同 `baseProviderId` 分组层面做整体禁用——只按 `provider.id` 判定单条

- [ ] **Step 6: 验证 + 提交**

Run:
```
pnpm exec vitest run test/renderer/settings
pnpm run typecheck:web
```
Expected: PASS

```bash
git add src/renderer/settings/components test/renderer/settings/providerManagedLock.test.ts
git commit -m "feat(managed): lock managed providers in settings ui"
```

---

## Task 8: 智能信息提取设置页只读

**Files:**
- Modify: `src/renderer/settings/components/DocumentsModelsSettings.vue`
- Test: `test/renderer/components/DocumentsModelsSettingsManaged.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// test/renderer/components/DocumentsModelsSettingsManaged.test.ts
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSettingMock = vi.fn()
const setSettingMock = vi.fn()

vi.mock('@api/ConfigClient', () => ({
  createConfigClient: () => ({
    getSetting: (...args: unknown[]) => getSettingMock(...args),
    setSetting: (...args: unknown[]) => setSettingMock(...args)
  })
}))

const managedStatus = { value: { managed: true, documentsLocked: true, providerIds: ['managed-corp-gw'] } }

vi.mock('@/stores/managedStore', () => ({
  useManagedStore: () => ({
    get documentsLocked() {
      return managedStatus.value.documentsLocked
    },
    refresh: vi.fn()
  })
}))

vi.mock('@/stores/providerStore', () => ({
  useProviderStore: () => ({
    sortedProviders: [
      { id: 'managed-corp-gw', name: '企业网关', enable: true, managed: true, baseProviderId: 'new-api' }
    ],
    providers: [
      { id: 'managed-corp-gw', name: '企业网关', enable: true, managed: true, baseProviderId: 'new-api' }
    ]
  })
}))

vi.mock('@/stores/modelStore', () => ({
  useModelStore: () => ({
    allProviderModels: [
      {
        providerId: 'managed-corp-gw',
        models: [
          { id: 'deepseek-v3', name: 'DeepSeek V3', endpointType: 'openai' },
          { id: 'gpt-4o', name: 'GPT-4o', vision: true, endpointType: 'openai' }
        ]
      }
    ],
    enabledModels: []
  })
}))

import DocumentsModelsSettings from '@/settings/components/DocumentsModelsSettings.vue'

const mountPage = () =>
  mount(DocumentsModelsSettings, {
    global: { plugins: [createI18n({ legacy: false, locale: 'en-US', messages: { 'en-US': {} } })] }
  })

describe('DocumentsModelsSettings (managed)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    managedStatus.value = { managed: true, documentsLocked: true, providerIds: ['managed-corp-gw'] }
    getSettingMock.mockImplementation((key: string) => {
      if (key === 'documents.textModel') {
        return { providerId: 'managed-corp-gw', modelId: 'deepseek-v3', endpointType: 'openai' }
      }
      if (key === 'documents.visionModel') return { providerId: 'managed-corp-gw', modelId: 'gpt-4o' }
      return undefined
    })
  })

  it('renders the page in read-only mode when documents are locked', async () => {
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.find('[data-testid="documents-models-managed-badge"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="documents-models-save"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="documents-concurrency-input"]').attributes('disabled')).toBeDefined()
  })

  it('does not write settings on mount when locked', async () => {
    mountPage()
    await flushPromises()
    expect(setSettingMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run test/renderer/components/DocumentsModelsSettingsManaged.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现只读模式**

在 `DocumentsModelsSettings.vue` 中：

1. 引入并调用 `const managedStore = useManagedStore()`，`onMounted` 里额外 `await managedStore.load()`（读快照；store 内部已 catch，不会抛出）
2. 新增计算属性：

```ts
const locked = computed(() => managedStore.documentsLocked)
```

3. 模板顶部加徽章与说明：

```vue
<div
  v-if="locked"
  class="flex items-start gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm"
  data-testid="documents-models-managed-badge"
>
  <span>{{ t('settings.managed.documentsBadge') }}</span>
</div>
```

4. 所有输入控件加禁用：模型选择触发器按钮加 `:disabled="locked"`，并发/温度/maxTokens 的 `<input>` 加 `:disabled="locked"`；`locked` 时不再打开 Popover
5. 保存按钮整块隐藏：

```vue
<div v-if="!locked" class="flex items-center gap-3">
  <!-- 既有保存按钮与状态文案 -->
</div>
```

6. 兜底：`save()` 开头加 `if (locked.value) return`，防止外部调用写入

> 实现提示：模型选中值若带 `endpointType`，展示 label 时不受影响；保存时保持该字段原样写回（非托管路径下用户选择器通常不带 `endpointType`，无需额外处理）。

- [ ] **Step 4: 验证 + 提交**

Run:
```
pnpm exec vitest run test/renderer/components/DocumentsModelsSettings.test.ts test/renderer/components/DocumentsModelsSettingsManaged.test.ts
pnpm run typecheck:web
```
Expected: PASS（既有 4 用例不回归：非托管路径 `locked=false`，行为不变）

```bash
git add src/renderer/settings/components/DocumentsModelsSettings.vue test/renderer/components/DocumentsModelsSettingsManaged.test.ts
git commit -m "feat(managed): lock documents models page"
```

---

## Task 9: i18n 文案与全量验证

> **执行顺序**：本 Task 必须在 **Task 10（documents endpointType 透传）** 之后执行，否则冒烟第 10 项会失败。

**Files:**
- Modify: `src/renderer/src/i18n/*/settings.json` ×20

- [ ] **Step 1: zh-CN settings.json 追加**

在 settings 命名空间内按字母序插入：

```json
"managed": {
  "providerBadge": "由企业统一配置",
  "providerHint": "该服务商由企业统一配置，不可在本机修改。",
  "documentsBadge": "识别模型由企业统一配置，不可修改。"
}
```

- [ ] **Step 2: en-US 及其余 18 locale**

en-US：

```json
"managed": {
  "providerBadge": "Managed by your organization",
  "providerHint": "This provider is configured by your organization and cannot be changed on this device.",
  "documentsBadge": "Extraction models are configured by your organization and cannot be changed."
}
```

其余 18 locale 用 en-US 同文（仓库惯例）。

- [ ] **Step 3: 校验**

Run:
```
pnpm run i18n
```
Expected: PASS（20 locales，无缺失键）

- [ ] **Step 4: 全量验证**

Run（PowerShell）:
```
pnpm run typecheck:web
pnpm run typecheck:node
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/managed test/main/provider test/main/documents test/main/app --config vitest.config.ts
pnpm exec vitest run test/renderer/stores test/renderer/settings test/renderer/components
```
Expected: 全部 PASS（预存环境失败按已知清单排除：`rendererPerformanceLogService.test.ts` 路径分隔符、`sessionDataMigrations.sqlite.test.ts` 表缺失）

- [ ] **Step 5: 手动冒烟（`pnpm dev`）**

1. 不设 `DEEPCHAT_MANAGED_CONFIG_URL`：启动无托管，服务商页、内置 Agent 设置页与识别模型页行为与现状完全一致（回归确认）
2. 设 `DEEPCHAT_MANAGED_CONFIG_URL` 指向 mock 服务（本地 json-server 按上述契约返回 `defaultProviderKey` + 一条 `apiType: "new-api"` 的 provider + `agentModels` + `documents`）：启动后服务商页的 `new-api` 分组下出现企业托管实例，带「由企业统一配置」徽章，输入框禁用，无删除/复制/停用按钮
3. 同组的**内置 `new-api` 条目**仍可正常编辑（仅托管实例被锁）
4. 手动新增一个自己的 `new-api` 实例：可正常新增/编辑/删除，与托管实例并存
5. **Agent 设置页「模型默认值」四项被预填**：mock 下发的 id 若存在于托管网关的模型列表 → 被正确选中（多个 provider 都有时选锚点 provider）；不存在的 id 不被写入，日志出现 `not offered by any managed provider` warning
6. 在 Agent 设置页把「视觉模型」改成自有 provider 的模型 → 重启（mock 仍下发原 id）→ **该字段保持用户选择不被覆盖**，其余未改过的字段仍跟随托管值
7. 识别模型页：整页只读、无保存按钮；任务实际使用下发的文本/视觉模型
8. 断开 mock 服务重启：配置保留（走缓存），页面仍为锁定态
9. 服务端改为返回 404 后重启：托管态清除，托管实例的锁定解除（页面恢复可编辑）
10. 配置 `endpointType: "anthropic"` 的模型引用后，识别任务确实走该协议路径

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/i18n
git commit -m "i18n: add managed provider copy"
```

---

## Task 10: documents `endpointType` 透传到 provider 调用层

> **背景（Task 5 spec 审查发现）**：Task 5 已把托管 `endpointType` 写入 `documents.textModel/visionModel` 设置并在 `resolveDocumentsModelSettings` 中解析出来，但该字段在**第一跳就被丢弃**：`DocumentExtractor` 的 `ModelTarget`、`CompletionRequest`、`provider.completions` 契约均不携带它。后果：企业为 `new-api` 网关下发 `endpointType: "anthropic"` 时，实际会走推断出的默认协议（通常 `openai`），静默用错协议 → 请求失败或行为不符，Task 9 冒烟第 10 项必挂。
>
> **必须在 Task 9 之前完成**。

**Files（现场核准确认，预计 5-7 处）**
- Modify: `src/main/documents/extractor/documentExtractor.ts`（`ModelTarget`、`CompletionRequest` 增加可选 `endpointType`）
- Modify: `src/main/app/composition.ts`（两个 resolver 与 `generateCompletion` 把解析出的 `endpointType` 传下去）
- Modify: `src/main/provider/index.ts`（`generateCompletionStandalone` 等转发参数）
- Modify: provider `completions` 调用契约（按现场实现位置）
- Modify: new-api 路由解析（显式 `endpointType` **优先于**既有推断）
- Test: extractor 透传单测 + 组装层断言

- [ ] **Step 1: 现场勘察并确定最小改动面**

先读并记录（写进最终报告）：
1. `src/main/documents/extractor/documentExtractor.ts` 中 `ModelTarget` 与 `CompletionRequest` 的定义位置，以及从「构造 target」到「调用 provider completions」的完整调用链（每一跳的函数签名与所在文件）。
2. `src/main/provider/index.ts` 中 `generateCompletionStandalone`（约 491 行）如何据此构造请求，以及 new-api 的 endpointType 解析入口（`resolveNewApiEndpointTypeFromRoute` / `configuredEndpointType` 优先级的实际代码位置）。
3. 判断最小改动面：**只做端到端的字段透传 + 让显式值优先**，不要重构路由推断逻辑。

- [ ] **Step 2: 写失败测试**

至少覆盖：
```ts
// 断言：显式 endpointType 会被带到 provider 调用层，且优先于按模型 id 的推断
it('forwards the explicit endpointType from the documents model ref to the provider call', async () => {
  // 用 fake provider settings / fake provider 收集实际收到的请求参数
  // documents.textModel = { providerId: 'managed-corp-gw', modelId: 'claude-x', endpointType: 'anthropic' }
  // 断言 provider 收到的请求携带 endpointType === 'anthropic'（而不是推断出的 'openai'）
})
```
另加：未指定 `endpointType` 时行为与改动前一致（回归保护）。

- [ ] **Step 3: 运行确认失败** → `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents --config vitest.config.ts`，Expected: 新增用例 FAIL

- [ ] **Step 4: 实现逐层透传**

逐层加可选字段并传递（每一跳只在有值时透传，保持既有调用点兼容）：
- `ModelTarget` / `CompletionRequest` 增加 `endpointType?: NewApiEndpointType`
- `composition.ts` 的两个 resolver 把 `settings.textModel.endpointType` / `settings.visionModel.endpointType` 传入 target 构造
- `generateCompletion` 路径同样透传
- provider `completions` 契约与 `generateCompletionStandalone` 接收并向下传
- new-api 路由解析处：**显式 `endpointType` 优先**，无显式值时才走既有推断

- [ ] **Step 5: 运行确认通过**

```
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents test/main/provider test/main/managed --config vitest.config.ts
pnpm run typecheck:node
```
Expected: 新增用例 PASS；documents 与 managed 既有用例不回归；`test/main/provider` 仍只有已知的 17 项预存失败（不增加）。

- [ ] **Step 6: 提交**

```bash
git add src/main/documents src/main/provider src/main/app/composition.ts test/main/documents
git commit -m "feat(documents): forward endpointType to provider calls"
```

---

## 自检记录

**Spec 覆盖**：服务商配置统一管理（Task 1-4、6、7）✓；按登录用户名自动获取（Task 1、3）✓；**多个服务商与供应商类型**（Task 1 `providers[]` + `apiType`/`baseProviderId`）✓；**同一服务商多个配置实例**（Task 1.3 多实例写入 + Task 2 applier + Task 7 分组内只锁单条）✓；自动配置后不可修改（Task 4 主进程写保护 + Task 7 UI 锁定）✓；用户可自定义添加其它服务商（Task 4 仅拦托管 id + Task 7 并存）✓；**new-api 多协议聚合的 endpointType**（Task 1 schema/规范化 + Task 5 透传 + Task 9 冒烟 10）✓；智能信息提取模型与参数完全锁定（Task 5 托管优先 + Task 8 只读页）✓；**Agent 四项模型「只下发 id + 按模型列表匹配选中」**（Task 1 id 规范化/锚点 + Task 2 applyAgentModels 匹配 + Task 3 先刷新模型再匹配 + Task 9 冒烟 5/6）✓；离线可用（Task 3 缓存回退 + 重新应用；模型列表拉取失败时跳过预填而非报错）✓。

**未纳入（YAGNI，明确不做）**：定时轮询刷新（已选「每次启动拉取」）；下发模型清单（客户端实时拉取）；Agent 四项模型的 provider 归属与推理参数下发（按需求只给 id，归属靠匹配）；把用户自建 provider 纳入 agentModels 匹配范围；Agent 设置页对托管默认值的锁定或来源徽章（该处保持用户可自由修改）；接管内置 `new-api` 条目（改为多实例并存）；服务端下发 provider 级 `supportedEndpointTypes`/`selectableEndpointTypes`；托管 provider 的 OAuth 流程。apiKey 在渲染端已有 UI 脱敏（`ProviderApiConfig.vue:322-325`），无需改造。

**类型一致性**：`ManagedConfigPayload` / `ManagedProvider` / `ManagedModelRef` / `ManagedAgentModelIds`（下发的 id 映射）/ `ManagedAgentModels`（匹配落地值）/ `AgentModelKey` / `ManagedDocumentsConfig` / `SyncStatus` / `SyncResult` 在 Task 1 定义，Task 2/3/5/6 引用一致；`AGENT_MODEL_KEYS` 与 `MANAGED_AGENT_MODEL_FIELDS`（`chat→defaultModelPreset` 等映射）在 Task 1 定义，被 Task 1 的 `normalizeAgentModelIds` 与 Task 2 的 `applyManagedAgentModels` 一致使用；`ManagedConfigPayload.defaultProviderId`（由下发 `defaultProviderKey` 解析）在 Task 1 产出、Task 2 `orderedProviderIds` 消费；`ManagedProviderModelLookup.listModelIds` 在 Task 2 定义、Task 3 用 `providerSettings.getProviderModels` 实现；`ApplyManagedAgentModelsResult` 在 Task 2 定义、Task 3 消费 `warnings`；`ManagedConfigStore` 方法名 `readConfig/writeConfig/readMeta/writeMeta/readProviderIds/writeProviderIds/readAgentModelApplied/writeAgentModelApplied` 在 Task 2 定义并被 Task 3/6 一致使用；`applyManagedConfig(config, writer)` 与 `applyManagedAgentModels(config, agentSettings, store, lookup, agentId)` 签名在 Task 2 定义、Task 3 调用一致；`assertProviderWritable(providerId, action, readManagedProviderIds)` 在 Task 4 定义并调用一致；`resolveDocumentsModelSettings(userSettings, managed)` 在 Task 5 定义并调用一致；`getKnownProviderTypes()` / `getBuiltinIdByApiType()` 在 Task 3 定义并传给 `syncManagedConfig`，与 Task 1 的 `FetchManagedConfigOptions` 字段名一致。
