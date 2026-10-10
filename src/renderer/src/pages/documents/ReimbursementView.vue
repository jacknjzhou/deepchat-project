<template>
  <div class="flex h-full min-h-0" data-testid="reimbursement-view">
    <aside class="w-56 shrink-0 overflow-y-auto border-r p-3">
      <button
        v-for="node in store.reimbursementTree?.tree ?? []"
        :key="node.category.id"
        class="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-muted"
        :class="{ 'bg-muted font-medium': selectedCategoryId === node.category.id }"
        :data-testid="`reimbursement-category-${node.category.id}`"
        @click="selectCategory(node.category.id)"
      >
        <span class="truncate">{{ node.category.name }}</span>
        <DcBadge variant="outline" class="ml-2">{{ node.total }}</DcBadge>
      </button>
      <button
        class="mt-1 flex w-full items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-muted"
        :class="{ 'bg-muted font-medium': selectedCategoryId === null }"
        data-testid="reimbursement-category-unassigned"
        @click="selectUnassigned"
      >
        <span>{{ t('settings.documents.reimbursement.unassigned') }}</span>
        <DcBadge variant="outline" class="ml-2">{{ unassignedTotal }}</DcBadge>
      </button>
      <div class="mt-3 border-t pt-3">
        <button
          class="w-full rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted"
          @click="goConfig"
        >
          {{ t('settings.documents.reimbursement.manageCategories') }}
        </button>
      </div>
    </aside>
    <section class="min-w-0 flex-1 overflow-y-auto p-4">
      <div v-if="store.reimbursementLoadError" class="flex flex-col items-center gap-3 py-6">
        <p class="text-sm text-destructive">{{ t(store.reimbursementLoadError) }}</p>
        <DcButton variant="outline" data-testid="reimbursement-retry" @click="retry">
          {{ t('settings.documents.reimbursement.retry') }}
        </DcButton>
      </div>

      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-base font-medium">{{ selectedName }}</h2>
        <div class="flex items-center gap-2">
          <DcButton
            v-if="selectedCategoryId !== null"
            variant="outline"
            size="sm"
            data-testid="reimbursement-add-group"
            @click="showGroupForm = !showGroupForm"
          >
            {{ t('settings.documents.reimbursement.addGroup') }}
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

      <div v-if="showGroupForm" class="mb-3 flex items-center gap-2">
        <input
          v-model="newGroupName"
          class="w-48 rounded border px-2 py-1 text-sm"
          :placeholder="t('settings.documents.reimbursement.groupNamePlaceholder')"
          data-testid="reimbursement-new-group-name"
          @keydown.enter="addGroup"
        />
        <DcButton size="sm" data-testid="reimbursement-add-group-confirm" @click="addGroup">
          {{ t('settings.documents.reimbursement.confirm') }}
        </DcButton>
        <DcButton size="sm" variant="outline" @click="showGroupForm = false">
          {{ t('settings.documents.reimbursement.cancel') }}
        </DcButton>
      </div>

      <details v-if="selectedMaterials.length" class="mb-3 rounded border p-2 text-sm">
        <summary class="cursor-pointer">
          {{ t('settings.documents.reimbursement.materialsTitle') }}
        </summary>
        <ul class="mt-2 space-y-1">
          <li
            v-for="material in selectedMaterials"
            :key="material.name"
            class="flex items-center justify-between"
          >
            <span>{{ material.name }}</span>
            <DcBadge v-if="material.linkedTypeKeys.length" variant="outline">
              {{ t('settings.documents.reimbursement.materialCount', { count: material.count }) }}
            </DcBadge>
          </li>
        </ul>
      </details>

      <div v-for="group in selectedGroups" :key="group.person ?? '__unknown__'" class="mb-5">
        <h3 class="mb-2 text-sm font-medium">
          {{ group.person ?? t('settings.documents.reimbursement.unknownPerson') }}
        </h3>
        <div
          v-for="bucket in group.buckets"
          :key="bucket.period ?? '__unknown_period__'"
          class="mb-3"
        >
          <div class="mb-1 text-xs text-muted-foreground">
            {{ bucket.period ?? t('settings.documents.reimbursement.unknownPeriod') }}
          </div>
          <ReimbursementEntryRow
            v-for="entry in bucket.documents"
            :key="entry.id"
            :entry="entry"
            :groups="selectedCategoryGroups"
            :categories="store.reimbursementTree?.tree ?? []"
            :category-id="selectedCategoryId"
            :show-group-select="selectedCategoryId !== null"
            @move="onMove"
            @move-group="onMoveGroup"
          />
        </div>
      </div>
      <p
        v-if="!selectedGroups.length && !selectedCustomGroups.some((node) => node.buckets.length)"
        class="py-10 text-center text-sm text-muted-foreground"
      >
        {{
          store.reimbursementIsLoading
            ? t('settings.documents.reimbursement.loading')
            : t('settings.documents.reimbursement.empty')
        }}
      </p>

      <div v-if="selectedCategoryId !== null" class="mt-6 border-t pt-4">
        <h3 class="mb-3 text-sm font-medium">
          {{ t('settings.documents.reimbursement.customGroupsTitle') }}
        </h3>
        <p v-if="!selectedCustomGroups.length" class="text-xs text-muted-foreground">
          {{ t('settings.documents.reimbursement.customGroupsEmpty') }}
        </p>
        <div
          v-for="node in selectedCustomGroups"
          :key="node.group.id"
          class="mb-4 rounded border p-3"
          :data-testid="`reimbursement-custom-group-${node.group.id}`"
        >
          <div class="mb-2 flex items-center justify-between gap-2">
            <template v-if="editingGroupId === node.group.id">
              <input
                v-model="editingGroupName"
                class="w-48 rounded border px-2 py-1 text-sm"
                data-testid="reimbursement-group-name-input"
                @keydown.enter="confirmRename"
              />
              <DcButton size="sm" @click="confirmRename">
                {{ t('settings.documents.reimbursement.confirm') }}
              </DcButton>
              <DcButton size="sm" variant="outline" @click="editingGroupId = null">
                {{ t('settings.documents.reimbursement.cancel') }}
              </DcButton>
            </template>
            <template v-else>
              <span class="flex items-center gap-2 text-sm font-medium">
                {{ node.group.name }}
                <DcBadge variant="outline">{{ groupEntryCount(node) }}</DcBadge>
              </span>
              <div class="flex gap-1">
                <DcButton
                  size="sm"
                  variant="outline"
                  :data-testid="`reimbursement-group-rename-${node.group.id}`"
                  @click="startRename(node.group.id, node.group.name)"
                >
                  {{ t('settings.documents.reimbursement.renameGroup') }}
                </DcButton>
                <DcButton
                  size="sm"
                  variant="outline"
                  :data-testid="`reimbursement-group-delete-${node.group.id}`"
                  @click="removeGroup(node.group.id)"
                >
                  {{ t('settings.documents.reimbursement.deleteGroup') }}
                </DcButton>
              </div>
            </template>
          </div>
          <div v-for="bucket in node.buckets" :key="bucket.period ?? '__unknown__'" class="mb-3">
            <div class="mb-1 text-xs text-muted-foreground">
              {{ bucket.period ?? t('settings.documents.reimbursement.unknownPeriod') }}
            </div>
            <ReimbursementEntryRow
              v-for="entry in bucket.documents"
              :key="entry.id"
              :entry="entry"
              :groups="selectedCategoryGroups"
              :categories="store.reimbursementTree?.tree ?? []"
              :category-id="selectedCategoryId"
              :show-group-select="true"
              @move="onMove"
              @move-group="onMoveGroup"
            />
          </div>
          <p v-if="!node.buckets.length" class="text-xs text-muted-foreground">
            {{ t('settings.documents.reimbursement.groupEmpty') }}
          </p>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { DcBadge } from '@dc-ui/components/badge'
import { DcButton } from '@dc-ui/components/button'
import { rendererNotificationManager } from '@renderer-notifications/rendererNotificationRuntime'
import { createConfigClient } from '@api/ConfigClient'
import { REIMBURSEMENT_UNASSIGNED } from '@shared/documents'
import type { ReimbursementConfig } from '@shared/contracts/routes'
import { useDocumentsStore } from '@/stores/documents'
import ReimbursementEntryRow from './ReimbursementEntryRow.vue'

const { t } = useI18n()
const store = useDocumentsStore()
const configClient = createConfigClient()

const selectedCategoryId = ref<string | null>(null)
const userSelected = ref(false)
const exporting = ref(false)
const showGroupForm = ref(false)
const newGroupName = ref('')
const editingGroupId = ref<string | null>(null)
const editingGroupName = ref('')

onMounted(async () => {
  // Custom-group management needs the saved config; fetch it alongside the
  // tree without blocking the initial category selection on it.
  void store.loadReimbursementConfig().catch((error: unknown) => {
    console.error('[ReimbursementView] load reimbursement config failed', error)
  })
  await store.loadReimbursementTree()
  // Land on the first category so the main content is visible right away;
  // a selection made while loading wins, and the unassigned bucket stays
  // one click away in the aside.
  if (!userSelected.value) {
    selectedCategoryId.value = store.reimbursementTree?.tree[0]?.category.id ?? null
  }
})

function resetGroupFormState() {
  showGroupForm.value = false
  newGroupName.value = ''
  editingGroupId.value = null
  editingGroupName.value = ''
}

function selectCategory(id: string) {
  userSelected.value = true
  resetGroupFormState()
  selectedCategoryId.value = id
}

function selectUnassigned() {
  userSelected.value = true
  resetGroupFormState()
  selectedCategoryId.value = null
}

function retry() {
  void store.loadReimbursementTree()
}

const selectedNode = computed(
  () =>
    store.reimbursementTree?.tree.find((node) => node.category.id === selectedCategoryId.value) ??
    null
)
const selectedName = computed(
  () => selectedNode.value?.category.name ?? t('settings.documents.reimbursement.unassigned')
)
const selectedGroups = computed(() =>
  selectedCategoryId.value === null
    ? (store.reimbursementTree?.unassigned ?? [])
    : (selectedNode.value?.groups ?? [])
)
const selectedCustomGroups = computed(() => selectedNode.value?.customGroups ?? [])
const selectedCategoryGroups = computed(() => selectedNode.value?.category.customGroups ?? [])
const selectedMaterials = computed(() => selectedNode.value?.materials ?? [])
const unassignedTotal = computed(() =>
  (store.reimbursementTree?.unassigned ?? []).reduce((sum, group) => {
    return sum + group.buckets.reduce((total, bucket) => total + bucket.documents.length, 0)
  }, 0)
)

function notifyTransient(kind: 'success' | 'error', code: string, title: string) {
  try {
    rendererNotificationManager.notify({ kind, code, title })
  } catch (error) {
    console.error('[ReimbursementView] Failed to present notification', error)
  }
}

async function updateSelectedCategory(
  mutate: (
    category: ReimbursementConfig['categories'][number]
  ) => ReimbursementConfig['categories'][number]
): Promise<boolean> {
  try {
    const config = store.reimbursementConfig ?? (await store.loadReimbursementConfig())
    if (!config || selectedCategoryId.value === null) return false
    await store.saveReimbursementConfig({
      ...config,
      categories: config.categories.map((category) =>
        category.id === selectedCategoryId.value ? mutate(category) : category
      )
    })
    await store.loadReimbursementTree()
    return true
  } catch (error) {
    console.error('[ReimbursementView] update custom groups failed', error)
    notifyTransient(
      'error',
      'documents.reimbursement.groupSaveFailed',
      t('settings.documents.reimbursement.groupSaveFailed')
    )
    return false
  }
}

async function addGroup() {
  const name = newGroupName.value.trim()
  if (!name || selectedCategoryId.value === null) return
  const saved = await updateSelectedCategory((category) => ({
    ...category,
    customGroups: [
      ...category.customGroups,
      {
        id: `grp-${crypto.randomUUID().slice(0, 8)}`,
        name,
        sortOrder: category.customGroups.length
      }
    ]
  }))
  if (!saved) return
  newGroupName.value = ''
  showGroupForm.value = false
}

function startRename(groupId: string, name: string) {
  editingGroupId.value = groupId
  editingGroupName.value = name
}

async function confirmRename() {
  const groupId = editingGroupId.value
  const name = editingGroupName.value.trim()
  if (!groupId || !name) return
  const saved = await updateSelectedCategory((category) => ({
    ...category,
    customGroups: category.customGroups.map((group) =>
      group.id === groupId ? { ...group, name } : group
    )
  }))
  if (!saved) return
  editingGroupId.value = null
  editingGroupName.value = ''
}

async function removeGroup(groupId: string) {
  await updateSelectedCategory((category) => ({
    ...category,
    customGroups: category.customGroups.filter((group) => group.id !== groupId)
  }))
}

async function onMove(documentId: string, value: string) {
  const categoryId =
    value === '__auto__' ? null : value === '__unassigned__' ? REIMBURSEMENT_UNASSIGNED : value
  try {
    await store.setReimbursementOverride(documentId, categoryId)
  } catch (error) {
    console.error('[ReimbursementView] set override failed', error)
    notifyTransient(
      'error',
      'documents.reimbursement.moveFailed',
      t('settings.documents.reimbursement.moveFailed')
    )
  }
}

async function onMoveGroup(documentId: string, value: string) {
  const groupId = value === '__none__' ? null : value
  try {
    await store.setReimbursementGroupOverride(documentId, groupId)
  } catch (error) {
    console.error('[ReimbursementView] set group override failed', error)
    notifyTransient(
      'error',
      'documents.reimbursement.moveGroupFailed',
      t('settings.documents.reimbursement.moveGroupFailed')
    )
  }
}

function groupEntryCount(node: { buckets: Array<{ documents: unknown[] }> }) {
  return node.buckets.reduce((sum, bucket) => sum + bucket.documents.length, 0)
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
