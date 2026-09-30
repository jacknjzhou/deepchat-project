# 单据识别模型设置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为"单据档案"新增独立模型设置页（设置 → Agent设置 → 单据识别模型），可配置文本/视觉模型（必填）、并发与推理参数，未配置则功能不可用并引导配置。

**Architecture:** 方案A——复用 settings 键值存储（新增 `documents.*` 键），主进程新建 `src/main/documents/modelSettings.ts` 纯逻辑模块（读取/迁移/校验），composition.ts 注入改造 `resolveTextTarget`/`resolveVisionTarget`（删除全局回退链）；renderer 新页面复用 `ModelSelect.vue`；错误用稳定前缀码经现有任务错误管道传递，渲染端映射为 20 locale 文案。

**Tech Stack:** Electron/Vue3/TS/Pinia、zod、Vitest（main 用 `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run <files> --config vitest.config.ts`）、vue-i18n。

**Spec:** `docs/superpowers/specs/2026-09-30-documents-model-settings-design.md`

**关键事实（执行者必读）：**
- settings 路由由 `src/renderer/settings/main.ts:22-50` 从 `getSettingsRouteItems()` + `settingsRouteComponents` **自动生成**，注册只需改两个文件，不改 router
- `ModelSelect.vue`（`src/renderer/src/components/ModelSelect.vue`）props：`vision-only`、`:respect-chat-mode="false"`、`selected-provider-id`、`selected-model-id`；emit `update:model(model, providerId)`
- composition 中 settings 访问对象是 `providerSettings`（`getSetting<T>(key)` / `setSetting(key, value)`）与 `dependencies.settingsStore.get<T>(key)`
- `documentExtractor.ts:69` 已有 `ModelNotConfiguredError`；`requireTarget(target, settingName)` 在 452-462 行
- oxfmt 格式化；Conventional Commits ≤50 字符；i18n 键先加 zh-CN 与 en-US，其余 18 locale 用 en-US 同文（仓库惯例），最后跑 `pnpm run i18n`

---

### Task 1: 主进程 modelSettings 模块（TDD）

**Files:**
- Create: `src/main/documents/modelSettings.ts`
- Test: `test/main/documents/modelSettings.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

import {
  DOCUMENTS_SETTINGS_KEYS,
  DEFAULT_DOCUMENTS_CONCURRENCY,
  migrateDocumentsModelSettings,
  readDocumentsModelSettings,
  validateDocumentsModelRef,
  type DocumentsSettingsStore
} from '@/main/documents/modelSettings'

function createStore(initial: Record<string, unknown> = {}): DocumentsSettingsStore & {
  data: Record<string, unknown>
} {
  const data: Record<string, unknown> = { ...initial }
  return {
    data,
    getSetting: <T,>(key: string) => data[key] as T | undefined,
    setSetting: (key: string, value: unknown) => {
      data[key] = value
    }
  }
}

describe('readDocumentsModelSettings', () => {
  it('returns defaults when keys are absent', () => {
    const store = createStore()
    const settings = readDocumentsModelSettings(store)
    expect(settings).toEqual({
      textModel: null,
      visionModel: null,
      concurrency: DEFAULT_DOCUMENTS_CONCURRENCY,
      temperature: null,
      maxTokens: null
    })
  })

  it('reads stored values and clamps concurrency into 1-10', () => {
    const store = createStore({
      [DOCUMENTS_SETTINGS_KEYS.textModel]: { providerId: 'p1', modelId: 'm1' },
      [DOCUMENTS_SETTINGS_KEYS.visionModel]: { providerId: 'p1', modelId: 'm2' },
      [DOCUMENTS_SETTINGS_KEYS.concurrency]: 99,
      [DOCUMENTS_SETTINGS_KEYS.temperature]: 0.3,
      [DOCUMENTS_SETTINGS_KEYS.maxTokens]: 4096
    })
    const settings = readDocumentsModelSettings(store)
    expect(settings.textModel).toEqual({ providerId: 'p1', modelId: 'm1' })
    expect(settings.visionModel).toEqual({ providerId: 'p1', modelId: 'm2' })
    expect(settings.concurrency).toBe(10)
    expect(settings.temperature).toBe(0.3)
    expect(settings.maxTokens).toBe(4096)
  })

  it('drops malformed model refs', () => {
    const store = createStore({ [DOCUMENTS_SETTINGS_KEYS.textModel]: { providerId: '' } })
    expect(readDocumentsModelSettings(store).textModel).toBeNull()
  })
})

describe('migrateDocumentsModelSettings', () => {
  it('prefills from global defaults once and marks migrated', () => {
    const store = createStore({
      defaultModel: { providerId: 'g1', modelId: 'gm1' },
      defaultVisionModel: { providerId: 'g1', modelId: 'gm2' }
    })
    migrateDocumentsModelSettings(store)
    expect(store.data[DOCUMENTS_SETTINGS_KEYS.textModel]).toEqual({ providerId: 'g1', modelId: 'gm1' })
    expect(store.data[DOCUMENTS_SETTINGS_KEYS.visionModel]).toEqual({ providerId: 'g1', modelId: 'gm2' })
    expect(store.data[DOCUMENTS_SETTINGS_KEYS.migrated]).toBe(true)
  })

  it('does not overwrite user-cleared refs on rerun', () => {
    const store = createStore({
      [DOCUMENTS_SETTINGS_KEYS.migrated]: true,
      [DOCUMENTS_SETTINGS_KEYS.textModel]: null
    })
    migrateDocumentsModelSettings(store)
    expect(store.data[DOCUMENTS_SETTINGS_KEYS.textModel]).toBeNull()
  })

  it('marks migrated even without global defaults', () => {
    const store = createStore()
    migrateDocumentsModelSettings(store)
    expect(store.data[DOCUMENTS_SETTINGS_KEYS.migrated]).toBe(true)
  })
})

describe('validateDocumentsModelRef', () => {
  const providers = [
    { id: 'p1', enable: true },
    { id: 'p2', enable: false }
  ]
  const getProviderModels = (providerId: string) =>
    providerId === 'p1' ? [{ id: 'm1' }, { id: 'm2' }] : []

  it('returns null for valid ref', () => {
    expect(validateDocumentsModelRef({ providerId: 'p1', modelId: 'm1' }, providers, getProviderModels)).toBeNull()
  })
  it('detects missing provider', () => {
    expect(validateDocumentsModelRef({ providerId: 'px', modelId: 'm1' }, providers, getProviderModels)).toBe('providerMissing')
  })
  it('detects disabled provider', () => {
    expect(validateDocumentsModelRef({ providerId: 'p2', modelId: 'm1' }, providers, getProviderModels)).toBe('providerDisabled')
  })
  it('detects missing model', () => {
    expect(validateDocumentsModelRef({ providerId: 'p1', modelId: 'mx' }, providers, getProviderModels)).toBe('modelMissing')
  })
  it('returns null for empty ref', () => {
    expect(validateDocumentsModelRef(null, providers, getProviderModels)).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/modelSettings.test.ts --config vitest.config.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/main/documents/modelSettings.ts`**

```ts
import { z } from 'zod'

export interface DocumentsModelRef {
  providerId: string
  modelId: string
}

export interface DocumentsSettingsStore {
  getSetting<T>(key: string): T | undefined
  setSetting(key: string, value: unknown): void
}

export const DOCUMENTS_SETTINGS_KEYS = {
  textModel: 'documents.textModel',
  visionModel: 'documents.visionModel',
  concurrency: 'documents.concurrency',
  temperature: 'documents.temperature',
  maxTokens: 'documents.maxTokens',
  migrated: 'documents.settingsMigrated'
} as const

export const DEFAULT_DOCUMENTS_CONCURRENCY = 4

const modelRefSchema = z.object({ providerId: z.string().min(1), modelId: z.string().min(1) })

export interface DocumentsModelSettings {
  textModel: DocumentsModelRef | null
  visionModel: DocumentsModelRef | null
  concurrency: number
  temperature: number | null
  maxTokens: number | null
}

const clampConcurrency = (value: number): number => Math.min(10, Math.max(1, Math.round(value)))

const sanitizeRef = (value: unknown): DocumentsModelRef | null => {
  const parsed = modelRefSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function readDocumentsModelSettings(store: DocumentsSettingsStore): DocumentsModelSettings {
  const concurrency = store.getSetting<number>(DOCUMENTS_SETTINGS_KEYS.concurrency)
  const temperature = store.getSetting<number>(DOCUMENTS_SETTINGS_KEYS.temperature)
  const maxTokens = store.getSetting<number>(DOCUMENTS_SETTINGS_KEYS.maxTokens)
  return {
    textModel: sanitizeRef(store.getSetting(DOCUMENTS_SETTINGS_KEYS.textModel)),
    visionModel: sanitizeRef(store.getSetting(DOCUMENTS_SETTINGS_KEYS.visionModel)),
    concurrency: clampConcurrency(typeof concurrency === 'number' ? concurrency : DEFAULT_DOCUMENTS_CONCURRENCY),
    temperature: typeof temperature === 'number' ? temperature : null,
    maxTokens: typeof maxTokens === 'number' ? maxTokens : null
  }
}

export function migrateDocumentsModelSettings(store: DocumentsSettingsStore): void {
  if (store.getSetting<boolean>(DOCUMENTS_SETTINGS_KEYS.migrated)) return
  if (!store.getSetting(DOCUMENTS_SETTINGS_KEYS.textModel)) {
    const textFallback = sanitizeRef(store.getSetting('defaultModel'))
    if (textFallback) store.setSetting(DOCUMENTS_SETTINGS_KEYS.textModel, textFallback)
  }
  if (!store.getSetting(DOCUMENTS_SETTINGS_KEYS.visionModel)) {
    const visionFallback = sanitizeRef(store.getSetting('defaultVisionModel'))
    if (visionFallback) store.setSetting(DOCUMENTS_SETTINGS_KEYS.visionModel, visionFallback)
  }
  store.setSetting(DOCUMENTS_SETTINGS_KEYS.migrated, true)
}

export type DocumentsConfigInvalidReason = 'providerMissing' | 'providerDisabled' | 'modelMissing'

export interface DocumentsProviderLike {
  id: string
  enable: boolean
}

export function validateDocumentsModelRef(
  ref: DocumentsModelRef | null,
  providers: DocumentsProviderLike[],
  getProviderModels: (providerId: string) => Array<{ id: string }>
): DocumentsConfigInvalidReason | null {
  if (!ref) return null
  const provider = providers.find((item) => item.id === ref.providerId)
  if (!provider) return 'providerMissing'
  if (!provider.enable) return 'providerDisabled'
  if (!getProviderModels(ref.providerId).some((model) => model.id === ref.modelId)) return 'modelMissing'
  return null
}
```

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2
Expected: 12 passed

- [ ] **Step 5: Commit**

```bash
git add src/main/documents/modelSettings.ts test/main/documents/modelSettings.test.ts
git commit -m "feat(documents): add model settings module"
```

---

### Task 2: composition 接线（解析链/迁移/并发/推理参数）

**Files:**
- Modify: `src/main/app/composition.ts:2881-2943`（documents 组装区）

- [ ] **Step 1: 导入模块并在 documents 初始化前执行迁移**

在 `documentExtractor = new DocumentExtractor({...})` 之前插入：

```ts
migrateDocumentsModelSettings(providerSettings)
```

import 区加：`import { migrateDocumentsModelSettings, readDocumentsModelSettings, validateDocumentsModelRef } from '../documents/modelSettings'`（路径以 composition.ts 实际相对层级为准，用 `from '../documents/modelSettings'`，若编译报错改 `@main/documents/modelSettings` 等价别名）

- [ ] **Step 2: 替换 resolveTextTarget/resolveVisionTarget（删除全局回退链）**

```ts
      resolveVisionTarget: async () => readDocumentsModelSettings(providerSettings).visionModel,
      resolveTextTarget: async () => readDocumentsModelSettings(providerSettings).textModel,
```

同时删除原实现中对 `defaultVisionModel`/`defaultModel`/`agentSettings.getDeepChatAgentConfig`/`pickVisionTarget`/`isVisionCapable` 的引用。若 `pickVisionTarget` 导入不再被 composition 使用，从 import 中移除；`visionTarget.ts` 文件保留（extractor 测试仍在用）。

- [ ] **Step 3: taskManager 并发与 generateCompletion 透传**

`new DocumentTaskManager({...})`（在同一组装区，grep `new DocumentTaskManager`）处：

```ts
        concurrency: readDocumentsModelSettings(providerSettings).concurrency,
```

`generateCompletion` 闭包改为实时读推理参数（留空沿用 extractor 传入值）：

```ts
      generateCompletion: ({ providerId, modelId, messages, temperature, maxTokens }) => {
        const generation = readDocumentsModelSettings(providerSettings)
        return providerRuntime.generateCompletionStandalone(
          providerId,
          messages,
          modelId,
          generation.temperature ?? temperature,
          generation.maxTokens ?? maxTokens,
          { swallowErrors: false }
        )
      },
```

- [ ] **Step 4: 运行时失效校验（provider 删除/停用/模型消失）**

在 resolve 闭包内追加校验（两个 resolve 同样处理）。以 text 为例：

```ts
      resolveTextTarget: async () => {
        const ref = readDocumentsModelSettings(providerSettings).textModel
        if (!ref) return null
        const reason = validateDocumentsModelRef(
          ref,
          providerManager.getProviders().map((p) => ({ id: p.id, enable: p.enable })),
          (providerId) => providerSettings.getProviderModels(providerId) ?? []
        )
        if (reason) throw new DocumentsModelConfigError(reason, ref)
        return ref
      },
```

`DocumentsModelConfigError` 定义在 `src/main/documents/modelSettings.ts` 末尾追加：

```ts
export class DocumentsModelConfigError extends Error {
  readonly reason: DocumentsConfigInvalidReason
  readonly ref: DocumentsModelRef
  constructor(reason: DocumentsConfigInvalidReason, ref: DocumentsModelRef) {
    // 稳定前缀码，渲染端 documentsTaskErrors.ts 按此映射本地化文案
    super(`[documents.${reason}:${ref.providerId}|${ref.modelId}] documents model config invalid`)
    this.reason = reason
    this.ref = ref
  }
}
```

`providerManager` 的实际变量名以 composition.ts 中 provider 列表来源为准（grep `getProviders()` 取现有用法；若不存在则用 providerSettings 已暴露的 provider 枚举，保持"存在/enable"两个事实即可）。

- [ ] **Step 5: requireTarget 错误消息改为稳定前缀码**

`documentExtractor.ts:452-462`，`ModelNotConfiguredError` 消息改为可识别前缀：

```ts
      throw new ModelNotConfiguredError(
        `[documents.modelRequired] No documents extraction model configured. Open Settings -> Agent -> Document Models.`
      )
```

调用点 `settingName` 实参（'defaultVisionModel'/'defaultModel'，120-123/299 行）保持不变（仅作内部标识）。

- [ ] **Step 6: typecheck + 相关测试**

Run: `pnpm run typecheck:node`
Expected: PASS（若 composition 中 `pickVisionTarget` 等删除后产生未用导入报错，一并清理）
Run: `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents test/main/device --config vitest.config.ts`
Expected: documents 相关既有用例如依赖旧回退链则改为预置 `documents.*` 键后断言（最小改动：在用例的 store 初始数据里加 `documents.textModel` 等键）

- [ ] **Step 7: Commit**

```bash
git add src/main/app/composition.ts src/main/documents/modelSettings.ts src/main/documents/extractor/documentExtractor.ts test/main/documents
git commit -m "feat(documents): wire dedicated model settings"
```

---

### Task 3: 渲染端任务错误文案映射

**Files:**
- Create: `src/renderer/src/lib/documentsTaskErrors.ts`
- Test: `test/renderer/lib/documentsTaskErrors.test.ts`
- Modify: 任务错误展示点（Step 4 定位）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { formatDocumentsTaskError } from '@/lib/documentsTaskErrors'

const t = (key: string, params?: Record<string, string>) => `${key}${params ? `:${JSON.stringify(params)}` : ''}`

describe('formatDocumentsTaskError', () => {
  it('maps modelRequired prefix', () => {
    expect(formatDocumentsTaskError('[documents.modelRequired] No documents extraction model configured.', t)).toBe(
      'documents.errors.modelRequired'
    )
  })
  it('maps providerMissing with provider param', () => {
    expect(formatDocumentsTaskError('[documents.providerMissing:g1|m1] boom', t)).toBe(
      'documents.errors.modelProviderMissing:{"provider":"g1"}'
    )
  })
  it('maps providerDisabled to the same copy as providerMissing', () => {
    expect(formatDocumentsTaskError('[documents.providerDisabled:g2|m1] boom', t)).toBe(
      'documents.errors.modelProviderMissing:{"provider":"g2"}'
    )
  })
  it('maps modelMissing with model param', () => {
    expect(formatDocumentsTaskError('[documents.modelMissing:p1|mx] boom', t)).toBe(
      'documents.errors.modelMissing:{"model":"mx"}'
    )
  })
  it('returns null for unrelated errors', () => {
    expect(formatDocumentsTaskError('network timeout', t)).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**（同 Task 1 Step 2 的命令模式，路径改为本测试文件）

- [ ] **Step 3: 实现 `src/renderer/src/lib/documentsTaskErrors.ts`**

```ts
type Translate = (key: string, params?: Record<string, string>) => string

const PROVIDER_REF_PATTERN = /^\[documents\.(providerMissing|providerDisabled):([^|\]]*)\|/
const MODEL_REF_PATTERN = /^\[documents\.modelMissing:([^|\]]*)\|([^|\]]*)\]/

/**
 * 把主进程任务错误里的稳定前缀码映射为本地化文案；
 * 未命中前缀返回 null，调用方回退显示原始错误串。
 */
export function formatDocumentsTaskError(raw: string, t: Translate): string | null {
  if (raw.startsWith('[documents.modelRequired]')) {
    return t('documents.errors.modelRequired')
  }
  const providerMatch = raw.match(PROVIDER_REF_PATTERN)
  if (providerMatch) {
    return t('documents.errors.modelProviderMissing', { provider: providerMatch[2] })
  }
  const modelMatch = raw.match(MODEL_REF_PATTERN)
  if (modelMatch) {
    return t('documents.errors.modelMissing', { model: modelMatch[2] })
  }
  return null
}
```

- [ ] **Step 4: 接入任务错误展示点**

Run: `Grep pattern "error" glob "src/renderer/src/**/documents/**" -i`（以及组件目录中渲染任务失败原因的位置，典型为任务列表/详情的 error 行）
Expected: 找到渲染 `task.error`（或同义字段）的模板行
在展示处改为：

```ts
const localizedError = computed(() =>
  formatDocumentsTaskError(task.error ?? '', t) ?? task.error
)
```

模板中 `{{ task.error }}` 替换为 `{{ localizedError }}`（变量名随现场调整；保留原始串兜底）。

- [ ] **Step 5: 运行确认通过 + Commit**

```bash
pnpm exec vitest run test/renderer/lib/documentsTaskErrors.test.ts
git add src/renderer/src/lib/documentsTaskErrors.ts test/renderer/lib/documentsTaskErrors.test.ts <展示点文件>
git commit -m "feat(documents): localize task model errors"
```

---

### Task 4: 导航与路由注册（含 routes i18n）

**Files:**
- Modify: `src/shared/settingsNavigation.ts`（routeName 联合类型 + items 数组）
- Modify: `src/renderer/settings/settingsRouteComponents.ts`
- Modify: `src/renderer/src/i18n/*/routes.json` ×20

- [ ] **Step 1: settingsNavigation.ts**

联合类型（第 2-37 行）加 `'settings-documents-models'`；`SETTINGS_NAVIGATION_ITEMS` 中 `settings-deepchat-agents` 条目（140-147 行）之后插入：

```ts
  {
    routeName: 'settings-documents-models',
    path: '/documents-models',
    titleKey: 'routes.settings-documents-models',
    icon: 'lucide:receipt-text',
    position: 3.55,
    groupKey: 'models',
    keywords: ['documents', 'models', 'extraction', '单据', '识别', '模型', '提取']
  },
```

- [ ] **Step 2: settingsRouteComponents.ts 追加**

```ts
  'settings-documents-models': () => import('./components/DocumentsModelsSettings.vue'),
```

- [ ] **Step 3: routes.json ×20**

zh-CN：`"settings-documents-models": "单据识别模型"`；en-US：`"settings-documents-models": "Document Models"`；其余 18 locale 用 en-US 同文（键按字母序插入 `settings-documents` 附近）。

- [ ] **Step 4: 验证 + Commit**

Run: `pnpm run typecheck:web`（此时页面文件尚不存在会 FAIL——先建最小占位组件再验证）

先建占位 `src/renderer/settings/components/DocumentsModelsSettings.vue`：

```vue
<template>
  <div class="p-6 text-sm">{{ t('settings.documentsModels.title') }}</div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
</script>
```

Run: `pnpm run typecheck:web`
Expected: PASS
```bash
git add src/shared/settingsNavigation.ts src/renderer/settings/settingsRouteComponents.ts src/renderer/settings/components/DocumentsModelsSettings.vue src/renderer/src/i18n
git commit -m "feat(documents): register document models page"
```

---

### Task 5: 设置页完整实现 + 组件测试

**Files:**
- Modify: `src/renderer/settings/components/DocumentsModelsSettings.vue`（替换占位）
- Test: `test/renderer/components/DocumentsModelsSettings.test.ts`
- 参照：`test/renderer/components/AboutUsSettings.test.ts` 的 mock 模式

- [ ] **Step 1: 写失败测试**

```ts
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSettingMock = vi.fn()
const setSettingMock = vi.fn()

vi.mock('@api/SettingsClient', () => ({
  createSettingsClient: () => ({
    getSetting: (...args: unknown[]) => getSettingMock(...args),
    setSetting: (...args: unknown[]) => setSettingMock(...args)
  })
}))

vi.mock('@/stores/providerStore', () => ({
  useProviderStore: () => ({
    sortedProviders: [
      { id: 'p1', name: 'Provider One', enable: true },
      { id: 'p2', name: 'Provider Two', enable: false }
    ]
  })
}))

vi.mock('@/stores/modelStore', () => ({
  useModelStore: () => ({
    allProviderModels: [
      { providerId: 'p1', models: [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'Vision One', vision: true }] }
    ],
    enabledModels: []
  })
}))

import DocumentsModelsSettings from '@/settings/components/DocumentsModelsSettings.vue'

const mountPage = () =>
  mount(DocumentsModelsSettings, {
    global: {
      plugins: [
        createI18n({ legacy: false, locale: 'en-US', messages: { 'en-US': {} } })
      ]
    }
  })

describe('DocumentsModelsSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads saved settings and marks page loaded', async () => {
    getSettingMock.mockImplementation((key: string) => {
      if (key === 'documents.textModel') return { providerId: 'p1', modelId: 'm1' }
      if (key === 'documents.visionModel') return { providerId: 'p1', modelId: 'm2' }
      if (key === 'documents.concurrency') return 6
      return undefined
    })
    const wrapper = mountPage()
    await flushPromises()
    expect(getSettingMock).toHaveBeenCalledWith('documents.textModel')
    expect(wrapper.vm.savedTextModel).toEqual({ providerId: 'p1', modelId: 'm1' })
    expect(wrapper.vm.savedVisionModel).toEqual({ providerId: 'p1', modelId: 'm2' })
  })

  it('disables save when text model missing', async () => {
    getSettingMock.mockReturnValue(undefined)
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.vm.canSave).toBe(false)
  })

  it('flags invalid provider row as providerMissing', async () => {
    getSettingMock.mockImplementation((key: string) => {
      if (key === 'documents.textModel') return { providerId: 'p2', modelId: 'm1' }
      return undefined
    })
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.vm.textInvalidReason).toBe('providerDisabled')
  })

  it('saves text/vision/concurrency/params on save', async () => {
    getSettingMock.mockReturnValue(undefined)
    const wrapper = mountPage()
    await flushPromises()
    wrapper.vm.savedTextModel = { providerId: 'p1', modelId: 'm1' }
    wrapper.vm.savedVisionModel = { providerId: 'p1', modelId: 'm2' }
    wrapper.vm.concurrency = 5
    await wrapper.vm.save()
    const keys = setSettingMock.mock.calls.map((call) => call[0])
    expect(keys).toContain('documents.textModel')
    expect(keys).toContain('documents.visionModel')
    expect(keys).toContain('documents.concurrency')
  })
})
```

（mock 路径 `@api/SettingsClient` 以页面实际 import 为准——执行时先在页面里定 import，再让测试 mock 同一路径；若设置窗口用别的 client，mock 那个。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run test/renderer/components/DocumentsModelsSettings.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现完整页面**

```vue
<template>
  <div class="h-full overflow-y-auto" data-testid="documents-models-page">
    <div class="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <div>
        <h1 class="text-lg font-semibold">{{ t('settings.documentsModels.title') }}</h1>
        <p class="mt-1 text-sm text-muted-foreground">{{ t('settings.documentsModels.description') }}</p>
      </div>

      <div class="rounded-lg border border-border p-4" data-testid="documents-models-model-card">
        <div class="text-sm font-medium">{{ t('settings.documentsModels.modelCardTitle') }}</div>
        <div class="mt-3 flex flex-col gap-4">
          <div>
            <div class="mb-1 text-sm">{{ t('settings.documentsModels.textModel') }}</div>
            <DcPopover v-model:open="textSelectOpen">
              <DcPopoverTrigger as-child>
                <button
                  type="button"
                  data-testid="documents-text-model-trigger"
                  class="w-full rounded-md border border-border px-3 py-2 text-start text-sm"
                  :class="textInvalidReason ? 'border-red-500' : ''"
                >
                  {{ textSelectionLabel || t('settings.documentsModels.notSet') }}
                </button>
              </DcPopoverTrigger>
              <DcPopoverContent class="w-80 p-1">
                <ModelSelect
                  :respect-chat-mode="false"
                  :selected-provider-id="draftTextModel?.providerId ?? ''"
                  :selected-model-id="draftTextModel?.modelId ?? ''"
                  @update:model="onTextModelPicked"
                />
              </DcPopoverContent>
            </DcPopover>
            <p v-if="textInvalidReason" class="mt-1 text-xs text-red-500" data-testid="documents-text-model-invalid">
              {{ t(`settings.documentsModels.invalid.${textInvalidReason}`) }}
            </p>
          </div>

          <div>
            <div class="mb-1 text-sm">{{ t('settings.documentsModels.visionModel') }}</div>
            <DcPopover v-model:open="visionSelectOpen">
              <DcPopoverTrigger as-child>
                <button
                  type="button"
                  data-testid="documents-vision-model-trigger"
                  class="w-full rounded-md border border-border px-3 py-2 text-start text-sm"
                  :class="visionInvalidReason ? 'border-red-500' : ''"
                >
                  {{ visionSelectionLabel || t('settings.documentsModels.notSet') }}
                </button>
              </DcPopoverTrigger>
              <DcPopoverContent class="w-80 p-1">
                <ModelSelect
                  vision-only
                  :respect-chat-mode="false"
                  :selected-provider-id="draftVisionModel?.providerId ?? ''"
                  :selected-model-id="draftVisionModel?.modelId ?? ''"
                  @update:model="onVisionModelPicked"
                />
              </DcPopoverContent>
            </DcPopover>
            <p v-if="visionInvalidReason" class="mt-1 text-xs text-red-500">
              {{ t(`settings.documentsModels.invalid.${visionInvalidReason}`) }}
            </p>
          </div>
        </div>
      </div>

      <div class="rounded-lg border border-border p-4" data-testid="documents-models-concurrency-card">
        <div class="text-sm font-medium">{{ t('settings.documentsModels.concurrencyTitle') }}</div>
        <label class="mt-3 flex items-center gap-3 text-sm">
          <span>{{ t('settings.documentsModels.concurrency') }}</span>
          <input
            v-model.number="concurrency"
            type="number"
            min="1"
            max="10"
            data-testid="documents-concurrency-input"
            class="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
          />
        </label>
        <p class="mt-1 text-xs text-muted-foreground">{{ t('settings.documentsModels.concurrencyHint') }}</p>
      </div>

      <details class="rounded-lg border border-border p-4">
        <summary class="cursor-pointer text-sm font-medium">{{ t('settings.documentsModels.advancedTitle') }}</summary>
        <label class="mt-3 flex items-center gap-3 text-sm">
          <span>temperature</span>
          <input
            v-model.number="temperature"
            type="number"
            min="0"
            max="2"
            step="0.1"
            data-testid="documents-temperature-input"
            class="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            :placeholder="t('settings.documentsModels.defaultPlaceholder')"
          />
        </label>
        <label class="mt-3 flex items-center gap-3 text-sm">
          <span>max tokens</span>
          <input
            v-model.number="maxTokens"
            type="number"
            min="1"
            data-testid="documents-max-tokens-input"
            class="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            :placeholder="t('settings.documentsModels.defaultPlaceholder')"
          />
        </label>
      </details>

      <div class="flex items-center gap-3">
        <DcButton data-testid="documents-models-save" :disabled="!canSave || saving" @click="save">
          {{ saving ? t('common.saving') : t('common.save') }}
        </DcButton>
        <span v-if="saveError" class="text-xs text-red-500">{{ saveError }}</span>
        <span v-else-if="saved" class="text-xs text-muted-foreground">{{ t('common.saved') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import DcButton from '@dc-ui/components/dc-button'
import { DcPopover, DcPopoverContent, DcPopoverTrigger } from '@dc-ui/components/popover'
import ModelSelect from '@/components/ModelSelect.vue'
import { useProviderStore } from '@/stores/providerStore'
import { useModelStore } from '@/stores/modelStore'
import { createSettingsClient } from '@api/SettingsClient'

type ModelRef = { providerId: string; modelId: string }

const { t } = useI18n()
const providerStore = useProviderStore()
const { sortedProviders } = storeToRefs(providerStore)
const modelStore = useModelStore()
const settingsClient = createSettingsClient()

const savedTextModel = ref<ModelRef | null>(null)
const savedVisionModel = ref<ModelRef | null>(null)
const draftTextModel = ref<ModelRef | null>(null)
const draftVisionModel = ref<ModelRef | null>(null)
const concurrency = ref(4)
const temperature = ref<number | null>(null)
const maxTokens = ref<number | null>(null)
const saving = ref(false)
const saved = ref(false)
const saveError = ref('')
const textSelectOpen = ref(false)
const visionSelectOpen = ref(false)

const invalidReasons = ref<Record<string, 'providerMissing' | 'providerDisabled' | 'modelMissing'>>({})

const modelsOf = (providerId: string) =>
  modelStore.allProviderModels.find((entry) => entry.providerId === providerId)?.models ?? []

const providerEnabled = (providerId: string) =>
  sortedProviders.value.some((provider) => provider.id === providerId && provider.enable)

const providerExists = (providerId: string) =>
  sortedProviders.value.some((provider) => provider.id === providerId)

const reasonOf = (modelRef: ModelRef | null) => {
  if (!modelRef) return null
  if (!providerExists(modelRef.providerId)) return 'providerMissing'
  if (!providerEnabled(modelRef.providerId)) return 'providerDisabled'
  if (!modelsOf(modelRef.providerId).some((model) => model.id === modelRef.modelId)) return 'modelMissing'
  return null
}

const textInvalidReason = computed(() => reasonOf(draftTextModel.value))
const visionInvalidReason = computed(() => reasonOf(draftVisionModel.value))

const selectionLabel = (modelRef: ModelRef | null) => {
  if (!modelRef) return ''
  const provider = sortedProviders.value.find((item) => item.id === modelRef.providerId)
  const model = modelsOf(modelRef.providerId).find((item) => item.id === modelRef.modelId)
  if (!provider || !model) return ''
  return `${provider.name} / ${model.name}`
}

const textSelectionLabel = computed(() => selectionLabel(draftTextModel.value))
const visionSelectionLabel = computed(() => selectionLabel(draftVisionModel.value))

const canSave = computed(
  () => Boolean(draftTextModel.value) && Boolean(draftVisionModel.value) && !textInvalidReason.value && !visionInvalidReason.value
)

const onTextModelPicked = (model: { id: string }, providerId: string) => {
  draftTextModel.value = { providerId, modelId: model.id }
  textSelectOpen.value = false
  saved.value = false
}

const onVisionModelPicked = (model: { id: string }, providerId: string) => {
  draftVisionModel.value = { providerId, modelId: model.id }
  visionSelectOpen.value = false
  saved.value = false
}

onMounted(async () => {
  const [textModel, visionModel, storedConcurrency, storedTemperature, storedMaxTokens] = await Promise.all([
    settingsClient.getSetting<ModelRef>('documents.textModel'),
    settingsClient.getSetting<ModelRef>('documents.visionModel'),
    settingsClient.getSetting<number>('documents.concurrency'),
    settingsClient.getSetting<number | null>('documents.temperature'),
    settingsClient.getSetting<number | null>('documents.maxTokens')
  ])
  savedTextModel.value = textModel ?? null
  savedVisionModel.value = visionModel ?? null
  draftTextModel.value = textModel ?? null
  draftVisionModel.value = visionModel ?? null
  concurrency.value = typeof storedConcurrency === 'number' ? Math.min(10, Math.max(1, storedConcurrency)) : 4
  temperature.value = typeof storedTemperature === 'number' ? storedTemperature : null
  maxTokens.value = typeof storedMaxTokens === 'number' ? storedMaxTokens : null
  invalidReasons.value = {}
})

const save = async () => {
  if (!canSave.value || !draftTextModel.value || !draftVisionModel.value) return
  saving.value = true
  saveError.value = ''
  try {
    await Promise.all([
      settingsClient.setSetting('documents.textModel', draftTextModel.value),
      settingsClient.setSetting('documents.visionModel', draftVisionModel.value),
      settingsClient.setSetting('documents.concurrency', Math.min(10, Math.max(1, Math.round(concurrency.value || 4)))),
      settingsClient.setSetting('documents.temperature', temperature.value),
      settingsClient.setSetting('documents.maxTokens', maxTokens.value)
    ])
    savedTextModel.value = draftTextModel.value
    savedVisionModel.value = draftVisionModel.value
    saved.value = true
  } catch (error) {
    saveError.value = String(error)
  } finally {
    saving.value = false
  }
}

defineExpose({ savedTextModel, savedVisionModel, canSave, textInvalidReason, visionInvalidReason, concurrency, save })
</script>
```

组件库名以实际为准：`DcPopover/DcPopoverTrigger/DcPopoverContent`、`DcButton` 的导入路径用 grep 现有设置页（如 `grep "DcPopover" src/renderer/settings/components -l`）确认；若设置窗口内无法使用主窗口 store（providerStore/modelStore 属于 chat 窗口 store，settings 窗口可能为空），则改用页面内 `providerClient.listProviders()` + `modelClient.getProviderModels(providerId)` 拉取数据——**执行时先验证 settings 窗口 store 是否有数据（Task 4 完成后手动打开页面看下拉是否为空），为空则改走 client 拉取并同步调整测试 mock**。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run test/renderer/components/DocumentsModelsSettings.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/renderer/settings/components/DocumentsModelsSettings.vue test/renderer/components/DocumentsModelsSettings.test.ts
git commit -m "feat(documents): implement document models page"
```

---

### Task 6: 单据档案页引导横幅

**Files:**
- Modify: `src/renderer/settings/components/DocumentsSettings.vue`
- Test: `test/renderer/components/DocumentsSettings.test.ts`（若已存在则追加用例）

- [ ] **Step 1: 测试（追加）**

```ts
it('shows required banner when a model ref is missing', async () => {
  getSettingMock.mockImplementation((key: string) =>
    key === 'documents.textModel' ? { providerId: 'p1', modelId: 'm1' } : undefined
  )
  const wrapper = mountDocumentsSettings()
  await flushPromises()
  expect(wrapper.find('[data-testid="documents-settings-banner"]').exists()).toBe(true)
})

it('hides banner when both refs configured', async () => {
  getSettingMock.mockImplementation((key: string) =>
    key === 'documents.textModel'
      ? { providerId: 'p1', modelId: 'm1' }
      : key === 'documents.visionModel'
        ? { providerId: 'p1', modelId: 'm2' }
        : undefined
  )
  const wrapper = mountDocumentsSettings()
  await flushPromises()
  expect(wrapper.find('[data-testid="documents-settings-banner"]').exists()).toBe(false)
})
```

- [ ] **Step 2: 实现**

`DocumentsSettings.vue` script 增加（onMounted 中探测；settingsClient 同 Task 5 取用方式）：

```ts
const bannerVisible = ref(false)
onMounted(async () => {
  const [textModel, visionModel] = await Promise.all([
    settingsClient.getSetting<{ providerId: string; modelId: string }>('documents.textModel'),
    settingsClient.getSetting<{ providerId: string; modelId: string }>('documents.visionModel')
  ])
  bannerVisible.value = !textModel || !visionModel
})
const goToModelSettings = () => router.push('/documents-models')
```

模板顶部加：

```vue
<div
  v-if="bannerVisible"
  data-testid="documents-settings-banner"
  class="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
>
  <span>{{ t('documents.settingsBanner.required') }}</span>
  <DcButton size="sm" @click="goToModelSettings">{{ t('documents.settingsBanner.go') }}</DcButton>
</div>
```

（DocumentsSettings.vue 若无 router 引入则 `import { useRouter } from 'vue-router'`。）

- [ ] **Step 3: 运行 + Commit**

Run: `pnpm exec vitest run test/renderer/components/DocumentsSettings.test.ts`
Expected: PASS
```bash
git add src/renderer/settings/components/DocumentsSettings.vue test/renderer/components/DocumentsSettings.test.ts
git commit -m "feat(documents): add settings guidance banner"
```

---

### Task 7: i18n 文案（20 locale）

**Files:**
- Modify: `src/renderer/src/i18n/zh-CN/settings.json`、`en-US/settings.json` 及其余 18 locale
- Modify: `src/renderer/src/i18n/zh-CN/documents.json`（若错误文案命名空间在别的 json，以 extractor/任务错误现有键所在文件为准）等 ×20

- [ ] **Step 1: zh-CN settings.json 追加**

```json
"documentsModels": {
  "title": "单据识别模型",
  "description": "为单据档案的识别任务单独指定模型，未配置时识别功能不可用。",
  "modelCardTitle": "模型设置",
  "textModel": "文本抽取模型",
  "visionModel": "视觉模型（扫描件/图片）",
  "notSet": "未设置",
  "invalid": {
    "providerMissing": "所选模型服务商已被删除，请重新选择",
    "providerDisabled": "所选模型服务商已被停用，请启用后再试",
    "modelMissing": "所选模型不存在或已被移除，请重新选择"
  },
  "concurrencyTitle": "识别并发",
  "concurrency": "任务并发数",
  "concurrencyHint": "仅影响任务级并发（1–10）",
  "advancedTitle": "推理参数",
  "defaultPlaceholder": "默认"
}
```

- [ ] **Step 2: zh-CN documents 命名空间追加（错误与横幅）**

```json
"errors": {
  "modelRequired": "单据识别尚未配置模型，请先在 设置 → Agent设置 → 单据识别模型 中完成配置",
  "modelProviderMissing": "单据识别模型配置无效：模型服务商 {provider} 已被删除或停用，请重新配置",
  "modelMissing": "单据识别模型配置无效：模型 {model} 不存在或已被移除，请重新配置"
},
"settingsBanner": {
  "required": "单据识别尚未配置模型，识别任务将无法运行。请在「设置 → Agent设置 → 单据识别模型」中完成配置。",
  "go": "去配置"
}
```

- [ ] **Step 3: en-US 及其余 18 locale**

en-US：

```json
"documentsModels": {
  "title": "Document Models",
  "description": "Configure dedicated models for document archive extraction. Extraction is unavailable until configured.",
  "modelCardTitle": "Model Settings",
  "textModel": "Text extraction model",
  "visionModel": "Vision model (scans/images)",
  "notSet": "Not set",
  "invalid": {
    "providerMissing": "The selected model provider has been removed. Please choose again",
    "providerDisabled": "The selected model provider is disabled. Enable it and try again",
    "modelMissing": "The selected model no longer exists. Please choose again"
  },
  "concurrencyTitle": "Extraction Concurrency",
  "concurrency": "Task concurrency",
  "concurrencyHint": "Affects task-level concurrency only (1-10)",
  "advancedTitle": "Generation Parameters",
  "defaultPlaceholder": "Default"
}
```

```json
"errors": {
  "modelRequired": "Document extraction models are not configured. Open Settings -> Agent -> Document Models to configure them first",
  "modelProviderMissing": "Invalid document model configuration: provider {provider} has been removed or disabled. Please reconfigure",
  "modelMissing": "Invalid document model configuration: model {model} no longer exists. Please reconfigure"
},
"settingsBanner": {
  "required": "Document models are not configured, extraction tasks will fail. Configure them in Settings -> Agent -> Document Models.",
  "go": "Configure"
}
```

其余 18 locale（zh-TW/zh-HK/ja-JP/ko-KR/fr-FR/de-DE/es-ES/pt-BR/ru-RU/ar-SA/he-IL/da-DK/nl-NL/pl-PL/tr-TR/vi-VN/id-ID/ms-MY/th-TH/hu-HU 中实际存在的）：沿用 en-US 同文（仓库惯例）。

- [ ] **Step 4: 校验**

Run: `pnpm run i18n`
Expected: PASS 且重生成 `i18n.d.ts` 无 drift

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/i18n
git commit -m "i18n: add document models settings copy"
```

---

### Task 8: 全量验证与收尾

- [ ] **Step 1: 格式化**

Run: `pnpm exec oxfmt src/main/documents src/main/app/composition.ts src/renderer/settings/components/DocumentsModelsSettings.vue src/renderer/settings/components/DocumentsSettings.vue src/renderer/src/lib/documentsTaskErrors.ts src/shared/settingsNavigation.ts test/main/documents test/renderer`
Expected: 无 diff 或已格式化

- [ ] **Step 2: 全量相关测试**

```bash
pnpm run typecheck:web
pnpm run typecheck:node
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents test/main/plugin --config vitest.config.ts
pnpm exec vitest run test/renderer/components/DocumentsModelsSettings.test.ts test/renderer/components/DocumentsSettings.test.ts test/renderer/lib/documentsTaskErrors.test.ts
```

Expected: 全部 PASS（预存环境失败按内存记录对照排除）

- [ ] **Step 3: 手动冒烟（pnpm dev）**

1. 设置 → Agent设置 → 出现「单据识别模型」，进入配置两个模型保存 → 重启应用：配置保持
2. 删除该 provider：页面行标红 + 任务失败显示 providerMissing 文案
3. 未配置状态（清空保存）：单据档案页横幅出现，任务创建被拦显示引导文案
4. 并发改为 8：识别任务并行度上升（观察任务列表）

- [ ] **Step 4: 最终提交（如有残留）+ 汇报**

```bash
git status --short
```

Expected: clean；向用户汇报验证结果，等待推送指令。
