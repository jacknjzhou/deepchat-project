# 单据档案独立模型设置（单据识别模型页）设计

日期：2026-09-30
状态：已确认（方案A细化版）

## 1. 背景与目标

"单据档案"（文档识别归档）目前复用全局默认模型：文本抽取走 `defaultModel`，视觉识别走
`defaultVisionModel` → Agent 预设 → 文本模型降级（`src/main/app/composition.ts` 的
`resolveTextTarget`/`resolveVisionTarget`）。用户无法为该功能单独指定模型。

目标：在设置页左侧栏「Agent设置」分组（`groupKey: 'models'`）新增「单据识别模型」页面，
独立配置文本抽取模型、视觉模型、识别并发与推理参数。模型项**必填，未配置则功能不可用**。

已确认的需求决策：

- 设置项：文本抽取模型、视觉模型、并发数、推理参数（temperature/maxTokens）；不新增分类模型项
- 未设置行为：必填，否则不可用（不回退全局默认）
- 存量迁移：升级后自动把现有全局 `defaultModel`/`defaultVisionModel` 预填为新键初始值
- 页面命名：侧栏「单据识别模型」，位于「SRIBD办公智能体 Agent」之后

## 2. 设置键定义（复用 settings 键值存储）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `documents.textModel` | `{providerId, modelId} \| null` | null | 文本抽取模型，必填 |
| `documents.visionModel` | `{providerId, modelId} \| null` | null | 视觉模型（扫描件/图片），必填 |
| `documents.concurrency` | `number` | 4 | 任务级并发，1–10 |
| `documents.temperature` | `number \| null` | null | 0–2，留空=沿用现有内置默认 |
| `documents.maxTokens` | `number \| null` | null | 留空=沿用现有内置默认 |
| `documents.settingsMigrated` | `boolean` | - | 一次性迁移标记，不暴露到 UI |

配套模型引用结构 `{providerId, modelId}` 以 `modelSettings.ts` 内部 zod schema 校验
（方案A无 typed IPC route，不新增 domainSchemas 键）。**不新增 typed IPC route**：读写复用
现有 settings get/set 通道。

## 3. 主进程设计

### 3.1 新模块 `src/main/documents/modelSettings.ts`

把读取/迁移/校验抽成可单测的纯逻辑，composition 只做注入：

- `readDocumentsModelSettings(settingsStore)` → 结构化配置（含各键默认值兜底）
- `migrateDocumentsModelSettings(settingsStore)`：幂等迁移
  - 仅当 `documents.settingsMigrated` 不存在时执行（标记键防重跑，保证用户之后
    **故意清空**不会被再次预填覆盖）
  - `documents.textModel` 为空且全局 `defaultModel` 存在 → 预填
  - `documents.visionModel` 为空且全局 `defaultVisionModel` 存在 → 预填
  - 结束后写 `documents.settingsMigrated = true`
- `validateDocumentsModelSettings(config, providers)`：校验 provider 存在且启用、modelId
  存在于该 provider 模型列表，返回逐项失效原因（供错误文案使用）

### 3.2 composition.ts 接线改造

- `resolveTextTarget`/`resolveVisionTarget` → 只读 `documents.textModel`/`documents.visionModel`，
  **删除全局回退链**（不再读 `defaultModel`/`defaultVisionModel`/Agent 预设）
- `pickVisionTarget` 不再用于降级选择；`isVisionCapable` 保留用于配置校验时对视觉模型
  `vision === true` 的提示性校验（不强制，仅页面黄条提醒）
- `taskManager` 的 `concurrency` 从 `readDocumentsModelSettings` 读取（替换现固定 4）；
  抽取内部 worker 池 `EXTRACT_CONCURRENCY = 3` 保持常量，不暴露
- `generateCompletion` 调用透传 `temperature`/`maxTokens`（null 时维持现行为）

### 3.3 必填判定

`documentExtractor.requireTarget` 对 null target 抛引导性错误（i18n key
`documents.errors.modelRequired`，见 §4.2），任务失败原因与聊天内置工具调用都会显示引导文案，
两条入口（页面任务创建 + 聊天工具）均被拦截。每次 `resolveXxxTarget` 实时读键，配置保存后
即时生效，无需重启。

## 4. 失效配置的错误文案（i18n）

配置指向的 provider/模型在保存后可能被删除或停用。分两层处理，文案均进 20 locale：

### 4.1 renderer 新设置页校验（即时提示）

页面加载与保存前校验，失效行标红并显示：

| 场景 | i18n key | zh-CN 文案 |
|---|---|---|
| provider 已删除 | `settings.documentsModels.invalidProvider` | 所选模型服务商已被删除，请重新选择 |
| provider 已停用 | `settings.documentsModels.disabledProvider` | 所选模型服务商已被停用，请启用后再试 |
| 模型 id 不存在（provider 有效但模型被移除） | `settings.documentsModels.invalidModel` | 所选模型不存在或已被移除，请重新选择 |

保存按钮在任一必填项为空或校验失效时禁用；失效未修正时不允许保存新配置。

### 4.2 主进程运行时错误（任务失败原因）

`resolveXxxTarget` 返回的 target 经 `validateDocumentsModelSettings` 校验，失效时抛出
带 i18n key 的结构化错误（沿用 documents 模块现有错误管道，支持 `{provider}`/`{model}`
插值），任务失败原因直接显示：

| 场景 | i18n key | zh-CN 文案 |
|---|---|---|
| 两个模型项均未配置 | `documents.errors.modelRequired` | 单据识别尚未配置模型，请先在 设置 → Agent设置 → 单据识别模型 中完成配置 |
| provider 已删除/停用 | `documents.errors.modelProviderMissing` | 单据识别模型配置无效：模型服务商 {provider} 已被删除或停用，请重新配置 |
| 模型 id 已不存在 | `documents.errors.modelMissing` | 单据识别模型配置无效：模型 {model} 不存在或已被移除，请重新配置 |

### 4.3 单据档案页引导横幅

`DocumentsSettings.vue` 顶部通过 `settingsClient.getSetting` 探测两个模型键，任一为空时
显示引导横幅（含「去配置」按钮，`router.push` 跳转新页）：

- i18n key：`documents.settingsBanner.required`
- zh-CN：单据识别尚未配置模型，识别任务将无法运行。请在「设置 → Agent设置 → 单据识别模型」中完成配置。

## 5. Renderer 新页面 `DocumentsModelsSettings.vue`

注册三件套：

- `settingsRouteComponents.ts`：`'settings-documents-models': () => import('./components/DocumentsModelsSettings.vue')`
- `settingsNavigation.ts`：新 routeName `settings-documents-models`，`path: '/documents-models'`，
  `groupKey: 'models'`，`position: 3.55`，`icon: 'lucide:receipt-text'`，keywords 含
  `documents/单据/识别/模型/提取`
- settings router 注册 `/documents-models`

页面结构：

1. **卡片1 模型设置**：文本抽取模型 + 视觉模型两行选择器（provider 下拉 + model 下拉）。
   数据源为 `providerStore` 启用服务商及其模型列表，交互参照 DeepChatAgentsSettings 现有
   defaultModel/visionModel 选择器。显式保存；必填未选或校验失效时保存禁用（见 §4.1）
2. **卡片2 识别并发**：1–10 数字输入，默认 4，说明"仅影响任务级并发"
3. **卡片3 推理参数（折叠）**：temperature（0–2，步进 0.1）、maxTokens（正整数），留空=默认

持久化语义（已确认）：保存即落盘（settingsStore 持久化）；重启后页面 onMounted 重读键值
显示用户配置，主进程每次调用实时读键使用新配置；迁移标记键保证重启不会覆盖用户自定义值。

## 6. i18n

- `routes.json`（20 locale）：`settings-documents-models: 单据识别模型`
- `settings.json`（20 locale）：新页文案（页面标题/说明/卡片标题/并发说明/推理参数/校验提示）
- `documents.json` 或现有 documents 命名空间：§4.2/§4.3 错误与横幅文案
- 跑 `pnpm run i18n` 校验并重生成 `i18n.d.ts`

## 7. 测试

- main：`modelSettings` 单测——默认值读取、迁移预填、标记键幂等、清空后不回填、
  validate 三类失效场景
- composition：resolve 函数读新键、必填错误抛出
- renderer：新组件测试（渲染/保存/必填禁用/失效行标红/横幅引导），参照 AboutUsSettings.test.ts 模式
- 更新 documentExtractor 既有用例（原依赖全局回退链的改为新键）

## 8. 验收清单

- [ ] 全新安装：未配置时单据档案页显示引导横幅，任务创建/聊天工具被拦并提示引导文案
- [ ] 配置后：任务正常运行，视觉模型用于扫描件，文本模型用于文本抽取
- [ ] 存量升级：自动预填全局默认，功能无感知，标记键存在
- [ ] 修改模型保存 → 重启：页面显示新配置，任务使用新模型（实时读键）
- [ ] 删除已配置的 provider：新页行标红提示、任务失败显示 providerMissing 文案
- [ ] 移除已配置的模型：新页行标红提示、任务失败显示 modelMissing 文案
- [ ] 并发数/temperature/maxTokens 修改即时生效，并发超界被钳制在 1–10
- [ ] 20 locale i18n 校验通过，typecheck/oxfmt/相关测试通过
