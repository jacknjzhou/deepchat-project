# SRIBD办公智能体 品牌重塑（显示层）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把所有用户可见的 "DeepChat" 显示内容替换为品牌名（zh 语言包「SRIBD办公智能体」，其余语言 "SRIBD Office Agent"），内部标识符一律不动。

**Architecture:** 按 spec（`docs/superpowers/specs/2026-09-26-sribd-office-agent-rebrand-design.md`）采用方案 1 直接替换：i18n 语言包用一次性脚本按有序短语规则批量替换（大小写敏感 "DeepChat" 不会命中小写开头的 key），静态显示点逐处手工改，最后以 grep 审计 + i18n 校验收口。

**Tech Stack:** Node 脚本（一次性）、grep 审计、vitest、electron-builder 配置。

**执行前置须知：**
- 工作区有大量无关未提交改动。**每个 commit 只 add 本任务列出的文件**，绝不 `git add -A`。
- 仓库规范：Oxfmt（单引号/无分号/100 列）、Conventional Commits（≤50 字符）、无 AI 署名。
- 大小写敏感约定：显示值均为 "DeepChat"（大写 D）；i18n key / 变量名 / 协议均为 `deepchat` 或 `deepChat`（小写 d 开头），替换永远不会命中它们。

---

### Task 1: i18n 语言包批量替换

**Files:**
- Modify: `src/renderer/src/i18n/<locale>/` 下全部 `.json`（about/chat/dialog/mcp/settings/routes/sync/welcome/update）与 `index.ts`（约 20 locale × 100 文件，共 1167 处）
- Create then delete: `scripts/tmp-rebrand-i18n.mjs`（一次性脚本，提交前删除）

- [ ] **Step 1: 创建一次性替换脚本**

写入 `scripts/tmp-rebrand-i18n.mjs`：

```js
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src/renderer/src/i18n'
const ZH = 'SRIBD办公智能体'
const EN = 'SRIBD Office Agent'

function rules(locale) {
  if (locale.startsWith('zh')) {
    return [
      ['DeepChat Agents', `${ZH} Agent`],
      ['DeepChat', ZH]
    ]
  }
  return [
    ['DeepChat Agents', `${EN}s`],
    ['DeepChat Agent', EN],
    ['DeepChat', EN]
  ]
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

let files = 0
let hits = 0
for (const locale of readdirSync(ROOT).filter((n) => statSync(join(ROOT, n)).isDirectory())) {
  const rs = rules(locale)
  for (const file of walk(join(ROOT, locale))) {
    let content = readFileSync(file, 'utf8')
    const before = content
    for (const [from, to] of rs) {
      content = content.replaceAll(from, to)
    }
    if (content !== before) {
      writeFileSync(file, content)
      files++
      hits++
    }
  }
}
console.log(`updated files: ${files}`)
```

短语规则说明（先长后短）：
- zh：`DeepChat Agents` → `SRIBD办公智能体 Agent`（避免出现"智能体 Agents"）；其余 `DeepChat` → `SRIBD办公智能体`
- 其他语言：`DeepChat Agents` → `SRIBD Office Agents`；`DeepChat Agent` → `SRIBD Office Agent`（避免 "SRIBD Office Agent Agent"）；其余 `DeepChat` → `SRIBD Office Agent`（属格形式如 `DeepChat's`、`DeepChats` 自然得到 `SRIBD Office Agent's` / `SRIBD Office Agents`，语义正确）

- [ ] **Step 2: 运行脚本**

```powershell
node scripts/tmp-rebrand-i18n.mjs
```

Expected: 输出 `updated files: 约 100`（几乎全部 locale 文件都有命中）。

- [ ] **Step 3: grep 审计零残留**

```powershell
pnpm exec rg -n "DeepChat" src/renderer/src/i18n
```

Expected: **无任何匹配**（i18n key 全部为小写 `deepchat`/`deepChat` 开头，不会残留）。若有匹配，逐处人工判断：显示文案则手工替换，代码标识（key/注释）记录到汇报中并保持不动。

- [ ] **Step 4: 抽查双语样例**

```powershell
pnpm exec rg -n "SRIBD" src/renderer/src/i18n/zh-CN/settings.json | Select-Object -First 5
pnpm exec rg -n "SRIBD Office Agent" src/renderer/src/i18n/en-US/chat.json | Select-Object -First 5
```

Expected: zh-CN 显示「SRIBD办公智能体」，en-US 显示 "SRIBD Office Agent"；确认没有 "SRIBD Office Agent Agent"。

- [ ] **Step 5: 删除临时脚本**

用文件删除工具删除 `scripts/tmp-rebrand-i18n.mjs`（不进入提交）。

- [ ] **Step 6: 跑 i18n 一致性校验**

```powershell
pnpm run i18n
```

Expected: 全部语言 key 结构一致，无报错。

- [ ] **Step 7: Commit**

```powershell
git add src/renderer/src/i18n
git commit -m "feat(brand): rebrand i18n display copy"
```

---

### Task 2: 应用内静态显示点

**Files:**
- Modify: `src/renderer/index.html`、`src/renderer/settings/index.html`
- Modify: `src/renderer/splash/loading.vue`（5 处）
- Modify: `src/main/desktop/window/index.ts:1326`
- Modify: `src/main/desktop/tray.ts:38`
- Modify: `src/main/desktop/preview/AgentPreviewCoordinator.ts:389`

- [ ] **Step 1: HTML 标题**

`src/renderer/index.html` 与 `src/renderer/settings/index.html`：

```html
<title>DeepChat</title>
```

改为：

```html
<title>SRIBD办公智能体</title>
```

- [ ] **Step 2: splash 页（静态点统一用中文品牌名，见 spec）**

`src/renderer/splash/loading.vue` 中 5 处（unlock 标题 L18、L67、L126、L129 与 aria-label L138 附近，以实际 grep 为准）：

```powershell
pnpm exec rg -n "DeepChat" src/renderer/splash/loading.vue
```

所有 `DeepChat` → `SRIBD办公智能体`（含英文句子内联，如 `SRIBD办公智能体 is starting`，spec 规定静态点统一中文品牌名）。

- [ ] **Step 3: 主进程窗口/托盘/预览**

| 文件:行 | 改前 | 改后 |
| --- | --- | --- |
| `src/main/desktop/window/index.ts:1326` | `title: 'DeepChat - Settings'` | `title: 'SRIBD办公智能体 - 设置'` |
| `src/main/desktop/tray.ts:38` | `tray.setToolTip('DeepChat')` | `tray.setToolTip('SRIBD办公智能体')` |
| `src/main/desktop/preview/AgentPreviewCoordinator.ts:389` | fallback `'DeepChat'` | fallback `'SRIBD办公智能体'` |

- [ ] **Step 4: grep 审计**

```powershell
pnpm exec rg -n "DeepChat" src/renderer/index.html src/renderer/settings/index.html src/renderer/splash/loading.vue src/main/desktop
```

Expected: 仅剩代码标识类匹配（如 import、类型名）；三处已知显示点均已替换。

- [ ] **Step 5: 主进程相关测试**

```powershell
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/desktop/preview/AgentPreviewCoordinator.test.ts --config vitest.config.ts
```

Expected: 若该测试 stub/fallback 断言 `'DeepChat'`，更新为 `'SRIBD办公智能体'` 后 PASS（与 Task 6 联动）。

- [ ] **Step 6: Commit**

```powershell
git add src/renderer/index.html src/renderer/settings/index.html src/renderer/splash/loading.vue src/main/desktop/window/index.ts src/main/desktop/tray.ts src/main/desktop/preview/AgentPreviewCoordinator.ts
git commit -m "feat(brand): rebrand static ui titles"
```

---

### Task 3: 托盘菜单文案（shared/i18n.ts）

**Files:**
- Modify: `src/shared/i18n.ts`（11 处 `showHide`）

- [ ] **Step 1: 按语言品牌映射替换 `showHide` 值中的 DeepChat**

| 行 | 改后 |
| --- | --- |
| L45（zh-CN） | `showHide: '显示/隐藏 SRIBD办公智能体'` |
| L78（zh-TW） | `showHide: '顯示/隱藏 SRIBD办公智能体'` |
| L111 起 9 处（en/es/de/tr/id/ms/it/pl/vi） | 例：`showHide: 'Show/Hide SRIBD Office Agent'`、`'Mostrar/ocultar SRIBD Office Agent'`、`'SRIBD Office Agent ein-/ausblenden'`、`"SRIBD Office Agent'i göster/gizle"` 等，仅替换 `DeepChat` token，语序保持原译文 |

- [ ] **Step 2: 审计**

```powershell
pnpm exec rg -n "DeepChat" src/shared/i18n.ts
```

Expected: 无匹配。

- [ ] **Step 3: Commit**

```powershell
git add src/shared/i18n.ts
git commit -m "feat(brand): rebrand tray menu labels"
```

---

### Task 4: 渲染层组件显示文案

**Files（已知含大小写敏感 "DeepChat" 的渲染层文件及匹配数）:**
- Modify: `src/renderer/settings/components/DeepChatAgentsSettings.vue`（40 处）
- Modify: `src/renderer/settings/components/MemoryConfigInlinePanel.vue`（31 处）
- Modify: `src/renderer/settings/components/McpSettings.vue`（6 处）
- Modify: `src/renderer/settings/components/MemorySettings.vue`（3 处）
- Modify: `src/renderer/settings/components/control-center/UsageNostalgiaCard.vue`（2 处）
- Modify: `src/renderer/settings/settingsRouteComponents.ts`（1 处）
- Modify: `src/renderer/src/components/chat/ChatStatusBar.vue`（12 处）
- Modify: `src/renderer/src/pages/NewThreadPage.vue`（15 处）
- Modify: `src/renderer/src/components/trace/TraceDialog.vue`（12 处）
- Modify: `src/renderer/src/components/cli/CliApprovalDialog.vue`（1 处）
- Modify: `src/renderer/src/components/mcp/McpAppView.vue`（2 处）
- Modify: `src/renderer/src/stores/ui/session.ts`（2 处）
- Modify: `src/renderer/api/SessionClient.ts`（4 处）
- Modify: `src/renderer/api/ConfigClient.ts`（22 处，多数为 CODE）
- Modify: `src/renderer/src/composables/message/useMessageCapture.ts`（`brand: 'DeepChat'` 为消息元数据标识，**保持不动**）
- Modify: `src/renderer/src/assets/style.css`（2 处）

- [ ] **Step 1: 逐文件分类替换**

对每个文件执行：

```powershell
pnpm exec rg -n "DeepChat" <file>
```

按以下决策规则处理每一处：
- **DISPLAY（替换，zh 品牌名 `SRIBD办公智能体`，组件内英文硬编码句子也统一中文品牌名）**：`<template>` 中文本/占位符/aria-label/title 属性；i18n 调用里的硬编码默认文案；CSS 注释以外的注释性用户文案。
- **CODE（不动）**：变量名、函数名、import、事件名、CSS 类、i18n **key**、日志前缀、API 字段（如 `brand: 'DeepChat'` 元数据、`deepchatAgent` 类型标识）。
- **AMBIGUOUS（先查引用再定）**：如 `session.ts`、`ConfigClient.ts` 中的字符串若作为对外 API 标识/存储值使用则属 CODE 不动；仅纯展示用途才替换。

已知判定：`useMessageCapture.ts:170` `brand: 'DeepChat'` 为 CODE 不动；`DeepChatAgentsSettings.vue` 文件名不改，仅改其内部显示文案。

- [ ] **Step 2: 审计**

```powershell
pnpm exec rg -n "DeepChat" src/renderer --glob "!src/renderer/src/i18n/**"
```

Expected: 剩余匹配全部为 CODE（逐处可解释）。在汇报中列出残留清单及理由。

- [ ] **Step 3: 跑渲染层受影响套件**

```powershell
pnpm exec vitest run --config vitest.config.renderer.ts test/renderer/settings test/renderer/components
```

Expected: 若有用例以 `DeepChat` 显示文本为期望值（如 AgentWelcomePage.test.ts 的 mock 文案独立于 locale 文件，一般无需改），失败则更新**期望值**后重跑至 PASS。测试 mock 中作为任意翻译值的 `'DeepChat'` 无需改。

- [ ] **Step 4: Commit**

```powershell
git add <本任务实际修改的文件>
git commit -m "feat(brand): rebrand renderer display copy"
```

---

### Task 5: 系统提示词 AI 身份（spec 补充项）

**Files:**
- Modify: `src/main/agent/promptSettings.ts`（L14、L70）

说明：spec 未覆盖此处（写计划时新发现）。`DEFAULT_SYSTEM_PROMPT` 中 "You are DeepChat" 是 AI 自我介绍文本，随对话内容呈现给用户，按 spec 显示层原则一并重塑。提示词为英文，故用英文品牌名。

- [ ] **Step 1: 替换两处 AI 身份**

L14 与 L70：

```text
You are DeepChat —
```

改为：

```text
You are SRIBD Office Agent —
```

（保留原句其余部分与破折号结构不变，仅替换 `DeepChat`。）

- [ ] **Step 2: 审计 + 查测试引用**

```powershell
pnpm exec rg -n "You are DeepChat" src
pnpm exec rg -ln "DEFAULT_SYSTEM_PROMPT|You are DeepChat" test
```

Expected: src 无匹配；若有测试断言提示词内容，更新期望值后重跑该套件至 PASS。

- [ ] **Step 3: Commit**

```powershell
git add src/main/agent/promptSettings.ts
git commit -m "feat(brand): rebrand agent system prompt identity"
```

---

### Task 6: 安装层显示（electron-builder + package.json）

**Files:**
- Modify: `electron-builder.yml`
- Modify: `package.json`（仅 `description`）

- [ ] **Step 1: electron-builder.yml**

```yaml
productName: DeepChat
```

改为：

```yaml
productName: SRIBD办公智能体
```

**不改**：`executableName: DeepChat`（可执行文件名，CI/更新器依赖）、`appId: com.wefonk.deepchat`、macOS helper 正则 `/Contents/Helpers/DeepChat Computer Use[.]app(?:/|$)`（已核实：helper 名在 4 个脚本中硬编码，不随 productName 变化——`scripts/build-cua-plugin-runtime.mjs:38`、`scripts/cua-macos-contract.mjs:1`、`scripts/package-plugin.mjs:10`、`scripts/plugin.mjs:6`，正则保持有效；helper 名属内部组件标识，本次不动）。

- [ ] **Step 2: package.json description**

```json
"description": "DeepChat，一个简单易用的 Agent 客户端"
```

改为：

```json
"description": "SRIBD办公智能体，一个简单易用的 Agent 客户端"
```

`name: "DeepChat"` 不改（artifactName `${name}`、npm 标识依赖）。

- [ ] **Step 3: Commit**

```powershell
git add electron-builder.yml package.json
git commit -m "feat(brand): rebrand installer display name"
```

---

### Task 7: 测试与端到端夹具同步

**Files:**
- Modify: `test/e2e/fixtures/electronApp.ts:63`
- Modify: `test/main/desktop/preview/AgentPreviewCoordinator.test.ts`（若 Task 2 未处理）

- [ ] **Step 1: e2e 窗口标题断言**

`test/e2e/fixtures/electronApp.ts:63`：

```ts
return title === 'DeepChat' && !url.includes('/renderer/')
```

改为：

```ts
return title === 'SRIBD办公智能体' && !url.includes('/renderer/')
```

**不改**：L34 `'DeepChat.exe'`（executableName 未变）、L139-146 userData `'DeepChat'` 路径（APP_NAME 未变）。

- [ ] **Step 2: 其余测试分类（已盘点，仅列结论）**

- 保持不动：`test/mocks/electron.ts:10` 与 `test/setup.ts:129`（`getName` mock 对应不变的 APP_NAME）、`test/main/routes/dispatcher.test.ts` 的 `brand: 'DeepChat'`（消息元数据）、`test/main/routes/contracts.test.ts` `publisher`（appId 侧）、`test/main/device/deviceService.test.ts:50` `X-Title: 'DeepChat'`（发往外部 API 的 HTTP 头，非显示内容，源码 `src/main/device/index.ts:18-19` 不改）、`AboutUsSettings.test.ts`/`AgentWelcomePage.test.ts` 的 i18n mock 值（与真实 locale 无关）、`test/main/desktop/shortcut.test.ts`（getName mock）。
- 若 Task 2/4 执行中发现其他测试失败，按"更新显示期望值、不动标识符断言"原则处理。

- [ ] **Step 3: Commit**

```powershell
git add test/e2e/fixtures/electronApp.ts
git commit -m "test(brand): sync e2e window title fixture"
```

---

### Task 8: 全量验证

- [ ] **Step 1: 质量检查**

```powershell
pnpm run format
pnpm run i18n
pnpm run lint
pnpm run typecheck
```

Expected: 四项全部通过。

- [ ] **Step 2: 相关测试套件**

```powershell
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/desktop --config vitest.config.ts
pnpm exec vitest run --config vitest.config.renderer.ts test/renderer/settings test/renderer/components test/renderer/pages
```

Expected: 全部 PASS（test:main 中预存的 ~98 个环境性失败与本任务无关，按失败文件清单比对确认无新增）。

- [ ] **Step 3: 全局残留审计**

```powershell
pnpm exec rg -n "DeepChat" src --glob "!src/renderer/src/i18n/**"
```

Expected: 输出逐处均为内部标识符（协议、IPC、key、日志、`brand`/`X-Title`、`APP_NAME`、splash preload API、组件/文件名）。在最终汇报中附残留清单与理由。

- [ ] **Step 4: 构建冒烟（可选，验证 productName 变更不破坏打包）**

```powershell
pnpm run build:unpack
```

Expected: 打包成功，产物目录名/快捷方式使用新 productName；`@napi-rs/canvas` asarUnpack 等既有配置不受影响。

- [ ] **Step 5: 人工验收清单（构建后启动应用）**

1. 主窗口标题 = 「SRIBD办公智能体」；设置窗口标题 = 「SRIBD办公智能体 - 设置」
2. 托盘 tooltip 与右键菜单「显示/隐藏 SRIBD办公智能体」
3. 解锁屏/加载页品牌标题
4. 关于页标题与描述、聊天输入框占位符、欢迎页文案
5. Windows 安装包：开始菜单名称、卸载列表显示名 = SRIBD办公智能体
6. 回归：`%APPDATA%\DeepChat` 数据目录不变、历史会话正常加载（APP_NAME 未动）

---

## Self-Review 记录

- **Spec 覆盖**：i18n（Task 1，welcome/update.json 为 spec 文件清单的自然延伸）、静态点（Task 2）、托盘菜单 shared/i18n.ts（Task 3，spec 中"渲染层散落文件"的补全）、组件文案（Task 4）、安装层（Task 6）、helper 正则核对结论已写入 Task 6、验证（Task 8）。Task 5（系统提示词）为 spec 外新发现，已在任务中标注补充理由。
- **占位符**：无 TBD/TODO；Task 4 为按规则决策型任务，决策规则、已知判定与审计命令均已给全。
- **类型/命名一致性**：品牌名常量 ZH=`SRIBD办公智能体`、EN=`SRIBD Office Agent` 全文一致；commit message 均 ≤50 字符。
