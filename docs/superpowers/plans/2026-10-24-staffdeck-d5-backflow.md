# D5：对话回流上报 —— 实施计划

- 日期：2026-10-24（补写；代码已在 `bee793f5`、`eaa22907` 落地）
- 对应 spec：`docs/superpowers/specs/2026-10-22-deepchat-side-integration-design.md` §5.6
- 前置：D1（配置与目录）、D2（远端执行）、D3（知识同步）

---

## 0. 为什么补写这份文档

D1–D4 每个阶段都有独立计划与实施结果表，D5 只有代码提交和 spec 的一段修订。缺文档的后果在 `2026-10-23-staffdeck-integration-gap-audit.md` 里体现得很直接：**P0-2（回流上报根本没有调用方）在代码提交后存活了一整天**——`reportBackflow` 定义、导出、测试齐全，但没有任何一轮对话会调用它。没有计划里的「触点在哪、事件从哪来」这两句话，就不容易发现这条链缺了中间一段。

---

## 1. 目标

本地执行的每一轮对话（消息正文、工具调用、token 用量）归档到 StaffDeck，管理端可审计。覆盖 `executionMode = local` 的员工，以及 hybrid 会话中在本地执行的那一段。

不覆盖 `remote` 员工的对话：它们本来就在服务端，重报会让管理端看到每条消息两份。

---

## 2. 协议核实（对照 StaffDeck `public_api` 源码实测）

| 端点 | 方法 | 实际行为 |
|---|---|---|
| `/api/v1/agents/{id}/sessions` | POST | 按 `(credential_id, external_session_id)` upsert；重复调用返回同一行。**是发事件的前置** |
| `/api/v1/agents/{id}/sessions/{sid}/events:batch` | POST | 按单事件 `event_id` 去重；`accepted: 0` 表示全部重复（重试生效，不是错误） |

两条实测结论直接决定了实现：

1. **本地执行的会话在服务端没有行**。`events:batch` 要求 session 属于本凭证的 `ChatSession`，并在 `ExternalSessionBinding` 里登记。第一次真实上报时全部 404，原因就是客户端从未建过远端会话——早期握手「通过」只是因为联调脚本手工调了 create-session。
2. **`external_session_id` 是幂等键**，所以「缓存缺失就重建」是安全操作，不需要额外的去重逻辑。

---

## 3. 任务拆分与落地

| # | 任务 | 落地位置 | 关键约束 |
|---|---|---|---|
| 1 | 事件采集：消息记录 → 事件数组 | `chat-page/model/backflowEvents.ts` | 事件 id 只由消息 id + 块位置决定；正文取可见文本不取 JSON；工具调用单独成事件 |
| 2 | 上报驱动：每轮结束触发 | `chat-page/composables/useBackflowReporting.ts` | 触点是「流结束」而非「用户发消息」；游标只在成功后前进 |
| 3 | 客户端：批量发送 + 分批 | `main/digital-employee/backflow.ts` | 永不抛错；按块上报，失败即停不跳过 |
| 4 | 建远端会话（**易漏步骤**） | 同上 `resolveRemoteSessionId` | 必须先建会话；404 时丢缓存重建一次，仍失败如实回报 |
| 5 | 路由 + 契约 | `backflowRoutes.ts` / `digitalEmployeeBackflow.routes.ts` | `BackflowEventInput` 三类事件的 zod 判别联合 |
| 6 | 隐私开关 | `settingsRoutes.ts` + 设置页 | 缺省视为**开启**；省略字段表示保留，避免旧 renderer 保存时把开关悄悄打开 |

---

## 4. 四条不可动摇的设计约束

1. **事件 id 必须稳定**。它是服务端的去重键。因此不能带时间戳、不能用数组下标兜底——同一轮重报必须产出同一批 id，否则归档里会出现两份。
2. **游标只在上报成功后前进**。失败时不动游标，下一轮把同一批重发；服务端按 id 去重，重发安全。丢掉游标会在归档里留一个洞。
3. **遇到乐观记录就停**。流刚结束时用户那条还是 `__optimistic_user_*`，提交持久化后 id 会换。用临时 id 上报的事件永远对不上重报；而游标一旦越过它，真实记录出现时 `orderSeq` 不前进，就再也采不到。
4. **永不阻塞对话**。上报是 fire-and-forget，任何失败只记日志。归档少一行，不能让用户看到「发送失败」。

---

## 5. 已知限制

| 限制 | 说明 |
|---|---|
| 无本地队列与退避重试 | `flush()` 一次成型，失败即返回。离线或服务端 5xx 时那一轮对话不会被补发（见审计 P1-1） |
| 远端会话 id 只存内存 | 进程重启后第一次上报会重建一次（幂等，代价一次往返）。落盘会让「服务端换了库」留下一堆指向不存在会话的陈旧 id |
| 未覆盖 hybrid 的远端段 | 只报本地执行段。远端段本来就在服务端 |
| `usage` 只在 `totalTokens > 0` 时上报 | 没有用量统计的轮次不产生事件，避免归档里一堆零值 |

---

## 6. 测试

- `test/renderer/features/chat-page/model/backflowEvents.test.ts`：13 例，覆盖 id 稳定性、乐观记录截断、正文提取、工具调用/用量拆分、游标推进
- `test/main/digital-employee/backflow.test.ts`：事件序列化、分批、404 重建、失败即停、隐私开关
- `test/main/digital-employee/backflowRoutes.test.ts`：契约投影
- `test/main/app/settingsRoutes.digitalEmployee.test.ts`：开关的缺省/保留语义

---

## 7. 未做（按审计文档编号）

- **P1-1 本地队列与退避重试**：spec §5.6 要求「本地 SQLite 队列暂存，指数退避重试」，目前是一次性 `flush()`。工作量最大的一项，独立一轮。
- **P1-2 开关 UI**：已由 `eaa22907` 补上，不再欠。
