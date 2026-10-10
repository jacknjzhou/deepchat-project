# 报销类别设置 Key 选择器 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 报销类别设置页四处 key 输入（类别/材料 linkedTypeKeys、全局 person/date/amount 字段键）改为从「智能信息识别」已配置模板勾选；识别任务完成后报销整理树自动刷新。

**Architecture:** 纯渲染端改造。新增 `ReimbursementKeyPicker.vue`（已选标签 + 勾选清单，四处复用），配置页复用 `useDocumentsStore.templates`；store `handleTaskUpdated` 在树已加载时于任务 done/failed 后触发 `loadReimbursementTree()`。无契约/主进程变更。

**Tech Stack:** Vue 3 + pinia + vue-i18n + Vitest/@vue/test-utils。

**Spec:** `docs/superpowers/specs/2026-10-10-reimbursement-key-picker-design.md`

**执行注意（本机教训）：**
- 同一文件多次编辑必须串行，每文件编辑完成后跑 `git diff --text -- <file>` 确认无 NUL/截断污染。
- Oxfmt：单引号、无分号、100 列。
- 渲染端测试命令：`pnpm exec vitest run <files>`（不要全量跑 renderer stores）。
- Conventional Commits ≤50 字符，不加 AI 署名，只 add 任务列出的文件。

---

### Task 1: ReimbursementKeyPicker 组件（TDD）

**Files:**
- Create: `src/renderer/settings/components/documents/ReimbursementKeyPicker.vue`
- Test (Create): `test/renderer/settings/documents/ReimbursementKeyPicker.test.ts`

DOM 约定（后续任务依赖）：
- 勾选项：`[data-testid="reimbursement-key-option-<value>"]`
- 移除按钮：`[data-testid="reimbursement-key-remove-<value>"]`
- 失效标签：含 class `stale-key`
- 空态：`[data-testid="reimbursement-picker-empty"]`；错误区：`[data-testid="reimbursement-picker-error"]`；重试：`[data-testid="reimbursement-picker-retry"]`
- 组件根**不设** data-testid，由使用方传入（fallthrough）。

- [ ] **Step 1: 写失败测试**

```ts
// test/renderer/settings/documents/ReimbursementKeyPicker.test.ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import ReimbursementKeyPicker from '../../../../src/renderer/settings/components/documents/ReimbursementKeyPicker.vue'

const dcButtonStub = defineComponent({
  name: 'DcButtonStub',
  props: ['variant', 'size', 'disabled'],
  emits: ['click'],
  template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>'
})

const dcBadgeStub = defineComponent({
  name: 'DcBadgeStub',
  props: ['variant'],
  template: '<span :class="variant"><slot /></span>'
})

const options = [
  { value: 'meeting_minutes', label: '会议纪要', hint: 'meeting_minutes' },
  { value: 'invoice', label: '发票', hint: 'invoice' }
]

function mountPicker(props: Record<string, unknown> = {}) {
  return mount(ReimbursementKeyPicker, {
    props: { modelValue: [], options, notice: null, ...props },
    global: { stubs: { DcButton: dcButtonStub, DcBadge: dcBadgeStub, Icon: true } }
  })
}

describe('ReimbursementKeyPicker', () => {
  it('renders options with label and mono hint, unchecked by default', () => {
    const wrapper = mountPicker()
    const opt = wrapper.get('[data-testid="reimbursement-key-option-meeting_minutes"]')
    expect((opt.element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.text()).toContain('会议纪要')
    expect(wrapper.text()).toContain('meeting_minutes')
  })

  it('checking an option emits the appended array; unchecking emits the filtered array', async () => {
    const wrapper = mountPicker()
    await wrapper.get('[data-testid="reimbursement-key-option-invoice"]').setValue(true)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual(['invoice'])
    await wrapper.setProps({ modelValue: ['invoice'] })
    await wrapper.get('[data-testid="reimbursement-key-option-invoice"]').setValue(false)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual([])
  })

  it('the × remove button emits the array without that value', async () => {
    const wrapper = mountPicker({ modelValue: ['meeting_minutes', 'invoice'] })
    await wrapper.get('[data-testid="reimbursement-key-remove-meeting_minutes"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual(['invoice'])
  })

  it('marks selected values missing from options as stale and keeps them removable', () => {
    const wrapper = mountPicker({ modelValue: ['ghost_key'] })
    const remove = wrapper.get('[data-testid="reimbursement-key-remove-ghost_key"]')
    expect(remove.element.closest('.stale-key')).not.toBeNull()
  })

  it('notice=empty shows the hint instead of the option list', () => {
    const wrapper = mountPicker({ options: [], notice: 'empty' })
    expect(wrapper.find('[data-testid="reimbursement-picker-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="reimbursement-key-option-invoice"]').exists()).toBe(false)
  })

  it('notice=error shows error text and emits retry from the retry button', async () => {
    const wrapper = mountPicker({ notice: 'error' })
    expect(wrapper.find('[data-testid="reimbursement-picker-error"]').exists()).toBe(true)
    await wrapper.get('[data-testid="reimbursement-picker-retry"]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run test/renderer/settings/documents/ReimbursementKeyPicker.test.ts`
Expected: FAIL（组件不存在，import 报错）。

- [ ] **Step 3: 实现组件**

```vue
<!-- src/renderer/settings/components/documents/ReimbursementKeyPicker.vue -->
<template>
  <div class="space-y-2">
    <div v-if="selectedItems.length" class="flex flex-wrap gap-1.5">
      <span
        v-for="item in selectedItems"
        :key="item.value"
        :class="[
          'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
          item.stale ? 'stale-key border-amber-500 text-amber-600' : 'border-transparent bg-muted'
        ]"
      >
        <span class="font-mono">{{ item.value }}</span>
        <span v-if="item.stale">{{ t('settings.documents.reimbursement.staleKey') }}</span>
        <button
          type="button"
          class="rounded-full p-0.5 hover:bg-accent"
          :data-testid="`reimbursement-key-remove-${item.value}`"
          :aria-label="t('settings.documents.reimbursement.removeKey', { key: item.value })"
          @click="remove(item.value)"
        >
          <Icon icon="lucide:x" class="size-3" />
        </button>
      </span>
    </div>

    <p
      v-if="notice === 'empty'"
      class="text-sm text-muted-foreground"
      data-testid="reimbursement-picker-empty"
    >
      {{ t('settings.documents.reimbursement.noTemplatesHint') }}
    </p>
    <div
      v-else-if="notice === 'error'"
      class="flex items-center gap-2"
      data-testid="reimbursement-picker-error"
    >
      <span class="text-sm text-destructive">
        {{ t('settings.documents.reimbursement.templatesLoadFailed') }}
      </span>
      <DcButton
        variant="outline"
        size="sm"
        data-testid="reimbursement-picker-retry"
        @click="emit('retry')"
      >
        {{ t('settings.documents.reimbursement.retry') }}
      </DcButton>
    </div>

    <div
      v-else-if="options.length"
      class="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2"
    >
      <label
        v-for="option in options"
        :key="option.value"
        class="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-accent/40"
      >
        <input
          type="checkbox"
          class="size-4"
          :checked="modelValue.includes(option.value)"
          :data-testid="`reimbursement-key-option-${option.value}`"
          @change="toggle(option.value)"
        />
        <span>{{ option.label }}</span>
        <span v-if="option.hint" class="font-mono text-xs text-muted-foreground">
          {{ option.hint }}
        </span>
      </label>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { DcButton } from '@dc-ui/components/button'

export interface ReimbursementKeyOption {
  value: string
  label: string
  hint?: string
}

const props = defineProps<{
  modelValue: string[]
  options: ReimbursementKeyOption[]
  notice?: 'empty' | 'error' | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
  retry: []
}>()

const { t } = useI18n()

const selectedItems = computed(() =>
  props.modelValue.map((value) => ({
    value,
    stale: !props.options.some((option) => option.value === value)
  }))
)

function toggle(value: string) {
  if (props.modelValue.includes(value)) {
    emit(
      'update:modelValue',
      props.modelValue.filter((item) => item !== value)
    )
  } else {
    emit('update:modelValue', [...props.modelValue, value])
  }
}

function remove(value: string) {
  emit(
    'update:modelValue',
    props.modelValue.filter((item) => item !== value)
  )
}
</script>
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run test/renderer/settings/documents/ReimbursementKeyPicker.test.ts`
Expected: 6 例 PASS。若 i18n 相关报错，检查 `test/setup.renderer.ts` 全局 i18n 是否可用（ReimbursementView.test.ts 同款挂载方式可直接用 t()）。

- [ ] **Step 5: 核查文件完整性 + 提交**

```bash
git diff --text -- src/renderer/settings/components/documents/ReimbursementKeyPicker.vue
git add src/renderer/settings/components/documents/ReimbursementKeyPicker.vue test/renderer/settings/documents/ReimbursementKeyPicker.test.ts
git commit -m "feat(documents): reimbursement key picker component"
```

---

### Task 2: 配置页接线（4 处替换 + 模板加载）

**Files:**
- Modify: `src/renderer/settings/components/documents/ReimbursementConfigPage.vue`
- Modify: `test/renderer/settings/documents/ReimbursementConfigPage.test.ts`

- [ ] **Step 1: 先改测试（失败先行）**

(a) `fakeClient`（vi.hoisted 块）增加 `listTemplates`：

```ts
const fakeClient = vi.hoisted(() => ({
  reimbursementGetConfig: vi.fn(),
  reimbursementSetConfig: vi.fn(),
  reimbursementTree: vi.fn(),
  reimbursementSetOverride: vi.fn(),
  reimbursementExport: vi.fn(),
  listTemplates: vi.fn()
}))
```

(b) `minimalConfig` 定义之后增加模板数据与 `beforeEach` 默认值：

```ts
const fakeTemplates = [
  {
    id: 'tpl-1',
    typeKey: 'meeting_minutes',
    name: '会议纪要',
    fields: [{ key: 'attendee', label: '参会人' }]
  },
  {
    id: 'tpl-2',
    typeKey: 'invoice',
    name: '发票',
    fields: [
      { key: 'buyer_name', label: '购买方' },
      { key: 'total_amount', label: '金额' }
    ]
  }
] as never
```

`beforeEach`（已有 notifySpy 那个）追加一行：

```ts
  fakeClient.listTemplates.mockResolvedValue({ templates: fakeTemplates })
```

(c) 新增 3 个用例（加入现有 `describe` 内）：

```ts
  it('type key options come from templates and toggling updates linkedTypeKeys', async () => {
    fakeClient.reimbursementGetConfig.mockResolvedValue({ config: minimalConfig })
    const { wrapper } = await mountPage()
    expect(
      wrapper
        .find(
          '[data-testid="reimbursement-category-linked"] [data-testid="reimbursement-key-option-meeting_minutes"]'
        )
        .exists()
    ).toBe(true)
    await wrapper
      .get(
        '[data-testid="reimbursement-category-linked"] [data-testid="reimbursement-key-option-meeting_minutes"]'
      )
      .setValue(true)
    expect(
      wrapper
        .find(
          '[data-testid="reimbursement-category-linked"] [data-testid="reimbursement-key-remove-meeting_minutes"]'
        )
        .exists()
    ).toBe(true)
    expect(wrapper.find('[data-testid="reimbursement-config-error"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="reimbursement-config-save"]').attributes('disabled')).toBeUndefined()
  })

  it('stale keys render a marker and do not block save', async () => {
    fakeClient.reimbursementGetConfig.mockResolvedValue({ config: minimalConfig })
    const { wrapper } = await mountPage()
    // cat-b 材料 linkedTypeKeys=['taxi']，fakeTemplates 无 taxi → 失效
    const materialPicker = wrapper.get('[data-testid="reimbursement-material-linked"]')
    expect(materialPicker.get('[data-testid="reimbursement-key-remove-taxi"]').exists()).toBe(true)
    expect(materialPicker.find('.stale-key').exists()).toBe(true)
    expect(wrapper.find('[data-testid="reimbursement-config-error"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="reimbursement-config-save"]').attributes('disabled')).toBeUndefined()
  })

  it('template load failure shows error with retry that reloads', async () => {
    fakeClient.listTemplates.mockRejectedValueOnce(new Error('boom'))
    fakeClient.reimbursementGetConfig.mockResolvedValue({ config: minimalConfig })
    const { wrapper } = await mountPage()
    expect(wrapper.find('[data-testid="reimbursement-picker-error"]').exists()).toBe(true)
    fakeClient.listTemplates.mockResolvedValue({ templates: fakeTemplates })
    await wrapper.get('[data-testid="reimbursement-picker-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="reimbursement-picker-error"]').exists()).toBe(false)
  })
```

(d) 适配既有用例：全文搜索已移除的 testid（`reimbursement-category-linked` 的 Input 值断言、`reimbursement-material-linked` 的 Input 值断言、`reimbursement-global-person` / `reimbursement-global-date` / `reimbursement-global-amount` 的 Input `.value` 断言），按下表替换（选择器加 picker 前缀，断言对象从 input value 改为「标签/勾选态」）：

| 旧断言（Input value） | 新断言（picker DOM） |
| --- | --- |
| `get('[data-testid="reimbursement-global-person"]').element.value === 'buyer_name'` | `get('[data-testid="reimbursement-global-person"] [data-testid="reimbursement-key-remove-buyer_name"]')` 存在 |
| category linked input value | `get('[data-testid="reimbursement-category-linked"] [data-testid="reimbursement-key-remove-<key>"]')` 存在 |
| material linked input value | `get('[data-testid="reimbursement-material-linked"] [data-testid="reimbursement-key-remove-<key>"]')` 存在 |
| 「输入非法 type_key 触发校验」类用例 | 自由输入已移除：改为 mount 一个含非法 key（如 `'Bad Key'`）的 config（mockResolvedValue），断言 error alert 出现且 save disabled。示例： |

```ts
  it('invalid saved keys still trigger validation (no free-text input anymore)', async () => {
    fakeClient.reimbursementGetConfig.mockResolvedValue({
      config: {
        ...minimalConfig,
        categories: [
          {
            id: 'cat-x',
            name: '餐费',
            requiredMaterials: [],
            linkedTypeKeys: ['Bad Key'],
            sortOrder: 1
          }
        ]
      }
    })
    const { wrapper } = await mountPage()
    expect(wrapper.find('[data-testid="reimbursement-config-error"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="reimbursement-config-save"]').attributes('disabled')).toBeDefined()
  })
```

注意：`mountPage` 无需改动（picker 用真实组件渲染，DcButton/DcBadge/Icon 已有 stub；`useI18n` 由全局 setup 提供）。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run test/renderer/settings/documents/ReimbursementConfigPage.test.ts`
Expected: FAIL（页面仍是自由文本 Input，找不到 picker testid）。

- [ ] **Step 3: 修改页面**

**3a. import 区**（`SettingsSectionCard` import 之后）加：

```ts
import ReimbursementKeyPicker, { type ReimbursementKeyOption } from './ReimbursementKeyPicker.vue'
```

**3b. 模板加载状态**：`const loadError = ref(false)` 之后加：

```ts
const templatesLoadError = ref(false)
```

`onMounted` 改为：

```ts
onMounted(() => {
  void retryLoad()
  void loadTemplatesOnce()
})

async function loadTemplatesOnce() {
  templatesLoadError.value = false
  try {
    if (!store.templates.length) {
      await store.loadTemplates()
    }
  } catch (error) {
    console.error('[ReimbursementConfigPage] load templates failed', error)
    templatesLoadError.value = true
  }
}
```

**3c. options 计算**（`isInvalidTypeKey` 函数之后、`const { t } = useI18n()` 之前不放——放在 `draft` 定义之后）：

```ts
const typeKeyOptions = computed<ReimbursementKeyOption[]>(() =>
  store.templates
    .filter((tpl) => tpl.typeKey !== 'unassigned' && !isInvalidTypeKey(tpl.typeKey))
    .map((tpl) => ({ value: tpl.typeKey, label: tpl.name, hint: tpl.typeKey }))
)

const fieldKeyOptions = computed<ReimbursementKeyOption[]>(() => {
  const seen = new Map<string, ReimbursementKeyOption>()
  for (const tpl of store.templates) {
    for (const field of tpl.fields) {
      if (isInvalidTypeKey(field.key) || seen.has(field.key)) {
        continue
      }
      seen.set(field.key, { value: field.key, label: field.label, hint: field.key })
    }
  }
  return [...seen.values()]
})

const pickerNotice = computed<'empty' | 'error' | null>(() => {
  if (templatesLoadError.value) {
    return 'error'
  }
  if (!store.templates.length) {
    return 'empty'
  }
  return null
})
```

**3d. 模板区 4 处替换。**

类别 linked（原 lines 73-83 的 `<Input ... data-testid="reimbursement-category-linked" ...>` 整块）：

```html
          <ReimbursementKeyPicker
            class="mt-1"
            :model-value="category.linkedTypeKeys"
            :options="typeKeyOptions"
            :notice="pickerNotice"
            data-testid="reimbursement-category-linked"
            @update:model-value="(value) => updateCategoryLinkedKeys(category, value)"
          />
```

材料 linked（原 lines 113-121 的 `<Input ... data-testid="reimbursement-material-linked" ...>`）：

```html
            <ReimbursementKeyPicker
              class="min-w-0 flex-1"
              :model-value="material.linkedTypeKeys"
              :options="typeKeyOptions"
              :notice="pickerNotice"
              data-testid="reimbursement-material-linked"
              @update:model-value="(value) => updateMaterialLinkedKeys(category, materialIndex, value)"
            />
```

全局三处（person/date/amount，各自原 Input 块替换，仅 model-value 与 handler 目标不同）：

```html
          <ReimbursementKeyPicker
            class="mt-1"
            :model-value="draft.personFieldKeys"
            :options="fieldKeyOptions"
            :notice="pickerNotice"
            data-testid="reimbursement-global-person"
            @update:model-value="(value) => updateGlobalKeys(draft.personFieldKeys, value)"
          />
```

```html
          <ReimbursementKeyPicker
            class="mt-1"
            :model-value="draft.dateFieldKeys"
            :options="fieldKeyOptions"
            :notice="pickerNotice"
            data-testid="reimbursement-global-date"
            @update:model-value="(value) => updateGlobalKeys(draft.dateFieldKeys, value)"
          />
```

```html
          <ReimbursementKeyPicker
            class="mt-1"
            :model-value="draft.amountFieldKeys"
            :options="fieldKeyOptions"
            :notice="pickerNotice"
            data-testid="reimbursement-global-amount"
            @update:model-value="(value) => updateGlobalKeys(draft.amountFieldKeys, value)"
          />
```

**3e. script handler 签名改为数组**，并删除 `parseKeyList`：

```ts
function updateCategoryLinkedKeys(category: ReimbursementCategory, value: string[]) {
  category.linkedTypeKeys = value
}

function updateMaterialLinkedKeys(
  category: ReimbursementCategory,
  materialIndex: number,
  value: string[]
) {
  const material = category.requiredMaterials[materialIndex]
  if (material) {
    material.linkedTypeKeys = value
  }
}

function updateGlobalKeys(target: string[], value: string[]) {
  target.splice(0, target.length, ...value)
}
```

删除整个 `parseKeyList` 函数与 `updateCategoryLinkedKeys`/`updateMaterialLinkedKeys`/`updateGlobalKeys` 的旧文本版本。校验 computed（`validationError`，regex + `isInvalidTypeKey`）**不动**——失效 key 均为历史保存值（保存时已过契约校验），且新选项已过滤非法 key。

- [ ] **Step 4: 运行确认通过 + 文件完整性**

Run: `pnpm exec vitest run test/renderer/settings/documents/ReimbursementConfigPage.test.ts test/renderer/settings/documents/ReimbursementKeyPicker.test.ts`
Expected: 全部 PASS。

```bash
git diff --text -- src/renderer/settings/components/documents/ReimbursementConfigPage.vue test/renderer/settings/documents/ReimbursementConfigPage.test.ts
```

确认无 NUL 污染、无意外截断。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/settings/components/documents/ReimbursementConfigPage.vue test/renderer/settings/documents/ReimbursementConfigPage.test.ts
git commit -m "feat(documents): config page key picker wiring"
```

---

### Task 3: 识别任务完成后自动刷新报销树（TDD）

**Files:**
- Modify: `src/renderer/src/stores/documents.ts:219-229`（`handleTaskUpdated`）
- Modify: `test/renderer/stores/documentsReimbursementStore.test.ts`

- [ ] **Step 1: 写失败测试**（加入现有 `describe` 内；文件顶部 import 补 `flushPromises`）

import 行改为：

```ts
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
```

`vi.mock('pinia', ...)` 之后加（`handleTaskUpdated` 内 `loadReimbursementTree()` 无参调用走 `defaultClient = documentsApi`，来自 `@api/documentTasks`）：

```ts
// handleTaskUpdated triggers loadReimbursementTree() without an explicit client,
// which resolves to documentsApi from '@api/documentTasks'; mock it here.
const defaultApi = vi.hoisted(() => ({
  reimbursementTree: vi.fn(async () => ({ tree: [], unassigned: [], summary: [] }))
}))
vi.mock('@api/documentTasks', () => ({ documentsApi: defaultApi }))
```

新用例：

```ts
  it('refreshes the reimbursement tree on task completion when already loaded', async () => {
    setActivePinia(createPinia())
    const store = useDocumentsStore()
    const client = makeFakeClient()
    await store.loadReimbursementTree(client as never)
    expect(client.reimbursementTree).toHaveBeenCalledTimes(1)
    store.handleTaskUpdated({ id: 't1', status: 'done' } as never)
    await flushPromises()
    expect(defaultApi.reimbursementTree).toHaveBeenCalledTimes(1)
    expect(store.reimbursementTree).toEqual({ tree: [], unassigned: [], summary: [] })
  })

  it('does not load the reimbursement tree on task completion when never loaded', async () => {
    setActivePinia(createPinia())
    const store = useDocumentsStore()
    store.handleTaskUpdated({ id: 't2', status: 'done' } as never)
    await flushPromises()
    expect(defaultApi.reimbursementTree).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run test/renderer/stores/documentsReimbursementStore.test.ts`
Expected: 第一例 FAIL（`defaultApi.reimbursementTree` 0 次调用）。

- [ ] **Step 3: 修改 store**

`handleTaskUpdated`（`src/renderer/src/stores/documents.ts` 约 219-229 行）尾部改为：

```ts
  function handleTaskUpdated(payload: DocumentsTaskUpdatedPayload) {
    const index = tasks.value.findIndex((task) => task.id === payload.id)
    if (index >= 0) {
      tasks.value[index] = payload
    } else {
      tasks.value.unshift(payload)
    }
    if (payload.status === 'done' || payload.status === 'failed') {
      scheduleArchiveRefresh()
      // Keep the reimbursement tree live while the view is open. Guarded by
      // reimbursementLoadSeq; skipped entirely when the tree was never loaded.
      if (reimbursementTree.value !== null) {
        void loadReimbursementTree()
      }
    }
  }
```

（`reimbursementTree` 与 `loadReimbursementTree` 定义在其后：函数声明会提升，ref 在 store setup 完成后才被事件回调访问，无 TDZ 问题。）

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run test/renderer/stores/documentsReimbursementStore.test.ts`
Expected: 7 例 PASS（原 5 + 新 2）。

- [ ] **Step 5: 提交**

```bash
git diff --text -- src/renderer/src/stores/documents.ts test/renderer/stores/documentsReimbursementStore.test.ts
git add src/renderer/src/stores/documents.ts test/renderer/stores/documentsReimbursementStore.test.ts
git commit -m "feat(documents): refresh tree on task completion"
```

---

### Task 4: i18n（20 locale）+ 回归收尾

**Files:**
- Modify: `src/renderer/src/i18n/<locale>/settings.json` ×20（`settings.documents.reimbursement` 对象内，紧跟 `retry` 键之后插入 3 键）

- [ ] **Step 1: 写入 20 locale**

各 locale 文件在 `"reimbursement"` 对象内 `"retry"` 键后插入：

Task 2 质量审查补充（随本任务一并处理）：
- **删除孤儿键 `materialLinkedPlaceholder`**：其唯一消费者（材料 linked Input）已在 Task 2 被替换，20 locale 一并移除。
- **补 notice='empty' 用例**：`ReimbursementConfigPage.test.ts` 加一条 `listTemplates` 返回 `{ templates: [] }` 时显示空态提示（`[data-testid="reimbursement-picker-empty"]` 存在）且不显示错误区的用例。

| locale | staleKey | noTemplatesHint | templatesLoadFailed |
| --- | --- | --- | --- |
| en-US | Outdated | Configure templates in Smart Document Recognition first. | Failed to load templates. |
| zh-CN | 已失效 | 请先在「智能信息识别」中配置模板 | 模板加载失败 |
| zh-TW | 已失效 | 請先在「智慧資訊辨識」中設定範本 | 範本載入失敗 |
| zh-HK | 已失效 | 請先喺「智慧資訊辨識」入面設定範本 | 範本載入失敗 |
| ja-JP | 期限切れ | 先に「スマート情報認識」でテンプレートを設定してください | テンプレートの読み込みに失敗しました |
| ko-KR | 만료됨 | 먼저 「스마트 정보 인식」에서 템플릿을 설정하세요 | 템플릿 로드에 실패했습니다 |
| de-DE | Veraltet | Bitte zuerst Vorlagen in der intelligenten Erkennung konfigurieren | Vorlagen konnten nicht geladen werden |
| fr-FR | Obsolète | Configurez d'abord un modèle dans la reconnaissance intelligente | Échec du chargement des modèles |
| es-ES | Obsoleto | Configure primero plantillas en el reconocimiento inteligente | Error al cargar las plantillas |
| pt-BR | Obsoleto | Configure primeiro modelos no reconhecimento inteligente | Falha ao carregar os modelos |
| it-IT | Obsoleto | Configura prima i modelli nel riconoscimento intelligente | Caricamento dei modelli non riuscito |
| ru-RU | Устарел | Сначала настройте шаблоны в умном распознавании | Не удалось загрузить шаблоны |
| pl-PL | Nieaktualny | Najpierw skonfiguruj szablony w inteligentnym rozpoznawaniu | Nie udało się załadować szablonów |
| tr-TR | Eski | Önce Akıllı Bilgi Tanıma'da şablon yapılandırın | Şablonlar yüklenemedi |
| vi-VN | Đã lỗi thời | Hãy cấu hình mẫu trong Nhận diện thông tin trước | Tải mẫu thất bại |
| id-ID | Kedaluwarsa | Konfigurasikan templat di Pengenalan Cerdas terlebih dahulu | Gagal memuat templat |
| ms-MY | Lapuk | Konfigurasikan templat dalam Pengecaman Pintar dahulu | Gagal memuatkan templat |
| da-DK | Forældet | Konfigurer skabeloner i Smart genkendelse først | Kunne ikke indlæse skabeloner |
| fa-IR | منقضی | ابتدا قالب‌ها را در تشخیص هوشمند پیکربندی کنید | بارگذاری قالب‌ها ناموفق بود |
| he-IL | מיושן | יש להגדיר תבניות בזיהוי החכם תחילה | טעינת התבניות נכשלה |

质量审查补充第 4 键 `removeKey`（组件移除按钮 aria-label，插在 `templatesLoadFailed` 之后）——en-US `Remove {key}`、zh-CN/zh-TW/zh-HK `移除 {key}`、ja-JP `{key} を削除`、ko-KR `{key} 제거`、de-DE `{key} entfernen`、fr-FR `Supprimer {key}`、es-ES `Eliminar {key}`、pt-BR `Remover {key}`、it-IT `Rimuovi {key}`、ru-RU `Удалить {key}`、pl-PL `Usuń {key}`、tr-TR `{key} kaldır`、vi-VN `Xóa {key}`、id-ID `Hapus {key}`、ms-MY `Buang {key}`、da-DK `Fjern {key}`、fa-IR `حذف {key}`、he-IL `הסר {key}`。即本任务每 locale 共插入 4 键。

- [ ] **Step 2: 校验 i18n + 定点回归**

```bash
pnpm run i18n
pnpm exec vitest run test/renderer/settings/documents/ReimbursementKeyPicker.test.ts test/renderer/settings/documents/ReimbursementConfigPage.test.ts test/renderer/stores/documentsReimbursementStore.test.ts test/renderer/components/ReimbursementView.test.ts
```

Expected: i18n parity 校验通过（若脚本只查 en-US 基准，人工抽查 zh-CN/ja-JP/de-DE 三个文件确认 3 键已插入）；4 个测试文件全绿。

- [ ] **Step 3: typecheck + 格式 + lint**

```bash
pnpm typecheck
```

格式/lint 按仓库既有校验（oxfmt 单引号无分号 100 列；若 `pnpm run lint`/`pnpm run format` 存在则执行）。

- [ ] **Step 4: 提交**

```bash
git diff --text --stat
git add src/renderer/src/i18n
git commit -m "feat(documents): i18n for reimbursement picker"
```

---

## 自审记录

- Spec 覆盖：组件（Task 1）、4 处接线 + 空态/失败态（Task 2）、自动刷新（Task 3）、i18n 3 键 20 locale（Task 4）、验收 4 条分别由 Task 2 用例（1/2）、Task 3 用例（3）、Task 4 Step 2（4）覆盖。无缺口。
- 占位符扫描：无 TBD/TODO；所有代码块完整。
- 类型一致性：`ReimbursementKeyOption` 在 Task 1 定义、Task 2 import 使用；testid 约定在 Task 1 开头统一声明并在 Task 2/复用一致；`handleTaskUpdated`/`loadReimbursementTree`/`reimbursementTree` 名称与 store 现状一致（已核对源码 219/325/348 行）。

## 实施记录（as-built）

- **Task 1**（`00e8c160` + `88260589`，spec ✅ + 质量 ✅）：计划勘误 `be8e0f02`——VTU emitted 断言需 `.at(-1)?.[0]` 取参（计划原文多包一层）；提交信息精简至 41 字符；质量审查修复（`88260589`）：移除按钮 aria-label 改 `removeKey` 插值（计划同步 `ff566d1f`，第 4 个 i18n 键随 Task 4 落地）、删除死代码 `dcBadgeStub`。其余照计划。
- **Task 2**（`1034a6fa`，spec ✅ + 质量 ✅）：4 处 picker 追加 `@retry="loadTemplatesOnce"`（计划代码块遗漏，retry 用例要求，属 spec §2 既定行为）；`templatesLoadError` 判定改为 `!store.templates.length && store.loadError !== null`（store `loadTemplates` 内部吞错不 rethrow，计划的 try/catch 捕不到；保留 try/catch 防御）；stale 用例失效键 taxi→trip_date（计划 fixture 笔误，cat-b 材料实为 `['trip_date']`）；长选择器提取 `option()`/`remove()` 辅助（Oxfmt 100 列）；既有用例 `flags invalid type keys...` 整替为「invalid saved keys still trigger validation」。质量审查通过，无阻塞；两条跟进项（删孤儿键、补 empty 用例）移交 Task 4。
- **Task 3**（`52e691cf` + `23f86e31`，spec ✅ + 质量 ✅）：实现照计划；质量审查修复（`23f86e31`）：树刷新改 300ms trailing 防抖（新增 `scheduleReimbursementRefresh`，镜像 `scheduleArchiveRefresh`，批量完成只刷一次）、注释改 "Once loaded, keep the reimbursement tree fresh for the session."、测试改假时钟（双事件→`advanceTimersByTimeAsync(300)`→断言仅 1 次刷新）+ `defaultApi` 补 `stats`/`listDocuments`。
- **Task 4**（`3b80d45c` + `830ebafc`，spec ✅ + 质量 ✅）：20 locale × 4 键（`removeKey` 为 Task 1 质量审查补充）+ 删除孤儿键 `materialLinkedPlaceholder` + 补 notice='empty' 用例。质量审查修复（`830ebafc`）：`noTemplatesHint` 功能名对齐各 locale `routes.json` 的 `settings-documents` 既有命名（20 locale 全量替换，pl-PL 为方位格变格）；zh-HK「範本」→「模板」对齐文件既有词汇。
- **回归终态**：`pnpm run i18n` 通过（20 locales / 4742 contracts）；`pnpm typecheck` 0 错误；定点测试 31 例全绿（KeyPicker 6 + ConfigPage 12 + store 7 + ReimbursementView 6）。
