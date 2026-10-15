# 入站通知（外部系统 → 消息集散地）设计

- 日期：2026-10-15
- 状态：已评审通过（brainstorming 产出）
- 分支：20261014
- 关联：`2026-10-15-outbound-submission-design.md`（出站提交，Phase 1，先行）、`2026-10-15-mcp-integration-evolution-design.md`（MCP 演进，Phase 3）

## 1. 背景与目标

出站提交（Phase 1）之后，集成能力扩展到入站：**从外部系统拉取消息，在本应用内集中展示**，作为消息通知的集散地。首版对接 OA，规范未定。

## 2. 需求决议

| 决议点 | 结论 |
| --- | --- |
| 展示形态 | 应用内通知中心页 + 侧栏未读徽标；**首版不弹系统托盘通知** |
| 点击行为 | 条目可跳转外部系统 Web 页（`link_url` 由解析模板映射，缺省不可点） |
| 获取方式 | 轮询拉取（桌面端无公网可达地址，webhook 不可行；用户明确「拉数据」） |
| 与出站关系 | 同属 `src/main/integrations/`，共享「外部系统通道」概念层，数据流/UI 独立 |

## 3. 非目标

- 系统托盘弹窗（`NotificationService` 管道保留，未来一行接入）
- 近实时推送（webhook/长连接）——MCP resource 订阅见演进文档
- 通知的双向操作回写（如在应用内审批 OA 事项）——只读展示
- 多端已读同步——单机单用户，已读状态本地落库

## 4. 总体架构

```
OA(外部系统) ──HTTP──> InboundPoller(timer 轮询) ──> notifications 表 ──> 通知中心页 + 未读徽标
                          ↑ 通道配置：inbound_channels
```

```
integrations/
  inbound/
    inboundPoller.ts            # timer 轮询调度（复用 autoWatch 模式，不引 cron 子系统）
    inboundChannelAdapter.ts    # 窄接口（签名同出站原则：配置对象入参）
    genericPollingAdapter.ts    # 首版唯一实现（HTTP GET/POST + 解析模板）
    templateParser.ts           # 响应 JSON → 通知条目（纯函数）
    repository.ts
    routes.ts
    data/tables/inboundChannels.ts
    data/tables/notifications.ts
```

## 5. 数据模型（2 张新表）

```sql
CREATE TABLE IF NOT EXISTS inbound_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  system_type TEXT NOT NULL DEFAULT 'oa',
  endpoint_url TEXT NOT NULL,
  auth_headers_json TEXT NOT NULL DEFAULT '{}',
  poll_interval_sec INTEGER NOT NULL DEFAULT 300,
  request_body_template_json TEXT,   -- POST 场景的请求体模板；{{lastPollTime}} 占位符做增量拉取；NULL=GET 全量
  parse_template_json TEXT NOT NULL, -- 响应 JSON → 通知条目映射（见下）
  last_error TEXT,                   -- 上次轮询失败摘要（UI 黄条）
  last_polled_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES inbound_channels(id),
  external_id TEXT NOT NULL,        -- 去重键（解析模板必配项）
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warning','urgent')),
  link_url TEXT,
  raw_payload_json TEXT NOT NULL,   -- 原始条目快照（审计）
  read INTEGER NOT NULL DEFAULT 0,
  external_time TEXT,               -- 外部消息时间（展示用）
  created_at INTEGER NOT NULL,
  UNIQUE(channel_id, external_id)   -- 轮询幂等的硬保证
);
```

## 6. 解析模板（纯函数，与出站渲染器对称）

```json
{
  "listPath": "data.records",
  "itemId":  "{{item.msgId}}",
  "title":   "{{item.title}}",
  "body":    "{{item.content}}",
  "time":    "{{item.createTime}}",
  "severity": "{{item.level}}",
  "link":    "{{item.detailUrl}}"
}
```

规则：
- `listPath` 定位数组，逐条按 `{{item.*}}` 映射
- `itemId` 为**必配项**——保存通道时校验，缺失则通道禁用保存（幂等无保证即拒绝启用）
- 缺字段 → 空串/默认值入库（fail-open）；某条 `itemId` 解析为空 → **跳过该条**并计入 last_error 摘要
- `severity` 未映射或值不在枚举内 → 默认 `info`

## 7. 轮询流程

1. 应用启动 + 每通道 `poll_interval_sec` 到期触发（单 timer 扫描到期通道，复用 autoWatch 模式）
2. GET（或按 `request_body_template_json` POST，`{{lastPollTime}}` 支持增量）
3. 响应 → 解析模板逐条映射 → `UNIQUE(channel_id, external_id)` 冲突跳过、新消息插入
4. 成功：更新 `last_polled_at`、清 `last_error`；失败（网络/超时/非 2xx/非 JSON）：写 `last_error`，**不弹窗、不自动重试**（下周期自然重试）
5. 通知中心页「立即刷新」按钮 → 触发一次全通道轮询

## 8. 通知中心 UI

- 侧栏新增「通知」入口，未读徽标复用 WindowSideBar 现有 unread/badge 机制
- 列表：时间倒序；条目 = 来源通道徽标 + severity 色点 + 标题 + 正文两行截断 + 时间；筛选（按通道、已读/未读）
- `link_url` 存在的条目整行可点 → `shell.openExternal`；无链接条目仅展开详情
- 操作：标记已读 / 全部已读 / 删除
- 通道顶部黄条：`last_error` 非空时提示「上次拉取失败：<摘要>」
- 保留策略：上限 2000 条，超出自动清最旧（常量，后续可配置化）

## 9. 错误处理

见第 7 节第 4 步；解析层错误（条目缺 itemId）计入 last_error 摘要但不阻断其余条目入库。

## 10. 测试策略（最小持久集）

| 层 | 持久保留用例 |
| --- | --- |
| 解析器纯函数 | listPath 定位、缺字段默认值、itemId 缺失跳过、severity 兜底 |
| 表层 | `UNIQUE(channel_id, external_id)` 幂等插入、迁移幂等重入、保留上限清理 |
| 服务层 | fetch mock：成功/超时/非 2xx → last_error 状态；增量 `{{lastPollTime}}` 注入 |
| UI | 通知列表挂载冒烟、徽标计数联动 |

## 11. 实施阶段（Phase 2，对应 plan T5-T8；Phase 1 终审通过后启动）

| 任务 | 内容 |
| --- | --- |
| T5 | 解析器纯函数 + 两表 DDL + repository |
| T6 | InboundPoller + GenericPollingAdapter + 契约路由 |
| T7 | 通知中心页 + 侧栏徽标 + 立即刷新 |
| T8 | 通道管理页扩展入站 tab（与出站同页两 tab） |
