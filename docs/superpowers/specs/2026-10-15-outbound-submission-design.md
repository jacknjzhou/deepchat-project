# 出站提交（分组数据 → 外部系统）设计

- 日期：2026-10-15
- 状态：已评审通过（brainstorming 产出）
- 分支：20261014
- 关联：`2026-10-15-inbound-notifications-design.md`（入站通知，Phase 2）、`2026-10-15-mcp-integration-evolution-design.md`（MCP 演进，Phase 3）

## 1. 背景与目标

智能信息识别（文档提取）已能将单据结构化落库，并按「报销类别 → 自定义分组」组织。本设计新增**出站集成能力**：用户把一个分组下的已识别数据，通过外部系统接口提交出去。

目标系统：财务、科研、合同、人事、OA 五类自建/集团系统，**接口规范均未确定**；首版以 OA 系统单通道跑通全流程。

## 2. 需求决议（brainstorming 澄清结果）

| 决议点 | 结论 |
| --- | --- |
| 触发方式 | 手动：分组节点上发起，payload 预览后确认提交 |
| 分组语义 | 复用现有报销分组树（`reimbursement_group_override` 维度），零新增分组管理 |
| 目标系统 | 已知五类（财务/科研/合同/人事/OA），规范未定；首版仅 OA 一条通道 |
| 提交粒度 | 整组一次批量请求（payload 为单据数组） |
| 失败处理 | 批次记录（payload/响应快照）+ 手动重推；**不做自动重试** |

## 3. 非目标

- 自动推送（单据确认后自动入队）——二期再评估
- 自动重试/退避——由手动重推覆盖，避免对端重复提交风险
- 财务/科研/合同/人事四类系统的专用代码——未来各自 = 一条新通道配置或一个新 Adapter
- MCP 传输实现——见演进文档（Phase 3），本设计仅保证接口可插拔

## 4. 方案选型记录

三个候选：A 通道注册表 + 通用 HTTP 适配器 + 批次表（选定）；B MCP/插件化出站（否决：提交管理能力碎片化、规范未定无法启动、插件桥接扩大安全面；其优势「第三方分发/Agent 编排」当前不成立，且未来可以 Adapter 形态并入 A）；C 单一全局配置（否决：五类系统共用一配置不可扩展）。

## 5. 总体架构

新模块 `src/main/integrations/`（与 `src/main/documents/` 平级）：

```
integrations/
  submission/
    submissionService.ts        # 渲染 → 落批次 → HTTP 提交 → 状态回写
    submissionChannelAdapter.ts # 窄接口（唯一契约）
    genericHttpAdapter.ts       # 首版唯一实现
    templateRenderer.ts         # payload 模板渲染（纯函数）
    repository.ts
    routes.ts                   # zod 契约路由
    data/tables/submissionChannels.ts
    data/tables/submissionBatches.ts
```

**适配器接口（唯一契约，签名按「可插拔 MCP Adapter」预留）：**

```ts
interface SubmissionChannelAdapter {
  /** 传输无关：配置对象入参，不允许出现 URL 字符串等 HTTP 特有概念 */
  submit(input: {
    channel: SubmissionChannelConfig
    payload: unknown            // 已渲染的模板产物
    signal?: AbortSignal
  }): Promise<SubmissionResult> // { ok, httpStatus?, responseBodySnippet?, errorMessage? }
}
```

核心代码不认识任何外部系统；新系统 = 新通道配置（规范通用）或新 Adapter 实现（规范特殊）。

## 6. 数据模型（2 张新表）

新建 `IntegrationsDatabase`/repository，复用项目 `BaseTable` 与 `src/main/data/schemaCatalog.ts` 的表注册方式；明确全新数据库的建表与既有数据库的幂等补建/索引路径。documents 的 `ensureMigrated()` 特例用于修复已有约束，不应机械照搬或绕开主 schema_versions 机制；若新表纳入主 schema catalog，按项目实际 schema version/repair 流程实施。

```sql
CREATE TABLE IF NOT EXISTS submission_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  system_type TEXT NOT NULL DEFAULT 'oa',   -- 'oa'|'finance'|'research'|'contract'|'hr'，首版仅 oa
  endpoint_url TEXT NOT NULL,
  auth_secret_ref TEXT,                         -- 认证凭据引用安全存储，不保存明文 header/value
  auth_scheme TEXT NOT NULL DEFAULT 'custom',   -- custom|bearer|basic|api-key（具体 header 由适配器决定）
  payload_template_json TEXT NOT NULL,
  type_key_filter_json TEXT NOT NULL DEFAULT '[]', -- 空=不过滤；非空=仅匹配模板 type_key 的单据纳入
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS submission_batches (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES submission_channels(id),
  category_id TEXT,                         -- 来源分组快照（类别/分组 id+名称）
  group_id TEXT,
  category_name TEXT,
  group_name TEXT,
  document_ids_json TEXT NOT NULL,
  payload_snapshot_json TEXT NOT NULL,      -- 渲染结果，审计依据
  status TEXT NOT NULL CHECK(status IN ('pending','success','failed','unknown')), -- unknown=超时/进程中断，需人工核实
  response_status INTEGER,
  response_body_snippet TEXT,               -- 脱敏后截断存储（如 4KB）
  error_message TEXT,
  resubmitted_from TEXT,                    -- 重推来源批次 id，NULL=首发
  idempotency_key TEXT NOT NULL,            -- 首发与重推沿用同一业务键，传给 OA（需对端支持）
  submitted_at INTEGER,
  created_at INTEGER NOT NULL
);
```

## 7. Payload 模板渲染（纯函数）

占位符语法仅两种：**点路径取值** + **显式数组迭代节点**，不引入表达式引擎。

上下文变量：`{{batch.id}}`、`{{group.name}}`、`{{group.categoryName}}`、`{{docs.length}}`；数组块内 `{{doc.typeKey}}`、`{{doc.fields.invoice_no.value}}` 等。

```json
{
  "batchNo": "{{batch.id}}",
  "groupName": "{{group.name}}",
  "items": {
    "$each": "docs",
    "template": { "type": "{{doc.typeKey}}", "invoiceNo": "{{doc.fields.invoice_no.value}}" }
  }
}
```

规则：
- 缺字段/空值 → 填 `null`，并在预览中**标黄警告**，不阻塞提交（fail-open，与识别哲学一致）
- 模板必须是合法 JSON（管理员保存时校验），渲染采用**解析后的 JSON 树递归替换**：整个字符串恰为单一占位符时保留原始 JSON 类型（缺值为真正的 `null`、数字仍为数字）；字符串内插值只允许标量且转成文本。数组迭代使用显式 `"$each": "docs"` 节点而非隐式识别单元素数组；不执行脚本/表达式。
- 预览在主进程一次性生成 `previewId + payloadSnapshot + documentIds + documentUpdatedAt` 并保存有限时长；确认提交仅引用 previewId，在事务内核验单据、分组、通道配置未变后把**相同快照**落库发送；已过期/有变化时要求重新预览（避免预览与发送不一致）。
- `fields` 按模板字段 key 取值（参见 `documentTemplateFieldSchema`），示例中的中文标签 `发票号码` 仅作示意，真实模板应使用稳定字段 key。

## 8. 提交流程与 UI

```
分组树节点「提交到外部系统」
  → 通道选择（仅列出 enabled 且 type_key_filter 匹配该组单据的通道）
  → 预览对话框（渲染 JSON 全文 + 缺字段警告列表）
  → 确认 → 主进程落批次(pending) → HTTP POST → success/failed 回写 → 刷新批次列表
```

- UI 落点：`DocumentsArchivePage` 分组树节点操作 + 独立设置窗口（`src/renderer/settings/`）「外部系统通道」分区（Phase 1 仅出站 tab）。主进程通过 `app/composition.ts` 装配服务与 `createRouteMap` 路由；共享契约需注册到 `src/shared/contracts/routes.ts`，并由对应 renderer client 调用。
- 批次历史：通道详情内列表（状态、时间、响应摘要、来源分组）；failed 批次「重推」= 从**原始 payload 快照**复制出新尝试（`resubmitted_from` 指向旧批次），沿用原始 `idempotency_key`，旧批次永久保留。若需提交修改后的单据，必须走新预览、新业务批次（新键），不能称为「重推」。
- 仅提交 `confirmed` 单据；分组成员在主进程从 repository + 当前报销配置重新解析，不能相信渲染器传入的单据列表。若组中存在 draft，预览明确显示排除数量；空组禁止提交。

## 9. 错误处理

- 明确未发出的网络连接失败/非 2xx 记为 `failed`；请求可能已送达但超时/连接中断记为 `unknown`，记录 `error_message`（脱敏、截断）与 `response_body_snippet`。
- 不做自动重试。`unknown` 必须显示「结果未知，请先到 OA 核实」，禁止直接重推；核实后人工标注结果或二次提交。`failed` 的重推沿用 `idempotency_key` 并要求 OA 端具备幂等识别；**在 OA 接口尚未确认可幂等前，禁用一键重推，改为核实后人工确认的二次提交**，不得承诺 exactly-once。
- 启动时滞留的 `pending` 转为 `unknown` 待核实，不能自动重新发送；同一批次并发确认/重推需要数据库状态条件更新或唯一约束拦截。
- 通道删除：有批次引用的通道禁止删除（主进程强制检查，UI 提示），避免批次悬挂

## 10. 安全

- 凭据使用项目现有凭据保护方案（实施时核实其持久化与跨进程边界）或 OS 密钥链保存，`submission_channels` 仅存 `auth_secret_ref`，列表/路由不返回明文；如需额外自定义 header，仅允许非敏感 header 配置，拒绝 Authorization/Cookie 等敏感字段明文入库。实施前确认项目实际可用的凭据存储实现。
- 所有出站请求仅主进程发起；生产默认仅允许 `https:`，本地开发 mock 可限定 `127.0.0.1`；禁止 file/ftp、任意环回/内网地址及重定向穿透。集团内网 OA 若确实仅提供 HTTP，必须经企业策略显式放行特定主机、端口和协议，说明明文传输风险；UI 输入的“管理员”配置不构成主机层面的信任边界。限制请求/响应体大小、超时、重定向次数，并脱敏日志及响应快照。
- 渲染器只传分组 ID、通道 ID 和预览 ID；服务层不相信渲染器提供的 payload、单据列表或目标 URL。

## 11. 测试策略（Vitest，最小持久集）

| 层 | 持久保留用例 |
| --- | --- |
| 渲染器纯函数 | 数组迭代、缺字段→null+警告、非法路径、`{{docs.length}}` |
| 表层 | CRUD、迁移幂等重入、批次状态机 CHECK |
| 服务层 | fetch mock：成功/超时/非 2xx → 批次状态与快照；重推复制语义 |
| 契约层 | zod 校验、secret 脱敏打码 |
| UI | 预览对话框挂载冒烟、提交入口可达 |

端到端验证：`test/` 内本地 mock OA http server（规范落地后替换真实地址）。

## 12. 实施阶段（Phase 1，对应 plan T1-T4）

| 任务 | 内容 |
| --- | --- |
| T1 | 渲染器纯函数 + 两表 DDL + repository |
| T2 | SubmissionService + GenericHttpAdapter + 契约路由 |
| T3 | 设置页通道管理（出站 tab）+ 分组树提交入口 + 预览对话框 |
| T4 | 批次历史 + 手动重推 |

T1-T4 完成即独立可交付（OA 跑通全流程）；终审通过后进入 Phase 2（入站通知）。
