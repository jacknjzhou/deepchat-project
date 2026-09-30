# DeepChat 代码结构与模块逻辑梳理

> 本文反映 `2026-09-30` 的实际代码，面向新人通读：按目录逐模块分析代码结构与运行逻辑。
> 与 [ARCHITECTURE.md](./ARCHITECTURE.md)（main 进程所有权与生命周期）、[FLOWS.md](./FLOWS.md)（关键流程时序）互补；
> 各子系统的深入合同见 [architecture/](./architecture/) 下的专题文档。

## 1. 项目概览

- **产品定位**：SRIBD办公智能体（`electron-builder.yml` 中 `productName`），基于开源项目 DeepChat 的企业级 AI Agent 桌面客户端。
- **技术栈**：Electron 41 + Vue 3 + TypeScript（全 ESM），electron-vite 构建；状态管理 Pinia；路由 vue-router（hash 模式）；UI 为 Tailwind CSS 4 + shadcn-vue（reka-ui）+ VueUse；文案 vue-i18n（20 个 locale）；契约校验 zod 4；测试 Vitest + Vue Test Utils + Playwright；代码风格 oxlint/oxfmt。
- **核心依赖**：
  - 模型接入：Vercel AI SDK（`ai` + `@ai-sdk/openai|anthropic|google|azure|bedrock|openai-compatible` 等）、`ollama`
  - 工具协议：`@modelcontextprotocol/sdk`（v1/v2 双 wire）、`@agentclientprotocol/sdk`（ACP）
  - 持久化：`better-sqlite3-multiple-ciphers`（加密 SQLite）、`electron-store`、`opendal`、`level`
  - 分析/检索：`@duckdb/node-api`（向量存储 VSS 扩展单独安装）
  - 原生能力：`node-pty`（终端）、`sharp`（图像）、`@arcships/light-ocr`（OCR，独立 helper 进程）、`pdfjs-dist`/`pdf-to-img`、`mammoth`/`xlsx`/`turndown`（文档转换）
- **进程模型**：Electron 三进程（main / preload / renderer）+ 多个 utility 子进程（OCR helper、scheduler、fileWatcher、codeMode、backgroundExec）。

## 2. 顶层目录总览

| 目录 | 角色 |
| --- | --- |
| `src/main/` | 主进程全部业务模块（40+ 子目录，见 §4） |
| `src/preload/` | contextBridge 安全桥（主窗口 + splash/floating/browser-overlay/plugin-settings 四个专用 preload） |
| `src/renderer/` | 渲染层多窗口入口：`src/`（主应用 SPA）、`splash/`、`floating/`、`browser-overlay/`、`settings/`、`services/`，以及共享的 `api/`（main 调用客户端层） |
| `src/shared/` | 三层共享的 typed 契约（routes/events/domainSchemas）与领域类型、工具 |
| `src/cli/` | 随包 CLI（thin client，经 localControl 契约连回主进程） |
| `src/dc-ui/`、`src/shadcn/` | 跨窗口共享的 UI 组件与 shadcn-vue 原语 |
| `src/types/` | 环境声明（`electron-store.d.ts`、`i18n.d.ts`，后者由 `pnpm i18n:types` 生成） |
| `plugins/` | 内置插件源码：`cua/`（计算机使用）、`feishu/`、`office-automation/` |
| `scripts/` | 构建/打包/运行时安装/i18n/lint guard 等脚本（见 §7） |
| `runtime/` | `installRuntime` 安装的 node/uv/rtk，供 MCP npx/uvx 类服务与 code mode 使用 |
| `resources/` | 运行时版本清单、静态资源 |
| `test/` | `test/main`（Vitest）、`test/renderer`（Vitest + Vue Test Utils）、`test/e2e`（Playwright smoke） |
| `docs/` | 架构/流程/指南/SDD 文档（本目录） |

## 3. 三进程与契约层

### 3.1 `src/shared/` — 契约与共享类型（唯一三层共用层）

- `contracts/routes.ts`：汇总各模块 typed route（`chat.routes`、`browser.routes` …）成一份 route contract 目录；
- `contracts/events.ts`：`DEEPCHAT_EVENT_CATALOG`，集中注册事件名与 zod contract；
- `contracts/domainSchemas.ts`：zod 领域模型（如 `DeviceInfoSchema`），既是运行时校验也是 TS 类型来源；
- `contracts/bridge.ts`、`channels.ts`：`DEEPCHAT_ROUTE_INVOKE_CHANNEL` / `DEEPCHAT_EVENT_CHANNEL` 常量与 bridge 形状；
- 其余：`cliCommands.ts`、`localControl.ts`（CLI↔主进程）、`databaseSecurity.ts`、`remoteControlErrors.ts` 等；
- 顶层还有 `chat/`、`orchestration/`、`types/`、`utils/`、`lib/` 与大量领域文件（`model.ts`、`providerDbCatalog.ts`、`documents.ts`、`imagePromptTemplates.ts`、`cronJobs.ts`、`toolMode.ts`、`agentTools.ts` 等）。

**约定**：renderer 与 main 之间不存在裸 `ipcRenderer.send` 业务消息，一切调用/事件都先在 shared 里定义 schema 契约。

### 3.2 `src/preload/` — 安全桥

- `index.ts`：`contextBridge.exposeInMainWorld('deepchat', bridge)`（context isolation 开启时），另有 `splash-preload.ts`、`floating-preload.ts`、`browser-overlay-preload.ts`、`plugin-settings-preload.ts` 四个窗口专用 preload；
- `createBridge.ts`：
  - `invoke()`：按 shared route contract 校验输入 → `ipcRenderer.invoke(DEEPCHAT_ROUTE_INVOKE_CHANNEL, ...)` → 校验输出后返回；
  - `on()`：统一监听 `DEEPCHAT_EVENT_CHANNEL`，按 event catalog 解析 payload 后分发回调。

**安全边界**：context isolation 常开，原生能力只能经 typed 契约暴露，renderer 拿不到 Node 能力。

### 3.3 两条核心链路（新人必背）

**请求链（renderer → main）**：

```
Vue 组件 / store
  → src/renderer/api/XxxClient.ts        （每模块一个客户端封装）
  → src/renderer/api/core.ts             （invokeDeepchatRoute）
  → window.deepchat.invoke(...)          （preload createBridge.ts，校验契约）
  → ipcMain.handle(DEEPCHAT_ROUTE_INVOKE_CHANNEL)
  → src/main/routes/index.ts dispatchDeepchatRoute
  → src/main/routes/routeRegistry.ts 合并的各模块 route map
  → 具体模块 service
```

**事件链（main → renderer）**：

```
main 模块 → typedEventHub.publish(target, event)
  → src/main/events/sessionEventRouter.ts   （按 session 归属分流：
      run 流式事件 → run stream；其余 → 绑定 renderer / renderer-all）
  → webContents.send(DEEPCHAT_EVENT_CHANNEL)
  → preload createBridge.on()（按 catalog 解析）
  → src/renderer/src/events.ts / store 订阅
  → UI 更新
```

### 3.4 `src/main/routes/` 与 `src/main/events/`

- `routeRegistry.ts`：`createRouteMap`（模块声明自己的 route→handler）、`requireRendererCaller`（来源校验）、`createRouteRegistry`（合并全部模块 route map）；
- `index.ts`：全应用唯一的 `ipcMain.handle` 挂点，构造 renderer caller context 后分发；
- `typedEventHub.ts`：`publish` 支持 `renderer-all`、指定 renderer、run/event-stream 订阅者多类目标；
- `sessionEventRouter.ts`：解析 payload 中的 session id，区分已知/未知 session、CLI run 归属，决定流式与常规事件的去向。

## 4. main 进程模块

### 4.1 入口与组合根

| 文件 | 职责 |
| --- | --- |
| `src/main/appMain.ts` | Electron 进程入口：single-instance 锁（冲突时弹窗提示"已在运行"再退出，不静默退出）、deeplink 缓存、`open-url`/`second-instance`、`whenReady → startMainProcess` |
| `src/main/app/mainProcess.ts` | 启动序列：设置 app user model → 创建 splash → 初始化 settings/secret/privacy/proxy/mcp/acp catalog → 数据库解锁与迁移 → 注册协议 → 创建 `MainProcessControl` |
| `src/main/app/composition.ts` | **唯一组合根**：创建全部业务模块、注入显式依赖、`registerRoutes()`（provider/tool/plugin/skill/mcp/remote 等 route map）、排定启动与停止顺序；不提供按名称查模块的能力 |
| `src/main/*UtilityHostEntry.ts` | 独立子进程入口：`lightOcrHelperEntry`（OCR helper）、`schedulerUtilityHostEntry`、`fileWatcherUtilityHostEntry`、`codeModeUtilityHostEntry`、`backgroundExecUtilityHostEntry` |

启动顺序（概化）：settings/secret → 数据库解锁+迁移 → 能力模块（provider/tool/mcp/skill/plugin/memory/knowledge）→ session/agent → desktop（窗口）→ 延迟启动 floating button、skill sync、MCP、remote runtime 等。

**依赖方向**（自上而下，下层禁止反向引用）：

```
App composition → Desktop / Remote / Scheduler / Deeplink → Session → Agent runtime
  → Provider / Tool / MCP / Skill / Plugin / Memory / Knowledge / Workspace
  → Platform / Settings / Data
```

### 4.2 `desktop/` — 桌面交互层

`window/`、`tab/`、`tray.ts`、`shortcut.ts`、`contextMenu.ts`、`dialog.ts`、`notification.ts`、`floatingButton/`、`browser/`（内嵌浏览器视图）、`computerUse/`（CUA 桌面控制）、`preview/`、`pluginSettingsWindow.ts`、`sessionBinding.ts`、`settings.ts`、`routes.ts`。

- 内部的 `WindowPresenter`、`TabPresenter` 等是历史类名，只是 desktop 模块内部实现；
- **窗口↔Session 的绑定在 `sessionBinding.ts`**，不属于 Session 数据：窗口关闭不删除 Session，也不默认停掉其他入口仍在使用的任务。

### 4.3 `session/` — 会话域

| 文件 | 职责 |
| --- | --- |
| `lifecycle.ts` | Session 创建、草稿、关闭等基础生命周期 |
| `turn.ts` | 发送、排队、停止、交互回复（一次用户输入 = 一个 Turn） |
| `assignment.ts` / `assignmentPolicy.ts` | 为 Turn 分派 Agent、模型、project、fork、subagent 结果归属 |
| `query.ts` | 只读查询（绝不偷偷加载 Agent） |
| `deletion.ts` / `deletionGate.ts` | 删除顺序与两类 backend 清理 |
| `chatService.ts` / `sessionService.ts` | 对外服务门面 |
| `clientMessageProjection.ts` | 消息到客户端视图的投影 |
| `sessionHistorySearch.ts` / `transcriptMutations.ts` | 历史搜索、transcript 修改 |
| `submissionCancellationRegistry.ts` / `subagentAuthority.ts` | 提交/取消登记、subagent 权限 |
| `usageStats.ts` / `usageStatsService.ts` | token 用量统计 |
| `data/` | transcript、Tape、pending input、settings、search、trace 等长期数据访问 |

### 4.4 `agent/` — Agent 运行时（双实现）

- `manager/`：`AgentManager` 按 `AgentDescriptor.kind` 分派；
- `deepchat/`：内置实现 `DeepChatAgentRuntime` → `DeepChatAgentInstance` → `DeepChatLoopEngine`（自研 agent loop）；
- `acp/`：`AcpAgentRuntime`/`AcpAgentInstance` + ACP protocol runtime（外部编码/任务 agent）；
- `repository/`：agent catalog（内置 + 用户自定义命令）；`shared/`、`vision/`、`data/`；
- 并发与生命周期控制：`invocationAdmission.ts`、`lifecycleGate.ts`；
- 对外：`routes.ts`、`promptRoutes.ts`、`promptSettings.ts`、`settings.ts`、`traceSettings.ts`。

**核心模型**：一个已加载 Session 对应一个 Agent Instance；每次 Turn 创建独立 **Run**（保存取消信号、provider round、request sequence、临时输出状态）。Session 拥有长期数据，Agent runtime 只通过窄接口读写。

### 4.5 能力模块

| 模块 | 关键结构 | 职责要点 |
| --- | --- | --- |
| `provider/` | `settings.ts`、`providerDbLoader.ts`、`data/settingsTable.ts` | 模型供应商/模型配置与请求认证；provider DB 来源链：远端 `DEFAULT_PROVIDER_DB_URL` → 缓存 → 内置，`DEEPCHAT_PROVIDER_DB_OFFLINE` 固定离线；SQLite 表：`providers`/`provider_models`/`model_status`/`model_configs` |
| `tool/` | `index.ts` | Tool 服务：汇总 MCP、Agent、Skill、Plugin、CodeMode、内置工具来源 + 权限 broker（permission broker）；保留 agent tool 名与外部文件访问策略 |
| `mcp/` | `index.ts`、`serverManager.ts`、`settings.ts` | MCP 配置、server/client 生命周期（含 OAuth、in-memory server、MCP Apps sandbox registry）；内置 servers：builtinKnowledge、deep-research、auto-prompting、conversation-search；v1/v2 双 wire |
| `skill/` | `discoveryWorker.ts`、`archive*.ts`、`sync/`、`skillTools.ts`、`skillExecutionAuthority.ts` | Skill 从文件夹/ZIP/URL 安装、扫描发现（worker）、与外部工具（Claude Code 等）互导同步、执行授权、贡献为 agent tools |
| `plugin/` | `index.ts` | `.dcplugin` 插件安装/激活/运行时迁移；内置分发插件：cua、feishu、office-automation |
| `memory/` | `core/`、`infra/vectorStoreManager.ts`、`services/`、`data/` | 长期记忆：写入、检索、索引与后台维护；向量 store 带 lease 与 config identity，embedding 配置变更时重建（duckdb VSS） |
| `knowledge/` | `index.ts` | 内置知识库：存储目录、embedding/file port、task queue、RAG 实例缓存与生命周期；同时以 MCP server 形式暴露 |
| `workspace/` + `file/` | `workspace/fileSecurity.ts`、`pathResolver.ts`、`file/adapters/` | Workspace 目录授权、文件树/搜索/预览协议；文件 MIME 检测、校验与格式转换（docx/xlsx/pdf 等） |
| `documents/` **（SRIBD）** | `taskManager.ts`、`extractor/`、`presetTemplates.json`、`repository.ts`、`data/` | 文档识别归档：批量任务队列（并发、进度、失败重试）、按文件智能路由提取（PDF 文本层 / 视觉模型 / OCR）、发票预设模板、归档入库与 CSV 导出 |
| `resumeScreening/` **（SRIBD）** | `service.ts`、`textExtractor.ts`、`llmInvoker.ts`、`prompts.ts`、`resumePreviewProtocol.ts`、`data/` | 简历筛选助手：文本抽取 + LLM 流水线生成结构化候选人画像与面试要点，进度事件驱动 UI |
| `ocr/` | `lightOcrProcessHost.ts`、`lightOcrProtocol.ts`、`ocrExtractionScheduler.ts`、`ocrArtifactStore.ts`、`attachmentCapabilityRouter.ts`、`ocrRuntimeService.ts` | OCR 子系统：light-ocr 跑在独立 helper 进程（协议通信）；提取调度、产物/缓存、runtime 资产解析；附件能力路由决定走文本层/视觉/OCR |
| `remote/` | `index.ts`、`binding/store.ts`、channel manager、delivery | IM 远程控制：Telegram、Feishu/Lark、QQBot、Discord、WeChat iLink 频道 runtime；endpoint 与 session 绑定；`/start`、`/pair`、`/new`、`/sessions`、`/model` 等命令协议 |
| `scheduler/` | `index.ts`、`routes.ts`、`data/tables/cronJobs.ts`、独立 `schedulerUtilityHostEntry` | Cron 定时任务：`cron_jobs` 表（表达式/时区/agent/权限策略/delivery）、run executor、detached session 进程管理、reconcile |
| `orchestration/` | `liveDelegation*.ts` | Live delegation（会话间委托）：consent、safety、repository、task contract |
| `approval/` | `approvalBroker.ts` | 工具/权限审批 broker |
| `tape/` | `application/`、`domain/`、`infrastructure/`、`ports/` | Session Tape（四层架构）：结构化工作记录、ViewManifest、回放、subagent lineage（详见 [architecture/tape-system.md](./architecture/tape-system.md)） |
| `settings/` + 各模块 `settings.ts` | — | 底层 `electron-store` 存储；各模块在自己的 `settings.ts` 里解释自己的配置键 |
| `data/` + 各模块 `data/` | `databaseConnection.ts`、`baseTable.ts` | SQLite 统一连接封装（`better-sqlite3-multiple-ciphers`，带解密与错误清理）；`baseTable` 提供「建表/迁移检查/schema version」基类，各模块 data/ 自管表 |
| 其他 | `device/`（设备与 Windows 账户信息）、`deeplink/`、`notifications/`、`exporter/`、`sync/`（多端同步）、`upgrade/`（更新）、`onboarding/`、`project/`、`config/`、`platform/`（跨平台差异）、`hook/`、`toolchains/`（node/uv 运行时管理）、`cli/`（CLI 后端支撑）、`logging/`（JSONL 结构化日志）、`lib/`、`utils/` | 支撑域 |

### 4.6 横切约定（读代码前先记住）

1. **模块三件套**：能力模块普遍遵循 `routes.ts`（typed route map）+ `settings.ts`（配置解释）+ `data/`（自有表）的目录约定；
2. **依赖单向**：见 §4.1 依赖方向图，renderer 通知一律由 App 在创建模块时注入 typed 发送函数；
3. **native 模块封装点**：SQLite 在 `data/databaseConnection.ts`、duckdb 在 `memory/infra/vectorStoreManager.ts`、light-ocr 独立进程（`lightOcr*`）、sharp/node-pty/opendal 均被包在对应模块内部，不外泄到 renderer。

## 5. renderer 渲染层

### 5.1 多窗口入口

`src/renderer/` 下除主应用 `src/`（`index.html` + SPA）外，还有 `splash/`、`floating/`（悬浮球）、`browser-overlay/`、`settings/`（独立窗口）、`services/` 等入口，各自配套专用 preload；共享的 `api/`（调用客户端层）放在 `src/renderer/api/`。

### 5.2 主应用 `src/renderer/src/`

- **入口/路由**：`main.ts`、`App.vue`、`router/index.ts`（hash 模式）。主要页面：
  - `/chat` → `apps/chat-main/ChatTabView.vue`（聊天主界面，多 Tab 会话）；
  - `/plugins`（children：catalog / `skills` / `mcp` / `builtin/ocr` / `:pluginId` 详情）；
  - `/documents` → 文档识别归档（`pages/documents/DocumentsArchivePage.vue`）；
  - `/resume-screening` → 简历筛选（`pages/resumeScreening/ResumeScreeningPage.vue`）；
  - `/welcome`、`NewThreadPage`、`AgentWelcomePage`。
- **apps/**：`chat-main` 聊天主应用；**features/**：`chat-page` 聊天页业务组件群；
- **components/**：按域组织 —— `chat`、`chat-input`、`message`、`markdown`、`artifacts`、`mcp`、`mcp-config`、`acp`、`agent`、`settings`（含 `AboutUsSettings.vue` 等设置分区）、`sidepanel`、`spotlight`、`tape-inspector`、`trace`、`workspace`、`computerUse`、`toolchains`、`editor`、`ui`（shadcn 封装）等；
- **stores/**（Pinia，30+）：`providerStore`、`modelStore`/`modelConfigStore`、`mcp`、`skillsStore`、`documents`、`resumeScreening`、`imagePromptTemplates`、`dialog`、`theme`、`language`、`upgrade`、`sync`、`cliApproval`、`artifact` 等——一个业务域通常一个 store；
- **api/**：`src/renderer/api/` 下 40+ 个 `XxxClient.ts`（与 main 模块一一对应：`ChatClient`、`SessionClient`、`ProviderClient`、`McpClient`、`DocumentsClient`、`ResumeScreeningClient`、`OcrClient`、`DeviceClient` …），统一经 `core.ts` 的 `invokeDeepchatRoute` 走 preload bridge；
- **事件订阅**：`src/renderer/src/events.ts` 封装事件订阅，store/组件消费后驱动 UI；
- **渲染栈**：markstream-vue（Markdown/流式渲染，含 `imgcache://` 协议的定制图片组件）、CodeMirror（代码块）、mermaid/katex、tiptap（输入框）、monaco、xterm；
- **i18n**：`src/renderer/src/i18n/<locale>/*.json`，20 个 locale，`pnpm i18n` 校验 + `pnpm i18n:types` 生成 `src/types/i18n.d.ts`。

### 5.3 业务 feature 的组织范式

一个 SRIBD 业务功能（如简历筛选）横跨四层，读代码时可按此线索追踪：

```
shared/contracts + shared/documents 等领域类型（契约）
  → src/main/<feature>/（service/routes/data，业务与持久化）
  → src/renderer/api/<Feature>Client.ts（调用客户端）
  → src/renderer/src/stores/<feature>.ts + pages/<feature>/ + components（UI）
```

## 6. 周边目录

### 6.1 `src/cli/` — 随包 CLI

`index.ts`（`runCli`）、`args.ts`（参数/输出模式/超时/stdin）、`run.ts`、`transport.ts`（经 shared `localControl` 契约连回主进程）、`artifacts.ts`、`discovery.ts`、`format.ts`、`errors.ts`。构建产物 `out/cli` 随包分发（见 [guides/cli.md](./guides/cli.md)）。

### 6.2 `plugins/` — 内置插件

- 插件：`cua/`（跨平台计算机使用）、`feishu/`、`office-automation/`（含百度搜索）；
- **manifest 约定**：每个插件根目录 `plugin.json`，声明 id/name/version/publisher/source/engines/skills/settingsContributions，可携带 `mcp/`（插件自带 MCP server，注意 startMode/surfaces 声明）、`runtime/`、`policies/`、`settings/`、`vendor/`；
- 打包流程：`scripts/plugin.mjs validate|package|bundle|verify` → `package-plugin.mjs` 产出 `deepchat-plugin-<name>-<version>[-<platform>-<arch>].dcplugin` 到 `build/bundled-plugins/` → electron-builder 进 `app.asar.unpacked`（详见 [guides/plugin-packaging.md](./guides/plugin-packaging.md)）。

### 6.3 `scripts/`（按用途）

- **构建准备**：`set-build-version.mjs`、`generate-icon-collections.mjs`、`fetch-provider-db.mjs`（provider DB 产物化）、`fetch-acp-registry.mjs`（ACP registry 产物化，随正常构建刷新）；
- **插件**：`plugin.mjs`、`package-plugin.mjs`、`build-cua-plugin-runtime.mjs`（CUA 原生 runtime，须在目标平台构建）；
- **运行时**：`install-runtime.mjs`（按 `resources/runtime-versions.json` 装 node/uv/rtk 到 `runtime/`）、`installVss.js`（duckdb VSS 扩展）；
- **i18n**：`validate-i18n.mjs`、`generate-i18n-types.js`；
- **质量**：`agent-cleanup-guard.mjs`、`alert-dialog-contract-guard.mjs`（repo 自定义 lint guard）、`generate-architecture-baseline.mjs`（架构基线报表）。

### 6.4 构建与打包

- `electron.vite.config.ts`：main / preload / renderer 三段入口；Vue、Tailwind 4、Monaco、svg-loader 等插件；renderer 多 HTML entry；
- `electron-builder.yml`：`productName: SRIBD办公智能体`；asar 打包 + `app.asar.unpacked` 放置 `out/cli`、`runtime/`、`resources/`、`build/bundled-plugins/`；macOS 另嵌 managed helper；
- 命令链：`pnpm dev`（electron-vite dev --watch）；`pnpm build`（typecheck → electron-vite build → cli:build）；`pnpm build:win|mac|linux[:arch]`（build → 三个插件 bundle → installVss → electron-builder）。

## 7. 关键流程（文字时序）

1. **应用启动**：`appMain`（single-instance 检查 → deeplink 缓存）→ `app/mainProcess`（splash → settings/secret/proxy → 数据库解锁+迁移 → 协议注册）→ `app/composition`（创建模块 → registerRoutes → 依序 start → 延迟启动 floating/skill sync/MCP/remote）→ desktop 创建窗口加载 renderer。
2. **发一条消息**：输入框 → `ChatClient` → route `session.turn` → `session/turn.ts` 排队 → `assignment` 确定 agent/model → `AgentManager` 取 instance → DeepChat LoopEngine 或 ACP runtime 创建 Run → provider 流式请求 → 工具调用走 `tool`（MCP/内置/Skill）→ run 事件经 `sessionEventRouter` 推 run stream → renderer 流式渲染；全过程由 Tape 记录。
3. **文档识别（SRIBD）**：`DocumentsClient` 创建任务 → `documents/taskManager` 并发队列 → `extractor` 智能路由（PDF 文本层直接抽 / pdfjs 渲染 + 视觉模型 / OCR 兜底）→ 字段校验与金额交叉校验 → repository 入库 → 事件刷新归档 UI。
4. **简历筛选（SRIBD）**：`ResumeScreeningClient` → `resumeScreening/service` → `textExtractor`（文本层/视觉/OCR）→ `llmInvoker` 按 `prompts` 产出结构化画像与面试要点 → 入库 → 进度事件驱动任务列表。
5. **远程控制**：`remote` 频道 runtime 收 IM 消息 → 校验/配对 → 定位绑定 session → 复用 Turn 链路 → 结果回传 IM。
6. **定时任务**：scheduler utility host 触发 cron → 创建 detached session 跑 Turn → delivery router 投递结果。

## 8. 测试体系

| 套件 | 位置/配置 | 说明 |
| --- | --- | --- |
| 主进程 | `test/main`（`vitest.config.ts`） | 纯 Node 可跑大多数套件；sqlite/duckdb 等原生模块测试需 `ELECTRON_RUN_AS_NODE=1 pnpm exec electron ./node_modules/vitest/vitest.mjs run <files>` |
| 渲染层 | `test/renderer`（`vitest.config.renderer.ts` + Vue Test Utils） | `test/setup.ts` 全局 mock fs/path，触盘测试需在文件头 `vi.unmock` |
| E2E | `test/e2e`（Playwright） | `pnpm e2e:smoke` |
| 记忆系统 | `vitest.config.memory*.ts` 系列 | 专门的 scope/type/perf/eval 门禁 |

约定：新增测试定位为回归保护（用户可见行为、持久化/迁移、生命周期/并发、恢复、安全边界），不写实现耦合的测试。

## 9. 延伸阅读

- [ARCHITECTURE.md](./ARCHITECTURE.md)：main 进程模块所有权、生命周期与依赖方向的权威描述
- [FLOWS.md](./FLOWS.md)：启动、Session、Agent、Tool、Remote、Scheduler、Sync、退出流程
- [architecture/](./architecture/)：agent-system、session-management、tool-system、memory-system、tape-system、event-system 等专题合同
- [guides/](./guides/)：getting-started、dev-windows、cli、plugin-packaging
