# 企业托管服务商配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让企业可以通过一个 HTTP 接口按登录用户名下发服务商配置（地址 + API Key + 供应商类型 + 默认模型），客户端启动时拉取并固化这些配置（用户可见但不可修改），同时把「智能信息提取」的模型完全锁定为下发值，其余模型选择处仅用下发值做初始预填。

**Architecture:** 主进程新增 `src/main/managed/` 模块（领域类型 + HTTP client + 缓存 + 应用器），在 `composition.ts` 启动链中于 provider 初始化之后、documents 迁移之前执行「拉取 → 缓存 → 应用」。托管 provider 以 `managed-<key>` 为 id 写入既有 `providers` 表（复用 `custom=false` 语义），托管 id 集合另存一个 settings 键用于**写保护**与 UI 锁定，从而不新增数据库列。documents 模型解析链改为「托管优先」，用户写入被忽略；agent chat 默认模型仅在一次成功下发后作为初始值预填，之后用户可改。

**Tech Stack:** Electron 主进程（TypeScript、zod、undici/全局 fetch）、设置持久化 `getSetting/setSetting`、typed IPC 契约（`src/shared/contracts/routes/`）、Vue 3 + pinia 渲染端、Vitest（main 需 Electron 运行时）+ Vue Test Utils、vue-i18n 20 locale。

---

## 设计契约（含在 plan 内，服务端待建）

### 1. HTTP 接口契约

服务端需实现一个只读查询接口。**端点地址来源优先级**：环境变量 `DEEPCHAT_MANAGED_CONFIG_URL` > app-settings 键 `managedConfigUrl` > 未配置则跳过托管流程（个人用户路径完全不变）。

```
GET {endpoint}?username=<urlencoded>&domain=<urlencoded>&hostname=<urlencoded>&sid=<urlencoded>
Headers:
  Accept: application/json
  X-DeepChat-Client: <app version>
  X-DeepChat-Device-Id: <sid>
```

成功响应 `200 application/json`：

```json
{
  "version": 1,
  "providers": [
    {
      "key": "corp-openai",
      "name": "企业 OpenAI 网关",
      "apiType": "openai",
      "baseUrl": "https://gw.corp.example.com/v1",
      "apiKey": "sk-corp-xxxx",
      "enabled": true,
      "defaultModelId": "gpt-4o"
    }
  ],
  "agentModels": {
    "chat": { "providerKey": "corp-openai", "modelId": "gpt-4o" },
    "assistant": { "providerKey": "corp-openai", "modelId": "gpt-4o-mini" },
    "vision": { "providerKey": "corp-openai", "modelId": "gpt-4o" },
    "imageGeneration": { "providerKey": "corp-openai", "modelId": "gpt-image-2" }
  },
  "documents": {
    "textModel": { "providerKey": "corp-openai", "modelId": "gpt-4o-mini" },
    "visionModel": { "providerKey": "corp-openai", "modelId": "gpt-4o" },
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
| `providers[].apiType` | 是 | 供应商类型，取值须在本地 `ProviderType` 枚举内（未知值该条 provider 被跳过并记日志） |
| `providers[].baseUrl` | 是 | 服务商地址 |
| `providers[].apiKey` | 是 | API Key |
| `providers[].enabled` | 否 | 默认 `true`；`false` 时写入但停用（用户仍不可启用） |
| `providers[].defaultModelId` | 否 | 该 provider 的默认模型 id，用于选择器预填 |
| `agentModels` | 否 | 内置 Agent 设置页「模型默认值」四项的托管默认值，**仅作默认值预填**；用户改过后不再覆盖。四个子键均可选：`chat`（默认对话模型）、`assistant`（助手模型）、`vision`（视觉模型）、`imageGeneration`（图像生成模型） |
| `documents` | 否 | 智能信息提取的模型与参数，**完全锁定**；为 `null`/缺省表示该企业不锁定此项 |
| 所有 `providerKey` | — | 必须命中 `providers[].key`，未命中则忽略该引用 |

#### 1.1 `agentModels` 的字段映射与「默认值跟随」语义

Agent 设置页「模型默认值」四项实际写入的是**内置 Agent（id = `deepchat`）的配置**（`DeepChatAgentConfig`，经 `agentSettings.updateDeepChatAgent(BUILTIN_DEEPCHAT_AGENT_ID, {...})` 持久化），不是全局 settings 键。映射关系：

| 接口字段 | agent config 字段 | 界面文案 |
| --- | --- | --- |
| `agentModels.chat` | `defaultModelPreset` | 默认对话模型 |
| `agentModels.assistant` | `assistantModel` | 助手模型 |
| `agentModels.vision` | `visionModel` | 视觉模型 |
| `agentModels.imageGeneration` | `imageGenerationModel` | 图像生成模型 |

**语义（默认值跟随，用户优先）**：托管值只作默认值预填，不锁定。每次成功下发后按下述规则逐字段决定是否写入：

1. 当前 agent 值为空 → 写入托管值
2. 当前 agent 值 == 上次写入的托管值（说明用户没改过）→ 用新托管值覆盖（跟随企业变更）
3. 当前 agent 值 != 上次写入的托管值（说明用户改过）→ **保持用户值**，不覆盖

为判定规则 2/3，需记录「上次写入的托管值」，存 settings 键 `managed.agentModelApplied`。用户新增自有 provider 后即可在 Agent 设置页把这四项改成自有 provider 的模型，之后企业再下发也不会覆盖它。

注意：不写全局 `defaultModel` / `assistantModel` settings 键（旧的 `DefaultModelSettingsSection.vue` 已无引用，属 zero-inbound 死路径），避免出现两个真相源。

**状态码语义**：
- `200` → 应用配置，进入托管模式
- `204` / `404` → 该用户名无托管配置，退出托管模式（清除本地托管配置与 id 集合，用户恢复自由配置）
- `401` / `403` → 鉴权失败，退出托管模式并记录日志（不阻断启动）
- 网络错误 / `5xx` / JSON 解析失败 → **保留本地缓存与托管模式**（离线可用），记录日志

### 2. 本地存储键（新增，均走既有 `getSetting/setSetting`）

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `managed.config` | `ManagedConfigPayload \| null` | 最近一次成功拉取并规范化后的配置 |
| `managed.meta` | `{ fetchedAt: number; username: string; endpoint: string } \| null` | 拉取元信息，用于设置页展示与排障 |
| `managed.providerIds` | `string[]` | 托管 provider 的本地 id 集合，**写保护与 UI 锁定的唯一依据** |
| `managed.agentModelApplied` | `Record<AgentModelKey, { providerId: string; modelId: string } \| null>` | 上一次写入内置 Agent 的托管模型值，用于判定「用户是否改过」（见 §1.1） |

不新增数据库列：`providers` 表沿用既有列，托管 provider 以 `custom=false` 写入，其"托管"身份由 `managed.providerIds` 表达（最小改动，避免 DB schema 迁移）。

### 3. 锁定语义汇总

| 位置 | 托管时的行为 |
| --- | --- |
| 服务商设置页 | 托管项显示「由企业统一配置」徽章；名称/地址/API Key/类型输入框禁用；删除、复制、停用按钮隐藏 |
| 主进程 provider 写操作 | `update/add/remove/setById(改 id)/reorder` 涉及托管 id 一律拒绝；托管 provider 不允许在本地新增同 id |
| 智能信息提取模型页 | 整页只读（模型、并发、推理参数全部禁用），显示徽章与说明；无「保存」按钮 |
| 智能信息提取运行时 | 解析链**托管优先**：即便用户绕过 UI 写了 `documents.*` 键，运行时仍用托管值 |
| Agent 设置页「模型默认值」四项 | 每次成功下发后按 §1.1 的「默认值跟随，用户优先」规则逐字段预填：用户没改过则跟随企业变更，改过则保留用户值 |
| 用户自定义 provider | 完全并存：可自由新增/编辑/删除，与托管项互不影响 |

### 4. 文件结构

**新建**
- `src/main/managed/types.ts` — 领域类型 + zod schema + `toLocalProviderId` 等纯函数
- `src/main/managed/client.ts` — HTTP 拉取与响应规范化
- `src/main/managed/store.ts` — 四个 settings 键的读写封装
- `src/main/managed/apply.ts` — 把 payload 应用到 providerSettings
- `src/main/managed/applyAgentModels.ts` — 按「默认值跟随，用户优先」规则预填内置 Agent 的模型默认值
- `src/main/managed/index.ts` — 编排入口 `syncManagedConfig()`
- `src/shared/contracts/routes/managed.routes.ts` — 渲染端查询/刷新契约
- `src/renderer/api/ManagedClient.ts` — 渲染端 client
- `src/renderer/src/stores/managedStore.ts` — 渲染端状态
- `test/main/managed/*.test.ts`、`test/renderer/components/*.test.ts`（各 Task 内指定）

**修改**
- `src/main/app/composition.ts` — 启动链插入 `syncManagedConfig()`；documents 解析链托管优先
- `src/main/provider/routes.ts` — 写保护
- `src/main/provider/settings.ts` — 提供 `upsertManagedProvider` 所需的最小能力（若既有 `setProvider` 够用则不改）
- `src/shared/contracts/routes/providers.routes.ts` — provider 输出加 `managed: boolean`
- `src/shared/types/provider.ts` — `LLM_PROVIDER` 加可选 `managed?: boolean`
- `src/shared/contracts/routes/config.routes.ts` + `src/main/app/settingsRoutes.ts` — 新增 `managed.*` 键与 `documents.locked*` 只读查询
- `src/renderer/settings/components/ProviderSettings.vue`（或实际服务商设置页组件）— 锁定 UI
- `src/renderer/settings/components/DocumentsModelsSettings.vue` — 只读模式
- i18n：`routes.json` / `settings.json` / `documents.json`（20 locale）

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

describe('toLocalProviderId', () => {
  it('prefixes and keeps safe characters', () => {
    expect(toLocalProviderId('corp-openai')).toBe('managed-corp-openai')
    expect(toLocalProviderId('a.b_c-1')).toBe('managed-a.b_c-1')
  })

  it('replaces unsafe characters with dash', () => {
    expect(toLocalProviderId('corp openai/主')).toBe('managed-corp-openai--')
  })
})

describe('fetchManagedConfig', () => {
  const device = { username: 'zhangsan', domain: 'CORP', hostname: 'PC-01', sid: 'S-1-5-21' }

  it('returns normalized config on 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [
          {
            key: 'corp-openai',
            name: 'Corp',
            apiType: 'openai',
            baseUrl: 'https://gw.corp/v1',
            apiKey: 'sk-x',
            enabled: true,
            defaultModelId: 'gpt-4o'
          }
        ],
        agentModels: {
          chat: { providerKey: 'corp-openai', modelId: 'gpt-4o' },
          vision: { providerKey: 'corp-openai', modelId: 'gpt-4o' }
        },
        documents: {
          textModel: { providerKey: 'corp-openai', modelId: 'gpt-4o-mini' },
          visionModel: { providerKey: 'corp-openai', modelId: 'gpt-4o' }
        }
      })
    )
    const result = await fetchManagedConfig({
      endpoint: 'https://cfg.corp/api',
      device,
      fetchImpl: fetchMock
    })
    expect(result.status).toBe('applied')
    expect(result.config?.providers[0].id).toBe('managed-corp-openai')
    expect(result.config?.documents?.textModel).toEqual({
      providerId: 'managed-corp-openai',
      modelId: 'gpt-4o-mini'
    })
    expect(result.config?.agentModels).toEqual({
      chat: { providerId: 'managed-corp-openai', modelId: 'gpt-4o' },
      assistant: null,
      vision: { providerId: 'managed-corp-openai', modelId: 'gpt-4o' },
      imageGeneration: null
    })
    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toContain('username=zhangsan')
    expect(calledUrl).toContain('domain=CORP')
  })

  it('returns absent on 404 and 204', async () => {
    const notFound = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    expect((await fetchManagedConfig({ endpoint: 'https://cfg', device, fetchImpl: notFound })).status).toBe('absent')
    const noContent = vi.fn().mockResolvedValue(new Response('', { status: 204 }))
    expect((await fetchManagedConfig({ endpoint: 'https://cfg', device, fetchImpl: noContent })).status).toBe('absent')
  })

  it('returns denied on 401/403', async () => {
    const denied = vi.fn().mockResolvedValue(new Response('', { status: 403 }))
    expect((await fetchManagedConfig({ endpoint: 'https://cfg', device, fetchImpl: denied })).status).toBe('denied')
  })

  it('returns unavailable on network error, 5xx and invalid json', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    expect((await fetchManagedConfig({ endpoint: 'https://cfg', device, fetchImpl: boom })).status).toBe('unavailable')
    const five = vi.fn().mockResolvedValue(new Response('oops', { status: 502 }))
    expect((await fetchManagedConfig({ endpoint: 'https://cfg', device, fetchImpl: five })).status).toBe('unavailable')
    const badJson = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }))
    expect((await fetchManagedConfig({ endpoint: 'https://cfg', device, fetchImpl: badJson })).status).toBe('unavailable')
  })

  it('drops providers with invalid payload and unknown apiType', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [
          { key: 'ok', name: 'OK', apiType: 'openai', baseUrl: 'https://a', apiKey: 'k' },
          { key: 'bad-type', name: 'X', apiType: 'not-a-real-type', baseUrl: 'https://b', apiKey: 'k' },
          { key: 'no-url', name: 'Y', apiType: 'openai', apiKey: 'k' }
        ]
      })
    )
    const result = await fetchManagedConfig({ endpoint: 'https://cfg', device, fetchImpl: fetchMock })
    expect(result.config?.providers.map((p) => p.key)).toEqual(['ok'])
  })

  it('ignores model refs whose providerKey is unknown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [{ key: 'ok', name: 'OK', apiType: 'openai', baseUrl: 'https://a', apiKey: 'k' }],
        documents: {
          textModel: { providerKey: 'missing', modelId: 'm' },
          visionModel: { providerKey: 'ok', modelId: 'm2' }
        }
      })
    )
    const result = await fetchManagedConfig({ endpoint: 'https://cfg', device, fetchImpl: fetchMock })
    expect(result.config?.documents?.textModel).toBeNull()
    expect(result.config?.documents?.visionModel).toEqual({
      providerId: 'managed-ok',
      modelId: 'm2'
    })
  })

  it('clamps documents concurrency into 1-10', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        providers: [{ key: 'ok', name: 'OK', apiType: 'openai', baseUrl: 'https://a', apiKey: 'k' }],
        documents: {
          textModel: { providerKey: 'ok', modelId: 'm' },
          visionModel: { providerKey: 'ok', modelId: 'm2' },
          concurrency: 99
        }
      })
    )
    const result = await fetchManagedConfig({ endpoint: 'https://cfg', device, fetchImpl: fetchMock })
    expect(result.config?.documents?.concurrency).toBe(10)
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
import type { ProviderType } from '@shared/types/provider'

const PROVIDER_KEY_PATTERN = /^[A-Za-z0-9._-]+$/

export const ManagedProviderSpecSchema = z.object({
  key: z.string().regex(PROVIDER_KEY_PATTERN),
  name: z.string().min(1),
  apiType: z.string().min(1),
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  enabled: z.boolean().optional(),
  defaultModelId: z.string().min(1).optional()
})

const ManagedModelRefSchema = z.object({
  providerKey: z.string().regex(PROVIDER_KEY_PATTERN),
  modelId: z.string().min(1)
})

export const ManagedDocumentsSchema = z.object({
  textModel: ManagedModelRefSchema.nullish(),
  visionModel: ManagedModelRefSchema.nullish(),
  concurrency: z.number().nullish(),
  temperature: z.number().nullish(),
  maxTokens: z.number().nullish()
})

export const ManagedAgentModelsSchema = z.object({
  chat: ManagedModelRefSchema.nullish(),
  assistant: ManagedModelRefSchema.nullish(),
  vision: ManagedModelRefSchema.nullish(),
  imageGeneration: ManagedModelRefSchema.nullish()
})

export const ManagedConfigPayloadSchema = z.object({
  version: z.number().int().positive(),
  providers: z.array(ManagedProviderSpecSchema),
  agentModels: ManagedAgentModelsSchema.nullish(),
  documents: ManagedDocumentsSchema.nullish()
})

export type ManagedProviderSpec = z.infer<typeof ManagedProviderSpecSchema>

export interface ManagedProvider {
  /** 本地 provider id，形如 managed-corp-openai */
  id: string
  /** 服务端业务 key，用于回显与排障 */
  key: string
  name: string
  apiType: ProviderType
  baseUrl: string
  apiKey: string
  enabled: boolean
  defaultModelId?: string
}

export interface ManagedModelRef {
  providerId: string
  modelId: string
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

/** 托管模型键 → 内置 Agent 配置字段名（见契约 §1.1） */
export const MANAGED_AGENT_MODEL_FIELDS: Record<AgentModelKey, string> = {
  chat: 'defaultModelPreset',
  assistant: 'assistantModel',
  vision: 'visionModel',
  imageGeneration: 'imageGenerationModel'
}

/** 内置 Agent 四项模型默认值的托管值；缺省字段为 null */
export type ManagedAgentModels = Record<AgentModelKey, ManagedModelRef | null>

export interface ManagedConfigPayload {
  version: number
  providers: ManagedProvider[]
  agentModels: ManagedAgentModels | null
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
  /** 未知 apiType / 未知 providerKey 导致的丢弃原因，用于日志 */
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
import type { ProviderType } from '@shared/types/provider'
import {
  AGENT_MODEL_KEYS,
  ManagedConfigPayloadSchema,
  clampManagedConcurrency,
  toLocalProviderId,
  type ManagedAgentModels,
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
  clientVersion?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  knownProviderTypes: readonly string[]
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
  const ref = raw as { providerKey?: unknown; modelId?: unknown }
  if (typeof ref.providerKey !== 'string' || typeof ref.modelId !== 'string') return null
  const providerId = localIdByKey.get(ref.providerKey)
  if (!providerId) {
    warnings.push(`model ref references unknown providerKey: ${ref.providerKey}`)
    return null
  }
  return { providerId, modelId: ref.modelId }
}

function normalizeDocuments(
  raw: { textModel?: unknown; visionModel?: unknown; concurrency?: unknown; temperature?: unknown; maxTokens?: unknown } | null | undefined,
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

function normalizeAgentModels(
  raw: Record<string, unknown> | null | undefined,
  localIdByKey: Map<string, string>,
  warnings: string[]
): ManagedAgentModels | null {
  if (!raw) return null
  const result = {} as ManagedAgentModels
  for (const key of AGENT_MODEL_KEYS) {
    result[key] = normalizeModelRef(raw[key] ?? null, localIdByKey, warnings)
  }
  return result
}

export async function fetchManagedConfig(
  options: FetchManagedConfigOptions
): Promise<SyncResult> {
  const { endpoint, device, clientVersion, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const fetchImpl = options.fetchImpl ?? fetch
  const warnings: string[] = []
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
        apiType: spec.apiType as ProviderType,
        baseUrl: spec.baseUrl,
        apiKey: spec.apiKey,
        enabled: spec.enabled ?? true,
        ...(spec.defaultModelId ? { defaultModelId: spec.defaultModelId } : {})
      })
    }

    const config: ManagedConfigPayload = {
      version: parsed.data.version,
      providers,
      agentModels: normalizeAgentModels(
        (parsed.data.agentModels ?? null) as Record<string, unknown> | null,
        localIdByKey,
        warnings
      ),
      documents: normalizeDocuments(parsed.data.documents ?? null, localIdByKey, warnings)
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
- Test: `test/main/managed/apply.test.ts`

**背景**：`providerSettings` 是 `src/main/provider/settings.ts` 导出的类实例（composition.ts 中已有变量名 `providerSettings`）。应用器只通过其公开方法写 provider，不直接碰 SQLite。先读 `settings.ts` 找到「新增/更新单个 provider」的既有方法名（形如 `setProvider`/`addProvider`/`updateProvider`），以及 `getProviders()` 返回结构，再按实际签名落地——**若既有方法无法表达 `enabled=false` 的写入，用 `updateProvider` 后置停用，不要新增方法**。

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
      id: 'managed-corp',
      key: 'corp',
      name: 'Corp',
      apiType: 'openai' as never,
      baseUrl: 'https://gw.corp/v1',
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
  it('inserts new managed providers and returns their ids', async () => {
    const settings = createSettings()
    const ids = await applyManagedConfig(payload(), settings as never)
    expect(ids).toEqual(['managed-corp'])
    expect(settings.setProvider).toHaveBeenCalledWith(
      'managed-corp',
      expect.objectContaining({ baseUrl: 'https://gw.corp/v1', apiKey: 'sk-x' })
    )
  })

  it('overwrites an existing managed provider (idempotent refresh)', async () => {
    const settings = createSettings([
      { id: 'managed-corp', name: 'Old', baseUrl: 'https://old', apiKey: 'sk-old' }
    ])
    await applyManagedConfig(payload(), settings as never)
    const entry = settings.store.find((p) => p.id === 'managed-corp') as Record<string, unknown>
    expect(entry.baseUrl).toBe('https://gw.corp/v1')
    expect(entry.apiKey).toBe('sk-x')
  })

  it('does not touch user providers', async () => {
    const settings = createSettings([{ id: 'openai', name: 'My OpenAI', apiKey: 'sk-mine' }])
    await applyManagedConfig(payload(), settings as never)
    const entry = settings.store.find((p) => p.id === 'openai') as Record<string, unknown>
    expect(entry.apiKey).toBe('sk-mine')
  })

  it('writes enabled=false for disabled managed providers', async () => {
    const settings = createSettings()
    await applyManagedConfig(
      payload({ providers: [{ ...payload().providers[0], enabled: false }] }),
      settings as never
    )
    const entry = settings.store.find((p) => p.id === 'managed-corp') as Record<string, unknown>
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
  /** 上一次写入内置 Agent 的托管模型值，用于判定「用户是否改过」 */
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

> 实现提示：确认 `src/main/config/settingsStore.ts` 导出的读写函数名（可能是 `getSetting/setSetting`，也可能需传入 store 实例）；按实际导出调整 import，一处调整即可，其余逻辑不变。

- [ ] **Step 4: 实现 `src/main/managed/apply.ts`**

```ts
import type { ManagedConfigPayload } from './types'

export interface ManagedProviderWriter {
  getProviders(): Array<Record<string, unknown>>
  setProvider(id: string, patch: Record<string, unknown>): Promise<void> | void
}

/**
 * 把托管配置写入 provider 存储；返回本次托管的 provider id 列表。
 * 幂等：每次启动重复调用只覆盖托管项，不触碰用户自建 provider。
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
import type { ManagedConfigPayload } from '@/managed/types'

const ref = (providerId: string, modelId: string) => ({ providerId, modelId })

const config = (agentModels: ManagedConfigPayload['agentModels']): ManagedConfigPayload => ({
  version: 1,
  providers: [],
  agentModels,
  documents: null
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
      readAgentModelApplied: () => stored,
      writeAgentModelApplied: (next: Record<string, unknown>) => {
        stored = next
      }
    }
  }
}

describe('applyManagedAgentModels', () => {
  it('fills all four fields when the agent has none configured', async () => {
    const agent = createAgentSettings()
    const store = createStore()
    await applyManagedAgentModels(
      config({
        chat: ref('managed-corp', 'c1'),
        assistant: ref('managed-corp', 'a1'),
        vision: ref('managed-corp', 'v1'),
        imageGeneration: ref('managed-corp', 'i1')
      }),
      agent.api as never,
      store.api as never,
      'deepchat'
    )
    expect(agent.api.updateDeepChatAgent).toHaveBeenCalledWith('deepchat', {
      defaultModelPreset: ref('managed-corp', 'c1'),
      assistantModel: ref('managed-corp', 'a1'),
      visionModel: ref('managed-corp', 'v1'),
      imageGenerationModel: ref('managed-corp', 'i1')
    })
    expect(store.getApplied()).toEqual({
      chat: ref('managed-corp', 'c1'),
      assistant: ref('managed-corp', 'a1'),
      vision: ref('managed-corp', 'v1'),
      imageGeneration: ref('managed-corp', 'i1')
    })
  })

  it('follows a new managed value when the user has not changed it', async () => {
    const agent = createAgentSettings({ defaultModelPreset: ref('managed-corp', 'old') })
    const store = createStore({ chat: ref('managed-corp', 'old') })
    await applyManagedAgentModels(
      config({ chat: ref('managed-corp', 'new') }),
      agent.api as never,
      store.api as never,
      'deepchat'
    )
    expect(agent.getCurrent().defaultModelPreset).toEqual(ref('managed-corp', 'new'))
    expect(store.getApplied().chat).toEqual(ref('managed-corp', 'new'))
  })

  it('keeps the user value when it differs from the last applied managed value', async () => {
    const userPick = ref('openai', 'my-model')
    const agent = createAgentSettings({ visionModel: userPick })
    const store = createStore({ vision: ref('managed-corp', 'v1') })
    await applyManagedAgentModels(
      config({ vision: ref('managed-corp', 'v2') }),
      agent.api as never,
      store.api as never,
      'deepchat'
    )
    expect(agent.getCurrent().visionModel).toEqual(userPick)
    expect(agent.api.updateDeepChatAgent).not.toHaveBeenCalled()
  })

  it('records user values so a later managed change still does not override them', async () => {
    const userPick = ref('openai', 'my-model')
    const agent = createAgentSettings({ visionModel: userPick })
    const store = createStore({ vision: ref('managed-corp', 'v1') })
    await applyManagedAgentModels(
      config({ vision: ref('managed-corp', 'v2') }),
      agent.api as never,
      store.api as never,
      'deepchat'
    )
    expect(store.getApplied().vision).toEqual(userPick)
  })

  it('does nothing when the payload has no agentModels', async () => {
    const agent = createAgentSettings()
    const store = createStore()
    await applyManagedAgentModels(config(null), agent.api as never, store.api as never, 'deepchat')
    expect(agent.api.updateDeepChatAgent).not.toHaveBeenCalled()
    expect(store.getApplied()).toEqual({})
  })

  it('skips fields the payload leaves null', async () => {
    const agent = createAgentSettings({ assistantModel: ref('openai', 'keep') })
    const store = createStore()
    await applyManagedAgentModels(
      config({ chat: ref('managed-corp', 'c1'), assistant: null, vision: null, imageGeneration: null }),
      agent.api as never,
      store.api as never,
      'deepchat'
    )
    expect(agent.api.updateDeepChatAgent).toHaveBeenCalledWith('deepchat', {
      defaultModelPreset: ref('managed-corp', 'c1')
    })
    expect(agent.getCurrent().assistantModel).toEqual(ref('openai', 'keep'))
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
  type AgentModelKey,
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

function sameRef(a: unknown, b: unknown): boolean {
  if (!a || !b) return false
  const left = a as { providerId?: unknown; modelId?: unknown }
  const right = b as { providerId?: unknown; modelId?: unknown }
  return left.providerId === right.providerId && left.modelId === right.modelId
}

/**
 * 按「默认值跟随，用户优先」规则把托管模型默认值写入内置 Agent 配置（见契约 §1.1）。
 * 返回实际写入的托管值映射，便于调用方持久化与排障。
 */
export async function applyManagedAgentModels(
  config: ManagedConfigPayload,
  agentSettings: ManagedAgentSettingsWriter,
  store: ManagedAgentAppliedStore,
  agentId: string
): Promise<Partial<ManagedAgentModels>> {
  const desired = config.agentModels
  if (!desired) return store.readAgentModelApplied()

  const current = (await agentSettings.getDeepChatAgentConfig(agentId)) ?? {}
  const applied = { ...store.readAgentModelApplied() }
  const patch: Record<string, unknown> = {}

  for (const key of AGENT_MODEL_KEYS) {
    const target = desired[key]
    if (!target) continue

    const field = MANAGED_AGENT_MODEL_FIELDS[key]
    const currentValue = current[field]
    const lastApplied = applied[key as AgentModelKey]

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
  return applied
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
      id: 'managed-corp',
      key: 'corp',
      name: 'Corp',
      apiType: 'openai' as never,
      baseUrl: 'https://gw/v1',
      apiKey: 'sk-x',
      enabled: true
    }
  ],
  agentModels: {
    chat: { providerId: 'managed-corp', modelId: 'gpt-4o' },
    assistant: null,
    vision: null,
    imageGeneration: null
  },
  documents: {
    textModel: { providerId: 'managed-corp', modelId: 'm1' },
    visionModel: { providerId: 'managed-corp', modelId: 'm2' },
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
  return {
    store,
    getConfig: () => config,
    getIds: () => ids,
    getMeta: () => meta,
    getAgentModelApplied: () => agentModelApplied
  }
}

const writer = { getProviders: () => [], setProvider: vi.fn(async () => {}) }

describe('syncManagedConfig', () => {
  it('skips entirely when no endpoint configured', async () => {
    const store = createStore()
    const result = await syncManagedConfig({
      endpoint: '',
      device: { username: 'u', domain: 'd', hostname: 'h', sid: 's' },
      store: store.store,
      writer: writer as never,
      knownProviderTypes: ['openai'],
      fetchImpl: vi.fn()
    })
    expect(result.status).toBe('skipped')
    expect(store.getConfig()).toBeNull()
  })

  it('persists config, ids and meta on applied', async () => {
    const store = createStore()
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        version: 1,
        providers: [{ key: 'corp', name: 'Corp', apiType: 'openai', baseUrl: 'https://gw/v1', apiKey: 'sk-x' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    )
    const result = await syncManagedConfig({
      endpoint: 'https://cfg',
      device: { username: 'u', domain: 'd', hostname: 'h', sid: 's' },
      store: store.store,
      writer: writer as never,
      knownProviderTypes: ['openai'],
      fetchImpl
    })
    expect(result.status).toBe('applied')
    expect(store.getIds()).toEqual(['managed-corp'])
    expect(store.getConfig()?.providers).toHaveLength(1)
    expect(store.getMeta()).toMatchObject({ username: 'u', endpoint: 'https://cfg' })
  })

  it('keeps cached config and managed mode when fetch is unavailable', async () => {
    const store = createStore({ config: payload })
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'))
    const result = await syncManagedConfig({
      endpoint: 'https://cfg',
      device: { username: 'u', domain: 'd', hostname: 'h', sid: 's' },
      store: store.store,
      writer: writer as never,
      knownProviderTypes: ['openai'],
      fetchImpl
    })
    expect(result.status).toBe('unavailable')
    expect(store.getConfig()).toEqual(payload)
  })

  it('re-applies cached config when unavailable so providers survive a wiped db', async () => {
    const store = createStore({ config: payload })
    const setProvider = vi.fn(async () => {})
    await syncManagedConfig({
      endpoint: 'https://cfg',
      device: { username: 'u', domain: 'd', hostname: 'h', sid: 's' },
      store: store.store,
      writer: { getProviders: () => [], setProvider } as never,
      knownProviderTypes: ['openai'],
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline'))
    })
    expect(setProvider).toHaveBeenCalledWith('managed-corp', expect.objectContaining({ apiKey: 'sk-x' }))
  })

  it('clears managed state on absent', async () => {
    const store = createStore({ config: payload })
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    const result = await syncManagedConfig({
      endpoint: 'https://cfg',
      device: { username: 'u', domain: 'd', hostname: 'h', sid: 's' },
      store: store.store,
      writer: writer as never,
      knownProviderTypes: ['openai'],
      fetchImpl
    })
    expect(result.status).toBe('absent')
    expect(store.getConfig()).toBeNull()
    expect(store.getIds()).toEqual([])
  })

  it('clears managed state on denied', async () => {
    const store = createStore({ config: payload })
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    const result = await syncManagedConfig({
      endpoint: 'https://cfg',
      device: { username: 'u', domain: 'd', hostname: 'h', sid: 's' },
      store: store.store,
      writer: writer as never,
      knownProviderTypes: ['openai'],
      fetchImpl
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
    ...(options.clientVersion ? { clientVersion: options.clientVersion } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  })

  if (result.status === 'unavailable') {
    const cached = store.readConfig()
    if (cached) {
      // 缓存存在：重新应用一次，覆盖被清空或被用户改动过的托管 provider
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

  store.writeConfig(config)
  store.writeMeta({ fetchedAt: Date.now(), username: device.username, endpoint })
  const ids = await applyManagedConfig(config, writer)
  store.writeProviderIds(ids)
  return { status: 'applied', config, warnings: result.warnings }
}
```

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2 → Expected: PASS

- [ ] **Step 5: 在 composition.ts 启动链接线**

先读 `src/main/app/composition.ts` 找到 documents 迁移调用点（`migrateDocumentsModelSettings(providerSettings)`）与设备信息获取方式（`src/main/device/index.ts` 的 `getDeviceInfo()`）；**必须插在 provider 初始化完成之后、documents 迁移之前**，这样 documents 迁移能读到已固化的托管 provider。

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
    clientVersion: app.getVersion()
  }).catch((error) => {
    console.warn('[managed] sync failed, continuing with cached state', error)
    return null
  })

  // 内置 Agent「模型默认值」四项：默认值跟随，用户改过则不覆盖（见契约 §1.1）
  if (managedResult?.config) {
    await applyManagedAgentModels(
      managedResult.config,
      agentSettings,
      managedStore,
      BUILTIN_DEEPCHAT_AGENT_ID
    ).catch((error) => {
      console.warn('[managed] agent model prefill failed', error)
    })
  }
```

同文件补充三个本地辅助函数（放在文件顶部 import 之后的模块级区域）：

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

function getKnownProviderTypes(): string[] {
  return Object.values(ProviderType) as string[]
}
```

> 实现提示：`ProviderType` 的实际枚举位置与导出名以 `src/shared/types/provider.ts` 为准；`getDeviceInfo()` 的返回结构以 `src/main/device/index.ts` 为准（必须含 `winAccount{username,domain,hostname,sid}`，非 Windows 平台该字段可能为空——空值时 `username` 为空串，接口调用仍可发出，由服务端决定是否返回配置）。imports 需补 `syncManagedConfig`、`createManagedConfigStore`、`applyManagedAgentModels`、`getDeviceInfo`、`ManagedDeviceInfo`、`ProviderType`、`BUILTIN_DEEPCHAT_AGENT_ID`、`agentSettings`。`agentSettings` 与 `BUILTIN_DEEPCHAT_AGENT_ID` 在 composition.ts 中已存在（`agentSettings` 另有约 18 处使用），直接引用即可；`applyManagedAgentModels` 的调用必须放在 `agentSettings` 初始化完成之后（见现场代码，与 documents 迁移同区段即可）。

- [ ] **Step 6: 补 composition 边界断言 + 验证 + 提交**

在既有 `test/main/app/compositionBoundaries.test.ts` 中追加一条源码断言，防止后续重构把托管接线删掉（沿用该文件既有的源码文本断言模式）：

```ts
it('wires managed config sync and agent model prefill into startup', () => {
  const source = readFileSync(compositionPath, 'utf8')
  expect(source).toContain('syncManagedConfig(')
  expect(source).toContain('applyManagedAgentModels(')
  expect(source).toContain('migrateDocumentsModelSettings(')
  // 托管同步必须排在 documents 迁移之前
  expect(source.indexOf('syncManagedConfig(')).toBeLessThan(
    source.indexOf('migrateDocumentsModelSettings(')
  )
})
```

> 实现提示：`compositionPath` / `readFileSync` 在既有文件中已有等价定义，直接复用其变量与导入，不要重复引入。

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
  const readProviderIds = vi.fn(() => ['managed-corp'])

  it('throws for managed provider on update', () => {
    expect(() => assertProviderWritable('managed-corp', 'update', readProviderIds)).toThrow(
      /\[managed\.providerLocked:managed-corp\]/
    )
  })

  it('throws for managed provider on remove', () => {
    expect(() => assertProviderWritable('managed-corp', 'remove', readProviderIds)).toThrow(
      /\[managed\.providerLocked:managed-corp\]/
    )
  })

  it('allows user providers', () => {
    expect(() => assertProviderWritable('openai', 'update', readProviderIds)).not.toThrow()
  })

  it('is case sensitive and does not match prefixes', () => {
    expect(() => assertProviderWritable('managed-corp-2', 'remove', readProviderIds)).not.toThrow()
    expect(() => assertProviderWritable('MANAGED-CORP', 'remove', readProviderIds)).not.toThrow()
  })

  it('allows everything when nothing is managed', () => {
    expect(() => assertProviderWritable('managed-corp', 'update', () => [])).not.toThrow()
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

先读 `src/main/provider/routes.ts:214-364`（`providers.setById` / `update` / `add` / `remove` / `reorder` 的实现）。对每个会修改既有 provider 的 handler，在处理体最前面插入守卫：

```ts
    assertProviderWritable(providerId, 'update', () => createManagedConfigStore().readProviderIds())
```

具体位置：
- `update` / `setById`：以被修改的 `id` 调用，action `'update'`
- `remove`：以被删除的 `id` 调用，action `'remove'`
- `reorder`：对入参里的每个 id 逐个调用，action `'reorder'`（只校验托管项顺序不被改；更简单做法是直接对全部入参 id 循环校验）
- `add`：若入参 id 命中托管集合则拒绝（防止用户伪造同 id 覆盖托管项），action `'update'`

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
- Modify: `src/main/app/composition.ts`（`resolveVisionTarget` / `resolveTextTarget` / 并发 / 推理参数）
- Modify: `src/main/documents/modelSettings.ts`（新增托管优先读取辅助）
- Test: `test/main/documents/managedOverride.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// test/main/documents/managedOverride.test.ts
import { describe, expect, it } from 'vitest'

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
    textModel: { providerId: 'managed-corp', modelId: 'corp-text' },
    visionModel: { providerId: 'managed-corp', modelId: 'corp-vision' },
    concurrency: 4,
    temperature: null,
    maxTokens: null
  }
}

describe('resolveDocumentsModelSettings', () => {
  it('uses user settings when nothing is managed', () => {
    expect(resolveDocumentsModelSettings(userSettings, null)).toEqual(userSettings)
  })

  it('managed models win over user settings', () => {
    const resolved = resolveDocumentsModelSettings(userSettings, managed)
    expect(resolved.textModel).toEqual({ providerId: 'managed-corp', modelId: 'corp-text' })
    expect(resolved.visionModel).toEqual({ providerId: 'managed-corp', modelId: 'corp-vision' })
  })

  it('managed concurrency and params win; null means provider default', () => {
    const resolved = resolveDocumentsModelSettings(userSettings, managed)
    expect(resolved.concurrency).toBe(4)
    expect(resolved.temperature).toBeNull()
    expect(resolved.maxTokens).toBeNull()
  })

  it('falls back to user value per field when managed field is null', () => {
    const partial: ManagedConfigPayload = {
      ...managed,
      documents: { ...managed.documents!, concurrency: null, temperature: 0.2 }
    }
    const resolved = resolveDocumentsModelSettings(userSettings, partial)
    expect(resolved.concurrency).toBe(6)
    expect(resolved.temperature).toBe(0.2)
  })

  it('keeps user value when managed documents section is absent', () => {
    const resolved = resolveDocumentsModelSettings(userSettings, {
      ...managed,
      documents: null
    })
    expect(resolved).toEqual(userSettings)
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

在 `src/main/documents/modelSettings.ts` 末尾追加（复用该文件既有的 `DocumentsModelRef` 与 `readDocumentsModelSettings` 返回类型）：

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

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2 → Expected: PASS

- [ ] **Step 5: 在 composition.ts 接入**

在 `composition.ts` 中，找到 documents 抽取器构建处与 `resolveVisionTarget` / `resolveTextTarget` / RecognitionTaskManager 并发注入处。**保留 `readDocumentsModelSettings(providerSettings)` 原调用不动**，只在其结果外层套一层托管优先解析。

具体做法：在文件模块级（或工厂函数内一次性）读取托管配置并缓存为常量，避免每次解析都读盘：

```ts
  // 企业托管配置（启动时已同步落盘）；documents 解析链托管优先
  const managedDocumentsConfig = createManagedConfigStore().readConfig()
```

然后在每个消费点把

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
- Modify: `src/shared/contracts/routes/providers.routes.ts`（输出加 `managed`）
- Modify: `src/shared/types/provider.ts`（`LLM_PROVIDER` 加 `managed?: boolean`）
- Modify: `src/main/provider/routes.ts`（list/listSummaries 输出填充 managed）
- Modify: `src/main/app/settingsRoutes.ts` + `src/shared/contracts/routes/config.routes.ts`（managed.* 只读键）
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

> 实现提示：`defineRoute` 的实际辅助名与导入路径以 `src/shared/contracts/routes/providers.routes.ts` 的既有写法为准，照抄该模式。

- [ ] **Step 2: 主进程 handler**

在 `src/main/app/settingsRoutes.ts`（或与 provider 路由同文件的注册区）注册两个 handler：

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

- `managed.getStatus` → 直接返回 `readManagedStatus()`
- `managed.refresh` → 复用 Task 3 的 `syncManagedConfig(...)`（endpoint/device/writer 取自 composition 暴露的同一实例），完成后返回 `readManagedStatus()`

- [ ] **Step 3: provider 输出带 managed 标记**

`src/shared/types/provider.ts` 的 `LLM_PROVIDER` 增加：

```ts
  /** 是否由企业统一配置（托管），true 时本地不可修改 */
  managed?: boolean
```

`src/main/provider/routes.ts` 的 `list` / `listSummaries` 返回处，对每条 provider 注入：

```ts
      managed: managedProviderIds.includes(provider.id)
```

其中 `managedProviderIds` 一次读取：

```ts
  const managedProviderIds = createManagedConfigStore().readProviderIds()
```

- [ ] **Step 4: 渲染端 client 与 store**

```ts
// src/renderer/api/ManagedClient.ts
import { createManagedRoutesClient } from '@shared/contracts/routes/managed.routes'
```

> 实现提示：渲染端 client 的建法照抄 `src/renderer/api/ProviderClient.ts` 的既有模式（同一个 rpc 调用封装），只暴露 `getStatus()` 与 `refresh()`。

```ts
// src/renderer/src/stores/managedStore.ts
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

  async function refresh() {
    loading.value = true
    try {
      const status = await client.getStatus()
      managed.value = status.managed
      providerIds.value = status.providerIds
      documentsLocked.value = status.documentsLocked
      username.value = status.username
      endpoint.value = status.endpoint
    } finally {
      loading.value = false
    }
  }

  function isManagedProvider(providerId: string) {
    return providerIds.value.includes(providerId)
  }

  return { managed, providerIds, documentsLocked, username, endpoint, loading, refresh, isManagedProvider }
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
      providerIds: ['managed-corp'],
      documentsLocked: true,
      username: 'zhangsan',
      endpoint: 'https://cfg',
      fetchedAt: 1
    })
    const store = useManagedStore()
    await store.refresh()
    expect(store.managed).toBe(true)
    expect(store.documentsLocked).toBe(true)
    expect(store.isManagedProvider('managed-corp')).toBe(true)
    expect(store.isManagedProvider('openai')).toBe(false)
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

## Task 7: 服务商设置页锁定 UI

**Files:**
- Modify: `src/renderer/settings/components/ProviderSettings.vue`（先确认实际文件名；若服务商页在 `src/renderer/src/pages/settings/` 下同样处理）
- Test: `test/renderer/settings/providerManagedLock.test.ts`

**背景**：托管项要「可见但禁用」。先读该组件，确认它如何渲染 provider 列表与编辑表单（找到名称/地址/API Key/类型输入框，以及删除/复制/停用按钮的模板位置），按现场结构落地。

- [ ] **Step 1: 写失败测试**

```ts
// test/renderer/settings/providerManagedLock.test.ts
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const providerList = [
  { id: 'managed-corp', name: 'Corp Gateway', apiType: 'openai', baseUrl: 'https://gw', apiKey: 'sk-x', enable: true, managed: true },
  { id: 'openai', name: 'My OpenAI', apiType: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'sk-mine', enable: true, managed: false }
]

vi.mock('@/stores/providerStore', () => ({
  useProviderStore: () => ({
    providers: providerList,
    sortedProviders: providerList,
    initialize: vi.fn(),
    updateProvider: vi.fn(),
    removeProvider: vi.fn()
  })
}))

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

- [ ] **Step 3: 实现 `src/renderer/settings/components/ProviderManagedBadge.vue`**

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

在 `ProviderSettings.vue`（实际文件名以现场为准）：

1. 引入 `ProviderManagedBadge` 与 `useManagedStore`
2. provider 列表项渲染处，名称旁插入 `<ProviderManagedBadge :managed="provider.managed ?? false" />`
3. 编辑表单：当 `provider.managed === true` 时，名称 / 地址 / API Key / 类型输入框加 `:disabled="true"`；若组件用 `readonly` 语义则用 `:readonly="true"`（按现场输入组件选）
4. 操作按钮：当 `isManaged` 时，`v-if="!isManaged"` 隐藏「删除」「复制」「停用/启用」按钮
5. 表单顶部（托管时）加说明行：

```vue
<p v-if="isManaged" class="text-xs text-muted-foreground" data-testid="provider-managed-hint">
  {{ t('settings.managed.providerHint') }}
</p>
```

6. 在 `onMounted` 中调用 `managedStore.refresh()`，让锁定状态在进入页面时即生效

- [ ] **Step 6: 验证 + 提交**

Run:
```
pnpm exec vitest run test/renderer/settings
pnpm run typecheck:web
```
Expected: PASS

```bash
git add src/renderer/settings/components/ProviderSettings.vue src/renderer/settings/components/ProviderManagedBadge.vue test/renderer/settings/providerManagedLock.test.ts
git commit -m "feat(managed): lock managed providers in settings ui"
```

---

## Task 8: 智能信息提取设置页只读

**Files:**
- Modify: `src/renderer/settings/components/DocumentsModelsSettings.vue`
- Test: `test/renderer/components/DocumentsModelsSettingsManaged.test.ts`

**背景**：内置 Agent 的「模型默认值」四项预填已在 Task 2/3 由主进程完成，本 Task 只处理智能信息提取页的完全只读。

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

const managedStatus = { value: { managed: true, documentsLocked: true, providerIds: ['managed-corp'] } }

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
    sortedProviders: [{ id: 'managed-corp', name: 'Corp', enable: true, managed: true }],
    providers: [{ id: 'managed-corp', name: 'Corp', enable: true, managed: true }]
  })
}))

vi.mock('@/stores/modelStore', () => ({
  useModelStore: () => ({
    allProviderModels: [
      { providerId: 'managed-corp', models: [{ id: 'corp-text', name: 'Corp Text' }, { id: 'corp-vision', name: 'Corp Vision', vision: true }] }
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
    managedStatus.value = { managed: true, documentsLocked: true, providerIds: ['managed-corp'] }
    getSettingMock.mockImplementation((key: string) => {
      if (key === 'documents.textModel') return { providerId: 'managed-corp', modelId: 'corp-text' }
      if (key === 'documents.visionModel') return { providerId: 'managed-corp', modelId: 'corp-vision' }
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

1. 引入并调用 `const managedStore = useManagedStore()`，`onMounted` 里额外 `await managedStore.refresh()`
2. 新增计算属性：

```ts
const locked = computed(() => managedStore.documentsLocked)
```

3. 模板顶部加徽章与说明：

```vue
<div v-if="locked" class="flex items-start gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm" data-testid="documents-models-managed-badge">
  <span>{{ t('settings.managed.documentsBadge') }}</span>
</div>
```

4. 所有输入控件加禁用：模型选择触发器按钮加 `:disabled="locked"`、并发/温度/maxTokens 的 `<input>` 加 `:disabled="locked"`；`locked` 时不再打开 Popover（`@click` 前置判断或 `:disabled` 天然阻断）
5. 保存按钮整块隐藏：

```vue
<div v-if="!locked" class="flex items-center gap-3">
  <!-- 既有保存按钮与状态文案 -->
</div>
```

6. 兜底：`save()` 开头加 `if (locked.value) return`，防止外部调用写入

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

**Files:**
- Modify: `src/renderer/src/i18n/*/settings.json` ×20
- Modify: `src/renderer/src/i18n/*/documents.json` ×20（如需）
- Modify: `src/renderer/src/i18n/*/routes.json` ×20（如需新路由）

- [ ] **Step 1: zh-CN settings.json 追加**

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

1. 不设 `DEEPCHAT_MANAGED_CONFIG_URL`：启动无托管，服务商页、Agent 设置页与识别模型页行为与现状完全一致（回归确认）
2. 设 `DEEPCHAT_MANAGED_CONFIG_URL` 指向 mock 服务（可用本地 json-server 按上述契约返回一条 provider + `agentModels` 四项）：启动后服务商页出现该 provider，带「由企业统一配置」徽章，输入框禁用，无删除按钮
3. **Agent 设置页「模型默认值」四项被预填为下发的托管模型**（首次启动，原本为空）
4. 在 Agent 设置页手动把「视觉模型」改成自有 provider 的模型 → 重启应用（企业 mock 仍返回原托管值）→ **该字段保持用户选择不被覆盖**，其余未改过的字段仍跟随托管值
5. 识别模型页：整页只读、无保存按钮；任务实际使用下发的 text/vision 模型
6. 断开 mock 服务重启：配置保留（走缓存），页面仍为锁定态
7. 手动在服务商页新增一个自有 provider：可正常新增/编辑/删除，与托管项并存
8. 服务端改为返回 404 后重启：托管态清除，页面恢复可编辑

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/i18n
git commit -m "i18n: add managed provider copy"
```

---

## 自检记录

**Spec 覆盖**：服务商配置统一管理（Task 1-4、6、7）✓；按用户名自动获取（Task 1、3）✓；多服务商与供应商类型（Task 1 schema）✓；自动配置后不可修改（Task 4 主进程写保护 + Task 7 UI 锁定）✓；用户可自定义添加其它服务商（Task 4 仅拦托管 id + Task 7 UI 并存）✓；内置 Agent「模型默认值」四项托管预填且用户可改为自有 provider 模型（Task 1 契约 + Task 2 applyAgentModels + Task 3 接线 + Task 9 冒烟 3/4）✓；智能信息提取不可修改（Task 5 托管优先 + Task 8 只读页）✓；离线可用（Task 3 缓存回退）✓。

**未纳入（YAGNI，明确不做）**：定时轮询刷新（已选「每次启动拉取」）；服务端下发模型清单（已选「仅下发默认模型 id」）；apiKey 在渲染端脱敏改造（涉及既有全局行为，超出本需求范围）；托管 provider 的 OAuth 流程；Agent 设置页对托管默认值的锁定或来源徽章（按需求该处保持用户可自由修改，不加锁定 UI）。

**类型一致性**：`ManagedConfigPayload` / `ManagedProvider` / `ManagedModelRef` / `ManagedAgentModels` / `AgentModelKey` / `ManagedDocumentsConfig` / `SyncStatus` / `SyncResult` 在 Task 1 定义，Task 2/3/5/6 引用一致；`MANAGED_AGENT_MODEL_FIELDS`（`chat→defaultModelPreset` 等映射）在 Task 1 定义并被 Task 2 的 `applyAgentModels` 使用；`ManagedConfigStore` 方法名 `readConfig/writeConfig/readMeta/writeMeta/readProviderIds/writeProviderIds/readAgentModelApplied/writeAgentModelApplied` 在 Task 2 定义并被 Task 3/6 一致使用；`applyManagedConfig(config, writer)` 与 `applyManagedAgentModels(config, agentSettings, store, agentId)` 签名在 Task 2 定义、Task 3 调用一致；`assertProviderWritable(providerId, action, readManagedProviderIds)` 在 Task 4 定义并调用一致；`resolveDocumentsModelSettings(userSettings, managed)` 在 Task 5 定义并调用一致。
