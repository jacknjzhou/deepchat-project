# 数字员工本地资产可调用能力 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让数字员工的技能、SOP、知识库与工具一样，在本地执行会话中真实可调用——工具已有 MCP 通道，本计划把知识库升级为「会话全程可检索的工具」，把 SOP 从「全量注入」升级为「截断注入 + 全文可检索」，技能链路补齐可观测性。

**Architecture:** 复用既有三套地基：① per-employee in-memory MCP（`mcpRegistration.ts` 的幂等注册模式 + `inMemoryServers/builder.ts` 工厂）新增每员工知识检索服务器；② 既有知识同步子系统（`knowledgeSync` → 本地库 `de-{employeeId}` → 向量索引）作为检索后端；③ 会话创建时的白名单收敛（`buildDisabledAgentTools`）放行新工具。

**Tech Stack:** Electron main / TypeScript / Vitest；MCP in-memory server（与 `BuiltinKnowledgeServer` 同构）。

---

## 0. 现状盘点（计划的事实基础）

| 资产 | 现状 | 证据 | 缺口 |
| --- | --- | --- | --- |
| 工具 tools | ✅ 每员工远端 MCP server（幂等注册）+ 会话白名单收敛 | `src/main/digital-employee/mcpRegistration.ts`、`digitalEmployeeStore.ts` `buildDisabledAgentTools` | 无 |
| 技能 skills | ✅ 本地会话前 provision：zip 下载 → `installFromZipForAgent('deepchat', employeeSkillName(employeeId, slug))`；`skills[].id` 作版本号比对重发布（`skillSyncState.ts`）；会话用 provision 返回的 `skillNames` 激活 | `skillSync.ts:67-115`、`provisioning.ts`、`digitalEmployeeStore.ts:354-361` | 仅可观测性（Task 5） |
| 知识库 knowledgeBaseIds | ⚠️ 后台同步全链路已存在（manifest → 概念 md 落盘 → 向量索引 → 状态表 stale 降级），但消费端只在**首问**检索一次（`openingQuestion` 门控），后续轮次与模型主动检索均缺失 | `knowledgeSync.ts`、`knowledgeProvisioning.ts`、`knowledgeSyncScheduler.ts`、`digitalEmployeeStore.ts:320-351` | **核心缺口**（Task 1-4） |
| SOP sops | ⚠️ `{title, content}` 全量静态注入 system prompt（每段 `## SOP：title`），长 SOP 撑 token、模型无法按需引用 | `digitalEmployeeStore.ts:44-59` | Task 4（截断）+ Task 5（入检索库） |
| 远端执行模式 | 服务端持有提示词与知识，本地不注入是**正确语义** | `digitalEmployeeStore.ts:303-318` | 明确不在本计划范围 |

**前置依赖（非代码，需运维确认）：** StaffDeck 服务端同步开关 `deepchat_sync_enabled` 必须显式开启；本地已配置嵌入模型（`knowledgeProvisioning` 在缺失时返回 reason 并跳过，不阻塞会话）。

---

## 1. 任务分解

### Task 1: 每员工知识检索 in-memory MCP 服务器

**Files:**
- Create: `src/main/digital-employee/knowledgeToolServer.ts`
- Test: `test/main/digital-employee/knowledgeToolServer.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// test/main/digital-employee/knowledgeToolServer.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createDigitalEmployeeKnowledgeServer } from '../../../src/main/digital-employee/knowledgeToolServer'

const makeKnowledge = (results: unknown[] = []) => ({
  similarityQuery: vi.fn(async () => results)
})

describe('DigitalEmployeeKnowledgeServer', () => {
  it('exposes one tool that queries the employee local base', async () => {
    const knowledge = makeKnowledge([
      { metadata: { content: '报销流程：先提交 OA…' }, score: 0.9 }
    ])
    const server = createDigitalEmployeeKnowledgeServer({ knowledge, localKnowledgeBaseId: 'de-emp-1' })

    expect(server.name).toBe('de-kb')
    const tools = await server.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('de_knowledge_search')

    const result = await server.callTool('de_knowledge_search', { query: '怎么报销' })
    expect(knowledge.similarityQuery).toHaveBeenCalledWith('de-emp-1', '怎么报销')
    expect(result.content[0].text).toContain('报销流程')
  })

  it('returns a friendly empty notice instead of erroring on no hits', async () => {
    const server = createDigitalEmployeeKnowledgeServer({
      knowledge: makeKnowledge(),
      localKnowledgeBaseId: 'de-emp-1'
    })
    const result = await server.callTool('de_knowledge_search', { query: '无关问题' })
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain('no matching knowledge')
  })

  it('degrades query failures to tool text so the session keeps running', async () => {
    const knowledge = { similarityQuery: vi.fn(async () => { throw new Error('index busy') }) }
    const server = createDigitalEmployeeKnowledgeServer({ knowledge, localKnowledgeBaseId: 'de-emp-1' })
    const result = await server.callTool('de_knowledge_search', { query: 'x' })
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain('knowledge query failed')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run --config vitest.config.ts test/main/digital-employee/knowledgeToolServer.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 最小实现**

实现前先读 `src/main/mcp/inMemoryServers/builtinKnowledgeServer.ts` 与同目录任一 server（如 `difyKnowledgeServer.ts`），确认 in-memory server 的接口形状（`listTools`/`callTool` 的确切签名与返回类型），以其为准调整下述骨架的类型；骨架逻辑不变：

```typescript
// src/main/digital-employee/knowledgeToolServer.ts
import type { KnowledgeSearchPort } from '@shared/types/knowledge'

/**
 * 每员工本地知识检索工具。与 staffdeck_* 远端工具对齐的思路：
 * 知识不该只在首问注入一次，模型在会话任何一轮都应该能主动查。
 * 服务端不可达或索引为空一律降级为工具文本，绝不抛错打断会话。
 */
export interface DigitalEmployeeKnowledgeServerDeps {
  knowledge: Pick<KnowledgeSearchPort, 'similarityQuery'>
  localKnowledgeBaseId: string
}

const EMPTY_NOTICE = 'no matching knowledge for this query'
const FAILURE_NOTICE = 'knowledge query failed; try again later'

export function createDigitalEmployeeKnowledgeServer(deps: DigitalEmployeeKnowledgeServerDeps) {
  return {
    name: 'de-kb',
    async listTools() {
      return [
        {
          name: 'de_knowledge_search',
          description:
            'Search this digital employee’s local knowledge base for relevant reference text. Use it whenever the user asks about policies, procedures, or facts the employee is expected to know.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query']
          }
        }
      ]
    },
    async callTool(_name: string, args: { query?: string }) {
      const query = (args.query ?? '').trim()
      if (query === '') {
        return { isError: false, content: [{ type: 'text', text: EMPTY_NOTICE }] }
      }
      try {
        const results = await deps.knowledge.similarityQuery(deps.localKnowledgeBaseId, query)
        const lines = results
          .slice(0, 5)
          .map((r, i) => `[${i + 1}] ${r.metadata?.content ?? ''}`.trim())
          .filter((l) => l.length > 4)
        return {
          isError: false,
          content: [{ type: 'text', text: lines.length > 0 ? lines.join('\n') : EMPTY_NOTICE }]
        }
      } catch {
        return { isError: false, content: [{ type: 'text', text: FAILURE_NOTICE }] }
      }
    }
  }
}
```

> 注意：`similarityQuery` 的确切签名以 `src/main/knowledge/routes.ts` 中现有调用为准（renderer 侧 `knowledgeClient.similarityQuery(baseId, question)` 已在 `digitalEmployeeStore.ts:341` 使用）；`QueryResult` 正文在 `metadata.content`（`src/shared/types/knowledge.ts`）。

- [ ] **Step 4: 测试通过**

Run: `pnpm vitest run --config vitest.config.ts test/main/digital-employee/knowledgeToolServer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit** `feat(digital-employee): add local knowledge tool server`

### Task 2: 工厂与命名接入

**Files:**
- Modify: `src/main/digital-employee/employeeScope.ts`（新增 `knowledgeServerNameForEmployee` / `isEmployeeKnowledgeServerName`，与 `mcpServerNameForEmployee` 并列）
- Modify: `src/main/mcp/inMemoryServers/builder.ts`（switch 新增 case）
- Modify: `src/main/app/composition.ts:1506` 附近（工厂依赖注入 `knowledgeService` —— 确认已注入，`BuiltinKnowledgeServer` 已用）
- Test: `test/main/digital-employee/employeeScope.test.ts`（追加用例）

- [ ] **Step 1: employeeScope 追加命名函数（先写测试）**

```typescript
it('names and recognizes the per-employee knowledge server', () => {
  expect(knowledgeServerNameForEmployee('emp-1')).toBe('deepchat-inmemory/de-kb-emp-1')
  expect(isEmployeeKnowledgeServerName('deepchat-inmemory/de-kb-emp-1')).toBe(true)
  expect(isEmployeeKnowledgeServerName('deepchat-inmemory/de-kb-other')).toBe(true)
  expect(isEmployeeKnowledgeServerName('de-emp-1')).toBe(false)
})
```

实现遵循 `employeeScope.ts` 中 `mcpServerNameForEmployee` 的既有命名规则（前缀/转义保持一致）。

- [ ] **Step 2: builder.ts 新增 case**

```typescript
case 'de-kb':
  return new DigitalEmployeeKnowledgeServer({
    knowledge: dependencies.knowledgeService,
    localKnowledgeBaseId: String(env?.localKnowledgeBaseId ?? '')
  })
```

`localKnowledgeBaseId` 为空时 server 必须仍可构造，所有调用返回 EMPTY_NOTICE（在 Task 1 实现里补一条守卫测试）。

- [ ] **Step 3: 测试通过 + Commit** `feat(mcp): register per-employee knowledge in-memory server`

### Task 3: provision 链路接入（幂等注册）

**Files:**
- Modify: `src/main/digital-employee/mcpRegistration.ts`（抽象出对 in-memory knowledge server 的注册，或新增 `knowledgeToolRegistration.ts` 采用同一幂等状态机：`NOT_CONFIGURED / NO_KNOWLEDGE / START_FAILED / REGISTER_FAILED`）
- Modify: `src/main/digital-employee/provisioning.ts`（chain 增加 `knowledgeTool`，仅 `employee.knowledgeBaseIds.length > 0` 且 `source() === 'http'` 时执行）
- Modify: `src/shared/contracts/routes/digitalEmployeeProvisioning.routes.ts`（output 增加 `knowledgeTool: z.object({ registered: z.boolean(), reason: z.string().optional() }).nullable().default(null)`）
- Modify: `src/main/digital-employee/provisioningRoutes.ts`（透传）
- Test: `test/main/digital-employee/provisioning.test.ts`、`provisioningRoutes.test.ts` 追加用例

要点：
- 注册名用 `knowledgeServerNameForEmployee(employeeId)`；`env` 携带 `{ localKnowledgeBaseId: 'de-' + employeeId }`（本地库 id 规则见 `knowledgeProvisioning.ts` 的建库命名，勿用服务端 `kb_*` id，原因见 `digitalEmployeeStore.ts:322-329` 注释）。
- 幂等：`addMcpServer` 已存在同名 server 时跳过写入（避免触发全量 MCP 重连，`mcpRegistration.ts:12-15` 已论证）。
- 员工没有配知识库（`knowledgeBaseIds` 为空）时返回 `registered: false, reason: 'NO_KNOWLEDGE'`，不算失败。
- 契约变更后跑 `pnpm test:main -- test/main/digital-employee` 与 `pnpm typecheck`。

- [ ] Commit: `feat(digital-employee): provision knowledge tool per employee`

### Task 4: 会话侧接入与白名单放行

**Files:**
- Modify: `src/renderer/src/stores/digitalEmployeeStore.ts`
  - `buildDisabledAgentTools`（L61-72）：白名单额外放行 `de_knowledge_search`（该工具名不在 `employee.tools` 中，现逻辑会把它 disable）：

```typescript
const whitelist = new Set([...employee.tools, DE_KNOWLEDGE_TOOL_NAME])
```

  - 本地会话创建（L294-372）：保留首问注入作为离线兜底，无需改动；确认 `disabledAgentTools` 计算发生在 provision 完成之后（`availableMcpToolNames` 已含新 server 工具）。
- Modify: `src/renderer/src/pages/digitalEmployee/*`：provision 后的降级 toast（`reportDegradedProvisioning`）把 `knowledgeTool.registered === false` 并入提示（复用 `failureReasons` 同款展示路径，i18n key：`digitalEmployee.provision.knowledgeToolUnavailable`，zh-CN/en-US 优先，其余 locale 走回退——与既有 `degraded*` 约定一致）。
- Test: `test/renderer/pages/digitalEmployee/DigitalEmployeeSquarePage.test.ts` 追加断言。

- [ ] Commit: `feat(digital-employee): allow knowledge tool in local sessions`

### Task 5: SOP 检索化 + 注入截断

**Files:**
- Modify: `src/main/digital-employee/knowledgeSync.ts`（同步员工时把 `sops` 一并写入概念缓存：`{cacheDir}/{localKnowledgeBaseId}/sops/{sanitized title}.md`，复用 `writeFileAtomic` 与 `sanitizeSegment`；内容变化（hash of title+content）时重写并 `reAddFile`）
- Modify: `src/renderer/src/stores/digitalEmployeeStore.ts` `buildDigitalEmployeeSystemPrompt`（L44-59）：每个 SOP 注入「标题 + 正文前 600 字符 + 截断标记」，并追加一行「完整 SOP 可用 de_knowledge_search 检索」：

```typescript
for (const sop of employee.sops) {
  const body = sop.content.length > 600 ? `${sop.content.slice(0, 600)}…（truncated）` : sop.content
  sections.push(`## SOP：${sop.title}\n${body}`)
}
```

- Test: `test/main/digital-employee/knowledgeSync.test.ts` 追加「sops written as retrievable concepts」「truncated prompt keeps title and marker」两条用例。

- [ ] Commit: `feat(digital-employee): make sops retrievable through knowledge tool`

### Task 6: 技能可观测性补齐（小）

**Files:**
- Modify: `src/renderer/settings/components/` 员工详情（OfficeAgent 设置页）：展示 provision 返回的 `skillNames` 与 `failureReasons`（数据契约已就绪，纯展示）。
- i18n: `digitalEmployee.service.installedSkills` / `digitalEmployee.service.skillInstallFailed`（zh-CN/en-US + 其余 locale 按仓库惯例回退）。

- [ ] Commit: `feat(digital-employee): show installed skills and failure reasons in settings`

---

## 2. 验证与交付

- 每任务：`pnpm vitest run --config vitest.config.ts test/main/digital-employee`（renderer 任务加 `--config vitest.config.renderer.ts test/renderer/pages/digitalEmployee test/renderer/settings`）
- 收尾：`pnpm format && pnpm lint && pnpm typecheck`（typecheck:web 若 OOM 用 `GOMEMLIMIT=1200MiB` 重试）；`pnpm i18n` 仅确认**无新增**缺键（存量红灯与本计划无关）
- 手工验收：真实 sd_* key + 开启服务端同步的员工 → 新建本地会话 → ①首问命中知识 ②追问一轮后要求模型「查一下知识库」→ 观察 `de_knowledge_search` 工具调用与命中 ③长 SOP 员工的 system prompt 不超预期长度（devtools 会话详情查看）

## 3. 风险与边界

- `listTools`/`callTool` 的接口形状需以 `builtinKnowledgeServer.ts` 实测为准（Task 1 Step 3 已内置校准步骤），不得凭空构造类型。
- per-employee in-memory server 数量随员工数增长：仅对 `knowledgeBaseIds` 非空的本地执行员工注册，员工删除/停用时 `unregister`（挂到既有 `mcpReconcile.ts` 的对账流程）。
- 远端模式（`executionMode === 'remote'`）不注册、不注入，维持服务端语义。
- mock 数据员工无 slug 技能属 mock 场景已知行为，不在本计划处理。
