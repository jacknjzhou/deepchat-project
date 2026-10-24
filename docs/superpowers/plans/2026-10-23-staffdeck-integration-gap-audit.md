# StaffDeck 接入能力缺口审计

- 日期：2026-10-23
- 范围：以 D4 计划（`2026-10-23-staffdeck-d4-skills-and-tools.md`）为锚点，回溯 D1→D5 全链条，逐项核对「spec/计划声明的能力」与「仓库实际实现」
- 方法：读源码 + grep 全仓调用点，不以文档自述为准；每条缺口都给出可复核的文件与行号

---

## 0. 结论摘要

三个层次，按「是否导致功能不可用」排序：

| 层 | 含义 | 数量 | 状态（2026-10-24） |
|---|---|---|---|
| **P0 真断链** | 代码写完了、测试也过了，但端到端跑起来功能不生效 | 3 | **全部已修** |
| **P1 能力缺失** | spec/计划明确要求，仓库里找不到实现 | 11 | 已修 6，剩 5 |
| **P2 验证与运维缺口** | 功能可用，但未验证或有误判风险 | 6 | 已修 4（P2-1 / P2-4 / P2-5 / P2-6），剩 2 需真机（P2-2 / P2-3） |

> **进度（2026-10-24）**：P0-1（`b6c553b0`）、P0-2（并行进程 `eaa22907`）、P0-3 + P1-5（`4c392c2f`）、P1-10（`913ecb3c`）、P1-2 + P1-3 + P1-4 + P1-9（`cbe212da`）、P1-1（`604a893f`）、P1-6（`68f59e0d`）、P2-1 + P2-5 + P2-6、P2-4（`9a4d4d69`）已完成。
> 剩余：P1-7（公共 MCP，阻塞于服务端）、P1-8（内置技能包，可选）、P2-2 / P2-3（均需真机或真实模型）。
> 真机走查步骤见 `2026-10-24-staffdeck-p2-field-walkthrough.md`。

最需要立刻知道的一条：**D3 的知识同步与对话检索之间没有接线**。同步把向量索引写进了 `de-{employeeId}` 本地库，而对话检索查的是 payload 里的远端 `knowledgeBaseIds`（`kb_xxx`）——查不到配置直接抛错，被 `.catch(() => [])` 吞掉，表现为「永远召回不到任何知识」。同步下的 25 个概念全在另一个库里，没有任何检索入口指向它。（**已于 2026-10-23 修复**，见 P0-1。）

---

## 1. P0 真断链

### P0-1 知识同步与对话检索用的是两套 KB id（D3）

| 环节 | 实际 id | 证据 |
|---|---|---|
| 同步写索引 | `de-{employeeId}`（如 `de-agent_f2828efc2a2a476d`） | `knowledgeProvisioning.ts:50,95`；`knowledgeSync.ts:224-225,311,318` |
| 对话做检索 | payload 的远端 id（如 `kb_067d71b1f22c48bc`） | `stores/digitalEmployeeStore.ts:320-327` |

后果链条：

1. `similarityQuery('kb_067d71b1f22c48bc', q)` → `getOrCreateKnowledgeBase` 在 `getKnowledgeConfigs()` 里找不到该 id → `throw new Error('Knowledge config not found for id: ...')`（`src/main/knowledge/index.ts:269-271`）；
2. renderer 侧 `.catch(() => [] as QueryResult[])` 把异常吃掉（`digitalEmployeeStore.ts:325`）；
3. 结果恒为空，`knowledgeSnippets` 恒为 `undefined`，systemPrompt 里永远没有知识片段。

**为什么测试没抓到**：`test/renderer/stores/digitalEmployeeStore.test.ts:229` 断言的是 `similarityQuery` 被以 `'kb-1'` 调用，只验证了「调用发生」，没有验证「这个 id 在本地存在」。而 main 侧的 16 条同步用例全部以 `localKnowledgeBaseId` 为参数直接调桩，两边各测各的，中间的 id 对齐没有任何用例覆盖。

**这是计划本身的漏项**，不是实现走偏：D3 计划的 Goal 写着「从而在既有 `similarityQuery` 检索链路里生效」，但 Task 1–7 里没有「把本地库接到会话检索」这一步。

**修复方向**（二选一，需决策）：
- A. `knowledgeStatus` 路由回传 `localKnowledgeBaseId`，store 检索时用它（契约注释明确说刻意不暴露该字段，需改契约）；
- B. 主进程新增「员工 → 本地库 id」查询，由 store 在 `startConversation` 前取一次；或干脆让同步把内容索引进与远端 id 同名的库（放弃「每员工一个库」）。

> **已修复（2026-10-23，选 B）**：
>
> 新增窄契约 `digitalEmployee.knowledgeLocalBase`（入参 `employeeId`，出参 `{ knowledgeBaseId: string | null }`），而不是把 `localKnowledgeBaseId` 塞进 `knowledgeStatus`。理由：状态是「每远端 KB 一条」的展示列表，本地库 id 是员工级单值；混进 `packages[]` 会在「列表为空」时无处安放，而列表为空恰恰是最需要它的场景。这样 `knowledgeStatus` 的契约注释（「刻意不暴露」）继续成立。
>
> 落地三处：
> 1. `knowledgeRoutes.ts` 新增 `readLocalKnowledgeBaseId`：状态表记录优先，缺失时按 `deriveLocalKnowledgeBaseId` 重算（覆盖「状态表被清但向量库还在」），最后用 `KnowledgeSettings.getKnowledgeConfigs()` 校验库真存在（覆盖「用户在设置里删了库」），任一不成立返回 `null`；
> 2. `digitalEmployeeStore.startConversation`：仅当 `knowledgeBaseIds.length > 0` 且有开场问题时才查一次本地库 id，检索用它；**`null` 一律跳过检索，绝不回退到远端 id**——回退正是原缺陷的来源（必抛 `Knowledge config not found`，又被 `.catch` 吞成空结果，故障不可见）；
> 3. 用例：main 侧 5 例（含「绝不回传 `kb_*`」）、renderer 侧 4 例（含「不得以 `kb-1` 检索」的负向断言）。
>
> 回归：main 全量 + renderer store 34 例全绿。

### P0-2 回流上报没有调用方（D5）——**已修（并行进程 `eaa22907`）**

> 修复方式见该提交：`useBackflowReporting` 挂在 `ChatPage`，`collectBackflowEvents` 负责从消息记录抽 `message`/`tool_call`/`usage` 三类事件；事件 id 只由消息 id 与块位置决定（服务端去重键必须稳定），游标只在成功后前进，遇到乐观记录就停（否则提交后真实记录再也采不到）。同时补上了「先建远端会话再发事件」——本地执行的会话在服务端没有行，直接发 `events:batch` 必然 404。

原始证据：

`reportBackflow` 定义在 `stores/digitalEmployeeStore.ts:387` 并已导出（:426），但：

```
grep -rn "reportBackflow" src/renderer/src --include=*.vue   → 空
grep -rn "backflow" src/main/session src/main/agent          → 空
```

`ChatPage.vue`、`ChatView`、消息发送链路都没有调用它。也就是说：**没有一轮对话会被上报**，管理端看板看不到任何本地执行会话。D5 交付的标志（spec §8「管理端看板可见本地执行会话」）实际未达成。

配套缺失：没有「本轮事件从哪来」的采集逻辑——`tool_call` / `usage` 两类事件需要从会话记录里抽取，仓库里没有这段。

### P0-3 hybrid 整会话切换没有 UI 入口（D2）——**已修（`4c392c2f`）**

> 顶栏新增切换按钮 + 确认弹窗（可填上下文摘要）。可见性条件为三个与关系：员工 `executionMode === 'hybrid'`、会话未绑远端、会话可写。判断「未绑远端」必须查主进程绑定表（新增 `loadRemoteBinding`）——员工的 `executionMode` 说不了某个会话的现状；查询失败按**已绑定**处理，避免给出必失败的入口。见 spec §5.2 的「D2 补充修订」。

原始证据：

链路齐了 3/4：

| 环节 | 状态 | 证据 |
|---|---|---|
| 契约 `digitalEmployee.switchToRemote` | 有 | `digitalEmployeeRemote.routes.ts:150` |
| main 路由实现 | 有 | `remoteRoutes.ts:115-151` |
| renderer client 方法 | 有 | `api/DigitalEmployeeClient.ts:69` |
| store 方法 | **无** | `digitalEmployeeStore.ts` 里搜不到 `switchToRemote` |
| UI 触发点 | **无** | `grep -rn switchToRemote src/renderer/src` → 空 |

用户没有任何办法把 hybrid 会话切到远端。spec §5.2 修订 3 把 hybrid 降级为「整会话可切换」，但「可切换」这半句没有落地——现在 hybrid 员工等同 local。

---

## 2. P1 能力缺失

### P1-1 回流没有本地队列与退避重试（D5）——**已修（本轮）**

spec §5.6 与 D1 计划骨架都要求「本地 SQLite 队列暂存，指数退避重试」。实现是一次性 `flush()`：失败就返回 `{ok:false, reason}`，没有持久化、没有重试、没有下次补发（`backflow.ts` 全文无 `queue/retry/backoff` 关键词）。store 拿到失败结果后也只是 `console.warn` 丢弃。

后果：离线或服务端 5xx 的那一轮对话永久丢失，与「全量回流归档」的目标不符。

> **修复方式**：新增三块。
>
> 1. **队列表** `main/digital-employee/data/tables/backflowQueue.ts`（表 `digital_employee_backflow_queue`，已进 schema catalog）。**一行一个事件**而不是一行一批——服务端的去重粒度就是单事件 id，一行一批的话重发时夹带一条已存事件会让整批失效。唯一索引 `(session_id, event_id)` 让「重复入队」变成静默忽略，正好对应 `flush` 里「失败后整批重发」的行为。
> 2. **补发器** `main/digital-employee/backflowRetry.ts`：30s 起、逐次翻倍、封顶 30 分钟；**按会话分组**（`events:batch` 的路径里带会话 id，跨会话混批只能拆成多个请求），组内保持 `seq` 升序（否则管理端看到倒序对话）。可重试 = `NETWORK` / 5xx / 408 / 429；401/403/404/422 直接丢弃——重试一万次还是同一个结局，留着只会让队列变成垃圾场。另加两条：队列里的事件超 7 天丢弃（否则长期离线会把 `batchLimit` 的名额永远占满）；关掉回流时**清空队列**（攒着不发等于把隐私开关做成摆设）。
> 3. **契约语义拆分**：`digitalEmployee.backflow` 的 `ok` 从「是否送达」改成「主进程是否接手」（送达或落盘），新增 `queued` / `pending`；`reason` 保留真实原因。这样 `ok: true` + `reason: 'NETWORK'` 表示「已入队待补发」。renderer 的游标跟着 `ok` 走——若因为「没送到」就保留游标，下一轮会重采同一批，而队列里已经有一份。
>
> 顺带修的两处：`reportBackflow` 收了 `title` 却没往下传（服务端那条会话永远没有标题）；新增只读路由 `digitalEmployee.backflowQueueStatus` 让设置页能显示「有 N 条对话尚未归档」，否则「暂时没归档」和「一直没归档」在界面上长一样。

### P1-2 回流开关没有 UI，也没有写入通道（D5）——**已修（`eaa22907`）**

`backflowEnabled` 只有两处出现：

- 读：`composition.ts:3504`
- 键定义：`digitalEmployeeSettings.routes.ts:23`

`digitalEmployeeSettingsSaveRoute.input`（同文件 :52-62）**不含该字段**，设置页也没有开关。spec §5.6 写的「用户可在设置中关闭回流（关闭时管理端无该会话记录，UI 明示）」完全无法操作——目前只能手工改 config entry。

### P1-3 知识同步间隔没有 UI，也没有写入通道（D3）——**已修（`cbe212da`）**

同样的问题：`syncIntervalSeconds` 只在 `composition.ts:3558` 被读，settings save input 不含该字段，设置页无输入框。默认 1h 无法调整。

### P1-4 首轮对话不触发知识同步（D3 遗留）——**已修（`cbe212da`）**

`knowledgeSyncScheduler.runOnce()` 存在且可直调（`knowledgeSyncScheduler.ts:49,121`），但没有挂到任何对话入口。首轮命中的是定时轮，最坏等一个完整间隔（默认 1h）。D3 计划「已确认的决策 3」明确写的是「用户首次与该员工对话时触发同步」，未落地。

### P1-5 远端不可恢复时不降级到本地（D2）——**已修（`4c392c2f`）**

> 判据是绑定表里的 `executionMode`：`hybrid` 失败时解除绑定（`ChatService` 只看 `has`，删掉即降级），`remote` 保持绑定并报错——remote 员工的提示词、知识库、工具都在服务端，本地跑出来是另一个员工。降级通过 `remoteRunUpdated` 的 `fallbackToLocal` 告知渲染层，聊天页显示「已自动切回本地执行」。

spec §6 错误处理表：「远端 runs 中断 → Last-Event-ID 续传；**不可恢复时 hybrid 转本地模式**，remote 明确报错并保留会话」。

`remoteRunner.ts` 只有 `degradedCode` 上报，没有 fallback 分支；`grep -c hybrid src/main/digital-employee/remoteRunner.ts` = **0**。hybrid 会话流断了就只是报错。

### P1-6 附件透传未实现（D2）——**已修（本轮）**

`remoteClient.createSession`（:124-139）与 remote run 的 body 都没有 `attachments`。D2 已知限制里写明「留待后续」，但 spec §7 与 D1 骨架并未把它标记为可选项，且 D3/D5 也没有接手。

> **修复方式**：新增 `src/main/digital-employee/remoteAttachments.ts` 做「本地附件 → 服务端描述符」的裁剪，`remoteRunner` 在首次 `streamRun` 时透传，`composition` 把 `content.files` 接下去（此前只取了 `content.text`）。
>
> 动手前先核对了服务端的真实接收能力，结论与原判断**相反**——原先以为「服务端会剥掉客户端文本、且无 API Key 可用的上传端点，所以只能透图片」，实际是：
>
> | 通道 | 服务端事实 | 结论 |
> |---|---|---|
> | 文本 | `public_api/runs.py:190` 直接 `ChatAttachmentRead.model_validate`，**不经过** `validate_chat_turn_attachments`（那只在 `api/chat.py:1019,1094` 的会话 cookie 路径上）；`harness_attachments.py:132` 的 `elif attachment.text` 会把文本写进 workspace | **可用**，内联 `text` |
> | PDF | 同上分支，note 明确写「PDF 附件保存的是服务端提取文本」 | **可用**，送本地已提取的 markdown |
> | 图片 | `_validated_image_data_url` 仍会二次校验：解码字节数须与 `size` **完全相等**、≤4MB、魔数匹配 `content_type` | **可用**，`data_url` |
> | docx/xlsx/音频等 | `POST /api/attachments` 走 `get_current_user` 会话鉴权，API Key 进不去 | **不可用**，明确跳过并告知 |
>
> 三个实现细节：
> 1. `sha256` **一律不传**——一旦带上，服务端会去 `read_staged_chat_attachment` 找从未上传过的暂存原件；
> 2. 图片 `size` 必须用 base64 解码后的字节数（服务端做严格相等比较，差 1 字节整条作废），`image/jpg` 这类别名要连 data URL 前缀一起改写成标准 MIME；
> 3. 单轮载荷设 8MB 预算——run 请求体会原样存进 `APIJob.request_json` 并参与幂等回放比对，不设限时 8 张 4MB 图会变成 40MB+ 的 SQLite 行。
>
> 被跳过的附件不只写日志：`digitalEmployee.remoteRunUpdated` 事件新增 `skippedAttachments`（只有文件名与原因码，不含内容），聊天页据此给一条 amber 提示。理由：对话框里明摆着一个文件、模型却完全不知道它存在，比报错更难自查——用户只会觉得「这个员工理解能力不行」。
>
> 测试：`remoteAttachments.test.ts` 18 例（体积/别名/白名单/预算/顺序/稳定 id）、`remoteRunner.test.ts` +5 例（透传、空数组省略、跳过上报、同轮不重复、跨轮清除）、`remoteClient.test.ts` +2 例（请求体有无 `attachments`）、`useRemoteAwaitingInput.test.ts` +5 例。

### P1-7 公共 MCP 工具直连未实现（D4/spec §5.5 第 3 条）

spec §5.5：「公共 MCP 工具（分发 payload 附连接信息、无凭证的）→ deepchat 本地直连」。

- 契约 `digitalEmployeeSchema` 无任何 mcp 连接字段（`digitalEmployee.routes.ts` 全文搜 `mcp` → 空）；
- 服务端 payload 也不下发（`backend/app/digital_employees/payload.py` 搜 `mcp` → 空）。

性质：**外部依赖未就绪**，客户端无处接入。需要在 StaffDeck 侧先补字段。

### P1-8 内置 `skills/staffdeck-api-*` 技能包不存在（D4/spec §5.3 第 3 条）

spec §5.3 第 3 条要求仓库根提供 4 个 OpenAPI 调用技能包。实际 `ls skills/` → 目录不存在，`git log --all -- 'skills/*'` → 无任何历史。虽然 spec 标了「可选」，但 D1/D2 的骨架把它列在 D4 交付里。

### P1-9 准备结果没有 UI 呈现（D4）——**已修（`cbe212da`）**

> 跳转后给一条 warning：工具未注册或技能未装全都说明白。`skipped` 不算降级（remote 员工本来就不在本地准备），全部成功时一条提示都不发。

`provision` 的 output 暴露了 `failedSkills` / `toolsReady` / `installedSkills` / `skillNames` / `failures`，但 renderer 只在广场页取用 `skillNames`（`DigitalEmployeeSquarePage.vue:362-370`），其余全部丢弃。技能没装上、工具没注册成功，用户完全看不到——与「准备失败一律降级」的设计相比，缺了「告诉用户降级了什么」这一半。

### P1-10 孤儿 MCP server 没有清理机制（D4）——**已修（`913ecb3c`）**

> 新增 `mcpReconcile.ts`，启动时扫一遍。只碰 `staffdeck-` 前缀；拿不到**可信**员工名单（provider 降级 / 拉取失败）时整轮跳过——按假 id 清理会把真实注册删光。正向算「在册员工应有的名字集合」，不在集合里的即孤儿（名字里的摘要不可反解）。

`listEmployeeMcpServers`（`mcpRegistration.ts:169`）定义了但**全仓无调用方**。

`unregister` 只在 `provision` 判定 `NOT_LOCAL` / `NOT_FOUND` 时触发，而 `provision` 只在用户点「开始对话」时调用。员工被删除、被改为 remote 之后，用户不会再点它 → 陈旧注册永久留在 MCP 配置里 → 该员工的 `staffdeck_*` 工具出现在**所有**会话中。启动时也没有扫描。

### P1-11 D5 没有计划文档——**已补（`docs/superpowers/plans/2026-10-24-staffdeck-d5-backflow.md`）**

`docs/superpowers/plans/` 下无 `*d5*`。D1–D4 每个阶段都有独立计划与实施结果表，D5 只有代码提交 `bee793f5` 和 spec §5.6 的一段修订。spec §8 里程碑表也没有 D5 的交付记录。

---

## 3. P2 验证与运维缺口

| # | 项 | 说明 | 状态 |
|---|---|---|---|
| P2-1 | `mcp:invoke` scope 无文案 | 20 locale 的 `remote.error.insufficientScope` 只提 runs/sessions（`i18n/zh-CN/digitalEmployee.json:65`）。缺该 scope 表现为「一个工具都没有」，运维极易误判为服务端故障 | **已修（本轮）** |
| P2-2 | MCP `startServer` 真机路径未验证 | D4 联调的 `serverManager` 是桩。deepchat 内部的 MCP 重连、工具注册表刷新、`loadTools` 之后的实际可调用性未端到端验证 | 需真机 |
| P2-3 | 向量召回未端到端验证 | D3 联调时 `addFile` 打桩（无启用的 embedding provider）。加上 P0-1，即使打桩问题解决也召回不到 | 需真实 embedding |
| P2-4 | 追问链路未端到端验证 | `awaiting_input` 只在真实 LLM 走到 SOP 的 `expected_user_info` 时产生，本地 `model_configs` 为空。原判为「未验证」，实际复查发现一个确定的缺陷：明细只在首轮写入 | **已修（`9a4d4d69`）** |
| P2-5 | `external_user_id` 双传法未清理 | `provider.ts:13,55` 仍发 `x-external-user-id` header，`remoteClient` 用 body。已确认惰性无害，但 D2 遗留项列了「建议一并清理」 | **已修（本轮）** |
| P2-6 | hybrid 员工一律按 local 处理 | `provisioning.ts:191` 只判 `=== 'remote'`。若将来 hybrid 默认走远端，会双份注入工具与技能 | **已修（本轮）** |

### P2-1 `mcp:invoke` 缺 scope 无法被识别 —— **已修（本轮）**

原文只说「文案没提 mcp:invoke」，但改文案解决不了根因：**测试连接根本不会发现这件事**。它只探 `GET /api/v1/digital-employees`（`settingsRoutes.ts:243`），而列表端点要的是 `agents:read`，与 `mcp:invoke` 是两个独立 scope（`credential_profiles.py:7-23`）。于是一个恰好缺 `mcp:invoke` 的 key 在设置页显示「连接成功，服务端返回的员工数据格式正确」，实际对话里 `staffdeck_*` 工具一个都不出现。

修复分两半：

1. **探测**。列表通过后再发一次 `GET /api/v1/mcp/agents/{id}`。这个处理器的关键性质是「接收 `agent_id` 却从不读取」（`mcp.py:191-204`），校验 scope 后无条件返回 405——所以路径里的员工 id 可以是固定占位值，且 405 就是「有 scope」的证明。整个过程不建会话、不调工具，比发一个真实 `initialize` 便宜得多。
2. **文案**。`remote.error.insufficientScope` 原本只提 runs/sessions，现在按 `require_scopes` 的实际用法补到 `agents / runs / sessions / mcp:invoke`（20 locale 全改）；新增结果码 `missingMcpScope` 并单独给文案，因为它和「鉴权失败」是两回事——key 是有效的，只是权限不够。

一个刻意的判定：**MCP 端点网络失败不报缺 scope**。列表刚成功而 MCP 端点连不上，多半是反代规则或抖动；把网络故障说成权限问题，会让人去改一个根本不需要改的东西。所以那种情况仍返回 `ok`，只在 401/403 时报 `missingMcpScope`。

### P2-5 `external_user_id` 双传法 —— **已修（本轮）**

`grep` 整个服务端 `backend/` 目录，`x-external-user-id` **零命中**：这个 header 从未被任何代码读取过。列表端点用 Bearer 鉴权、租户由凭证反推，只读 If-None-Match / If-Match / Last-Event-ID。

删掉而不是保留的理由不是带宽，是**误导**：请求头摆在那里，会让人以为列表响应按用户过滤，于是「为什么这个 key 看到了不属于它的员工」这类排查会从错误的地方开始。真正生效的 `external_user_id` 在两处 JSON body——`remoteClient.streamRun`（`remoteClient.ts:173`）与 `backflow`（`backflow.ts:256`）。

顺带把 `HttpProviderConfig` 里的 `externalUserId` 也移除了：列表压根用不到它。`providerFactory` 仍然校验它是否为空，那是在配置页拦住不完整的一组值，与列表请求无关。

### P2-6 hybrid 判定 —— **已修（本轮），但原判断指错了地方**

审计原文担心的是「将来 hybrid 默认走远端会双份注入工具与技能」，那是**假想风险**（`provisioning` 里 `!== 'remote'` 对 hybrid 放行，而 hybrid 在本地执行时正需要这些准备，双份注入只有切到云端后才成立，且那次切换之后本地根本不再执行）。顺着同一条判据查，发现了一个**已经存在**的真缺陷：

`reportBackflow` 只排除 `executionMode === 'remote'`（`digitalEmployeeStore.ts:409`）。hybrid 会话一旦被 `switchToRemote` 切到云端，后续每一轮都由服务端执行并已在服务端归档，而 `employeeForSession` 依旧把它判成 hybrid —— 于是同一段对话在管理端出现两份，且事后无法区分哪份是真的。

修复：hybrid 再多查一次绑定状态（`isBoundToRemote`）。查询失败按「已绑定」处理，与 `loadRemoteBinding` 的乐观方向**相反**，因为两者代价不对等——那里乐观只是让用户点到一个必失败的按钮（可见、可纠正），这里乐观会往归档里塞重复消息（不可见、分不清）。

同时把 `provisioning` 的判据提成 `needsLocalProvisioning` 并写清理由：写成「哪些**不需要**」而不是「哪些需要」，因为答案只取决于执行发生在哪里，而 hybrid 默认在本地跑、切到云端后下一个新会话又从本地开始。

### P2-4 追问链路 —— **已修（`9a4d4d69`），原判断不完整**

审计原文把这项归为「未验证」：`awaiting_input` 只在真实 LLM 走到 SOP 的 `expected_user_info` 时产生，本地 `model_configs` 为空跑不出来。

整理真机走查清单时顺着「提示条的明细从哪来」往下查，发现这不是纯验证项，而是一个**确定存在的缺陷**：

`remoteStatus` 返回的 `awaitingInput` 只有一个来源——`remoteRoutes` 内部的 `outcomes` Map。而往这个 Map 里写的只有两处，都是路由自己的处理器：`bindRemoteSession` 与 `switchToRemote`，也就是**首轮**。第二轮起的 run 由 `ChatService` 的 `remoteTurn.send` 发起（`composition.ts`），那条路径完全不经过这两个路由，于是：

- 第一轮追问 → 提示条正常
- 第二轮起追问 → `remoteStatus.awaitingInput` 恒为 `null` → 提示条永不出现

真实对话里追问多发生在第二、三轮（第一轮信息不全被追问，补完可能还要再补），所以这个缺陷的实际表现是「追问功能看起来只是偶尔生效」。它与 P2-2 / P2-3 的区别很关键：那两项缺的是环境，这项缺的是代码，CI 完全有能力覆盖，只是当时没人写这个用例。

修复方式：把存放处提成独立模块 `remoteRunOutcomes.ts`，两处写入共用一份——首轮仍由路由写，之后每轮由 `remoteTurn.send` 写。三条配套决定：

1. **每轮都写，含 `null`**。「这一轮没追问」正是撤掉上一条提示的信号；只在有追问时写入，会让提示条在用户答完之后继续挂着。
2. **不落库**。追问是瞬时的，重启后补查一个旧 run 会拿到与服务端现状不符的结论。它与绑定表刻意分开：绑定是必须恢复的持久事实，追问是答完就该消失的瞬时状态。
3. **降级时 `forget`**。hybrid 会话失败退回本地后，旧明细不该被后来的查询读到。

淘汰按「最久未更新」而非计数上限，命中上限的代价只是某个会话的提示条晚一轮恢复。

测试 15 例（新增 `remoteRunOutcomes` 7 例、`remoteRoutes` +2 例）。**测试覆盖的边界要说清**：用例证明的是「读取侧共用同一份存储」，而写入侧那一行在 `composition.ts` 里，该文件没有单测——它靠真机走查 §3 步骤 6（多轮追问）验证。这条限制写进了提交信息与走查清单，不留「测过就等于全部覆盖」的印象。

真实模型环境下的完整验证仍未做（`awaiting_input` 的产生条件没有变化），步骤见走查清单 §3。

### 附：一处「有意偏离」需在 spec 标注 —— **已回写（此前）**

spec §5.7 要求 `STAFFDECK_BASE_URL / API_KEY / EXTERNAL_USER_ID` 走构建期 env 注入。实际 D1 计划明确反向决策：「配置只从持久化设置读入，factory 内不读 env」（`providerFactory.ts:16` 注释），全仓无 `process.env.STAFFDECK`。

这个偏离本身合理（企业部署靠 UI 配置更现实），但 spec §5.7 至今仍写着 env 注入，属于文档与实现不一致，应回写。

> **已回写**：spec §5.7 现有「实现偏离」小节，逐项列出四个 spec 变量与实际设置键的对应关系，并写清这个选择的代价——多端部署无法用镜像固化配置。留着这条是因为「文档说 A、代码做 B」比任何一方单独存在都危险：按文档排障的人会在 env 里找一辈子。

---

## 4. 按 spec 章节对照

| spec 章节 | 声明能力 | 状态 |
|---|---|---|
| §5.1 Provider + ETag + configHash 标记 + 降级横幅 | 全部 | ✅ 完成 |
| §5.2 local/remote 分流 + SSE + 续传 + 追问提示条 | 分流/SSE/续传/追问 | ✅ 完成（追问 P2-4 已修，多轮明细不再丢失） |
| §5.2 hybrid 整会话切换 | 可切换 | ✅ 完成（P0-3 UI、P1-5 降级） |
| §5.2 附件 | 远端首轮纯文本，附件留后续 | ✅ 完成（P1-6：文本/PDF/图片三通道） |
| §5.3 技能导入 + 前缀隔离 + 会话激活 | 全部 | ✅ 完成 |
| §5.3 内置 `staffdeck-api-*` 4 包 | 可选 | ❌ P1-8 |
| §5.4 知识同步 + stale 提示 + 索引 | 同步/落盘/坏标记 | ✅ 完成（索引 P2-3 打桩） |
| §5.4 对话带知识引用 | 检索生效 | ✅ 完成（P0-1 已修） |
| §5.5 `staffdeck_*` MCP 注册 + 白名单 | 全部 | ✅ 完成（真机 P2-2） |
| §5.5 公共 MCP 直连 | 本地直连 | ❌ P1-7（服务端未下发） |
| §5.6 回流上报 | 客户端发送 | ✅ 完成（P0-2 调用方、P1-1 队列、P1-2 开关均已补） |
| §5.7 env 注入 | 构建期配置 | ✅ 已回写（实现走持久化设置，spec 现记录该偏离） |
| §6 降级表 | hybrid 转本地 | ✅ 完成（P1-5） |

---

## 5. 建议修复顺序

按「用户可感知的功能完整性」排：

1. ~~**P0-1 知识检索接线**~~ —— **已完成（方案 B）**，见上文修复记录。
2. **P0-2 回流调用方** —— 需要先在 renderer 侧定「一轮何时结束、事件怎么采集」，这是设计问题不是接线问题。
3. **P0-3 + P1-5 hybrid 切换与降级** —— 同一功能的两半，一起做。
4. **P1-10 孤儿 MCP 清理** —— 有数据污染风险，修复成本低（启动时扫一遍 + 每次列表刷新时对已下线员工 unregister）。
5. **P1-9 准备结果提示** —— 让「降级」可见，否则 P1-5 的降级用户也不知道。
6. **P1-2 / P1-3 / P1-4 三个设置与时机项** —— 一起改 settings 契约与设置页，一次提交。
7. **P1-1 回流队列** —— 工作量最大，独立一轮。
8. **P1-11 D5 计划文档** —— 补文档时把上面几项一并记进去。

P1-7（公共 MCP）、P1-8（内置技能包）、P2-1（scope 文案）依赖外部或属打磨，可穿插。

> **2026-10-24 补记**：上面这段排期里的 P2-1 已在同日与 P2-5、P2-6 一并完成。
>
> **同日后补**：原以为 P2-2 / P2-3 / P2-4 三项都是纯验证项。整理走查清单时逐条核对「这条判据由谁保证」，发现 P2-4 不是——追问明细的写入方只覆盖首轮，第二轮起 `remoteStatus` 恒返回空。它缺的是代码不是环境，已在 `9a4d4d69` 修掉。教训是：把某项判成「只需验证」之前，要先确认它**声称的行为**在代码里确实存在，否则「验证不出来」和「根本没实现」会长得一模一样。
>
> 剩下 P2-2 / P2-3 是真验证项，步骤见 `2026-10-24-staffdeck-p2-field-walkthrough.md`。这类项在 CI 里跑不出来，只能在有环境时逐条走查，不适合排进代码提交序列。
