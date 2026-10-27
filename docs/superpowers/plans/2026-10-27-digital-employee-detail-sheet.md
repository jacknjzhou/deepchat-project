# 数字员工详情 Sheet 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 广场页每张数字员工卡片可打开右侧只读 Sheet，展示 SOP 全文、知识库包级状态、技能（定义 + 安装状态）与工具（名单 + 就绪状态）；现有 Dialog 瘦身为纯「开始对话」弹层。

**Architecture:** 纯 renderer 侧改动，零新路由零 main 改动。新建独立 `DigitalEmployeeDetailSheet.vue`（props 驱动的展示组件，知识状态经 store 新增的只读方法按需拉取）；广场页卡片 click 开 Sheet、卡片显式按钮开瘦身 Dialog；provision 结果只读缓存、绝不触发 provision。

**Tech Stack:** Vue 3 `<script setup>` + TS、shadcn-vue Sheet 原语（`@shadcn/components/ui/sheet`，已存在）、vue-i18n、Vitest + Vue Test Utils。

**规格：** `docs/superpowers/specs/2026-10-27-digital-employee-detail-sheet-design.md`

**执行环境注意（Windows / PowerShell 5）：**
- 多命令用 `;` 连接；禁用 bash heredoc；git commit 用单引号内联消息。
- typecheck 若崩溃（tsgo 已知问题），先 `$env:GOMAXPROCS='2'` 再跑。
- 测试命令：`pnpm exec vitest run <path>`。

---

## 文件结构

| 操作 | 文件 | 职责 |
| --- | --- | --- |
| Create | `src/renderer/src/pages/digitalEmployee/DigitalEmployeeDetailSheet.vue` | 只读详情 Sheet，四分区展示 |
| Modify | `src/renderer/src/stores/digitalEmployeeStore.ts` | 新增只读 `listKnowledgePackages(employeeId)` |
| Modify | `src/renderer/src/pages/digitalEmployee/DigitalEmployeeSquarePage.vue` | 卡片 click 开 Sheet；卡片开始对话按钮；Dialog 瘦身 |
| Modify | `src/renderer/src/i18n/<20 locales>/digitalEmployee.json` | 新增 `detail.*` 13 个 key |
| Create | `test/renderer/pages/digitalEmployee/DigitalEmployeeDetailSheet.test.ts` | 组件测试 |
| Modify | `test/renderer/pages/digitalEmployee/DigitalEmployeeSquarePage.test.ts` | 接线断言更新 |

关键事实（执行者无需重查）：
- `DigitalEmployee` 契约字段：`id/name/role/description/avatar/capabilities/greeting/systemPrompt/sops{k,title|content}/knowledgeBaseIds/skillIds/tools/enabled/updatedAt/executionMode('local'|'remote'|'hybrid')/configHash?/skills?({id,name,slug?,downloadUrl})[]/knowledgePackagesUrl?`。
- `DigitalEmployeeProvisionResult`：`employeeId/skipped('NOT_LOCAL'|'DEGRADED'|'NOT_FOUND'|null)/toolsReady/knowledgeToolReady/installedSkills(number)/failedSkills[]/failureReasons(record)/skillNames[]/failures[]`。
- `KnowledgePackageStatus`：`knowledgeBaseId/stale/staleReason(string|null)/lastSyncAt(number)/conceptCount`。
- store 已有 `client.knowledgeStatus(employeeId)`（`loadKnowledgeStatus` 在用，但它只返回「最需要处理的一条」，详情视图需要全部包）。
- 页面现有 `provisionResults` 缓存 map 与 `detailProvisionResult` computed（remote `skipped !== null` 归 null）。
- i18n 已有可复用 key：`digitalEmployee.sectionSops/sectionSkills/sectionTools/sectionKnowledge/provision.installedSkills/startConversation/remote.badge/local.badge`。

---

### Task 1: store 只读方法 `listKnowledgePackages`

**Files:**
- Modify: `src/renderer/src/stores/digitalEmployeeStore.ts`

- [ ] **Step 1: 在 `loadKnowledgeStatus` 函数之后新增方法**

```ts
  /**
   * 详情视图用：读员工全部知识包状态（loadKnowledgeStatus 只挑「最需要处理
   * 的一条」，详情页要的是全量清单）。失败返回空数组：知识状态是展示性的
   * 信息，不该打断详情查看。
   */
  async function listKnowledgePackages(employeeId: string): Promise<KnowledgePackageStatus[]> {
    try {
      return (await client.knowledgeStatus(employeeId)).packages
    } catch {
      return []
    }
  }
```

- [ ] **Step 2: 在 store 的 return 对象里，紧挨 `loadKnowledgeStatus` 导出项加一行**

```ts
    listKnowledgePackages,
```

- [ ] **Step 3: 确认类型已有导入**

`KnowledgePackageStatus` 已在文件头部 `import type { KnowledgePackageStatus } from '@shared/contracts/routes'`（`loadKnowledgeStatus` 在用），无需新增 import。

- [ ] **Step 4: 运行既有 store 套件确认无回归**

Run: `pnpm exec vitest run test/renderer/stores/digitalEmployeeStore.test.ts`
Expected: PASS（纯新增，无既有断言受影响）

- [ ] **Step 5: Commit**

```powershell
git add src/renderer/src/stores/digitalEmployeeStore.ts; git commit -m 'feat(digital-employee): list knowledge packages api'
```

---

### Task 2: `DigitalEmployeeDetailSheet.vue` 组件（TDD）

**Files:**
- Test (create first): `test/renderer/pages/digitalEmployee/DigitalEmployeeDetailSheet.test.ts`
- Create: `src/renderer/src/pages/digitalEmployee/DigitalEmployeeDetailSheet.vue`

- [ ] **Step 1: 写失败测试（完整文件）**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, reactive } from 'vue'
import type {
  DigitalEmployee,
  DigitalEmployeeProvisionResult
} from '../../../../src/shared/contracts/routes'

const makeEmployee = (overrides: Partial<DigitalEmployee> = {}): DigitalEmployee => ({
  id: 'emp-1',
  name: '文案写手',
  role: '写手',
  description: '擅长文案创作',
  avatar: null,
  capabilities: ['文案写作', '内容策划'],
  greeting: null,
  systemPrompt: '你是文案写手',
  sops: [{ title: '公众号写作SOP', content: '步骤' }],
  knowledgeBaseIds: ['kb-1'],
  skillIds: ['skill-write'],
  tools: ['browser'],
  enabled: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides
})

const makeProvisionResult = (
  overrides: Partial<DigitalEmployeeProvisionResult> = {}
): DigitalEmployeeProvisionResult => ({
  employeeId: 'emp-1',
  skipped: null,
  toolsReady: true,
  knowledgeToolReady: true,
  installedSkills: 1,
  failedSkills: [],
  failureReasons: {},
  skillNames: ['emp-1:skill-write'],
  failures: [],
  ...overrides
})

const stubStore = reactive({
  listKnowledgePackages: vi.fn(async () => []),
  provisionEmployee: vi.fn(async () => null)
})

const slotStub = (name: string) =>
  defineComponent({ name, template: '<div><slot /></div>' })

async function setup(options: {
  employee: DigitalEmployee | null
  provisionResult?: DigitalEmployeeProvisionResult | null
  open?: boolean
}) {
  vi.resetModules()
  stubStore.listKnowledgePackages.mockClear()
  stubStore.provisionEmployee.mockClear()
  vi.doMock('@/stores/digitalEmployeeStore', () => ({
    useDigitalEmployeeStore: () => stubStore
  }))
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key
    })
  }))
  const DigitalEmployeeDetailSheet = (
    await import(
      '../../../../src/renderer/src/pages/digitalEmployee/DigitalEmployeeDetailSheet.vue'
    )
  ).default
  const wrapper = mount(DigitalEmployeeDetailSheet, {
    props: {
      employee: options.employee,
      provisionResult: options.provisionResult ?? null,
      open: options.open ?? true
    },
    global: {
      stubs: {
        Sheet: slotStub('SheetStub'),
        SheetContent: slotStub('SheetContentStub'),
        SheetHeader: slotStub('SheetHeaderStub'),
        SheetTitle: slotStub('SheetTitleStub'),
        SheetDescription: slotStub('SheetDescriptionStub')
      }
    }
  })
  await flushPromises()
  return { wrapper }
}

describe('DigitalEmployeeDetailSheet', () => {
  beforeEach(() => {
    stubStore.listKnowledgePackages.mockResolvedValue([])
  })

  it('renders all four sections for a fully configured employee', async () => {
    const { wrapper } = await setup({
      employee: makeEmployee({
        skills: [{ id: 'skill-write', name: '写作技能', downloadUrl: 'https://x/skill' }]
      }),
      provisionResult: makeProvisionResult()
    })
    expect(wrapper.find('[data-testid="detail-overview"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-sops"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-knowledge"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-skills"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-tools"]').exists()).toBe(true)
    // 技能：服务端明细 + 本地安装状态
    expect(wrapper.text()).toContain('写作技能')
    expect(wrapper.text()).toContain('emp-1:skill-write')
    // 工具：名单 + 就绪徽标
    expect(wrapper.text()).toContain('browser')
    expect(wrapper.text()).toContain('digitalEmployee.detail.toolsReady')
    expect(wrapper.text()).toContain('digitalEmployee.detail.knowledgeToolReady')
  })

  it('shows SOP full content without the 600-char prompt truncation', async () => {
    const longContent = 'x'.repeat(700)
    const { wrapper } = await setup({
      employee: makeEmployee({ sops: [{ title: '长SOP', content: longContent }] })
    })
    expect(wrapper.find('[data-testid="detail-sop-content-长SOP"]').text()).toBe(longContent)
  })

  it('renders knowledge package status cards', async () => {
    stubStore.listKnowledgePackages.mockResolvedValue([
      { knowledgeBaseId: 'kb-1', stale: false, staleReason: null, lastSyncAt: 1000, conceptCount: 5 },
      {
        knowledgeBaseId: 'kb-2',
        stale: true,
        staleReason: 'NO_EMBEDDING_MODEL',
        lastSyncAt: 0,
        conceptCount: 0
      }
    ])
    const { wrapper } = await setup({ employee: makeEmployee() })
    expect(stubStore.listKnowledgePackages).toHaveBeenCalledWith('emp-1')
    expect(wrapper.find('[data-testid="detail-knowledge-kb-1"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('digitalEmployee.detail.knowledgeFresh')
    expect(wrapper.text()).toContain(
      'digitalEmployee.detail.knowledgeStale:{"reason":"NO_EMBEDDING_MODEL"}'
    )
    expect(wrapper.text()).toContain('digitalEmployee.detail.knowledgeMeta:')
  })

  it('shows the unavailable placeholder when status fetch yields nothing', async () => {
    const { wrapper } = await setup({ employee: makeEmployee() })
    expect(wrapper.find('[data-testid="detail-knowledge-unavailable"]').exists()).toBe(true)
  })

  it('shows empty-state copy for unconfigured sections', async () => {
    const { wrapper } = await setup({
      employee: makeEmployee({ sops: [], knowledgeBaseIds: [], tools: [], skillIds: [] })
    })
    expect(wrapper.text()).toContain('digitalEmployee.detail.emptySops')
    expect(wrapper.text()).toContain('digitalEmployee.detail.emptyKnowledge')
    expect(wrapper.text()).toContain('digitalEmployee.detail.emptySkills')
    expect(wrapper.text()).toContain('digitalEmployee.detail.emptyTools')
    // 未绑定知识库时不发状态请求
    expect(stubStore.listKnowledgePackages).not.toHaveBeenCalled()
  })

  it('shows the not-provisioned hint for local employees only', async () => {
    const local = await setup({ employee: makeEmployee(), provisionResult: null })
    expect(local.wrapper.find('[data-testid="detail-not-provisioned"]').exists()).toBe(true)

    const remote = await setup({
      employee: makeEmployee({ id: 'emp-2', executionMode: 'remote' }),
      provisionResult: null
    })
    expect(remote.wrapper.find('[data-testid="detail-not-provisioned"]').exists()).toBe(false)
  })

  it('lists failed skills with reasons', async () => {
    const { wrapper } = await setup({
      employee: makeEmployee(),
      provisionResult: makeProvisionResult({
        failedSkills: ['skill-broken'],
        failureReasons: { 'skill-broken': 'HTTP 401' }
      })
    })
    expect(wrapper.find('[data-testid="detail-failed-skills"]').text()).toContain('skill-broken')
    expect(wrapper.find('[data-testid="detail-failed-skills"]').text()).toContain('HTTP 401')
  })

  it('is read-only: no inputs and provisioning is never triggered', async () => {
    const { wrapper } = await setup({
      employee: makeEmployee(),
      provisionResult: makeProvisionResult()
    })
    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.find('button').exists()).toBe(false)
    expect(stubStore.provisionEmployee).not.toHaveBeenCalled()
  })

  it('does not render content when closed', async () => {
    const { wrapper } = await setup({ employee: makeEmployee(), open: false })
    expect(wrapper.find('[data-testid="detail-sops"]').exists()).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run test/renderer/pages/digitalEmployee/DigitalEmployeeDetailSheet.test.ts`
Expected: FAIL（组件文件不存在，import 失败）

- [ ] **Step 3: 创建组件（完整文件）**

```vue
<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent
      v-if="employee"
      side="right"
      class="w-[440px] overflow-y-auto sm:max-w-[440px]"
      data-testid="digital-employee-detail-sheet"
    >
      <SheetHeader>
        <SheetTitle>{{ employee.name }} · {{ employee.role }}</SheetTitle>
        <SheetDescription>{{ employee.description }}</SheetDescription>
      </SheetHeader>
      <div class="space-y-5 text-sm">
        <!-- 概要：执行模式 + 能力标签 + 未初始化提示 -->
        <section data-testid="detail-overview" class="space-y-2">
          <div class="flex flex-wrap items-center gap-1.5">
            <span
              class="rounded px-1.5 py-0.5 text-[10px] font-medium"
              :class="
                employee.executionMode === 'remote'
                  ? 'bg-emerald-500/10 text-emerald-600'
                  : 'bg-muted text-muted-foreground'
              "
              >{{
                employee.executionMode === 'remote'
                  ? t('digitalEmployee.remote.badge')
                  : t('digitalEmployee.local.badge')
              }}</span
            >
            <span
              v-for="capability in employee.capabilities"
              :key="capability"
              class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >{{ capability }}</span
            >
          </div>
          <p
            v-if="showNotProvisioned"
            class="text-xs text-muted-foreground"
            data-testid="detail-not-provisioned"
          >
            {{ t('digitalEmployee.detail.notProvisioned') }}
          </p>
        </section>

        <!-- SOP：全文折叠列表（不受执行链路 600 字截断限制，那是提示词注入的事） -->
        <section data-testid="detail-sops" class="space-y-2">
          <h3 class="text-xs font-semibold text-muted-foreground">
            {{ t('digitalEmployee.sectionSops') }}
          </h3>
          <p v-if="employee.sops.length === 0" class="text-xs text-muted-foreground">
            {{ t('digitalEmployee.detail.emptySops') }}
          </p>
          <details
            v-for="sop in employee.sops"
            :key="sop.title"
            class="rounded-md border border-border/60 p-2"
          >
            <summary class="cursor-pointer text-xs font-medium">{{ sop.title }}</summary>
            <p
              class="mt-1 whitespace-pre-wrap text-xs text-muted-foreground"
              :data-testid="`detail-sop-content-${sop.title}`"
            >
              {{ sop.content }}
            </p>
          </details>
        </section>

        <!-- 知识库：包级状态卡 -->
        <section data-testid="detail-knowledge" class="space-y-2">
          <h3 class="text-xs font-semibold text-muted-foreground">
            {{ t('digitalEmployee.sectionKnowledge') }}
          </h3>
          <p v-if="employee.knowledgeBaseIds.length === 0" class="text-xs text-muted-foreground">
            {{ t('digitalEmployee.detail.emptyKnowledge') }}
          </p>
          <p
            v-else-if="knowledgePackages.length === 0"
            class="text-xs text-muted-foreground"
            data-testid="detail-knowledge-unavailable"
          >
            {{ t('digitalEmployee.detail.knowledgeUnavailable') }}
          </p>
          <template v-else>
            <div
              v-for="pkg in knowledgePackages"
              :key="pkg.knowledgeBaseId"
              class="rounded-md border border-border/60 p-2 text-xs"
              :data-testid="`detail-knowledge-${pkg.knowledgeBaseId}`"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="truncate font-medium">{{ pkg.knowledgeBaseId }}</span>
                <span
                  class="shrink-0"
                  :class="pkg.stale ? 'text-amber-600' : 'text-emerald-600'"
                  data-testid="detail-knowledge-badge"
                >
                  {{
                    pkg.stale
                      ? t('digitalEmployee.detail.knowledgeStale', { reason: pkg.staleReason ?? '-' })
                      : t('digitalEmployee.detail.knowledgeFresh')
                  }}
                </span>
              </div>
              <p class="mt-1 text-muted-foreground">
                {{
                  t('digitalEmployee.detail.knowledgeMeta', {
                    count: pkg.conceptCount,
                    time: formatSyncTime(pkg.lastSyncAt)
                  })
                }}
              </p>
            </div>
          </template>
        </section>

        <!-- 技能：服务端定义（有明细展示名称，无明细回退 id）+ 本地安装状态 -->
        <section data-testid="detail-skills" class="space-y-2">
          <h3 class="text-xs font-semibold text-muted-foreground">
            {{ t('digitalEmployee.sectionSkills') }}
          </h3>
          <p v-if="employee.skillIds.length === 0" class="text-xs text-muted-foreground">
            {{ t('digitalEmployee.detail.emptySkills') }}
          </p>
          <ul v-else class="space-y-1 text-xs">
            <li
              v-for="skill in employee.skills ?? []"
              :key="`detail-${skill.id}`"
              class="flex items-center justify-between gap-2"
            >
              <span class="truncate">{{ skill.name }}</span>
              <span class="shrink-0 text-muted-foreground">{{ skill.id }}</span>
            </li>
            <li v-for="id in skillIdsWithoutDetail" :key="id" class="truncate">{{ id }}</li>
          </ul>
          <p
            v-if="provisionResult?.skillNames.length"
            class="text-xs text-emerald-600"
            data-testid="detail-installed-skills"
          >
            {{
              t('digitalEmployee.provision.installedSkills', {
                skills: provisionResult.skillNames.join('、')
              })
            }}
          </p>
          <ul
            v-if="provisionResult?.failedSkills.length"
            class="list-disc space-y-1 pl-4 text-xs text-destructive"
            data-testid="detail-failed-skills"
          >
            <li v-for="slug in provisionResult.failedSkills" :key="slug">
              {{ slug }}：{{ provisionResult.failureReasons[slug] ?? '' }}
            </li>
          </ul>
        </section>

        <!-- 工具：名单 + provision 就绪状态 -->
        <section data-testid="detail-tools" class="space-y-2">
          <h3 class="text-xs font-semibold text-muted-foreground">
            {{ t('digitalEmployee.sectionTools') }}
          </h3>
          <p v-if="employee.tools.length === 0" class="text-xs text-muted-foreground">
            {{ t('digitalEmployee.detail.emptyTools') }}
          </p>
          <ul v-else class="space-y-1 text-xs">
            <li v-for="tool in employee.tools" :key="tool" class="truncate">{{ tool }}</li>
          </ul>
          <div
            v-if="provisionResult"
            class="flex flex-wrap gap-3 text-xs"
            data-testid="detail-tool-readiness"
          >
            <span :class="provisionResult.toolsReady ? 'text-emerald-600' : 'text-destructive'">
              {{
                t(
                  provisionResult.toolsReady
                    ? 'digitalEmployee.detail.toolsReady'
                    : 'digitalEmployee.detail.toolsNotReady'
                )
              }}
            </span>
            <span
              v-if="employee.knowledgeBaseIds.length > 0"
              :class="provisionResult.knowledgeToolReady ? 'text-emerald-600' : 'text-destructive'"
            >
              {{
                t(
                  provisionResult.knowledgeToolReady
                    ? 'digitalEmployee.detail.knowledgeToolReady'
                    : 'digitalEmployee.detail.knowledgeToolNotReady'
                )
              }}
            </span>
          </div>
        </section>
      </div>
    </SheetContent>
  </Sheet>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@shadcn/components/ui/sheet'
import { useDigitalEmployeeStore } from '@/stores/digitalEmployeeStore'
import type { DigitalEmployeeProvisionResult } from '@shared/contracts/routes'
import type { DigitalEmployee, KnowledgePackageStatus } from '@shared/contracts/routes'

const props = defineProps<{
  employee: DigitalEmployee | null
  provisionResult: DigitalEmployeeProvisionResult | null
  open: boolean
}>()

const emit = defineEmits<{ (event: 'update:open', value: boolean): void }>()

const { t } = useI18n()
const store = useDigitalEmployeeStore()

const knowledgePackages = ref<KnowledgePackageStatus[]>([])

/**
 * 只读视图：打开时按需拉一次知识包状态，员工切换时重拉。
 * 结果回来时若员工已切换则直接丢弃，避免串显上一家的数据。
 * 绝不触发 provision——那是有副作用的准备动作，只读详情不代用户执行。
 */
watch(
  () => [props.open, props.employee?.id] as const,
  async ([open, id]) => {
    if (!open || !props.employee || !id) return
    const packages = await store.listKnowledgePackages(id)
    if (props.employee.id !== id) return
    knowledgePackages.value = packages
  },
  { immediate: true }
)

const skillDetailIds = computed(
  () => new Set((props.employee?.skills ?? []).map((skill) => skill.id))
)
const skillIdsWithoutDetail = computed(() =>
  (props.employee?.skillIds ?? []).filter((id) => !skillDetailIds.value.has(id))
)

// remote 员工本来就不在本地准备，「未初始化」提示只对本地员工有意义。
const showNotProvisioned = computed(
  () =>
    props.employee !== null &&
    props.employee.executionMode !== 'remote' &&
    props.provisionResult === null
)

const formatSyncTime = (lastSyncAt: number | null | undefined): string =>
  !lastSyncAt ? '—' : new Date(lastSyncAt).toLocaleString()
</script>
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run test/renderer/pages/digitalEmployee/DigitalEmployeeDetailSheet.test.ts`
Expected: PASS（9 用例）

- [ ] **Step 5: Commit**

```powershell
git add src/renderer/src/pages/digitalEmployee/DigitalEmployeeDetailSheet.vue test/renderer/pages/digitalEmployee/DigitalEmployeeDetailSheet.test.ts; git commit -m 'feat(digital-employee): read-only detail sheet'
```

---

### Task 3: 广场页接线 + Dialog 瘦身

**Files:**
- Modify: `src/renderer/src/pages/digitalEmployee/DigitalEmployeeSquarePage.vue`
- Modify: `test/renderer/pages/digitalEmployee/DigitalEmployeeSquarePage.test.ts`

- [ ] **Step 1: 更新页面测试（先改断言，跑出失败基线）**

1. `stubStore` 增加一行（`startConversation` 之后）：

```ts
  listKnowledgePackages: vi.fn(async () => [])
```

2. `setup()` 的 `global.stubs` 增加 Sheet 桩（紧跟 DialogDescription 桩之后）：

```ts
        Sheet: slotStub,
        SheetContent: slotStub,
        SheetHeader: slotStub,
        SheetTitle: slotStub,
        SheetDescription: slotStub
```

文件顶部补一个通用桩定义（`dcEmptyStub` 之后）：

```ts
const slotStub = defineComponent({ name: 'SlotStub', template: '<div><slot /></div>' })
```

3. 新增两个接线用例（describe 内追加）：

```ts
  it('opens the read-only detail sheet from the card click', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="digital-employee-card-emp-1"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="digital-employee-detail-sheet"]').exists()).toBe(true)
    // 纯只读：Sheet 打开不等于对话入口
    expect(wrapper.find('[data-testid="digital-employee-opening-question"]').exists()).toBe(false)
    // 详情内容进了 Sheet，Dialog 不再重复能力罗列
    expect(wrapper.text()).toContain('digitalEmployee.sectionSops')
  })

  it('opens the slim start dialog only from the card start button', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-testid="digital-employee-start-emp-1"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="digital-employee-detail-dialog"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="digital-employee-opening-question"]').exists()).toBe(true)
    // 瘦身后 Dialog 不含能力罗列
    expect(wrapper.text()).not.toContain('digitalEmployee.sectionSops')
  })
```

4. 既有用例断言映射（跑套件后逐条按此调整）：
   - `卡片 click → Dialog` 类断言：改为卡片 click 开 Sheet；对话入口改走 `digital-employee-start-emp-1` 按钮。
   - `digital-employee-provision-result` 出现在 Dialog 的断言：该 testid 已随瘦身移除，provision 展示断言已迁至 DetailSheet 组件测试（`detail-installed-skills` / `detail-failed-skills` / `detail-tool-readiness`）。
   - Dialog 内 `sectionSops/sectionSkills/sectionTools/sectionKnowledge` 文案断言：改为 `not.toContain`。

- [ ] **Step 2: 运行页面测试确认失败**

Run: `pnpm exec vitest run test/renderer/pages/digitalEmployee/DigitalEmployeeSquarePage.test.ts`
Expected: FAIL（页面尚无 Sheet 与开始按钮）

- [ ] **Step 3: 修改页面脚本**

`script setup` 三处改动：

1. import 区（`useDigitalEmployeeStore` 导入行之后）加：

```ts
import DigitalEmployeeDetailSheet from './DigitalEmployeeDetailSheet.vue'
```

2. 状态区（`detailEmployee` 定义之后）加：

```ts
// 详情 Sheet 与对话弹层分离：卡片点击看详情，卡片上的对话按钮才开对话。
const sheetEmployee = ref<DigitalEmployee | null>(null)
```

3. `openDetail` 与 `detailProvisionResult` 整体替换为：

```ts
/** 每员工最近一次本地准备结果；remote（skipped）与未准备都归一为 null。 */
const provisionResultFor = (id: string | null | undefined) => {
  if (!id) return null
  const result = provisionResults.value[id] ?? null
  // remote 员工本地不准备，`skipped` 不携带任何本地能力信息。
  if (!result || result.skipped !== null) return null
  return result
}

const openSheet = (employee: DigitalEmployee) => {
  sheetEmployee.value = employee
}

const openStartDialog = (employee: DigitalEmployee) => {
  detailEmployee.value = employee
  openingQuestion.value = ''
}

const sheetProvisionResult = computed(() => provisionResultFor(sheetEmployee.value?.id))
```

- [ ] **Step 4: 修改页面模板**

1. 卡片根元素 `@click="openDetail(employee)"` 改为 `@click="openSheet(employee)"`。
2. 卡片头部收藏星标 `<span role="button" ... data-testid="digital-employee-favorite-...">` 之后追加开始对话按钮：

```vue
            <span
              role="button"
              tabindex="0"
              class="ml-1 shrink-0 cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              :data-testid="`digital-employee-start-${employee.id}`"
              :title="t('digitalEmployee.startConversation')"
              @click.stop="openStartDialog(employee)"
              @keydown.enter.stop="openStartDialog(employee)"
            >
              <Icon icon="lucide:message-circle" class="size-4" />
            </span>
```

3. Dialog 瘦身：删除整个能力罗列容器 `<div class="max-h-[50vh] space-y-3 overflow-y-auto text-sm">`…`</div>`（内含 sectionSops / sectionSkills / provision-result / sectionTools / sectionKnowledge 五个 section），保留 DialogHeader 与底部开场问题输入 + 开始按钮。
4. 模板末尾（`</Dialog>` 之后、根元素闭合之前）挂载 Sheet：

```vue
    <!-- 详情 Sheet：纯只读，开始对话走卡片按钮 + 上面的瘦身 Dialog -->
    <DigitalEmployeeDetailSheet
      :employee="sheetEmployee"
      :provision-result="sheetProvisionResult"
      :open="sheetEmployee !== null"
      @update:open="
        (open: boolean) => {
          if (!open) sheetEmployee = null
        }
      "
    />
```

- [ ] **Step 5: 运行页面测试确认通过**

Run: `pnpm exec vitest run test/renderer/pages/digitalEmployee/DigitalEmployeeSquarePage.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```powershell
git add src/renderer/src/pages/digitalEmployee/DigitalEmployeeSquarePage.vue test/renderer/pages/digitalEmployee/DigitalEmployeeSquarePage.test.ts; git commit -m 'feat(digital-employee): wire detail sheet into square'
```

---

### Task 4: i18n（20 locales）

**Files:**
- Modify: `src/renderer/src/i18n/<locale>/digitalEmployee.json` —— 共 20 个：da-DK, de-DE, en-US, es-ES, fa-IR, fr-FR, he-IL, id-ID, it-IT, ja-JP, ko-KR, ms-MY, pl-PL, pt-BR, ru-RU, tr-TR, vi-VN, zh-CN, zh-HK, zh-TW

- [ ] **Step 1: en-US 的 `digitalEmployee.json` 增加块（放在 `sectionKnowledge` 同级之后）**

```json
  "detail": {
    "emptySops": "No SOPs configured",
    "emptySkills": "No skills configured",
    "emptyTools": "No tools configured",
    "emptyKnowledge": "No knowledge bases bound",
    "knowledgeUnavailable": "Knowledge status unavailable or not synced yet",
    "knowledgeFresh": "Up to date",
    "knowledgeStale": "Stale ({reason})",
    "knowledgeMeta": "{count} concepts · last synced {time}",
    "notProvisioned": "Local capabilities are not ready yet; they will be prepared automatically when you start a conversation.",
    "toolsReady": "Tools ready",
    "toolsNotReady": "Tools unavailable",
    "knowledgeToolReady": "Knowledge search ready",
    "knowledgeToolNotReady": "Knowledge search unavailable"
  },
```

- [ ] **Step 2: zh-CN 使用中文文案**

```json
  "detail": {
    "emptySops": "未配置 SOP",
    "emptySkills": "未配置技能",
    "emptyTools": "未配置工具",
    "emptyKnowledge": "未绑定知识库",
    "knowledgeUnavailable": "知识状态不可用或尚未同步",
    "knowledgeFresh": "已同步",
    "knowledgeStale": "已过期（{reason}）",
    "knowledgeMeta": "{count} 个概念 · 最近同步 {time}",
    "notProvisioned": "本地能力尚未就绪，开始对话后会自动准备。",
    "toolsReady": "工具就绪",
    "toolsNotReady": "工具不可用",
    "knowledgeToolReady": "知识检索就绪",
    "knowledgeToolNotReady": "知识检索不可用"
  },
```

- [ ] **Step 3: 其余 18 个 locale**

`zh-HK`/`zh-TW` 参照 zh-CN 改为繁体；其余 16 个 locale 暂镜像 en-US 文案（与仓库现行 fallback 一致，后续翻译批次统一处理）。

- [ ] **Step 4: 验证 i18n 完整性检查脚本（若存在）**

Run: `pnpm exec vitest run test/renderer/i18n` （目录不存在则跳过此步，由 Task 5 全量验证兜底）
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/renderer/src/i18n; git commit -m 'i18n(digital-employee): detail sheet copy'
```

---

### Task 5: 全量验证 + 收尾

- [ ] **Step 1: 格式化**

Run: `pnpm oxfmt` （若脚本名不同，用 `pnpm format`）
Expected: 仅触碰本计划涉及的文件

- [ ] **Step 2: 类型检查**

Run: `$env:GOMAXPROCS='2'; pnpm typecheck`
Expected: PASS；崩溃重试需先设 GOMAXPROCS

- [ ] **Step 3: 相关测试套件**

Run: `pnpm exec vitest run test/renderer/pages/digitalEmployee test/renderer/stores/digitalEmployeeStore.test.ts`
Expected: 全部 PASS

- [ ] **Step 4: 实机冒烟（可选但推荐）**

`pnpm dev` 启动 → 设置页开总开关 → 广场页：卡片点击开 Sheet（四分区内容正确、关闭正常）；卡片对话按钮开瘦身 Dialog；开始对话链路不变。

- [ ] **Step 5: 若有遗留改动，按文件分主题提交；确认 `git status` 干净**

```powershell
git status --short
```
