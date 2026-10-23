# StaffDeck 接入 D3：知识同步 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `executionMode = local` / `hybrid` 的数字员工在 deepchat 本地对话时，能用上 StaffDeck 分发的知识库内容——把员工 `knowledgeBaseIds` 指向的知识库下载成 markdown 落进本地内置知识库，经本地嵌入建立向量索引，从而在既有 `similarityQuery` 检索链路里生效；同步失败保留旧副本并标 `stale`，不让对话因此中断。

**Architecture:** 新增 main 侧 `StaffdeckKnowledgeSync`（纯编排类，依赖全注入，可单测）：读分发 payload 的 `knowledgePackagesUrl` → `GET .../knowledge-packages` 取清单（ETag 缓存）→ 逐概念比对 `hash` 与本地已同步记录 → 只拉差异概念的 `concepts/{path}:download` → 写入本地缓存目录 → 交给 `KnowledgeService.addFile`/`reAddFile` 建索引。本地知识库按「每员工一个」创建（id 为 `de:` + employeeId 的稳定派生），嵌入模型取现有已启用 provider 中的嵌入模型，维度经 `providerRuntime.getDimensions` 探测。同步状态（每 KB 的 `configHash`、概念 hash 表、`stale` 标记、`lastSyncAt`）存 config entry `digitalEmployee.knowledgeSync`。调度仿 `AutoWatchScheduler`：分钟 tick + 可配间隔，启动后首轮延迟执行。

**Tech Stack:** Electron main + zod 契约路由 + Pinia + Vitest + vue-i18n（20 locale）。zip 用已装的 `fflate`；不新增运行时依赖。

## Global Constraints

- 禁止新增运行时依赖（zip 用 `fflate`，HTTP 用全局 `fetch`）
- API Key 只在 main 内取用，绝不出现在 route output / renderer state / 日志
- **只同步 `knowledgeBaseIds` 指向的 KB**，不全量镜像租户知识（spec §5.4 一致性规则）
- `knowledge-packages` 的同步开关是**默认关闭**（`metadata.get("deepchat_sync_enabled") is not True`），因此「清单为空」是正常状态，不是错误——不得重试轰炸、不得报错
- `bundleUrl` 指向服务端 `tool_base_url`（默认 `http://localhost:5173`），**不是客户端 baseUrl**，不可直接下载；只用 `concepts/{path}:download` 逐概念拉取
- 同步失败一律降级：保留旧副本 + `stale` 标记，绝不阻塞会话；后台按退避重试
- 契约走 zod route contract（`defineRouteContract`）+ main `createRouteMap`
- 测试目录镜像 src 结构；`test/main/**` 用 `../../../src/`
- pnpm shim 损坏——直接执行：`C:\Users\SRIBD\.workbuddy\binaries\node\versions\22.22.2-6\node.exe node_modules/vitest/vitest.mjs run <path>`（不要在 exe 前加 `node`）
- vitest 与 vue-tsc / oxlint 必须分开串行执行（并行会 CPU 争抢产生假超时）
- Lint = oxlint；每任务单独 commit，不 `--no-verify`
- i18n：zh-CN 为源语言，en 真实翻译，其余 18 locale 复制 en 值；`test/main/scripts/i18nValidation.test.ts` 会校验 20 个 locale 的 key 完全一致

---

## 协议核实结论（对照 StaffDeck 源码实测，非推测）

本计划的每个服务端细节都来自本地 StaffDeck 仓库（`D:\sync-workspace\traework\StaffDeck-Project\StaffDeck-Project\backend`）源码，行号可直接复核。

| 事实 | 证据位置 | 对 D3 的影响 |
|---|---|---|
| 清单端点：`GET /api/v1/digital-employees/{agent_id}/knowledge-packages`，scope `agents:read` | `public_api/knowledge_sync.py:79-98` | 与 D2 的 `runs:create` 不同，这个 Key 需要额外带 `agents:read`（分发已在用，已有） |
| 清单体：`{packages[], configVersion, fetchedAt}`；package 含 `knowledgeBaseId`/`name`/`version`/`configHash`/`bundleUrl`/`concepts[]`/`conceptCount` | `digital_employees/knowledge_sync.py:60-110` | `configHash` 前缀 `sha256:`，是「整 KB 是否变化」的快速判据，但**不能只看它**——单概念变化也会改 configHash，仍需逐概念比对 |
| `concepts[]` 每项：`{conceptId, type, title, hash, size}`，`hash` 是 `content_md` 的 sha256 前 16 位 | `knowledge_sync.py:33-35`、`71-79` | 本地按 `conceptId` 存 hash，仅 hash 变化才重拉 |
| `configVersion` 形如 `kv1:{digest}`，仅在 packages 列表变化时才变 | `knowledge_sync.py:112-118` | 可作为「清单级」ETag 替代物；服务端另有真 ETag |
| ETag 支持 + 304 | `public_api/knowledge_sync.py:83-92` | 带上 `If-None-Match` 省流量；304 时必须沿用本地缓存清单，不能当成空列表 |
| 单概念下载：`GET .../knowledge-packages/{kb}/concepts/{concept_path}:download`，返回 `text/markdown; charset=utf-8`，ETag 为 `"{hash}"` | `public_api/knowledge_sync.py:130-174` | 路径含 `/`（`sources/<doc>/sections/sec-1`），必须整体 URL 编码但**保留 `/`** |
| 概念下载 404 有 3 种：KB 未同步（`KNOWLEDGE_PACKAGE_NOT_FOUND`）、概念不在包内（`CONCEPT_NOT_FOUND`）、agent 不存在（`AGENT_NOT_FOUND`） | 同上 | 404 一律跳过该概念并记 warning，不中断整轮 |
| bundle zip 结构：`index.md` + `log.md` + 每概念 `{concept_id}.md` | `knowledge/okf.py:210-222` | 本计划**不用 bundle**（见下节偏差 1），但概念文件的正文就是这个 md |
| 同步开关是 opt-in：`metadata.get("deepchat_sync_enabled") is not True` 即跳过 | `knowledge_sync.py:36`、`57` | 默认无 KB 被同步，清单为空是常态 |
| 概念 id 里带 `/`，且概念可能很多（每文档最多 80 section + 若干 bucket） | `knowledge/okf.py:62-72` | 本地缓存目录必须按 conceptId 建层级，不能全部平铺 |
| 知识库 id 形如 `kb_xxxx`，只含 `[a-z0-9_]` | `db/models.py:477` | 本地知识库 id 可直接用 `de:` 前缀 + employeeId，但 employeeId 可能更长，需自行收窄 |

### 设计文档（spec §5.4）需要修正的 3 处

| # | spec 原文 | 实测 | 本计划的处理 |
|---|---|---|---|
| 1 | 「差异文档经 `:export-manifest` / `:download` 拉取」 | **无 `:export-manifest` 端点**。只有 `/knowledge-packages`（清单，已含全部 hash）、`:export-bundle`（整包 zip）、`/concepts/{path}:download`（单概念） | 用 `knowledge-packages` 当清单（它本身就带 per-concept hash），差异概念走 `concepts/{path}:download`。不使用 bundle |
| 2 | 「`bundleUrl` → 下载」隐含可直接用 payload 里的 URL | `bundleUrl` 由服务端 `get_settings().normalized_tool_base_url` 拼出（`knowledge_sync.py:145-152`），默认 `http://localhost:5173`，与客户端 `STAFFDECK_BASE_URL` 无关 | 忽略 `bundleUrl`，用客户端自己配置的 baseUrl 拼端点。另：就算要用也应走概念下载——bundle 是整包，无法增量 |
| 3 | 「同步粒度按员工（只同步其 `knowledgeBaseIds`）」但未说明 KB 与员工的归属 | 服务端 `select_package` 已按 principal+agent 过滤，返回的 packages 就是该员工可见且开启同步的集合 | 客户端仍要用分发 payload 的 `knowledgeBaseIds` 做交集，防止清单里有历史遗留 KB（例如员工已解绑但版本仍开着开关） |

---

## 现状核实（deepchat 侧源码）

| 事实 | 证据 | 影响 |
|---|---|---|
| `KnowledgeService.addFile(id, filePath)` 返回 `{data}` 或 `{error}`，**不抛错**（内部 catch） | `knowledge/index.ts:318-327` | 判成功必须看 `error` 字段，不能用 try/catch 判 |
| `addFile` 是异步索引：插库后立即返回，向量在后台 `processFileAsync` 里算 | `knowledgeBase.ts:72-119` | 不能以 addFile 返回判定「已可检索」；stale 状态应保持到下一轮或按任务队列状态推进 |
| `reAddFile(id, fileId)` 按 **fileId** 定位，内部清 chunks/vectors 后重加 | `knowledgeBase.ts:369-377` | 增量更新用 fileId 稳定映射，不用路径（路径变了会重复） |
| `listFiles(id)` 可列本地已索引文件（含 `path`） | `knowledge/index.ts:350-353` | 用于「清单有但本地没有」与「本地有但清单已删」两侧对账 |
| `deleteFile(id, fileId)` | `knowledge/index.ts:329-332` | 清理服务端已移除的概念 |
| `BuiltinKnowledgeConfig` 必填 `embedding{providerId,modelId}` 与 `dimensions`，**无默认值** | `shared/types/knowledge.ts:47-64` | 必须自己挑嵌入模型并探测维度，否则建不了 KB |
| `providerRuntime.getDimensions(providerId, modelId)` 可直接在 main 调 | `provider/index.ts:1141-1146` | 维度探测不需要经过 renderer |
| 知识库配置存 settings 键 `knowledgeConfigs`，读写在 `KnowledgeSettings` | `knowledge/settings.ts` | 同步器通过注入的 settings 写配置，然后调 `service.syncConfigChanges()` 让服务生效 |
| markdown 走 `TextFileAdapter`（`text/markdown` 已映射） | `file/mime.ts:24` | 概念正文直接存 `.md` 即可被索引 |
| 周期任务先例：`AutoWatchScheduler`（分钟 tick + 归一到小时间隔 + `runOnce()` 可直调） | `documents/autoWatch.ts` | 调度器照此模式，`runOnce()` 保持公开以便测试直调 |
| `remoteClient` 已有 `authHeaders()` / problem+json 解析 | `digital-employee/remoteClient.ts` | 同步器复用同一份鉴权与错误码语义，不重复实现 |
| config entry 已有 3 处注册范例（`digitalEmployee.remoteSessions`） | `shared/contracts/routes/config.routes.ts` | 新增 `digitalEmployee.knowledgeSync` 照抄这三处 |
| `useRemoteAwaitingInput` 负责追问态，`digitalEmployeeStore` 负责员工与绑定 | D2 交付 | 同步状态是 main 的事，renderer 只读状态做提示，不加写入口 |

---

## 任务拆分

### Task 1: 同步状态存储（config entry + 纯读写类）

**Files:**
- Create: `src/main/digital-employee/knowledgeSyncState.ts`
- Modify: `src/shared/contracts/routes/config.routes.ts`（3 处注册键）
- Modify: `src/main/app/settingsRoutes.ts`（快照读取）
- Test: `test/main/digital-employee/knowledgeSyncState.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖：空表读到空结构、损坏 JSON 按空表处理、`set`/`get` 往返、`markStale` 不清其他 KB 的 hash、`clear` 只清指定 KB。

- [ ] **Step 2: 跑测试确认失败**

```bash
C:\Users\SRIBD\.workbuddy\binaries\node\versions\22.22.2-6\node.exe node_modules/vitest/vitest.mjs run test/main/digital-employee/knowledgeSyncState.test.ts
```

- [ ] **Step 3: 实现**

状态结构（按员工分桶，避免串号）：
```ts
interface KnowledgeSyncState {
  employees: Record<string, {
    localKnowledgeBaseId: string        // 本地 KB id（稳定派生）
    packages: Record<string, {          // key = 远端 knowledgeBaseId
      configVersion: string
      configHash: string
      etag: string | null
      stale: boolean
      staleReason: string | null        // 'UNREACHABLE' | 'HTTP_<status>' | 'PARTIAL'
      lastSyncAt: string
      concepts: Record<string, { hash: string; fileId: string }>
    }>
  }>
}
```
读写每次从 settings 重解析，不做进程内缓存（对齐 `remoteSessionRegistry`）。

- [ ] **Step 4: 跑测试 + `vue-tsc` + `tsc -p tsconfig.node.json` + `oxlint`**

- [ ] **Step 5: Commit** `feat(digital-employee): persist knowledge sync state per employee`

---

### Task 2: 远端清单与概念拉取客户端

**Files:**
- Create: `src/main/digital-employee/knowledgeClient.ts`
- Test: `test/main/digital-employee/knowledgeClient.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖：清单解析（含空的 packages 属正常）、`If-None-Match` 命中 304 返回 null 表示未变、非 2xx 抛 `StaffdeckProblemError`（复用 D2 的类）、概念路径保留 `/` 但编码特殊字符、概念 404 返回 null 而非抛错、概念正文按 utf-8 读、超时。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

关键点：
```ts
// 概念 id 形如 sources/<doc>/sections/sec-1，斜杠必须保留，
// 否则路径会被编码成 %2F 而 FastAPI 的 :path 转换器收不到。
const encodeConceptPath = (conceptId: string): string =>
  conceptId.split('/').map(encodeURIComponent).join('/') + ':download'
```
端点拼接全部基于注入的 `baseUrl`（**不用 payload 的 `bundleUrl`**）。

- [ ] **Step 4: 跑测试 + 类型检查 + oxlint**

- [ ] **Step 5: Commit** `feat(digital-employee): fetch staffdeck knowledge manifest and concept bodies`

---

### Task 3: 本地知识库准备（创建 + 嵌入模型选择 + 维度探测）

**Files:**
- Create: `src/main/digital-employee/knowledgeProvisioning.ts`
- Test: `test/main/digital-employee/knowledgeProvisioning.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖：无可用嵌入模型时返回明确失败原因（不抛错、不建 KB）、KB 已存在则复用不重建、id 派生稳定（同员工同 id）、id 满足安全字符集、维度探测成功写入配置、探测失败时用模型元数据里的已有维度兜底、配置写入后调用 `syncConfigChanges`。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

- id 派生：`de:` 前缀不合适（`:` 在 Windows 是非法路径字符），用 `de-{employeeId}` 并收窄到 `[a-z0-9_-]`，超长截断 + 短 hash 后缀。
- 嵌入模型选择顺序：员工的 provider 默认嵌入模型（若契约有）→ 第一个 `enabled` 且 `modelType` 为 embedding 的模型。**找不到就明确失败**并写入 `staleReason: 'NO_EMBEDDING_MODEL'`，提示用户去设置里配。
- 生成配置后 `settings.setKnowledgeConfigs([...])` + `await service.syncConfigChanges()`。

- [ ] **Step 4: 跑测试 + 类型检查 + oxlint**

- [ ] **Step 5: Commit** `feat(digital-employee): provision a local knowledge base per remote employee`

---

### Task 3b: `managedBy` 标记（schema + 设置页禁删）

**Files:**
- Modify: `src/shared/contracts/domainSchemas.ts`（`BuiltinKnowledgeConfigSchema` 加可选字段）
- Modify: `src/shared/types/knowledge.ts`（类型同步）
- Modify: `src/renderer/settings/components/BuiltinKnowledgeSettings.vue`（禁删 + 禁改嵌入模型 + 说明文案）
- Modify: 20 个 locale
- Test: `test/renderer/settings/BuiltinKnowledgeSettings.managed.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖：带 `managedBy: 'digital-employee'` 的 KB 不渲染删除按钮、不渲染编辑入口、显示「由数字员工同步维护」标记；不带标记的 KB 行为不变；旧数据（无该字段）不报错（schema 可选，向后兼容）。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 + 20 locale**

文案 key：`settings.knowledgeBase.managedByEmployee`（由数字员工同步维护，不可直接删除）、`settings.knowledgeBase.managedDeleteHint`。

- [ ] **Step 4: 跑测试 + `vue-tsc` + oxlint**

- [ ] **Step 5: Commit** `feat(settings): protect digital-employee managed knowledge bases from manual edits`

---

### Task 4: 同步编排器（差异计算 + 落盘 + 索引 + stale 降级）

**Files:**
- Create: `src/main/digital-employee/knowledgeSync.ts`
- Test: `test/main/digital-employee/knowledgeSync.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖（这是本任务的核心，至少 12 条）：
1. 清单为空 → 不建 KB、不标记 stale、不报错
2. 首轮全量：N 个概念 → N 次下载 + N 次 addFile
3. 二轮无变化（hash 全同）→ 零下载
4. 单概念 hash 变化 → 只下这一个 + `reAddFile`
5. 服务端删除概念 → `deleteFile` + 本地记录移除
6. 下载中途失败 → 该 KB 标 `stale`，**已完成的部分保留**
7. 清单 304 → 用本地缓存清单，零下载
8. 员工 `knowledgeBaseIds` 与清单取交集：清单里多出的 KB 不处理
9. 概念 id 含 `/` → 落盘时建层级目录，不被压成单文件
10. 落盘路径稳定（同概念二次同步写同一路径）
11. 全部成功后 `stale=false` 且 `lastSyncAt` 更新
12. `addFile` 返回 `{error}` → 记为失败但不抛，整轮继续

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

结构：`syncEmployee(employeeId, knowledgeBaseIds)` → `synckb(...)`，缓存目录 `{userData}/digital-employee-knowledge/{localKbId}/{conceptId}.md`。

要点：
- 写文件用 `mkdir -p` + 原子写（`.tmp` 后 rename），避免半截文件进索引
- 概念正文原样保存 md，不拼 frontmatter（索引吃正文；frontmatter 里的 YAML 会被当正文切进块，反而污染检索）
- `stale` 一旦为真，**保留旧向量**：不删、不重建，只标记
- 下载并发限 3，避免打爆服务端

- [ ] **Step 4: 跑测试 + 类型检查 + oxlint**

- [ ] **Step 5: Commit** `feat(digital-employee): sync staffdeck knowledge into the local index`

---

### Task 5: 调度与接线（composition + 配置变更触发）

**Files:**
- Create: `src/main/digital-employee/knowledgeSyncScheduler.ts`
- Modify: `src/main/app/composition.ts`
- Test: `test/main/digital-employee/knowledgeSyncScheduler.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖：未启用时不跑、间隔未到不跑、`runOnce()` 可直调、单员工失败不影响其他员工、并发触发被跳过（同一时刻只跑一轮）、`stop()` 后可重启。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

仿 `AutoWatchScheduler`：`TICK_MS = 60_000`，间隔读 `STAFFDECK_SYNC_INTERVAL`（秒，默认 3600）。接线进 composition：与 `remoteClient` 同源判断（连接配置齐备才建），配置变更时重建。

- [ ] **Step 4: 跑测试 + 类型检查 + oxlint**

- [ ] **Step 5: Commit** `feat(digital-employee): schedule periodic staffdeck knowledge sync`

---

### Task 6: 状态查询契约 + renderer `stale` 提示

**Files:**
- Create: `src/shared/contracts/routes/digitalEmployeeKnowledge.routes.ts`
- Create: `src/main/digital-employee/knowledgeRoutes.ts`
- Modify: `src/main/app/composition.ts`（注册路由）
- Modify: `src/renderer/src/stores/digitalEmployeeStore.ts`（读状态）
- Modify: `src/renderer/src/features/chat-page/ChatPage.vue`（stale 提示条）
- Modify: 20 个 locale
- Test: `test/main/digital-employee/knowledgeRoutes.test.ts`、`test/renderer/stores/digitalEmployeeStore.test.ts`（追加）、`test/renderer/components/chat/KnowledgeStaleBanner.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖：状态路由返回每 KB 的 `{knowledgeBaseId, stale, staleReason, lastSyncAt, conceptCount}`、无记录时空数组、`staleReason` 映射到 i18n key 且 key 在 en-US 真实存在、renderer 只在 stale 时显示提示条、切会话不串号。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 + 20 locale**

文案（zh-CN 源 / en）：`digitalEmployee.knowledge.stale`（知识可能过期，正在后台重试）、`digitalEmployee.knowledge.noEmbedding`（未配置嵌入模型，无法同步）、`digitalEmployee.knowledge.syncing`。

- [ ] **Step 4: 跑测试 + `vue-tsc` + `tsc` + `oxlint`**

- [ ] **Step 5: Commit** `feat(digital-employee): surface knowledge sync staleness in chat`

---

### Task 7: 联调与文档

- [ ] **Step 1: 后端开启一个 KB 的同步开关**，用 `curl --noproxy '*'` 验证 `/knowledge-packages` 返回非空
- [ ] **Step 2: 直连脚本跑一轮同步**，断言本地 `listFiles` 出现概念文件、`similarityQuery` 能召回
- [ ] **Step 3: 修订 spec §5.4 的 3 处偏差 + §6 降级表 + §7 测试计划第 5 条**
- [ ] **Step 4: 全量回归**（`test/main/digital-employee` + `test/main/knowledge` + `test/renderer` 相关目录，串行）
- [ ] **Step 5: Commit** `docs(digital-employee): record staffdeck d3 outcome and correct the knowledge sync spec`

---

## 实施结果（2026-10-23，代码已落地并提交）

| Task | 提交 | 交付 |
|---|---|---|
| 1 同步状态存储 | `74bb178f` | `knowledgeSyncState.ts`：每员工 → 每 KB → 每概念 hash 的对照表，走 config entry |
| 2 清单与概念拉取 | `56ceef6e` | `knowledgeClient.ts`：ETag 协商、304 返回 null、逐段编码 concept 路径 |
| 3 本地知识库准备 | `64c35baa` | `knowledgeProvisioning.ts`：`de-` 前缀稳定 id、取第一个启用的 embedding 模型、维度探测失败写 0 |
| 3b `managedBy` 标记 | `53b31f75` | 设置页禁止删除/改嵌入模型 |
| 4 同步编排器 | `9a4fb384` | `knowledgeSync.ts` + 16 条用例，覆盖空清单/增量/删除/部分失败/304/交集/层级路径/原子写 |
| 5 调度与接线 | `19fe9f02` | `knowledgeSyncScheduler.ts` + composition 接线（含 destroy 停止）+ `syncIntervalSeconds` 配置键 |
| 6 状态契约与 UI | 见 `git log` | `digitalEmployeeKnowledge.routes.ts`、`knowledgeRoutes.ts`、`KnowledgeStaleBanner.vue`、store `loadKnowledgeStatus`、20 locale |
| 7 联调与文档 | 见 `git log` | 真实服务联调 + spec §5.4/§6/§7 修订 |

### Task 7 联调实测（本地 StaffDeck 服务 + 真实 client/编排器）

环境：`backend/.venv` 起 `uvicorn app.main:app --port 5174`；用临时脚本给 `agent_f2828efc2a2a476d` 的 `kb_067d71b1f22c48bc` 打开 `deepchat_sync_enabled`（脚本已删）。口径：只把 provision 与向量索引换成桩，其余全用真实实现。

| 项目 | 结果 |
|---|---|
| 清单 | 1 个包「财务-报销办理流程说明」，**25 个概念**，`configHash=sha256:2b60971612254fe3` |
| 首轮同步 | `{ok:true, downloaded:25, failedPackages:0}` |
| 层级路径 | **13 个**概念形如 `sources/<doc>/sections/sec-N`，落盘为真实目录，未被压平 |
| 二轮同步 | `{ok:true, downloaded:0}` —— hash 全同，零下载 |
| 落盘整洁 | 缓存顶层只有 `playbooks` / `sources`，无 `.tmp` 残留 |
| ETag 304 | 携 `If-None-Match` 返回 **304**，客户端据此跳过整轮 |

### 三个计划外的发现（已回写 spec）

1. **概念正文是 OKF 格式**，自带 YAML frontmatter 与 `# Summary` / `# Source Sections` / `# Notes` / `# Citations` 分段。计划里写「不拼 frontmatter」是对的，但**也不能剥离**服务端自带的：hash 就是对这份完整正文算的，任何改写都会让 hash 永远对不上、每轮全量重拉。实现取「原样保存」。
2. **`bundleUrl` 不可用**。它指向服务端 `tool_base_url`（默认 `localhost:5173`），与客户端 baseUrl 无关。计划 §Global Constraints 已列出，实现按「完全忽略」处理。
3. **空清单是最常见的正常状态**。服务端 `deepchat_sync_enabled` 必须显式为 `True` 才进清单，实测未开启时返回 `{"packages":[],"configVersion":"kv1:4f53cda18c2b"}` 且 HTTP 200。这条决定了「不能把空清单当失败」的实现选择。

### 已知限制

- 索引环节在联调中被打桩：`addFile` 的真实建向量路径依赖已启用的 embedding provider，脚本环境没有。落盘与调用次数已验证，**向量检索召回效果未端到端验证**。
- 「首轮对话触发同步」目前只有调度器的 `runOnce()` 可直调，尚未挂到 `ChatService.sendMessage`——首轮命中的是定时轮，最坏等一个间隔（默认 1h）。若要即时生效，需在远端/本地分流处加一次 fire-and-forget 调用。

## 已确认的决策（2026-10-23）

1. **嵌入模型**：自动取第一个已启用的 `embedding` 模型；一个都没有时不建库，标 `NO_EMBEDDING_MODEL` 并在会话页提示去设置里配。
2. **KB 归属**：`BuiltinKnowledgeConfig` 新增可选 `managedBy?: 'digital-employee'`；带此标记的 KB 在设置页不可删除、不可编辑嵌入模型（删了下一轮会重建、改了维度会让旧向量失效），只允许查看。**这会动 settings schema，见 Task 3b。**
3. **同步时机**：用户首次与该员工对话时触发同步，同时后台按间隔预热。不采用「列表拉取后即全量同步」——用户可能一辈子不用其中大半员工。

---

## 自审

- 每个 Task 的测试都可独立运行，且失败是真实的（先写测试再实现）
- 不新增依赖：`fflate` 已装（虽然本计划实际不用 zip，走单概念下载）
- 无占位符：所有端点、字段名、错误码都标了源码位置
- stale 语义明确：保留旧向量、只打标记、不进错误路径
- 空清单不等于失败——这是最容易写错的地方（服务端默认全关）
