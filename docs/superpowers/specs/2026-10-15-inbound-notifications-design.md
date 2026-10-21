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

- 系统托盘弹窗（现有 `src/main/notifications` 是语义通知投递/确认管道，不是持久消息中心；后续接入需评估其事件语义，不能视为一行改动）
- 近实时推送（webhook/长连接）——是否可用取决于外部系统协议；MCP resource 订阅见演进文档
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
    inboundPoller.ts            # 专用轮询服务，复用项目已有生命周期/任务调度接口并保证单通道不重入
    inboundChannelAdapter.ts    # 窄接口（签名同出站原则：配置对象入参）
    genericPollingAdapter.ts    # 首版唯一实现（HTTP GET/POST + 解析模板）
    templateParser.ts           # 响应 JSON → 通知条目（纯函数）
    repository.ts
    routes.ts
    data/tables/inboundChannels.ts
    data/tables/notifications.ts
```

## 5. 数据模型（2 张新表）

入站与出站同属新 `IntegrationsDatabase`/repository，不直接把表塞进 `DocumentsDatabase`；新表注册到项目数据库 schema catalog，并明确已有库的幂等建表/索引路径（参考 `src/main/data/schemaCatalog.ts` 与 `src/main/documents/data/database.ts`，不盲目照搬 documents 的独立迁移纪律）。

```sql
CREATE TABLE IF NOT EXISTS inbound_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  system_type TEXT NOT NULL DEFAULT 'oa',
  endpoint_url TEXT NOT NULL,
  auth_secret_ref TEXT,             -- 安全存储引用，与出站通道一致
  poll_interval_sec INTEGER NOT NULL DEFAULT 300,
  request_body_template_json TEXT,   -- POST 场景请求体；NULL=GET；增量游标不等同轮询时间
  parse_template_json TEXT NOT NULL, -- 响应 JSON → 通知条目映射（见下）
  last_error TEXT,                   -- 上次轮询失败摘要（UI 黄条，需脱敏）
  last_polled_at INTEGER,           -- 仅用于调度，不作为增量游标
  cursor_value TEXT,                -- OA 端确认的游标/水位；成功持久化消息后才推进
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
CREATE INDEX IF NOT EXISTS idx_inbound_notifications_time ON notifications(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_notifications_unread ON notifications(read, created_at DESC);
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

1. 应用启动后由独立 InboundPoller 管生命周期（不直接把业务任务塞进用于 Agent 会话的 CronJob Scheduler）；检查通道到期时间，单通道互斥，手动刷新与定时拉取共用同一入口；退出时取消计时器和进行中的请求。
2. GET（或按 `request_body_template_json` POST）。默认全量拉取并依靠 `UNIQUE(channel_id, external_id)` 幂等；只有 OA 接口明确支持游标/水位时才开启增量，以单独的 `cursor_value` 而非 `last_polled_at` 作为参数。
3. 响应必须受大小/条目数/分页上限约束；解析后将新消息与新游标在**同一 SQLite 事务**持久化，失败不推进游标；分页每页独立事务，重复页安全跳过。
4. 成功：更新 `last_polled_at`、清 `last_error`；失败（网络/超时/非 2xx/非 JSON）：写脱敏 `last_error`，**不弹窗、不做即时重试**（下周期自然重试）。解析不出 `itemId` 的条目跳过并保留摘要警告，不得清除该警告。
5. 通知中心页「立即刷新」按钮 → 经同一互斥入口触发全通道轮询；并发请求复用同一执行结果或返回 busy。
6. 新消息通过现有事件/路由通知渲染器刷新未读数；现有 `src/main/notifications/` 不负责本模块的持久化存储。

## 8. 通知中心 UI

- 侧栏新增「通知」入口；WindowSideBar 现有徽标用于会话快捷标识和工作区默认标识，并非通知未读数，通知徽标须新增独立 store/repository 查询与事件刷新，不得假定可直接复用。
- 通知路由按现有 `createRouteMap` + `src/shared/contracts/routes.ts` 契约注册，服务在 `app/composition.ts` 装配；如设置页增入站通道 tab，需编辑独立设置窗口 `src/renderer/settings/`。
- 列表：数据库分页、时间倒序；条目 = 来源通道徽标 + severity 色点 + 标题 + 正文两行截断 + 时间；筛选（按通道、已读/未读）。
- `link_url` 存在时仅允许 `https:`，跳转前在主进程验证 scheme/目的地址（企业内网地址须企业策略允许，并提示用户即将打开外部网站）；通过现有安全外链打开入口调用 `shell.openExternal`，禁止 `javascript:`、`file:`、自定义 scheme。无链接条目仅展开详情。
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
| 服务层 | fetch mock：成功/超时/非 2xx → last_error 状态；分页落库与游标同事务、单通道互斥 |
| UI | 通知列表挂载冒烟、徽标计数联动 |

## 11. 实施阶段（Phase 2，对应 plan T5-T8；Phase 1 终审通过后启动）

| 任务 | 内容 |
| --- | --- |
| T5 | 解析器纯函数 + 两表 DDL + repository |
| T6 | InboundPoller + GenericPollingAdapter + 契约路由 |
| T7 | 通知中心页 + 侧栏徽标 + 立即刷新 |
| T8 | 通道管理页扩展入站 tab（与出站同页两 tab） |
