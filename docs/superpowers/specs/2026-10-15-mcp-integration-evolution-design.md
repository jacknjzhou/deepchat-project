# MCP 集成演进技术方案（前瞻设计）

- 日期：2026-10-15
- 状态：前瞻设计，**无实施任务**；Phase 3 触发时依此出 plan
- 分支：20261014
- 关联：`2026-10-15-outbound-submission-design.md`（Phase 1）、`2026-10-15-inbound-notifications-design.md`（Phase 2）

## 1. 定位

MCP 不是对已确认「通道 + 适配器」架构的替代，而是**适配器接口上新增的一种传输形态**。Phase 1/2 不写任何 MCP 代码，但两个适配器接口的签名已按「可插拔 MCP Adapter」预留（配置对象入参、无 HTTP 特有概念）。

现有基建（已核实）：
- **Client 侧**：`serverManager.getClient()` + `callTool()`（支持 stdio/HTTP/OAuth，`mcpOAuthManager` 管鉴权）
- **Server 侧**：`InMemoryServerFactory` 注册机制（apple/artifacts/builtinKnowledge 等 in-memory server 同构挂载）

## 2. 方向 1：应用作为 MCP Client（外部系统提供 MCP Server）

```
SubmissionChannelAdapter（现有接口，不动）
  ├─ GenericHttpAdapter      # Phase 1，HTTP REST 型系统
  └─ McpChannelAdapter       # Phase 3，MCP 型系统
```

- 通道配置扩展：`transport: 'http' | 'mcp'`；`transport:'mcp'` 时以 `serverName + toolName` 定位外部工具
- 出站：`buildPayload` 复用现有 payload 模板渲染器生成工具参数 → `callTool` → 返回值映射为 `SubmissionResult`（批次/预览/重推/快照全套复用）
- 入站：`McpInboundAdapter` 轮询调用外部 `list_notifications` 类工具，结果过现有 parse 模板；远期可升级为 MCP resource 订阅（server→client 通知）实现近实时
- 成本：一个 Adapter 类 + 通道配置项；数据模型与 UI 零改动

## 3. 方向 2：应用作为 MCP Server（暴露自身集成能力）

新增 in-memory server `integrations/integrationServer.ts`（经 `InMemoryServerFactory` 注册）：

| 工具 | 能力 | 底层 |
| --- | --- | --- |
| `groups_list` | 列分组树与单据摘要 | repository 只读 |
| `submissions_preview` | 渲染指定分组 payload（不出站） | SubmissionService |
| `submissions_submit` | 提交批次（需用户确认） | SubmissionService |
| `notifications_list` / `notifications_unread_count` | 通知查询 | 通知表只读 |

- 收益 ①：应用内 Agent 对话式完成「提交这个月的合同组」「看下 OA 新通知」——`submissions_submit` 必须走用户确认，与现有 Agent 工具权限机制一致
- 收益 ②：集团 Agent 平台可将本应用作为 MCP 工具源接入，成为对外服务化入口

## 4. 设计开发流程（两方向通用）

1. **确认 transport**：外部提供 server → 方向 1；暴露自身能力 → 方向 2
2. **定义工具契约**：工具名 + zod 参数 schema + 返回结构；方向 1 时 = 对方工具清单的映射配置
3. **实现**：方向 1 写 Adapter 类（复用渲染器/批次服务）；方向 2 写 in-memory server 注册进 factory（**只许复用服务层，禁止绕过服务直写表**）
4. **验证**：`test/` 内 mock MCP server 契约测试；UI 路径复用批次/通知界面
5. **准入门槛**：仅当 HTTP 通道无法满足（协议本质不同 / 需要 OAuth 编排 / 需要对话式编排）才新增 MCP 通道——**能用配置解决的不写代码**

## 5. 阶段归属

| 阶段 | 内容 |
| --- | --- |
| Phase 1（出站）/ Phase 2（入站） | 不写 MCP 代码；仅保证接口签名可插拔 |
| Phase 3 | 出现真实 MCP 对接需求时，按第 4 节流程独立出 plan 实施 |
