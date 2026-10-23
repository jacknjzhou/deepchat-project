# StaffDeck 接入 D4：技能导入 + `staffdeck_*` MCP 工具 Plan

**Goal:** 让 `executionMode = local` / `hybrid` 的数字员工在 deepchat 本地对话时真正拿到两类能力：StaffDeck 分发的技能包落进本地技能目录并在会话里激活，员工 `tools[]` 里的 `staffdeck_*` 远端工具以 HTTP MCP server 的形式注册进 deepchat，从而在既有 MCP 客户端链路里可调用。

**Architecture:** 新增 main 侧 `EmployeeProvisioner`（编排层）在一次调用里跑两条互相独立的链路：`StaffdeckMcpRegistrar`（把员工变成一个 `type:'http'` 的 MCP server）与 `StaffdeckSkillSync`（下载 `:export-skill` zip → 交给现有 `skillService.installFromZipForAgent` 装进 `deepchat` agent 的技能根）。renderer 在点「开始对话」时**先**调 `digitalEmployee.provision`，**再**读 MCP 工具列表、建会话——顺序是硬要求，因为会话的工具白名单是「可用工具列表的补集」。两条链路都可失败，都不得阻塞会话。

**Tech Stack:** Electron main + zod 契约路由 + Pinia + Vitest + vue-i18n（20 locale）。zip 解包复用现有 `src/main/skill/archive.ts`（`fflate`），不新增运行时依赖。

## Global Constraints

- 禁止新增运行时依赖（HTTP 用全局 `fetch`，zip 用已装的 `fflate`）
- API Key 只在 main 内取用，绝不出现在 route output / renderer state / MCP 配置的 URL 里（只进 `customHeaders.Authorization`）
- **只对 `local` / `hybrid` 员工准备**：`remote` 员工在服务端执行，本地重复注册会把同一批工具变成两份
- **降级到 mock 时不准备**：mock 员工的 id 与技能包都是伪造的，只会在服务端刷 404
- 准备失败一律降级：少一点能力，绝不阻塞「开始对话」
- 同一员工同时只跑一轮准备（两条链路都写共享设置，重叠会触发 MCP 全量重连）
- 技能安装必须带员工前缀 `de-{employee}-{slug}`：`digital-employee:<id>` 不是注册过的 Agent，冒号在 Windows 路径非法，隔离只能靠名字前缀
- 契约走 zod route contract（`defineRouteContract`）+ main `createRouteMap`
- 测试目录镜像 src 结构；`test/main/**` 用 `../../../src/`
- pnpm shim 损坏——直接执行：`C:\Users\SRIBD\.workbuddy\binaries\node\versions\22.22.2-6\node.exe node_modules/vitest/vitest.mjs run <path>`（不要在 exe 前加 `node`）
- vitest 与 vue-tsc / oxlint 必须分开串行执行（并行会 CPU 争抢产生假超时）
- Lint = oxlint；每任务单独 commit，不 `--no-verify`
- i18n：zh-CN 为源语言，en 真实翻译，其余 18 locale 复制 en 值；`test/main/scripts/i18nValidation.test.ts` 校验 20 个 locale 的 key 完全一致

---

## 协议核实结论（对照 StaffDeck 源码 + 实测，非推测）

| 事实 | 证据位置 | 对 D4 的影响 |
|---|---|---|
| 技能导出：`GET /api/v1/digital-employees/{agent_id}:export-skill?slug=...`，scope `agents:read` | `public_api/digital_employees.py:55-66` | slug 是 **query 参数**，不是路径段；`{id}:export-skill` 的形状保持不变 |
| zip 结构：SKILL.md 位于**包根**，其余条目是 `skill_files_json[]` 里的 `{path, content}`；`path` 含 `..`、绝对路径、`~` 的条目被服务端整条丢弃 | `digital_employees/skill_package.py:9-45` | deepchat 的解包器要求 SKILL.md 在根，两边假设一致——已用真实导出的包做了 fixture 测试 |
| 技能版本 = `skills[].id`：每次保存技能服务端都会换新 id | `db/models.py` `GeneralSkill` + 实测两轮 | 不需要下载包算 hash 就能判断是否要重装，也不必留旧 zip |
| 分发包的 `skills[].downloadUrl` 里写的是服务端 `tool_base_url`（默认 `localhost:5173`） | `digital_employees/payload.py:95,121-124` | **不可用**，与 D3 的 `bundleUrl` 同一个坑；一律用客户端自己的 baseUrl 重拼 |
| MCP 网关：`POST /api/v1/mcp/agents/{agent_id}`（JSON-RPC 单端点），另有 `POST /api/v1/mcp`（靠 `_meta.agentId`） | `public_api/mcp.py:144-215` | deepchat 的 `MCPServerConfig` 只有静态 header，标准 MCP 客户端也不会往 `tools/list` 注入 `_meta`，所以**必须用路径形式** |
| MCP 是纯 JSON-RPC over POST：`initialize` / `ping` / `tools/list` / `tools/call`；GET 返回 405 | `public_api/mcp.py:99-142,191-215` | 无服务端推流；deepchat 的 `type:'http'` 正好够用 |
| `initialize` 下发 `Mcp-Session-Id` 响应头，协议版本落到 `2024-11-05` | 实测 | SDK 支持该版本（`SUPPORTED_PROTOCOL_VERSIONS`） |
| 鉴权 scope：`mcp:invoke`（与 `agents:read` 不同） | `public_api/mcp.py:150,174` | Key 需要额外带 `mcp:invoke`；缺了会 403，表现为工具「一个都没有」 |
| 工具名：`staffdeck_{slug}`，不安全字符归一为 `_` 并附 8 位摘要，总长 ≤ 64 | `digital_employees/tool_namespace.py:23-83` | 与分发 payload 的 `tools[]` **逐字节一致**（同一份映射），白名单可以直接比对 |
| `tools/list` 只返回**绑定在员工上**的工具 | `mcp_server/catalog.py` + 实测 3 个财务工具 | 与 `employee.tools` 数目一致是正常态 |

---

## 现状核实（deepchat 侧源码）

| 结论 | 证据 |
|---|---|
| 现有 zip 安装能力可直接复用：`skillService.installFromZipForAgent(agentId, zipPath, {overwrite, targetName})` | `src/main/skill/index.ts:3335` |
| 解包器要求 SKILL.md 在根，并有路径/大小/压缩比限制 | `src/main/skill/archive.ts:1-30` |
| MCP `type:'http'` 已被 `normalizeServerConfig` 支持，Bearer 由 `SimpleOAuthProvider` 承接 | `src/main/mcp/settings.ts:386-423`、`mcpClient.ts:199-215,467-486` |
| **设置里存的 baseUrl 是主机根**：占位符 `https://staffdeck.example.com`，`/api/v1` 由各 client 自己拼（`provider.ts:51`、`remoteClient.ts:125`、`knowledgeClient.ts:107`） | `settings/components/DigitalEmployeeServiceSettings.vue:44` |
| `loadTools()` 默认走 `refresh`，`toolsQuery` 的 `staleTime` 是 30s | `stores/mcp.ts:74-78,152-157,917-925` |
| 工具白名单 = 可用工具列表里「不在 `employee.tools` 中」的部分 | `stores/digitalEmployeeStore.ts:56-67` |
| 数字员工会话统一跑在内置 `deepchat` Agent 上 | `stores/digitalEmployeeStore.ts:37` |

---

## 任务拆分

### Task 1: 员工作用域派生（纯函数）

`src/main/digital-employee/employeeScope.ts`

- `employeeSkillPrefix(employeeId)`：`de-{id}-`；id 不是 lossless 归一（含 `:`、`/`、非 ASCII、大小写混用）时追加 8 位摘要，避免 `a:b` 与 `a/b` 撞同一个目录
- `employeeSkillName(employeeId, slug)`：`de-{id}-{slug}`，总长 ≤ 255
- `mcpServerNameForEmployee(employeeId)`：`staffdeck-{id}-{digest}`，前缀保证 `removeMcpServer` 永不误删用户自己的 server
- `isEmployeeMcpServerName(name)`：清理时的判别式

**测试**（`test/main/digital-employee/employeeScope.test.ts`，12 例）：lossless / 有损 id 的稳定性、非法字符、超长截断、非 ASCII slug 回落摘要、作用域互不相同。

### Task 2: MCP 注册器

`src/main/digital-employee/mcpRegistration.ts`

- `registerForEmployee({employeeId, tools})`：
  - 无凭证 → `unregister` 后返回 `NOT_CONFIGURED`（留着旧注册等于继续发死 key）
  - `tools` 里没有 `staffdeck_*` → `unregister` 后返回 `NO_TOOLS`
  - 已有注册且目标未变 → **完全不写设置**（每次写都触发 MCP 全量重连，工具列表会在对话中途闪断）
  - 目标变了 → `updateMcpServer`
  - 注册成功后 `startServer`；起不来返回 `START_FAILED`（`registered: true, started: false`）
- `unregister(employeeId)`：先 `stopServer`（失败也继续），再 `removeMcpServer`
- URL：`{baseUrl}/api/v1/mcp/agents/{employeeId}`；Bearer 只进 `customHeaders`

**测试**（`mcpRegistration.test.ts`，14 例）：配置形状、幂等（不重写）、key 变更触发重写、凭证缺失清理、无工具清理、起服失败、URL 不含密钥、baseUrl 尾斜杠归一。

### Task 3: 技能包同步

`src/main/digital-employee/skillSync.ts` + `skillSyncState.ts`

- `syncEmployee({employeeId, skills})`：逐技能比对 `skills[].id` 与 baseline，仅变化的才下载
- 下载失败 / 空包 / 安装失败 → 记入 `failedSkills`，**不写 baseline**（否则下轮认为已完成，这条永远补不上）
- baseline 走 config entry `digitalEmployee.skillSync`（`{employeeId: {slug: id}}`），读侧容错：损坏条目降级为「都没装」，只是全量重装一次
- 临时文件每次用独立随机目录（并发装两个员工时同名 zip 会互相覆盖），`finally` 里整目录删除
- 安装用 `overwrite: true` + `targetName = employeeSkillName(...)`；agentId 固定 `deepchat`

**测试**（`skillSync.test.ts` 16 例 + `skillSyncState.test.ts` 8 例）：首发全装、二轮零下载、id 变更重装、下载失败不记账、安装失败不记账、空清单清 baseline、URL 用客户端 baseUrl 而非 `downloadUrl`、slug 进 query、临时文件必删、损坏 baseline 容错。

### Task 4: 准备编排器（两条链路的门与并发闸）

`src/main/digital-employee/provisioning.ts`

- 闸门（`skipped`）：`NOT_LOCAL`（remote 员工）/ `DEGRADED`（provider 降级 mock）/ `NOT_FOUND`（分发列表里没了）
- `NOT_LOCAL` 与 `NOT_FOUND` 都会顺手 `unregister`：陈旧的注册会让这家员工的工具出现在**所有**会话里
- 两条链路各自 `try/catch`，抛错记入 `failures`，互不影响
- 顺序：先 MCP 后 skills，**不并行**——注册决定了 renderer 随后要读的工具列表，安装决定了首轮读 system prompt 时的技能目录
- 同员工在途轮次复用（`inFlight` Map）
- `reset()` 供配置变更时丢弃旧凭证那一轮

**测试**（`provisioning.test.ts`，17 例）：三类跳过、跳过时的清理、链路抛错隔离、在途复用、`reset` 后重跑、`skills` 缺 slug 时丢弃、`skillNames` 仍上报（旧轮装过的技能还在盘上）。

### Task 5: 契约 + 接线 + renderer

- 契约 `src/shared/contracts/routes/digitalEmployeeProvisioning.routes.ts`：`digitalEmployeeProvisionRoute`，output 只暴露 `skipped / toolsReady / installedSkills / failedSkills / skillNames / failures`
- `digitalEmployee.routes.ts` 补 `skills[].slug`（可选）——zod 默认 strip 未知字段，不补的话每个技能都拿不到 slug、静默失败
- `composition.ts`：建 registrar / skillSync / provisioner，`onDigitalEmployeeConfigurationChanged` 里 `reset()`，注册 `digitalEmployeeProvisioningRoutes`
- `DigitalEmployeeClient.provision()` + store `provisionEmployee()`
- `DigitalEmployeeSquarePage.startConversation()`：`provision` → `loadTools({force:true})` → `startConversation({activeSkillNames})`

**测试**：契约解析（`test/main/contracts/digitalEmployeeSchema.test.ts`）、路由投影（`provisioning.test.ts` 内含）、renderer 顺序与透传（`test/renderer/pages/digitalEmployee/DigitalEmployeeSquarePage.test.ts` 17 例，含「provision 必须先于 loadTools」与「技能名透传」）、store（`digitalEmployeeStore.test.ts`）。

### Task 6: 联调 + 文档

- 用真实服务跑 `initialize` / `tools/list` / `tools/call` 与两个技能包下载解包
- 回写 spec §5.3 / §5.5 与 §8 里程碑
- 本文件补实施结果

---

## 实施结果（2026-10-23）

| Task | 提交 | 交付 |
|---|---|---|
| 1 作用域派生 | `ca744f98` | `employeeScope.ts` + 12 例 |
| 2 MCP 注册 | `c3b77d64` | `mcpRegistration.ts` + 14 例 |
| 3 技能同步 | `e5b7ec44` | `skillSync.ts` / `skillSyncState.ts` + 24 例 |
| 4 准备编排 | `ee30ec3b` | `provisioning.ts` / `provisioningRoutes.ts` + 17 例 |
| 5 契约与接线 | `ee30ec3b` | 契约 + composition + client + store + 广场页顺序 |
| — 前缀常量笔误 | `16895b38` | `STAFDECK_TOOL_PREFIX` → `STAFFDECK_TOOL_PREFIX` |
| — 真实包 fixture | `20a13d29` | `test/fixtures/skills/staffdeck-export-skill.zip` + 握手用例 |
| — 联调缺陷修复 | `19ca27ad` | 两个 client 补 `/api/v1`；`loadTools({force:true})` |
| 6 联调 + 文档 | 本文件 | 见下 |

### Task 6 联调实测

环境：`backend/.venv` 起 `uvicorn app.main:app --port 5174`；临时脚本签发一个带 `mcp:invoke` 的 Key（脚本已删）。口径：只把 MCP 配置存储、`serverManager`、技能安装器换成桩，**HTTP、URL 拼接、zip 解包全用真实实现**。

| 项目 | 结果 |
|---|---|
| 员工 | `agent_f2828efc2a2a476d`（财务），`executionMode=local` |
| 分发 payload | `tools` = 3 个 `staffdeck_*`；`skills` = 2 个（`data-statistical-analysis` / `bill-field-extract`） |
| MCP 注册 URL | `http://127.0.0.1:5174/api/v1/mcp/agents/agent_f2828efc2a2a476d` |
| `initialize` | 200，`serverInfo={StaffDeck MCP,1.0.0}`，下发 `Mcp-Session-Id` |
| `tools/list` | **3 个**，与 payload 的 `tools[]` 逐字一致 |
| `tools/call` | `staffdeck_expense_quota_query_613d69d6` 返回真实额度：`total_quota=20000, used=0, remaining=20000, CNY` |
| 技能首轮 | `{ok:true, installed:2, failedSkills:[]}` |
| 技能 zip | 1780 / 1805 字节，解包后 SKILL.md 均在包根，安装名为 `de-agent_f2828efc2a2a476d-{slug}` |
| 技能二轮 | `{ok:true, installed:0}` —— id 未变，零下载 |

### 联调发现的两个缺陷（均已在 `19ca27ad` 修复）

1. **两个 client 都漏了 `/api/v1`**。设置里存的是主机根（占位符 `https://staffdeck.example.com`），`provider` / `remoteClient` / `knowledgeClient` 都是自己拼前缀，只有 D4 这两个照搬。实测不带前缀的 `/mcp/agents/...` 与 `/digital-employees/...:export-skill` **都是 404**——整个 D4 功能其实一次都跑不通。
   - 测试为什么没抓到：`getConnection` 直接喂 `http://staffdeck.test/api/v1`，恰好把缺失的前缀补上了。已把测试改成真实形态（主机根），并新增一条「补上设置里没有的版本段」用例。
   - 顺带修了一个自我矛盾的旧用例：`does not double the /api/v1 prefix` 声称验证去重，但实现里从来没有去重逻辑，它只是靠 baseUrl 里带前缀才通过。
2. **工具列表读的是 30 秒缓存**。`loadTools()` 默认 `refresh`，`toolsQuery` 的 `staleTime` 是 30s；刚注册完的 server 工具读不到，「先注册后读列表」这个顺序约束就白做了。改为 `{force: true}` 并在广场页用例里钉住参数。

### 已知限制

- **`mcp:invoke` scope 是 D4 新增的必需项**，分发列表只需要 `agents:read`。缺它会表现为「工具一个都没有」而不是报错，运维上容易误判。当前 20 locale 的 `remote.error.insufficientScope` 文案只提到 runs/sessions，尚未覆盖此项。
- 联调用的 `serverManager` 是桩（真实路径要起整台 Electron 的 MCP 服务），因此 `startServer` 成功只证明「端点接受该配置且工具可列可调」，未覆盖 deepchat 内部的重连与工具注册表刷新。
- hybrid 员工按 `local` 处理（`executionMode !== 'remote'` 即准备）。若将来 hybrid 的「远端分支」成为默认，需要重新审视是否会双份注入。

## 自审

- 每个 Task 的测试都能独立跑，且失败是真实的
- 不新增依赖：zip 走已装的 `fflate`，HTTP 走全局 `fetch`
- 无占位符：所有端点、scope、工具名规则都标了源码位置
- 顺序约束有测试钉住（`callOrder === ['provision', 'loadTools']`），不是注释里的君子协定
- 失败语义统一：任何一步失败都只减少能力，用户永远能点得动「开始对话」
