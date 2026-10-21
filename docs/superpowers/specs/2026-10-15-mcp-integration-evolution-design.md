# MCP 集成演进技术方案（前瞻设计）

- 日期：2026-10-15
- 状态：前瞻设计，**无实施任务**；Phase 3 触发时依此出 plan
- 分支：20261014
- 关联：`2026-10-15-outbound-submission-design.md`（Phase 1）、`2026-10-15-inbound-notifications-design.md`（Phase 2）

## 1. 定位

MCP 不是对已确认「通道 + 适配器」架构的替代，而是**适配器接口上新增的一种传输形态**。Phase 1/2 不写任何 MCP 代码，但两个适配器接口的签名已按「可插拔 MCP Adapter」预留（配置对象入参、无 HTTP 特有概念）。

现有基建（已核实）：
- **Client 侧**：`McpService` 暴露调用流程，并由 `serverManager.getClient()` 管连接；实际工具调用入口/权限与结果映射需在 Phase 3 核实，不能直接从业务服务绕过 MCP 管理层调用底层 client。
- **Server 侧**：`src/main/mcp/inMemoryServers/builder.ts` 的 `InMemoryServerFactory` 是**应用内部**内存 MCP server 工厂（switch 分发），不是现成的网络服务发布接口。

## 2. 方向 1：应用作为 MCP Client（外部系统提供 MCP Server）

```
SubmissionChannelAdapter（现有接口，不动）
  ├─ GenericHttpAdapter      # Phase 1，HTTP REST 型系统
  └─ McpChannelAdapter       # Phase 3，MCP 型系统
```

- 通道配置将来扩展 `transport: 'http' | 'mcp'`，以稳定 server id（不是可重命名的 serverName）+ toolName 定位工具；**Phase 1/2 不预加列**。
- 出站：复用 payload 模板生成工具参数，经 MCP 服务统一的连接状态、权限校验和工具调用入口执行；`isError`、结构化/文本返回、超时分别映射到 `SubmissionResult`。不得把任意工具名当可信白名单，也不得绕过手动确认。
- 入站：仅在外部工具提供稳定消息 ID、分页/游标、明确权限时才实现 `McpInboundAdapter`，仍由 InboundPoller 执行、以同一事务存储；MCP resource 更新通知并不等于消息推送接口，需验证对方确实提供可订阅资源及重新连接语义。
- 成本：除 Adapter 外还涉及配置 schema、权限边界、结果映射和契约测试；不能承诺数据模型/UI 零改动。

## 3. 方向 2：应用作为 MCP Server（暴露自身集成能力）

若需**应用内 Agent**使用，扩展 `src/main/mcp/inMemoryServers/builder.ts` 的工厂及其依赖注入，新增内部 in-memory server；若需**集团 Agent 平台远程调用**，必须另立服务端设计（监听/鉴权/部署/会话隔离/审计），当前内部工厂不提供对外可达能力。

| 工具 | 能力 | 底层 |
| --- | --- | --- |
| `groups_list` | 列分组树与单据摘要 | repository 只读 |
| `submissions_preview` | 渲染指定分组 payload（不出站） | SubmissionService |
| `submissions_submit` | 提交批次（需用户确认） | SubmissionService |
| `notifications_list` / `notifications_unread_count` | 通知查询 | 通知表只读 |

- 收益 ①：应用内 Agent 可对话式查询分组/通知；`submissions_submit` 是**有外部副作用的操作**，必须由主进程服务执行强制用户确认与会话权限检查（不能只依赖模型提示或通用工具策略），并沿用出站批次的同一幂等/审计约束。
- 收益 ②：集团 Agent 平台远程接入是**另一个产品能力**，需额外运行独立可达服务并设计身份认证、授权范围和多用户隔离；不得视为内部 in-memory server 的直接收益。

## 4. 设计开发流程（两方向通用）

1. **确认 transport**：外部提供 server → 方向 1；暴露自身能力 → 方向 2
2. **定义工具契约**：工具名 + zod 参数 schema + 返回结构；方向 1 时 = 对方工具清单的映射配置
3. **实现**：方向 1 写 Adapter 并通过 MCP 服务统一入口调用（复用渲染器/批次服务）；方向 2 按需扩展内部 in-memory factory 依赖注入与注册（**只许复用服务层，禁止绕过服务直写表**），远程服务另立独立项目/设计。
4. **验证**：`test/` 内 mock MCP server 契约测试，覆盖连接失败、工具 `isError`、返回结构变化、权限拒绝和重复提交；UI 路径复用批次/通知界面。
5. **准入门槛**：仅当 HTTP 通道无法满足（协议本质不同 / 需要 OAuth 编排 / 需要对话式编排）才新增 MCP 通道——**能用配置解决的不写代码**

## 5. 阶段归属

| 阶段 | 内容 |
| --- | --- |
| Phase 1（出站）/ Phase 2（入站） | 不写 MCP 代码；仅保证接口签名可插拔 |
| Phase 3 | 出现真实 MCP 对接需求时，按第 4 节流程独立出 plan 实施 |
