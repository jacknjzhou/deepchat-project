# 构建期注入托管配置地址 + 关于页展示 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建安装包时可注入默认托管配置地址（`MAIN_VITE_MANAGED_CONFIG_URL`），客户端「关于」页展示生效地址与来源。

**Architecture:** 主进程新增纯函数 `resolveManagedEndpointInfo(env, builtin)` 统一解析（运行时环境变量 > 构建注入 > 未配置）；经新增 IPC 路由 `device.getManagedConfigEndpoint` 暴露给渲染端；`AboutUsSettings.vue` 新增始终可见的「企业托管配置」卡片。构建期值经 electron-vite 的 `MAIN_VITE_*` 机制在打包时替换为字面量。

**Tech Stack:** electron-vite（`import.meta.env.MAIN_VITE_*`）、zod 契约路由、Vue 3 + shadcn 风格卡片、vitest。

**Spec:** `docs/superpowers/specs/2026-10-08-managed-config-url-builtin-design.md`

**基线提醒：** `test/main/app` 有 4 项预存失败（Windows 路径分隔符 ×2、sqlite 表名 ×2），与本功能无关，不得新增失败。

---

### Task 1: 端点解析纯函数 `resolveManagedEndpointInfo`

**Files:**
- Create: `src/main/managed/endpoint.ts`
- Test: `test/main/managed/endpoint.test.ts`

- [ ] **Step 1: 写失败测试**

先看 `test/main/managed/client.test.ts` 顶部第一行 import 的写法（相对路径或别名），用同样风格导入。以下按相对路径写：

```ts
import { describe, expect, it } from 'vitest'
import { resolveManagedEndpointInfo } from '../../../src/main/managed/endpoint'

describe('resolveManagedEndpointInfo', () => {
  it('prefers runtime env over builtin', () => {
    expect(
      resolveManagedEndpointInfo('http://env/config', 'http://builtin/config')
    ).toEqual({ endpoint: 'http://env/config', source: 'env' })
  })

  it('falls back to builtin when env is missing', () => {
    expect(resolveManagedEndpointInfo(undefined, 'http://builtin/config')).toEqual({
      endpoint: 'http://builtin/config',
      source: 'builtin'
    })
  })

  it('treats empty or whitespace-only values as unset', () => {
    expect(resolveManagedEndpointInfo('   ', 'http://builtin/config')).toEqual({
      endpoint: 'http://builtin/config',
      source: 'builtin'
    })
    expect(resolveManagedEndpointInfo(undefined, undefined)).toEqual({
      endpoint: '',
      source: 'none'
    })
  })

  it('trims the returned endpoint', () => {
    expect(resolveManagedEndpointInfo('  http://env/config  ', undefined)).toEqual({
      endpoint: 'http://env/config',
      source: 'env'
    })
  })
})
```

- [ ] **Step 2: 运行确认失败**

```
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/managed/endpoint.test.ts --config vitest.config.ts
```
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`src/main/managed/endpoint.ts`：

```ts
export type ManagedEndpointSource = 'env' | 'builtin' | 'none'

export interface ManagedEndpointInfo {
  endpoint: string
  source: ManagedEndpointSource
}

/**
 * 解析托管配置端点：运行时环境变量优先，其次构建期注入的默认值（MAIN_VITE_*）。
 * 空串 / 纯空格视为未设置；返回值已 trim。
 */
export function resolveManagedEndpointInfo(
  runtimeEndpoint: string | undefined,
  builtinEndpoint: string | undefined
): ManagedEndpointInfo {
  const fromEnv = runtimeEndpoint?.trim() ?? ''
  if (fromEnv) return { endpoint: fromEnv, source: 'env' }
  const fromBuiltin = builtinEndpoint?.trim() ?? ''
  if (fromBuiltin) return { endpoint: fromBuiltin, source: 'builtin' }
  return { endpoint: '', source: 'none' }
}
```

- [ ] **Step 4: 运行确认通过**

同 Step 2 命令。Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/main/managed/endpoint.ts test/main/managed/endpoint.test.ts
git commit -m "feat(managed): endpoint resolution with builtin default"
```

---

### Task 2: 契约路由 + 主进程接线 + DeviceClient

**Files:**
- Modify: `src/shared/contracts/routes/device.routes.ts`（在 `deviceGetAppVersionRoute` 定义之后插入）
- Modify: `src/main/device/routes.ts:13-17`（deps 类型）与 `createRouteMap([...])` 数组（新增条目）
- Modify: `src/main/app/composition.ts:519-521`（函数替换）、`2949`、`3387`（调用点）、`3301`（createDeviceRoutes deps）
- Modify: `src/renderer/api/DeviceClient.ts`
- Test: typecheck（透传 handler 无独立单测，理由见下）

- [ ] **Step 1: 契约**

`src/shared/contracts/routes/device.routes.ts`，在 `deviceGetAppVersionRoute` 块后加：

```ts
export const deviceManagedConfigEndpointRoute = defineRouteContract({
  name: 'device.getManagedConfigEndpoint',
  input: z.object({}).default({}),
  output: z.object({
    endpoint: z.string(),
    source: z.enum(['env', 'builtin', 'none'])
  })
})
```

- [ ] **Step 2: 路由 handler 与 deps**

`src/main/device/routes.ts`：

import 行加 `deviceManagedConfigEndpointRoute`；deps 增加（放在 `device: DeviceServicePort` 之后）：

```ts
  managedEndpoint: () => { endpoint: string; source: 'env' | 'builtin' | 'none' }
```

`createRouteMap([...])` 中 `deviceGetAppVersionRoute` 条目之后加：

```ts
    [
      deviceManagedConfigEndpointRoute.name,
      async (rawInput) => {
        deviceManagedConfigEndpointRoute.input.parse(rawInput)
        return deviceManagedConfigEndpointRoute.output.parse(deps.managedEndpoint())
      }
    ],
```

（透传 handler 与同文件兄弟条目同构，无独立单测；逻辑风险集中在 Task 1 的纯函数，已覆盖。）

- [ ] **Step 3: composition 接线**

`src/main/app/composition.ts`：

顶部 import 增加：

```ts
import { resolveManagedEndpointInfo, type ManagedEndpointInfo } from '../managed/endpoint'
```

替换 519-521 行：

```ts
function resolveManagedConfigEndpoint(): string {
  return process.env.DEEPCHAT_MANAGED_CONFIG_URL ?? ''
}
```

为：

```ts
function managedEndpointInfo(): ManagedEndpointInfo {
  return resolveManagedEndpointInfo(
    process.env.DEEPCHAT_MANAGED_CONFIG_URL,
    (import.meta.env as Record<string, string | undefined> | undefined)?.MAIN_VITE_MANAGED_CONFIG_URL
  )
}
```

两个调用点（2949、3387，形如 `endpoint: resolveManagedConfigEndpoint(),`）改为：

```ts
endpoint: managedEndpointInfo().endpoint,
```

`createDeviceRoutes({...})`（约 3301 行）deps 增加：

```ts
managedEndpoint: managedEndpointInfo,
```

- [ ] **Step 4: DeviceClient**

`src/renderer/api/DeviceClient.ts`：import 增加 `deviceManagedConfigEndpointRoute`；`getAppVersion` 之后加：

```ts
  async function getManagedConfigEndpoint() {
    const result = await bridge.invoke(deviceManagedConfigEndpointRoute.name, {})
    return result
  }
```

`createDeviceClient` 返回对象中（`getAppVersion,` 附近）加入 `getManagedConfigEndpoint,`。

- [ ] **Step 5: 验证 MAIN_VITE_* 在主进程生效（关键风险点）**

```
$env:MAIN_VITE_MANAGED_CONFIG_URL='http://builtin-probe/config'; $env:DEEPCHAT_MANAGED_CONFIG_URL=''; pnpm run typecheck:node
```
Expected: typecheck 通过。

然后临时在 `managedEndpointInfo()` 返回前加 `console.log('[probe]', managedEndpointInfo())`，运行 `$env:MAIN_VITE_MANAGED_CONFIG_URL='http://builtin-probe/config'; pnpm dev`，在关于页打开时观察主进程 stdout：
- 打印 `{ endpoint: 'http://builtin-probe/config', source: 'builtin' }` → 机制生效，**删除探针日志**
- 打印 `source: 'none'` → electron-vite 主进程不注入，启用兜底：`electron.vite.config.ts` 的 `main` 段加 `define: { __MANAGED_BUILTIN_CONFIG_URL__: JSON.stringify(process.env.MAIN_VITE_MANAGED_CONFIG_URL ?? '') }`，Step 3 中读取值改为 `__MANAGED_BUILTIN_CONFIG_URL__`（并在 `src/shared` 或主进程 env.d.ts 声明 `declare const __MANAGED_BUILTIN_CONFIG_URL__: string`），重跑本步

- [ ] **Step 6: Commit**

```bash
git add src/shared/contracts/routes/device.routes.ts src/main/device/routes.ts src/main/app/composition.ts src/renderer/api/DeviceClient.ts
git commit -m "feat(managed): expose managed config endpoint over ipc"
```

---

### Task 3: 关于页卡片 + i18n（20 locale）

**Files:**
- Modify: `src/renderer/settings/components/AboutUsSettings.vue`
- Modify: `src/renderer/src/i18n/{zh-CN,en-US,da-DK,de-DE,es-ES,fa-IR,fr-FR,he-IL,id-ID,it-IT,ja-JP,ko-KR,ms-MY,pl-PL,pt-BR,ru-RU,tr-TR,vi-VN,zh-HK,zh-TW}/about.json`
- Test: `test/renderer/components/AboutUsSettingsManagedConfig.test.ts`（新建，mock 模式参照 `test/renderer/components/DocumentsModelsSettingsManaged.test.ts` 对 api/模块的 vi.mock 写法）

- [ ] **Step 1: i18n 键**

zh-CN `about.json` 顶层（`systemInfo` 之后）加：

```json
  "managedConfig": {
    "title": "企业托管配置",
    "endpoint": "配置服务地址",
    "sourceLabel": "来源",
    "sourceEnv": "环境变量",
    "sourceBuiltin": "内置配置",
    "notConfigured": "未配置企业托管"
  },
```

en-US 用同结构英文（title: "Managed Configuration", endpoint: "Config Service URL", sourceLabel: "Source", sourceEnv: "Environment variable", sourceBuiltin: "Built-in", notConfigured: "Not configured"）；其余 18 个 locale 复制 en-US 文本。

- [ ] **Step 2: 写失败测试**

`test/renderer/components/AboutUsSettingsManagedConfig.test.ts`（mock 写法照抄 `DocumentsModelsSettingsManaged.test.ts`：mock 掉 AboutUsSettings 使用的 api 模块，暴露 `getManagedConfigEndpoint` 与 `getAppVersion` 两个 mock 函数；挂载用 en-US i18n 消息，先在该测试文件中给 `about.managedConfig` 注入英文键值）：

```ts
// 三个核心用例（断言均用 data-testid / 文本）：
// 1. source='env' 且 endpoint 非空 → 显示地址文本 + 「Environment variable」标签，复制按钮存在
// 2. source='builtin' → 显示地址 + 「Built-in」标签
// 3. endpoint='' → 显示「Not configured」，复制按钮不存在
```

（完整断言照实现者按上述三点展开：`wrapper.find('[data-testid="managed-config-card"]')`、`text()` 含期望串、`find('button[aria-label]')` 存在性。）

- [ ] **Step 3: 运行确认失败**

```
pnpm exec vitest run test/renderer/components/AboutUsSettingsManagedConfig.test.ts
```
Expected: FAIL（卡片不存在）

- [ ] **Step 4: 实现卡片**

`AboutUsSettings.vue`：模板中 `data-testid="system-info-card"` 的卡片 `</div>` 结束后（约 102 行后）插入：

```html
      <div
        data-testid="managed-config-card"
        class="mt-2 w-full max-w-xl rounded-xl border border-border/80 bg-card/70 p-4 shadow-sm"
      >
        <div class="text-sm font-medium">{{ t('about.managedConfig.title') }}</div>
        <div class="mt-3 flex flex-col gap-1.5 text-sm">
          <div class="flex items-center justify-between gap-2">
            <span class="shrink-0 text-muted-foreground">{{
              t('about.managedConfig.endpoint')
            }}</span>
            <span class="flex min-w-0 items-center gap-1">
              <span
                class="truncate font-mono text-xs"
                :title="managedEndpoint || t('about.managedConfig.notConfigured')"
              >
                {{ managedEndpoint || t('about.managedConfig.notConfigured') }}
              </span>
              <button
                v-if="managedEndpoint"
                class="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                :aria-label="t('about.managedConfig.endpoint')"
                data-testid="managed-config-copy"
                @click="copyManagedEndpoint"
              >
                <Icon
                  :icon="managedEndpointCopied ? 'lucide:check' : 'lucide:copy'"
                  class="h-3 w-3"
                />
              </button>
            </span>
          </div>
          <div v-if="managedEndpoint" class="flex items-center justify-between gap-2">
            <span class="shrink-0 text-muted-foreground">{{ t('about.managedConfig.sourceLabel') }}</span>
            <span class="text-xs">{{ managedEndpointSourceLabel }}</span>
          </div>
        </div>
      </div>
```

script（`<script setup>`）增加（复制逻辑先看同文件 `copySystemInfo` 用了什么剪贴板调用，是则复用同一调用，否则用 `navigator.clipboard.writeText`）：

```ts
const managedEndpoint = ref('')
const managedEndpointSource = ref<'env' | 'builtin' | 'none'>('none')
const managedEndpointCopied = ref(false)
const managedEndpointSourceLabel = computed(() =>
  managedEndpointSource.value === 'env'
    ? t('about.managedConfig.sourceEnv')
    : t('about.managedConfig.sourceBuiltin')
)

async function copyManagedEndpoint() {
  try {
    await navigator.clipboard.writeText(managedEndpoint.value)
    managedEndpointCopied.value = true
    setTimeout(() => {
      managedEndpointCopied.value = false
    }, 1500)
  } catch (error) {
    console.error('[AboutUsSettings] Failed to copy managed endpoint', error)
  }
}
```

既有 `onMounted`（约 481 行）内追加：

```ts
  deviceClient
    .getManagedConfigEndpoint()
    .then((info) => {
      managedEndpoint.value = info.endpoint
      managedEndpointSource.value = info.source
    })
    .catch((error) => {
      console.error('[AboutUsSettings] Failed to load managed config endpoint', error)
    })
```

- [ ] **Step 5: 运行确认通过 + 全量校验**

```
pnpm exec vitest run test/renderer/components/AboutUsSettingsManagedConfig.test.ts
pnpm run i18n
pnpm run typecheck:web
```
Expected: 新测试 3 项通过；i18n PASS（20 locales 无缺失键）；typecheck 通过。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/settings/components/AboutUsSettings.vue src/renderer/src/i18n test/renderer/components/AboutUsSettingsManagedConfig.test.ts
git commit -m "feat(managed): show managed config endpoint on about page"
```

---

### Task 4: 文档 + 手动验收

**Files:**
- Modify: `.env.example`
- Modify: `docs/superpowers/specs/2026-09-30-managed-config-http-contract.md`（第 1 节「端点配置」表格后加构建注入说明）

- [ ] **Step 1: `.env.example` 追加**

```bash
# 构建期注入企业托管配置服务地址（打进安装包，关于页可见；运行时环境变量 DEEPCHAT_MANAGED_CONFIG_URL 优先）
# MAIN_VITE_MANAGED_CONFIG_URL=https://example.com/managed/config
```

- [ ] **Step 2: 契约文档补构建注入说明**

`docs/superpowers/specs/2026-09-30-managed-config-http-contract.md` 第 1 节表格后追加：

```markdown
> **构建期注入（v1.3+）**：打包时设置 `MAIN_VITE_MANAGED_CONFIG_URL` 可将默认地址内置进安装包（关于页可见，来源显示「内置配置」）。运行时环境变量 `DEEPCHAT_MANAGED_CONFIG_URL` 优先级更高，用于应急覆盖。
```

- [ ] **Step 3: 全量回归**

```
pnpm run typecheck:node
pnpm run typecheck:web
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/managed test/main/app --config vitest.config.ts
```
Expected: `test/main/managed` 全绿；`test/main/app` 仅 4 项预存失败（无新增）。

- [ ] **Step 4: 手动验收（用户执行）**

```
$env:MAIN_VITE_MANAGED_CONFIG_URL='http://10.26.6.177:3000/managed/config'; pnpm run build:win
```
安装产物 → 关于页应显示地址与来源「内置配置」；再用 `$env:DEEPCHAT_MANAGED_CONFIG_URL='http://other/config'` 启动同包，关于页来源应变为「环境变量」。

- [ ] **Step 5: Commit**

```bash
git add .env.example docs/superpowers/specs/2026-09-30-managed-config-http-contract.md
git commit -m "docs(managed): document build-time endpoint injection"
```
