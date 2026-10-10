# 报销整理全宽虚拟树视图 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 报销整理视图从「aside 类别列表 + 选择式浏览」重构为全宽虚拟滚动树（报销类型 → 人员 → 年月 → 条目）一屏展开，保留条目内下拉人工归类，数据层零变更。

**Architecture:** `ReimbursementView.vue` 重写为容器（工具条 + 加载/错误/空态 + move 事件转发）；新建 `ReimbursementTree.vue` 纯展示递归树（flatten 可见行 + `vue-virtual-scroller` 的 RecycleScroller，`:item-size="null" :min-item-size="40"`，镜像 `ProviderModelList.vue:207-210` 惯例）。store/IPC/归类纯函数/导出逻辑零变更。

**Tech Stack:** Vue 3 + pinia + vue-i18n + vue-virtual-scroller（既有依赖）+ Vitest/@vue/test-utils。

**Spec:** `docs/superpowers/specs/2026-10-10-reimbursement-tree-view-redesign.md`

**执行注意（本机教训）：**
- 同一文件多次编辑必须串行；每文件写完跑 `git diff --text -- <file>` 确认无 NUL/截断。
- Oxfmt：单引号、无分号、100 列。PowerShell 5 多命令用 `;` 不用 `&&`。
- 渲染端测试：`pnpm exec vitest run <files>`（不要全量跑 renderer stores）。
- Conventional Commits ≤50 字符、无 AI 署名、只 add 任务列出的文件。
- jsdom 无真实尺寸：所有涉及 RecycleScroller 的测试必须用 stub（渲染全部 items 并透传 scoped slot），见 Task 1 Step 1。

**数据契约（已核对 `src/shared/contracts/routes/documents.routes.ts`）：**
- Entry：`{ id, typeKey, templateName, person: string|null, period: string|null, amount: number|null, amountUncertain, uncertainCount, fileNames: string[], isOverride }`
- Bucket：`{ period: string|null, documents: Entry[] }`；Group：`{ person: string|null, buckets: Bucket[] }`
- CategoryNode：`{ category: {id, name, requiredMaterials, linkedTypeKeys, sortOrder}, total, materials: {name, linkedTypeKeys, count}[], groups: Group[] }`
- 类型经 `import type { z } from 'zod'` + `z.infer<typeof reimbursementCategoryNodeSchema | reimbursementGroupSchema | reimbursementDocumentEntrySchema>`，schema 均从 `@shared/contracts/routes` 可导入（routes.ts:708 `export *`）。

---

### Task 1: ReimbursementTree 树组件（TDD）

**Files:**
- Create: `src/renderer/src/pages/documents/ReimbursementTree.vue`
- Test (Create): `test/renderer/components/ReimbursementTree.test.ts`

DOM 约定（Task 2 依赖，必须严格一致）：
- 折叠按钮：`[data-testid="reimbursement-toggle-<rowKey>"]`（category/person/period 行头整体可点）
- 材料按钮：`[data-testid="reimbursement-materials-<categoryId>"]`（仅类别节点有）
- 条目行：`[data-testid="reimbursement-entry-<documentId>"]`（与现视图一致，内含 select）
- 行 key 规则：类别 `cat:<id>`；未分类根 `unassigned`；人员 `<parent>:p:<person ?? 'unknown'>`；年月 `<parent>:b:<period ?? 'unknown'>`；条目 `<periodKey>:d:<id>`；材料行 `mat:<id>`。
- select 值语义：`entry.isOverride ? (所在类别 id ?? '__unassigned__') : '__auto__'`；`@change` emit `move(documentId, value)`。

- [ ] **Step 1: 写失败测试**

```ts
// test/renderer/components/ReimbursementTree.test.ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import ReimbursementTree from '../../../../src/renderer/src/pages/documents/ReimbursementTree.vue'

const dcBadgeStub = defineComponent({
  name: 'DcBadgeStub',
  props: ['variant'],
  template: '<span><slot /></span>'
})

// jsdom has no layout: render all items and forward the scoped slot.
const recycleScrollerStub = defineComponent({
  name: 'RecycleScrollerStub',
  props: { items: { type: Array, default: () => [] }, itemSize: { type: null }, minItemSize: { type: Number } },
  template: `
    <div>
      <div v-for="(item, index) in items" :key="item.key">
        <slot :item="item" :index="index" />
      </div>
    </div>
  `
})

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    typeKey: 'meeting_minutes',
    templateName: '会议纪要',
    person: '张三',
    period: '2026-09',
    amount: 100,
    amountUncertain: false,
    uncertainCount: 0,
    fileNames: ['a.pdf'],
    isOverride: false,
    ...overrides
  }
}

function makeProps(unassigned = []) {
  return {
    tree: [
      {
        category: {
          id: 'cat-a',
          name: '会议费',
          requiredMaterials: [],
          linkedTypeKeys: [],
          sortOrder: 1
        },
        total: 1,
        materials: [{ name: '发票', linkedTypeKeys: ['invoice'], count: 2 }],
        groups: [
          {
            person: '张三',
            buckets: [{ period: '2026-09', documents: [entry()] }]
          }
        ]
      }
    ],
    unassigned
  }
}

function mountTree(props: Record<string, unknown> = {}) {
  return mount(ReimbursementTree, {
    props: { ...makeProps(), ...props },
    global: {
      stubs: { DcBadge: dcBadgeStub, Icon: true, RecycleScroller: recycleScrollerStub }
    }
  })
}

describe('ReimbursementTree', () => {
  it('renders category, person, period and entry rows with counts', () => {
    const wrapper = mountTree()
    expect(wrapper.text()).toContain('会议费')
    expect(wrapper.text()).toContain('张三')
    expect(wrapper.text()).toContain('2026-09')
    expect(wrapper.text()).toContain('a.pdf')
    expect(wrapper.find('[data-testid="reimbursement-toggle-cat:cat-a"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="reimbursement-toggle-unassigned"]').exists()).toBe(true)
  })

  it('collapsing a category hides its descendants but keeps the header', async () => {
    const wrapper = mountTree()
    await wrapper.get('[data-testid="reimbursement-toggle-cat:cat-a"]').trigger('click')
    expect(wrapper.text()).not.toContain('张三')
    expect(wrapper.text()).not.toContain('a.pdf')
    expect(wrapper.text()).toContain('会议费')
  })

  it('renders the unassigned group last without a materials button', () => {
    const wrapper = mountTree()
    const buttons = wrapper.findAll('[data-testid^="reimbursement-materials-"]')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].attributes('data-testid')).toBe('reimbursement-materials-cat-a')
    expect(wrapper.find('[data-testid="reimbursement-toggle-unassigned"]').exists()).toBe(true)
  })

  it('toggles the materials row under a category node', async () => {
    const wrapper = mountTree()
    expect(wrapper.text()).not.toContain('发票')
    await wrapper.get('[data-testid="reimbursement-materials-cat-a"]').trigger('click')
    expect(wrapper.text()).toContain('发票')
  })

  it('emits move with the selected category id from an entry select', async () => {
    const wrapper = mountTree()
    await wrapper.get('[data-testid="reimbursement-entry-d1"] select').setValue('cat-a')
    expect(wrapper.emitted('move')?.at(-1)).toEqual(['d1', 'cat-a'])
  })

  it('mirrors the owning category for overrides and the sentinel in unassigned', () => {
    const wrapper = mountTree({
      unassigned: [
        {
          person: '李四',
          buckets: [
            {
              period: '2026-09',
              documents: [
                entry({ id: 'd1', person: '李四', isOverride: true }),
                entry({ id: 'd2', person: '李四', isOverride: false })
              ]
            }
          ]
        }
      ]
    })
    const overrideSelect = wrapper.get('[data-testid="reimbursement-entry-d1"] select')
    expect((overrideSelect.element as HTMLSelectElement).value).toBe('cat-a')
    const unassignedOverride = wrapper.get('[data-testid="reimbursement-entry-d1"] select')
    // d1 in the category branch mirrors cat-a; the unassigned branch entries are
    // d1/d2 too — query within the unassigned section via the last occurrences.
    const selects = wrapper.findAll('[data-testid="reimbursement-entry-d1"] select')
    expect(selects).toHaveLength(2)
    expect((selects[1].element as HTMLSelectElement).value).toBe('__unassigned__')
    const autoSelect = wrapper.get('[data-testid="reimbursement-entry-d2"] select')
    expect((autoSelect.element as HTMLSelectElement).value).toBe('__auto__')
    expect(unassignedOverride).toBeTruthy()
  })

  it('showUnassignedOnly hides the category branch', () => {
    const wrapper = mountTree({ showUnassignedOnly: true })
    expect(wrapper.text()).not.toContain('会议费')
    expect(wrapper.find('[data-testid="reimbursement-toggle-unassigned"]').exists()).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run test/renderer/components/ReimbursementTree.test.ts`
Expected: FAIL（组件不存在）。

- [ ] **Step 3: 实现组件**

```vue
<!-- src/renderer/src/pages/documents/ReimbursementTree.vue -->
<template>
  <div class="min-h-0" data-testid="reimbursement-tree">
    <RecycleScroller
      v-if="visibleRows.length"
      class="h-full"
      :items="visibleRows"
      :item-size="null"
      :min-item-size="40"
      key-field="key"
      v-slot="{ item }"
    >
      <div :style="{ paddingLeft: `${item.depth * 16}px` }">
        <div
          v-if="item.kind === 'category'"
          class="flex items-center gap-2 border-b px-2 py-1.5 text-sm font-medium hover:bg-accent/40"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-1 text-left"
            :data-testid="`reimbursement-toggle-${item.key}`"
            @click="toggleExpand(item.key)"
          >
            <Icon
              icon="lucide:chevron-right"
              class="size-4 shrink-0 transition-transform"
              :class="{ 'rotate-90': isExpanded(item.key) }"
            />
            <span class="truncate">{{ item.label }}</span>
          </button>
          <button
            v-if="item.materials && item.materials.length"
            type="button"
            class="shrink-0 rounded px-1 text-xs text-muted-foreground hover:bg-muted"
            :data-testid="`reimbursement-materials-${item.categoryId}`"
            @click="toggleMaterials(item.key)"
          >
            {{ t('settings.documents.reimbursement.materialsTitle') }}
          </button>
          <DcBadge variant="outline" class="shrink-0">{{ item.count }}</DcBadge>
        </div>

        <div v-else-if="item.kind === 'materials'" class="border-b px-2 py-2 text-sm">
          <ul class="space-y-1">
            <li
              v-for="material in item.materials ?? []"
              :key="material.name"
              class="flex items-center justify-between"
            >
              <span>{{ material.name }}</span>
              <DcBadge v-if="material.linkedTypeKeys.length" variant="outline">
                {{ t('settings.documents.reimbursement.materialCount', { count: material.count }) }}
              </DcBadge>
            </li>
          </ul>
        </div>

        <div
          v-else-if="item.kind === 'person'"
          class="flex items-center gap-2 border-b px-2 py-1 text-sm font-medium hover:bg-accent/40"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-1 text-left"
            :data-testid="`reimbursement-toggle-${item.key}`"
            @click="toggleExpand(item.key)"
          >
            <Icon
              icon="lucide:chevron-right"
              class="size-3.5 shrink-0 transition-transform"
              :class="{ 'rotate-90': isExpanded(item.key) }"
            />
            <span class="truncate">{{ item.label }}</span>
          </button>
          <DcBadge variant="outline" class="shrink-0">{{ item.count }}</DcBadge>
        </div>

        <div
          v-else-if="item.kind === 'period'"
          class="flex items-center gap-2 border-b px-2 py-1 text-xs text-muted-foreground hover:bg-accent/40"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-1 text-left"
            :data-testid="`reimbursement-toggle-${item.key}`"
            @click="toggleExpand(item.key)"
          >
            <Icon
              icon="lucide:chevron-right"
              class="size-3 shrink-0 transition-transform"
              :class="{ 'rotate-90': isExpanded(item.key) }"
            />
            <span class="truncate">{{ item.label }}</span>
          </button>
          <DcBadge variant="outline" class="shrink-0">{{ item.count }}</DcBadge>
        </div>

        <div
          v-else
          class="flex items-center gap-2 border-b px-2 py-1 text-sm"
          :data-testid="`reimbursement-entry-${item.entry?.id}`"
        >
          <span class="w-36 shrink-0 truncate">{{ item.entry?.templateName }}</span>
          <span class="min-w-0 flex-1 truncate text-muted-foreground">
            {{ item.entry?.fileNames.join('、') }}
          </span>
          <span
            v-if="item.entry?.amount !== null && item.entry?.amount !== undefined"
            class="shrink-0 tabular-nums"
            :class="{ 'text-amber-600': item.entry?.amountUncertain }"
          >
            ¥{{ item.entry?.amount }}
          </span>
          <select
            class="shrink-0 rounded border bg-transparent px-1 py-0.5 text-xs"
            :value="selectValueFor(item)"
            @change="onRowMove(item, ($event.target as HTMLSelectElement).value)"
          >
            <option value="__auto__">
              {{ t('settings.documents.reimbursement.autoCategory') }}
            </option>
            <option value="__unassigned__">
              {{ t('settings.documents.reimbursement.forceUnassigned') }}
            </option>
            <option v-for="node in tree" :key="node.category.id" :value="node.category.id">
              {{ node.category.name }}
            </option>
          </select>
        </div>
      </div>
    </RecycleScroller>
    <p v-else class="py-10 text-center text-sm text-muted-foreground">
      {{ t('settings.documents.reimbursement.empty') }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { DcBadge } from '@dc-ui/components/badge'
import { RecycleScroller } from 'vue-virtual-scroller'
import type { z } from 'zod'
import type {
  reimbursementCategoryNodeSchema,
  reimbursementDocumentEntrySchema,
  reimbursementGroupSchema
} from '@shared/contracts/routes'

type TreeCategoryNode = z.infer<typeof reimbursementCategoryNodeSchema>
type TreeGroup = z.infer<typeof reimbursementGroupSchema>
type TreeEntry = z.infer<typeof reimbursementDocumentEntrySchema>

interface TreeRow {
  key: string
  kind: 'category' | 'person' | 'period' | 'entry' | 'materials'
  depth: number
  label: string
  count: number | null
  materials: TreeCategoryNode['materials'] | null
  categoryId: string | null
  entry: TreeEntry | null
}

const props = withDefaults(
  defineProps<{
    tree: TreeCategoryNode[]
    unassigned: TreeGroup[]
    showUnassignedOnly?: boolean
  }>(),
  { showUnassignedOnly: false }
)

const emit = defineEmits<{ move: [documentId: string, value: string] }>()

const { t } = useI18n()

// Expansion resets to fully expanded whenever the tree data is replaced
// (load, task-completion refresh); folding is session-local by design.
const expanded = ref(new Set<string>())
const materialsOpen = ref(new Set<string>())

watch(
  () => [props.tree, props.unassigned],
  () => {
    const keys = new Set<string>()
    for (const node of props.tree) {
      const catKey = `cat:${node.category.id}`
      keys.add(catKey)
      for (const group of node.groups) {
        const personKey = `${catKey}:p:${group.person ?? 'unknown'}`
        keys.add(personKey)
        for (const bucket of group.buckets) {
          keys.add(`${personKey}:b:${bucket.period ?? 'unknown'}`)
        }
      }
    }
    keys.add('unassigned')
    for (const group of props.unassigned) {
      const personKey = `un:p:${group.person ?? 'unknown'}`
      keys.add(personKey)
      for (const bucket of group.buckets) {
        keys.add(`${personKey}:b:${bucket.period ?? 'unknown'}`)
      }
    }
    expanded.value = keys
    materialsOpen.value = new Set<string>()
  },
  { immediate: true }
)

function isExpanded(key: string) {
  return expanded.value.has(key)
}

function toggleExpand(key: string) {
  const next = new Set(expanded.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  expanded.value = next
}

function toggleMaterials(key: string) {
  const next = new Set(materialsOpen.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  materialsOpen.value = next
}

function pushGroupRows(
  rows: TreeRow[],
  prefix: string,
  depth: number,
  groups: TreeGroup[],
  categoryId: string | null
) {
  for (const group of groups) {
    const personKey = `${prefix}:p:${group.person ?? 'unknown'}`
    const personCount = group.buckets.reduce((sum, bucket) => sum + bucket.documents.length, 0)
    rows.push({
      key: personKey,
      kind: 'person',
      depth,
      label: group.person ?? t('settings.documents.reimbursement.unknownPerson'),
      count: personCount,
      materials: null,
      categoryId,
      entry: null
    })
    if (!isExpanded(personKey)) {
      continue
    }
    for (const bucket of group.buckets) {
      const periodKey = `${personKey}:b:${bucket.period ?? 'unknown'}`
      rows.push({
        key: periodKey,
        kind: 'period',
        depth: depth + 1,
        label: bucket.period ?? t('settings.documents.reimbursement.unknownPeriod'),
        count: bucket.documents.length,
        materials: null,
        categoryId,
        entry: null
      })
      if (!isExpanded(periodKey)) {
        continue
      }
      for (const entry of bucket.documents) {
        rows.push({
          key: `${periodKey}:d:${entry.id}`,
          kind: 'entry',
          depth: depth + 2,
          label: '',
          count: null,
          materials: null,
          categoryId,
          entry
        })
      }
    }
  }
}

const visibleRows = computed<TreeRow[]>(() => {
  const rows: TreeRow[] = []
  if (!props.showUnassignedOnly) {
    for (const node of props.tree) {
      const catKey = `cat:${node.category.id}`
      rows.push({
        key: catKey,
        kind: 'category',
        depth: 0,
        label: node.category.name,
        count: node.total,
        materials: node.materials,
        categoryId: node.category.id,
        entry: null
      })
      if (!isExpanded(catKey)) {
        continue
      }
      if (isMaterialsOpen(catKey) && node.materials.length) {
        rows.push({
          key: `mat:${node.category.id}`,
          kind: 'materials',
          depth: 1,
          label: '',
          count: null,
          materials: node.materials,
          categoryId: node.category.id,
          entry: null
        })
      }
      pushGroupRows(rows, catKey, 1, node.groups, node.category.id)
    }
  }
  const unassignedCount = props.unassigned.reduce(
    (sum, group) =>
      sum + group.buckets.reduce((total, bucket) => total + bucket.documents.length, 0),
    0
  )
  rows.push({
    key: 'unassigned',
    kind: 'category',
    depth: 0,
    label: t('settings.documents.reimbursement.unassigned'),
    count: unassignedCount,
    materials: null,
    categoryId: null,
    entry: null
  })
  if (isExpanded('unassigned')) {
    pushGroupRows(rows, 'un', 1, props.unassigned, null)
  }
  return rows
})

function selectValueFor(row: TreeRow): string {
  if (!row.entry) {
    return '__auto__'
  }
  return row.entry.isOverride ? (row.categoryId ?? '__unassigned__') : '__auto__'
}

function onRowMove(row: TreeRow, value: string) {
  if (row.entry) {
    emit('move', row.entry.id, value)
  }
}
</script>
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run test/renderer/components/ReimbursementTree.test.ts`
Expected: 7 例 PASS。若 i18n 相关报错，参照 `test/renderer/components/ReimbursementView.test.ts` 的挂载方式（全局 setup 已提供 i18n 与 pinia mock 说明）。

- [ ] **Step 5: 提交**

```bash
git diff --text -- src/renderer/src/pages/documents/ReimbursementTree.vue test/renderer/components/ReimbursementTree.test.ts
git add src/renderer/src/pages/documents/ReimbursementTree.vue test/renderer/components/ReimbursementTree.test.ts
git commit -m "feat(documents): reimbursement tree component"
```

---

### Task 2: ReimbursementView 重写为工具条 + 树容器

**Files:**
- Modify (整文件重写): `src/renderer/src/pages/documents/ReimbursementView.vue`
- Modify (整文件重写): `test/renderer/components/ReimbursementView.test.ts`

- [ ] **Step 1: 先重写测试（失败先行）**

在现有 6 用例基础上适配树形态（全部保留语义），新增 3 用例。完整新文件：

```ts
// test/renderer/components/ReimbursementView.test.ts
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import ReimbursementView from '@/pages/documents/ReimbursementView.vue'
import { rendererNotificationManager } from '@renderer-notifications/rendererNotificationRuntime'
import { useDocumentsStore } from '@/stores/documents'

// test/setup.renderer.ts mocks a lightweight pinia globally; restore the real one
// so the test store and the mounted component share the same pinia instance.
vi.mock('pinia', async () => vi.importActual<typeof import('pinia')>('pinia'))

const configClientMock = vi.hoisted(() => ({
  openSettings: vi.fn(async () => undefined)
}))
vi.mock('@api/ConfigClient', () => ({ createConfigClient: () => configClientMock }))

const dcButtonStub = defineComponent({
  name: 'DcButtonStub',
  props: ['variant', 'size', 'disabled'],
  template: '<button :disabled="disabled"><slot /></button>'
})

const dcBadgeStub = defineComponent({
  name: 'DcBadgeStub',
  props: ['variant'],
  template: '<span><slot /></span>'
})

// jsdom has no layout: render all tree rows and forward the scoped slot.
const recycleScrollerStub = defineComponent({
  name: 'RecycleScrollerStub',
  props: { items: { type: Array, default: () => [] }, itemSize: { type: null }, minItemSize: { type: Number } },
  template: `
    <div>
      <div v-for="(item, index) in items" :key="item.key">
        <slot :item="item" :index="index" />
      </div>
    </div>
  `
})

const mountView = (pinia: ReturnType<typeof createPinia>) =>
  mount(ReimbursementView, {
    global: {
      plugins: [pinia],
      stubs: { DcButton: dcButtonStub, DcBadge: dcBadgeStub, RecycleScroller: recycleScrollerStub }
    }
  })

function setupStore() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return { pinia, store: useDocumentsStore() }
}

function makeTree() {
  return {
    tree: [
      {
        category: {
          id: 'cat-a',
          name: '会议费',
          requiredMaterials: [],
          linkedTypeKeys: [],
          sortOrder: 1
        },
        total: 1,
        materials: [],
        groups: [
          {
            person: '张三',
            buckets: [
              {
                period: '2026-09',
                documents: [
                  {
                    id: 'd1',
                    typeKey: 'meeting_minutes',
                    templateName: '会议纪要',
                    person: '张三',
                    period: '2026-09',
                    amount: 100,
                    amountUncertain: false,
                    uncertainCount: 0,
                    fileNames: ['a.pdf'],
                    isOverride: false
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    unassigned: [
      {
        person: '李四',
        buckets: [
          {
            period: '2026-08',
            documents: [
              {
                id: 'd2',
                typeKey: 'meeting_minutes',
                templateName: '会议纪要',
                person: '李四',
                period: '2026-08',
                amount: 50,
                amountUncertain: false,
                uncertainCount: 0,
                fileNames: ['b.pdf'],
                isOverride: false
              }
            ]
          }
        ]
      }
    ],
    summary: [
      { categoryId: 'cat-a', total: 1 },
      { categoryId: null, total: 1 }
    ]
  }
}

describe('ReimbursementView', () => {
  it('renders the full tree from the store', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    store.reimbursementTree = makeTree()
    const wrapper = mountView(pinia)
    await flushPromises()
    expect(wrapper.find('[data-testid="reimbursement-view"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('会议费')
    expect(wrapper.text()).toContain('张三')
    expect(wrapper.text()).toContain('a.pdf')
    expect(wrapper.text()).toContain('b.pdf')
  })

  it('moves document via override select', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    vi.spyOn(store, 'setReimbursementOverride').mockResolvedValue()
    store.reimbursementTree = makeTree()
    const wrapper = mountView(pinia)
    await flushPromises()
    const select = wrapper.get('[data-testid="reimbursement-entry-d1"] select')
    expect(select.exists()).toBe(true)
    await select.setValue('cat-a')
    expect(store.setReimbursementOverride).toHaveBeenCalledWith('d1', 'cat-a')
  })

  it('exports package and notifies success once', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    let resolveExport!: (value: { canceled: boolean; path: string; exportedFiles: number }) => void
    const exportPromise = new Promise<{ canceled: boolean; path: string; exportedFiles: number }>(
      (resolve) => {
        resolveExport = resolve
      }
    )
    vi.spyOn(store, 'exportReimbursementPackage').mockReturnValue(exportPromise)
    const notifySpy = vi
      .spyOn(rendererNotificationManager, 'notify')
      .mockImplementation(() => undefined)
    const wrapper = mountView(pinia)
    await flushPromises()
    const exportButton = wrapper.get('[data-testid="reimbursement-export"]')
    await exportButton.trigger('click')
    await exportButton.trigger('click')
    resolveExport({ canceled: false, path: 'D:\\pkg', exportedFiles: 2 })
    await flushPromises()
    expect(store.exportReimbursementPackage).toHaveBeenCalledTimes(1)
    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'success', code: 'documents.reimbursement.exportSuccess' })
    )
  })

  it('mirrors the owning category on overridden selects', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    const tree = makeTree()
    tree.tree[0].groups[0].buckets[0].documents[0].isOverride = true
    store.reimbursementTree = tree
    const wrapper = mountView(pinia)
    await flushPromises()
    const select = wrapper.get('[data-testid="reimbursement-entry-d1"] select')
    expect((select.element as HTMLSelectElement).value).toBe('cat-a')
  })

  it('shows forced-unassigned and auto values for unassigned entries', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    const tree = makeTree()
    tree.unassigned[0].buckets[0].documents[0].isOverride = true
    store.reimbursementTree = tree
    const wrapper = mountView(pinia)
    await flushPromises()
    const overridden = wrapper.get('[data-testid="reimbursement-entry-d2"] select')
    expect((overridden.element as HTMLSelectElement).value).toBe('__unassigned__')
  })

  it('notifies an error when moving fails', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    vi.spyOn(store, 'setReimbursementOverride').mockRejectedValue(new Error('boom'))
    const notifySpy = vi
      .spyOn(rendererNotificationManager, 'notify')
      .mockImplementation(() => undefined)
    store.reimbursementTree = makeTree()
    const wrapper = mountView(pinia)
    await flushPromises()
    await wrapper.get('[data-testid="reimbursement-entry-d1"] select').setValue('cat-a')
    await flushPromises()
    expect(store.setReimbursementOverride).toHaveBeenCalledWith('d1', 'cat-a')
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', code: 'documents.reimbursement.moveFailed' })
    )
  })

  it('filters to the unassigned branch only', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    store.reimbursementTree = makeTree()
    const wrapper = mountView(pinia)
    await flushPromises()
    expect(wrapper.text()).toContain('会议费')
    await wrapper.get('[data-testid="reimbursement-unassigned-only"]').trigger('click')
    expect(wrapper.text()).not.toContain('会议费')
    expect(wrapper.text()).toContain('b.pdf')
  })

  it('opens the category management settings from the toolbar', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockResolvedValue()
    store.reimbursementTree = makeTree()
    const wrapper = mountView(pinia)
    await flushPromises()
    await wrapper.get('[data-testid="reimbursement-manage-categories"]').trigger('click')
    expect(configClientMock.openSettings).toHaveBeenCalledWith({
      routeName: 'settings-documents-reimbursement'
    })
  })

  it('keeps the error state with retry from the toolbar area', async () => {
    const { pinia, store } = setupStore()
    vi.spyOn(store, 'loadReimbursementTree').mockRejectedValue(new Error('boom'))
    const wrapper = mountView(pinia)
    await flushPromises()
    store.reimbursementLoadError = 'settings.documents.reimbursement.loadFailed'
    await flushPromises()
    expect(wrapper.find('[data-testid="reimbursement-retry"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('报销整理数据加载失败')
  })
})
```

注：原第 5 用例「shows forced-unassigned and auto values in the unassigned view」拆分并入上述第 4/5 用例（树形态下未分类条目直接可见，无需切到未分类视图）；错误态用例采用 store.reimbursementLoadError 手动置位方式（store.loadReimbursementTree 的 catch 会设置该值，mock reject 后真实 catch 路径亦可，实现者可按实际行为择一，断言目标不变：错误区 + retry 按钮可见、文案来自 loadFailed 键）。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run test/renderer/components/ReimbursementView.test.ts`
Expected: FAIL（工具条 testid 不存在，仍是 aside 结构）。

- [ ] **Step 3: 重写视图**

```vue
<!-- src/renderer/src/pages/documents/ReimbursementView.vue -->
<template>
  <div class="flex h-full min-h-0 flex-col" data-testid="reimbursement-view">
    <div class="flex items-center justify-between border-b px-4 py-2">
      <h2 class="text-base font-medium">
        {{ t('settings.documents.reimbursement.viewReimbursement') }}
      </h2>
      <div class="flex items-center gap-2">
        <DcButton
          :variant="showUnassignedOnly ? 'default' : 'outline'"
          size="sm"
          data-testid="reimbursement-unassigned-only"
          @click="showUnassignedOnly = !showUnassignedOnly"
        >
          {{ t('settings.documents.reimbursement.showUnassignedOnly') }}
        </DcButton>
        <DcButton
          variant="outline"
          size="sm"
          data-testid="reimbursement-manage-categories"
          @click="goConfig"
        >
          {{ t('settings.documents.reimbursement.manageCategories') }}
        </DcButton>
        <DcButton
          variant="outline"
          size="sm"
          data-testid="reimbursement-export"
          :disabled="exporting"
          @click="onExport"
        >
          {{ t('settings.documents.reimbursement.export') }}
        </DcButton>
      </div>
    </div>

    <div v-if="store.reimbursementLoadError" class="flex flex-col items-center gap-3 py-6">
      <p class="text-sm text-destructive">{{ t(store.reimbursementLoadError) }}</p>
      <DcButton variant="outline" data-testid="reimbursement-retry" @click="retry">
        {{ t('settings.documents.reimbursement.retry') }}
      </DcButton>
    </div>

    <ReimbursementTree
      v-else-if="store.reimbursementTree"
      class="min-h-0 flex-1"
      :tree="store.reimbursementTree.tree"
      :unassigned="store.reimbursementTree.unassigned"
      :show-unassigned-only="showUnassignedOnly"
      @move="onMove"
    />

    <p v-else class="flex-1 py-10 text-center text-sm text-muted-foreground">
      {{
        store.reimbursementIsLoading
          ? t('settings.documents.reimbursement.loading')
          : t('settings.documents.reimbursement.treeEmpty')
      }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { DcButton } from '@dc-ui/components/button'
import { rendererNotificationManager } from '@renderer-notifications/rendererNotificationRuntime'
import { createConfigClient } from '@api/ConfigClient'
import { REIMBURSEMENT_UNASSIGNED } from '@shared/documents'
import { useDocumentsStore } from '@/stores/documents'
import ReimbursementTree from './ReimbursementTree.vue'

const { t } = useI18n()
const store = useDocumentsStore()
const configClient = createConfigClient()

const showUnassignedOnly = ref(false)
const exporting = ref(false)

onMounted(() => {
  void store.loadReimbursementTree()
})

function retry() {
  void store.loadReimbursementTree()
}

function notifyTransient(kind: 'success' | 'error', code: string, title: string) {
  try {
    rendererNotificationManager.notify({ kind, code, title })
  } catch (error) {
    console.error('[ReimbursementView] Failed to present notification', error)
  }
}

function onMove(documentId: string, value: string) {
  const categoryId =
    value === '__auto__' ? null : value === '__unassigned__' ? REIMBURSEMENT_UNASSIGNED : value
  void store
    .setReimbursementOverride(documentId, categoryId)
    .catch((error: unknown) => {
      console.error('[ReimbursementView] set override failed', error)
      notifyTransient(
        'error',
        'documents.reimbursement.moveFailed',
        t('settings.documents.reimbursement.moveFailed')
      )
    })
}

function goConfig() {
  void configClient.openSettings({ routeName: 'settings-documents-reimbursement' })
}

async function onExport() {
  if (exporting.value) return
  exporting.value = true
  try {
    const result = await store.exportReimbursementPackage()
    if (result.canceled) return
    notifyTransient(
      'success',
      'documents.reimbursement.exportSuccess',
      t('settings.documents.reimbursement.exportDone', {
        count: result.exportedFiles ?? 0,
        path: result.path ?? ''
      })
    )
  } catch (error) {
    console.error('[ReimbursementView] export failed', error)
    notifyTransient(
      'error',
      'documents.reimbursement.exportFailed',
      t('settings.documents.reimbursement.exportFailed')
    )
  } finally {
    exporting.value = false
  }
}
</script>
```

注意：旧实现的 `selectedCategoryId`/`userSelected`/`selectedName`/`selectedGroups`/`selectedMaterials`/`unassignedTotal`/`selectCategory`/`selectUnassigned` 与 aside 模板、`DcBadge` import 全部移除，不留死代码。

- [ ] **Step 4: 运行确认通过 + 回归**

Run: `pnpm exec vitest run test/renderer/components/ReimbursementView.test.ts test/renderer/components/ReimbursementTree.test.ts test/renderer/components/DocumentsArchivePage.test.ts`
Expected: 全绿（View 9 例 + Tree 7 例 + ArchivePage 既有 13 例）。DocumentsArchivePage 若因 ReimbursementView 重构出现选择器断言失败，按其用例意图适配（该页仅做视图切换，预期无需改动；若有改动需在汇报中列出）。

```bash
git diff --text -- src/renderer/src/pages/documents/ReimbursementView.vue test/renderer/components/ReimbursementView.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/pages/documents/ReimbursementView.vue test/renderer/components/ReimbursementView.test.ts
git commit -m "feat(documents): reimbursement full tree view"
```

---

### Task 3: i18n（2 新键 ×20 locale）+ 回归收尾

**Files:**
- Modify: `src/renderer/src/i18n/<locale>/settings.json` ×20（`settings.documents.reimbursement` 内追加 2 键，建议插在 `"loading"` 之后）

- [ ] **Step 1: 写入 20 locale**

| locale | showUnassignedOnly | treeEmpty |
| --- | --- | --- |
| en-US | Show unassigned only | No document records yet |
| zh-CN | 只看未分类 | 暂无单据记录 |
| zh-TW | 只看未分類 | 暫無單據記錄 |
| zh-HK | 只睇未分類 | 暫無單據記錄 |
| ja-JP | 未分類のみ表示 | ドキュメント記録はまだありません |
| ko-KR | 미분류만 보기 | 문서 기록이 아직 없습니다 |
| de-DE | Nur nicht zugeordnete anzeigen | Keine Belegdatensätze vorhanden |
| fr-FR | Afficher uniquement les non-classés | Aucun enregistrement de document |
| es-ES | Mostrar solo sin clasificar | Aún no hay registros de documentos |
| pt-BR | Mostrar apenas não classificados | Ainda não há registros de documentos |
| it-IT | Mostra solo non classificati | Nessun record di documenti |
| ru-RU | Только нераспределённые | Записей документов пока нет |
| pl-PL | Pokaż tylko nieprzypisane | Brak rekordów dokumentów |
| tr-TR | Yalnızca sınıflandırılmamışı göster | Henüz belge kaydı yok |
| vi-VN | Chỉ xem chưa phân loại | Chưa có bản ghi tài liệu |
| id-ID | Tampilkan belum diklasifikasi | Belum ada catatan dokumen |
| ms-MY | Tunjuk belum dikelaskan sahaja | Tiada rekod dokumen lagi |
| da-DK | Vis kun ikke-tildelte | Ingen dokumentposter endnu |
| fa-IR | فقط دسته‌بندی‌نشده‌ها | هنوز سند ثبت نشده است |
| he-IL | הצג לא מסווגים בלבד | אין עדיין רשומות מסמכים |

批量编辑可用临时 Node 脚本（用后必须删除），或逐文件 Edit；JSON 保持原缩进/末尾换行。

- [ ] **Step 2: 回归**

```bash
pnpm run i18n
pnpm exec vitest run test/renderer/components/ReimbursementTree.test.ts test/renderer/components/ReimbursementView.test.ts test/renderer/components/DocumentsArchivePage.test.ts test/renderer/settings/documents/ReimbursementConfigPage.test.ts test/renderer/stores/documentsReimbursementStore.test.ts
pnpm typecheck
```

Expected: i18n 校验通过；5 个测试文件全绿；typecheck 无新增错误。格式/lint 按仓库既有校验（oxfmt 单引号无分号 100 列）。

- [ ] **Step 3: 提交**

```bash
git diff --text --stat
git add src/renderer/src/i18n
git commit -m "feat(documents): tree view i18n and regression"
```

---

## 自审记录

- Spec 覆盖：全宽树 + 折叠/计数（Task 1）、材料行（Task 1）、条目下拉 + move 转发（Task 1+2）、工具条三项（Task 2）、未分类置底/只看未分类（Task 1+2）、错误/加载/空态（Task 2）、i18n 2 键（Task 3）、验收 5 条各有对应任务与用例。无缺口。
- 占位符扫描：无 TBD/TODO；全部代码块完整；DOM 约定在 Task 1 开头统一声明。
- 类型一致性：TreeRow/行 key 规则/emit 签名在 Task 1 定义，Task 2 测试复用其 testid 约定；数据契约字段与 `documents.routes.ts:362-425` 逐字核对；`@api/ConfigClient` mock 与视图既有 import 一致。
