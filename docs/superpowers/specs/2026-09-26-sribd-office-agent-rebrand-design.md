# DeepChat 显示品牌重塑为「SRIBD办公智能体」设计文档

日期：2026-09-26
状态：已确认（方案 1 + 用户确认的设计要点）

## 背景与目标

本项目基于 DeepChat 深度定制，需要把所有**用户可见**的 "DeepChat" 显示内容调整为 SRIBD 品牌名，使应用以「SRIBD办公智能体」的名义呈现给最终用户。全项目 "DeepChat" 出现约 1365 处（80 文件），其中绝大多数是内部标识符，不属于本次范围。

## 范围决策（已与需求方确认）

1. **替换范围**：应用内显示 + 安装层显示。内部标识符（协议、userData 路径、包名、appId、IPC 通道名、i18n key）一律不动，保证数据兼容与升级安全。
2. **品牌名映射（双品牌名）**：
   - `zh-CN`、`zh-TW` → `SRIBD办公智能体`
   - 其余 18 种语言 → `SRIBD Office Agent`
   - 静态单语言显示点（HTML `<title>` 等）统一使用中文品牌名（本部署面向中文用户）。
3. **实施方案**：方案 1 —— 译文/显示点直接替换。不做品牌常量参数化（方案 2）或运行时替换层（方案 3）。
4. **CLI 输出文案不在本次范围**（src/cli 保持现状）。

## 修改清单

### 1. i18n 语言包（核心，约 20 语言）

目录：`src/renderer/src/i18n/<locale>/`，涉及 `about.json`、`chat.json`、`dialog.json`、`mcp.json`、`settings.json`、`routes.json`、`sync.json` 及各 `index.ts`。

规则：

- 仅替换**显示值**中的 "DeepChat"；**key 名一律不动**（如 `settings-deepchat-agents`、`deepchat_agent_required`、`deepchatSettings`、`deepChatTargetOnly`）。
- zh-CN / zh-TW 的值：`DeepChat` → `SRIBD办公智能体`。
- 其余语言的值：`DeepChat` → `SRIBD Office Agent`，注意结合上下文微调语法（如 "Ask DeepChat anything" → "Ask SRIBD Office Agent anything"；"Switch to DeepChat Agent" → "Switch to the SRIBD Office Agent"）。
- 组合词 "DeepChat Agent"（指内置 Agent 类型）：zh → `SRIBD办公智能体 Agent`；en → `SRIBD Office Agent`（不出现 "SRIBD Office Agent Agent"）。
- 各语言 `index.ts` 中匹配到的长行需人工确认是显示文案还是代码标识，仅替换显示文案。

### 2. 应用内静态显示点

| 文件 | 修改 |
| --- | --- |
| `src/renderer/index.html` | `<title>DeepChat</title>` → `<title>SRIBD办公智能体</title>` |
| `src/renderer/settings/index.html` | 同上 |
| `src/renderer/splash/loading.vue` | 4 处 `DeepChat` 标题（unlock/recovery/system-unlock/loading 的 unlock-title 与 aria-label）→ `SRIBD办公智能体` |
| `src/main/desktop/window/index.ts:1326` | `'DeepChat - Settings'` → `'SRIBD办公智能体 - 设置'` |
| `src/main/desktop/tray.ts:38` | `setToolTip('DeepChat')` → `setToolTip('SRIBD办公智能体')` |
| `src/main/desktop/preview/AgentPreviewCoordinator.ts:389` | fallback `'DeepChat'` → `'SRIBD办公智能体'` |

渲染层 Vue 组件中散落的 "DeepChat"（如 `ChatStatusBar.vue`、`NewThreadPage.vue`、`TraceDialog.vue`、`SettingsOverview.vue`、`McpSettings.vue` 等 grep 命中文件）逐一人工确认：显示文案则替换，代码标识（变量名、key、样式类名、日志）不动。

### 3. 安装层（electron-builder.yml + package.json）

- `productName: DeepChat` → `productName: SRIBD办公智能体`（影响开始菜单、任务栏应用名、安装目录、卸载列表显示名；`shortcutName`/`uninstallDisplayName` 使用 `${productName}` 自动跟随）。
- `executableName` **保持 `DeepChat`**：可执行文件名属内部标识，避免破坏 CI 打包、更新器与既有升级逻辑。
- macOS helper 匹配正则 `/Contents/Helpers/DeepChat Computer Use[.]app(?:/|$)`：与 CUA 插件打包脚本（`build-cua-plugin-runtime.mjs`）核对 helper app 实际命名来源，若随 productName 变化则同步更新正则。
- `package.json` `description` → `SRIBD办公智能体，一个简单易用的 Agent 客户端`；`name` 保持 `DeepChat`（影响 artifactName `${name}` 与 npm 标识）。

### 4. 绝对不改（内部标识符）

- `src/main/appMain.ts` 的 `APP_NAME = 'DeepChat'`：决定 userData 路径 `%APPDATA%\DeepChat`，改名等同用户数据丢失。
- `appId: com.wefonk.deepchat`、`package.json name`、`deepchat://` 协议与 `x-scheme-handler/deepchat`、preload 全局 `window.deepchatSplash`、IPC 通道名（`deepchat:route:invoke` 等）、i18n key、日志前缀、组件/文件名（如 `DeepChatAgentsSettings.vue` 文件名，仅改其内部显示文案）。

## 验证计划

1. i18n 校验脚本（`pnpm run i18n` / 相关 check）通过，20 语言 key 结构无增删。
2. 渲染层 + 主进程相关测试：同步更新断言 "DeepChat" 显示文本的用例后全量跑 documents 相关与受影响套件。
3. `format` / `lint` / `typecheck` 通过。
4. `pnpm run build` 后人工验收：主窗口/设置窗口标题、托盘 tooltip、splash、关于页、聊天输入框占位符、设置页文案、Windows 安装后的开始菜单与卸载列表名称。
5. 回归确认：`%APPDATA%\DeepChat` 数据目录不变，老数据正常加载。

## 风险与对策

- **20 语言批量替换遗漏/误替换**：以 grep 驱动逐文件核对显示值 vs key 名；i18n 校验 + 抽样人工验收兜底。
- **macOS productName 变更引发 helper/打包脚本不匹配**：实施时核对 CUA 打包脚本并在本机跑 `build:unpack` 验证；macOS 侧以 CI 打包结果为准。
- **测试文本断言失效**：替换测试中作为期望值的显示文本（仅测试期望值，不改测试覆盖的内部标识）。
