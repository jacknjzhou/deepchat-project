# 数字员工详情 Sheet 设计

日期：2026-10-27
状态：已确认（用户认可方案与四个范围决策）

## 背景与目标

数字员工广场每张卡片点击后目前打开一个混合 Dialog，只罗列 ID/数量级的粗信息。目标：为每个数字员工提供真正的详情视图——关联 SOP 全文、知识库包级状态、技能（服务端定义 + 本地安装状态）与工具（名单 + 就绪状态），纯只读。

## 已确认决策

| 决策点 | 结论 |
| --- | --- |
| 交互形态 | 右侧 Sheet 抽屉（`src/shadcn/components/ui/sheet/` 原语已存在，零新增依赖） |
| 知识库粒度 | 包级状态（复用 `digitalEmployee.knowledgeStatus` 路由，不做概念级明细） |
| 工具深度 | 名单 + provision 就绪状态（不新增 MCP tools/list 描述路由） |
| 操作入口 | Sheet 纯只读；开始对话走卡片显式按钮 → 瘦身 Dialog |
| 结构 | 新建独立 `DigitalEmployeeDetailSheet.vue`；现有 Dialog 瘦身为纯对话弹层 |

## 数据源映射（零新路由、零 main 改动）

| 分区 | 数据 | 来源 |
| --- | --- | --- |
| SOP 全文 | `employee.sops: {title, content}[]` | store 已有员工对象直读（不受执行链路 `SOP_PROMPT_LIMIT=600` 截断影响，该限制仅作用于提示词注入） |
| 知识库状态 | `packages: {knowledgeBaseId, stale, staleReason, lastSyncAt, conceptCount}[]` | 复用 `store.loadKnowledgeStatus(employeeId)`（现有只读路由，Sheet 打开时按需加载） |
| 技能 | 服务端 `employee.skills` 明细 + provision 的 `installedSkills/failedSkills` | store 员工对象 + `store.provisionEmployee` 现有缓存 |
| 工具 | `employee.tools` 名单 + `toolsReady/knowledgeToolReady` | 同上 |

隔离机制不受影响：详情视图纯只读，不触碰 `de-{employeeId}` 寻址、server 白名单或任何执行链路。

## 组件设计

### `DigitalEmployeeDetailSheet.vue`（新建，与广场页同目录）

- Props：`employee: DigitalEmployee | null`、`open: boolean`；emit：`update:open`。
- 分区自上而下：
  1. **概要**：头像、名称、角色、描述、执行模式；
  2. **SOP**：可折叠列表逐条展示标题 + 正文全文；
  3. **知识库**：每 kb 包一张状态卡（最新/过期 + 原因、最近同步时间、概念数）；
  4. **技能与工具**：技能「服务端定义 + 本地安装状态」成对展示；工具名单 + 就绪徽标（含 `de_knowledge_search` 的 `knowledgeToolReady`）。

### `DigitalEmployeeSquarePage.vue`（修改）

- 卡片 click → 打开 Sheet；卡片新增显式「开始对话」按钮（`@click.stop`）→ 打开瘦身后 Dialog。
- 现有 Dialog 移除能力罗列段，只保留开场问题输入 + 开始按钮，消除与 Sheet 的信息重复。

## 副作用约束

详情视图绝不触发 provision：provision 会安装技能、注册 MCP server（含每员工知识检索 server），是有副作用的准备动作。Sheet 只读缓存——未 provision 时展示「尚未初始化，开始对话后自动准备」提示，而不是替用户执行。

## 空态与错误处理

- 未 provision → 技能/工具区提示未初始化；
- `loadKnowledgeStatus` 失败/返回 null → 知识分区失败占位（沿用现有「知识提示是锦上添花」语义，不打断）；
- 无 SOP / 无知识库绑定 / 无工具 → 各分区空态文案（员工未配知识是常态）。

## i18n

20 个 locale 的 `digitalEmployee.json` 新增：四个分区标题、空态与未初始化提示、就绪/失败徽标、同步时间等 key。

## 测试计划

- `DigitalEmployeeDetailSheet` 组件测试（Vitest + Vue Test Utils）：四分区渲染、SOP 全文展示、stale 徽标与原因文案、空态、未初始化态、纯只读断言（无对话输入、不触发 provision mock）。
- 广场页测试更新：卡片 click 开 Sheet、「开始对话」按钮开 Dialog 且冒泡被阻止、Dialog 不再渲染能力罗列。

## 非目标

- 概念级知识明细（需新路由，价值低）；
- 工具 description 展示（需从 staffdeck server tools/list 取，本次不做）；
- 独立路由详情页（已否决）；
- Sheet 内任何写操作或会话入口。
