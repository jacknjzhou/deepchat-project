# 图像生成提示词范本 — 设计文档

日期：2026-09-27
状态：已确认（用户逐节审阅通过）
范围：聊天内嵌范本（方案 1：config 设置项通道）

## 1. 背景与目标

参考外部产品（截图：图像生成工作台，含 7 类范本卡片：设计创作/商品图/海报制作/图片美化/人像写真/风格创意/写实照片），为 DeepChat 的聊天式图像生成补充**提示词范本能力**：用户选中图像生成模型后，可一键应用精选范本（提示词 + 推荐参数）或自建范本，降低空提示词起步门槛。

### 已确认决策

| 决策点 | 结论 |
|---|---|
| 功能形态 | 聊天内嵌范本（不建独立图像生成页） |
| 数据来源 | 内置范本 + 用户自定义 |
| 点击行为 | 替换输入框提示词 + 应用范本携带的图像参数（size/quality，仅有值字段合并） |
| 入口 | 新会话空态卡片 + 输入工具栏「范本」按钮弹层 |
| 自定义管理 | 弹层内「我的」tab 直接 CRUD（不新建设置页） |
| 实施方案 | 方案 1：config 设置项通道（否决 SQLite 新表——过度设计；localStorage——绕开持久化模式） |

## 2. 数据模型与存储层

### 2.1 shared 契约：`src/shared/imagePromptTemplates.ts`（新文件）

用户自定义范本是唯一持久化形态：

```ts
export const UserImagePromptTemplateSchema = z.strictObject({
  id: z.string().min(1),                    // uuid
  title: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(8000),
  size: z.string().refine(isValidOpenAIImageGenerationSize).optional(),
  quality: z.enum(IMAGE_GENERATION_QUALITY_VALUES).optional(),
  createdAt: z.number().int().positive()
})
```

- `size` 校验复用现有 `isValidOpenAIImageGenerationSize`；`quality` 复用 `IMAGE_GENERATION_QUALITY_VALUES`
- 内置范本**不持久化**，见 2.3

### 2.2 config 通道扩展（4 个接触点）

1. `src/shared/contracts/routes/config.routes.ts`：
   - `CONFIG_ENTRY_KEYS` += `'user_image_prompt_templates'`
   - `ConfigEntryValuesSchema` += `user_image_prompt_templates: z.array(UserImagePromptTemplateSchema)`
   - `ConfigEntryChangeSchema` += 对应 discriminated union member
2. `src/main/config/settingsStore.ts`：默认值 `user_image_prompt_templates: []`
3. 主进程**无读取方**（纯渲染层特性），不新增 settingsRoutes 读取
4. 渲染层经 `configClient.getSetting/setSetting` 读写

### 2.3 内置范本：`src/renderer/src/config/builtinImagePromptTemplates.ts`（新文件）

7 项静态数组，参考截图分类，每项：

```ts
{ id: 'builtin:design', titleKey: 'chat.imageTemplates.design.title',
  promptKey: 'chat.imageTemplates.design.prompt', size?: string, quality?: 'high' }
```

文案经 i18n 解析（见 §5）。内置项不进 config 存储，不受用户增删影响。

### 2.4 渲染层 store：`src/renderer/src/stores/imagePromptTemplates.ts`（新 pinia store）

- `load()`：启动时 `configClient.getSetting('user_image_prompt_templates')`，zod 校验失败回退 `[]` + console.warn
- `add / update / remove`：全量数组回写（量级几十条，无需增量）
- 自定义上限 **50 条**，超限禁用新增
- getter 合并内置（组件内 i18n 解析）+ 自定义

### 2.5 点击应用数据流

```
范本卡片点击（空态卡片或弹层，同一 action）
  → NewThreadPage.message = template.prompt          （替换输入框文本）
  → draftStore.updateGenerationSettings({
      imageGeneration: { size, quality }              （仅有值字段合并，undefined 不覆盖用户已设值）
    })
  → 关弹层/隐藏卡片，焦点回输入框
```

## 3. UI 组件与交互

### 3.1 组件族

| 组件 | 职责 | 挂载点 |
|---|---|---|
| `ImagePromptTemplateButton.vue`（新） | 自含 shadcn Popover：触发按钮 + 精选/我的 tab + CRUD 内联表单；发 `apply-template` 事件 | `ChatInputToolbar` 左侧，`showImageTemplates` 为 true 时渲染 |
| `ImagePromptTemplateCards.vue`（新） | 空态卡片墙（轻量 chips）；发 `apply-template` 事件 | `NewThreadPage` 输入区上方 |
| `ChatInputToolbar.vue`（小改） | 新增可选 prop `showImageTemplates`（默认 false）+ `apply-template` 事件转发 | 已有组件，向后兼容 |

### 3.2 布局（AFTER）

```
空态（选中图像模型且输入为空）              工具栏
+--------------------------------+   +----------------------------------------+
|        开始你的创作              |   | [+] [🖼范本]       [搜索][语音][发送] |
| +--------+ +--------+ +------+ |   +----------------------------------------+
| |设计创作 | |商品图   | |海报  | |              ↓ 点击范本按钮
| +--------+ +--------+ +------+ |   +----------------------------------------+
| |图片美化 | |人像写真 | |风格  | |   | Popover:                               |
| +--------+ +--------+ +------+ |   | [精选] [我的]                  [新增+] |
| |写实照片 |  （点击=应用范本）    |   | | 设计创作                               |
| +--------+                    |   | | 为可持续旅行产品设计…                    |
| +----------------------------+|   | | 1024x1024 · high                      |
| | ChatInputBox              |||   | +---------------------------------------+
| +----------------------------+|   +----------------------------------------+
+--------------------------------+
```

### 3.3 显示条件

- 空态卡片与工具栏按钮均以 `useModelTypeDetection` 的 `isImageGenerationModel` 为前提
- 空态卡片额外条件：`message` 为空且未附文件；开始输入即隐藏

### 3.4 弹层交互（精选/我的）

- **精选**：内置 7 项只读卡片，显示标题 + 提示词预览 + 参数徽标（size · quality）
- **我的**：自定义列表，项悬停显示 编辑/删除；底部「新增范本」→ 内联表单（标题、提示词多行、尺寸下拉 `OPENAI_IMAGE_GENERATION_SIZE_PRESETS`、质量下拉 `IMAGE_GENERATION_QUALITY_VALUES`），校验规则与 §2.1 zod 一致
- 删除需确认（复用现有 confirm dialog 模式）

## 4. 错误边界

| 场景 | 处理 |
|---|---|
| 配置值损坏（zod 校验失败） | `load()` 捕获 → 回退空列表 + console.warn；UI 不崩；主进程契约层天然拒绝非法写入 |
| 自定义超 50 条 | 禁用新增（防超大 JSON） |
| size 与具体模型不兼容 | 范本层不做模型能力探测（YAGNI）；写入侧 zod 拦截非法值，应用侧由现有生成链路错误提示兜底 |
| 长提示词 | 8000 字符契约上限，表单与卡片预览各自截断 |
| 多窗口同步 | v1 非目标：仅启动 `load()`，不做 change 事件订阅（后续可按 providerHealth 模式补） |

## 5. i18n

- 文案挂现有 `chat` 命名空间：`chat.imageTemplates.*`（约 25 key × 20 语言；避免新建 namespace 触发 20 处 index.ts 注册）
- 覆盖：7 内置范本 title/prompt、弹层 UI（tab 名/新增/编辑/删除/确认文案）、空态引导语、参数徽标
- 以英文为基准撰写，zh 系精心校对（主用户群），其余语言可后续润色

## 6. 非目标

- 范本导入/导出、拖拽排序、分类标签
- 跨设备同步、多窗口实时同步
- AI 自动生成范本
- 独立图像生成工作台页面

## 7. 测试与验证

- **主进程**：仅契约 schema 扩展；若现有 config 契约测试枚举 key 需同步更新（无新业务逻辑）
- **渲染层 vitest**（`test/renderer`）：
  - store：add/update/remove、上限 50、持久化载荷断言（mock configClient）
  - `ImagePromptTemplateButton`：精选渲染、我的 tab CRUD、`apply-template` 载荷（prompt+size+quality）
  - `ImagePromptTemplateCards`：`isImageGenerationModel` 条件渲染、点击事件
  - NewThreadPage 集成：apply 后 `message` 与 `draftStore.updateGenerationSettings` 参数断言
- **门禁**：`pnpm run i18n`、format/lint/typecheck、相关渲染层套件
- **人工验收**：选图像模型看空态卡片与按钮 → 点范本填词+参数 → 新增/编辑/删除自定义 → 切非图像模型确认入口消失

## 8. 风险

1. 20 语言翻译质量 → 英文基准，zh 系优先校对
2. `ChatInputToolbar` 多页面复用 → prop 默认 false，其他页面零影响
3. 文案全为新 key，与既有 key（含近期品牌重塑 key）无交集
