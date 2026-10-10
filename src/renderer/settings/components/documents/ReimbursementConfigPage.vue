<template>
  <SettingsPageShell
    :title="t('settings.documents.reimbursement.configTitle')"
    :eyebrow="t('routes.settings-documents-reimbursement')"
    data-testid="reimbursement-config-page"
  >
    <Alert v-if="loadError" variant="destructive" data-testid="reimbursement-config-load-error">
      <Icon icon="lucide:circle-alert" class="size-4" />
      <AlertDescription class="flex flex-col items-start gap-3">
        <span>{{ t('settings.documents.reimbursement.loadFailed') }}</span>
        <DcButton
          variant="outline"
          size="sm"
          data-testid="reimbursement-config-retry"
          @click="retryLoad"
        >
          {{ t('settings.documents.reimbursement.retry') }}
        </DcButton>
      </AlertDescription>
    </Alert>

    <SettingsSectionCard :title="t('settings.documents.reimbursement.categoriesTitle')">
      <DcButton
        variant="outline"
        size="sm"
        data-testid="reimbursement-add-category"
        @click="addCategory"
      >
        <Icon icon="lucide:plus" class="mr-2 size-4" />
        {{ t('settings.documents.reimbursement.addCategory') }}
      </DcButton>

      <div
        v-for="(category, index) in draft.categories"
        :key="category.id"
        class="mt-4 rounded-md border p-3"
      >
        <div class="flex flex-wrap items-center gap-2">
          <Input
            :model-value="category.name"
            maxlength="50"
            data-testid="reimbursement-category-name"
            class="min-w-0 flex-1"
            @update:model-value="(value) => updateCategoryName(category, String(value))"
          />
          <DcButton
            variant="ghost"
            size="sm"
            :disabled="index === 0"
            data-testid="reimbursement-category-move-up"
            @click="moveCategory(index, -1)"
          >
            <Icon icon="lucide:arrow-up" class="size-4" />
          </DcButton>
          <DcButton
            variant="ghost"
            size="sm"
            :disabled="index === draft.categories.length - 1"
            data-testid="reimbursement-category-move-down"
            @click="moveCategory(index, 1)"
          >
            <Icon icon="lucide:arrow-down" class="size-4" />
          </DcButton>
          <DcButton
            variant="ghost"
            size="sm"
            data-testid="reimbursement-category-remove"
            @click="removeCategory(index)"
          >
            <Icon icon="lucide:trash-2" class="size-4" />
          </DcButton>
        </div>
        <div class="mt-3">
          <label class="text-sm font-medium">
            {{ t('settings.documents.reimbursement.linkedTypeKeys') }}
          </label>
          <Input
            :model-value="category.linkedTypeKeys.join(', ')"
            data-testid="reimbursement-category-linked"
            class="mt-1"
            @update:model-value="(value) => updateCategoryLinkedKeys(category, String(value))"
          />
        </div>
        <div class="mt-3 border-t pt-3">
          <div class="mb-2 flex items-center justify-between">
            <span class="text-sm font-medium">
              {{ t('settings.documents.reimbursement.materials') }}
            </span>
            <DcButton
              variant="ghost"
              size="sm"
              data-testid="reimbursement-add-material"
              @click="addMaterial(category)"
            >
              <Icon icon="lucide:plus" class="mr-2 size-4" />
              {{ t('settings.documents.reimbursement.addMaterial') }}
            </DcButton>
          </div>
          <div
            v-for="(material, materialIndex) in category.requiredMaterials"
            :key="materialIndex"
            class="mb-2 flex flex-wrap items-center gap-2"
          >
            <Input
              :model-value="material.name"
              maxlength="100"
              data-testid="reimbursement-material-name"
              class="min-w-0 flex-1"
              @update:model-value="
                (value) => updateMaterialName(category, materialIndex, String(value))
              "
            />
            <Input
              :model-value="material.linkedTypeKeys.join(', ')"
              :placeholder="t('settings.documents.reimbursement.materialLinkedPlaceholder')"
              data-testid="reimbursement-material-linked"
              class="min-w-0 flex-1"
              @update:model-value="
                (value) => updateMaterialLinkedKeys(category, materialIndex, String(value))
              "
            />
            <DcButton
              variant="ghost"
              size="sm"
              data-testid="reimbursement-material-remove"
              @click="removeMaterial(category, materialIndex)"
            >
              <Icon icon="lucide:trash-2" class="size-4" />
            </DcButton>
          </div>
        </div>
      </div>
    </SettingsSectionCard>

    <SettingsSectionCard :title="t('settings.documents.reimbursement.globalTitle')">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label class="text-sm font-medium">
            {{ t('settings.documents.reimbursement.personFieldKeys') }}
          </label>
          <Input
            :model-value="draft.personFieldKeys.join(', ')"
            data-testid="reimbursement-global-person"
            class="mt-1"
            @update:model-value="(value) => updateGlobalKeys(draft.personFieldKeys, String(value))"
          />
        </div>
        <div>
          <label class="text-sm font-medium">
            {{ t('settings.documents.reimbursement.dateFieldKeys') }}
          </label>
          <Input
            :model-value="draft.dateFieldKeys.join(', ')"
            data-testid="reimbursement-global-date"
            class="mt-1"
            @update:model-value="(value) => updateGlobalKeys(draft.dateFieldKeys, String(value))"
          />
        </div>
        <div>
          <label class="text-sm font-medium">
            {{ t('settings.documents.reimbursement.amountFieldKeys') }}
          </label>
          <Input
            :model-value="draft.amountFieldKeys.join(', ')"
            data-testid="reimbursement-global-amount"
            class="mt-1"
            @update:model-value="(value) => updateGlobalKeys(draft.amountFieldKeys, String(value))"
          />
        </div>
      </div>
      <div class="mt-4">
        <label class="text-sm font-medium" for="reimbursement-date-grouping">
          {{ t('settings.documents.reimbursement.dateGrouping') }}
        </label>
        <select
          id="reimbursement-date-grouping"
          class="mt-1 h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          data-testid="reimbursement-date-grouping"
          :value="draft.dateGrouping"
          @change="onDateGroupingChange"
        >
          <option value="month">{{ t('settings.documents.reimbursement.groupByMonth') }}</option>
          <option value="day">{{ t('settings.documents.reimbursement.groupByDay') }}</option>
        </select>
      </div>
    </SettingsSectionCard>

    <Alert v-if="validationError" variant="destructive" data-testid="reimbursement-config-error">
      <Icon icon="lucide:circle-alert" class="size-4" />
      <AlertDescription>{{ t(validationError) }}</AlertDescription>
    </Alert>

    <div class="flex items-center justify-end gap-2">
      <DcButton
        variant="outline"
        size="sm"
        :disabled="!isLoaded || isSaving"
        data-testid="reimbursement-config-reset"
        @click="onReset"
      >
        {{ t('settings.documents.reimbursement.reset') }}
      </DcButton>
      <DcButton
        size="sm"
        :disabled="!!validationError || isSaving || !isLoaded"
        data-testid="reimbursement-config-save"
        @click="onSave"
      >
        <Spinner v-if="isSaving" class="mr-2 size-4" />
        {{ t('settings.documents.reimbursement.save') }}
      </DcButton>
    </div>
  </SettingsPageShell>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Input } from '@shadcn/components/ui/input'
import { Alert, AlertDescription } from '@shadcn/components/ui/alert'
import { Spinner } from '@shadcn/components/ui/spinner'
import { DcButton } from '@dc-ui/components/button'
import SettingsPageShell from '../control-center/SettingsPageShell.vue'
import SettingsSectionCard from '../control-center/SettingsSectionCard.vue'
import { rendererNotificationManager } from '@renderer-notifications/rendererNotificationRuntime'
import type { ReimbursementConfig } from '@shared/contracts/routes'
import { useDocumentsStore } from '@/stores/documents'

type ReimbursementCategory = ReimbursementConfig['categories'][number]

// Must stay in sync with reimbursementTypeKeySchema in documents.routes.ts.
const TYPE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/
const TYPE_KEY_MAX_LENGTH = 64

function isInvalidTypeKey(typeKey: string): boolean {
  return typeKey.length > TYPE_KEY_MAX_LENGTH || !TYPE_KEY_PATTERN.test(typeKey)
}

const { t } = useI18n()
const store = useDocumentsStore()

const isSaving = ref(false)
const isLoaded = ref(false)
const loadError = ref(false)

const draft = reactive<ReimbursementConfig>({
  version: 1,
  categories: [],
  personFieldKeys: [],
  dateFieldKeys: [],
  amountFieldKeys: [],
  dateGrouping: 'month'
})

const validationError = computed<string | null>(() => {
  const seenNames = new Set<string>()
  for (const category of draft.categories) {
    const name = category.name.trim()
    if (!name) {
      return 'settings.documents.reimbursement.errorNameRequired'
    }
    if (seenNames.has(name)) {
      return 'settings.documents.reimbursement.errorNameDuplicate'
    }
    seenNames.add(name)
    if (category.linkedTypeKeys.some(isInvalidTypeKey)) {
      return 'settings.documents.reimbursement.errorTypeKeyInvalid'
    }
    for (const material of category.requiredMaterials) {
      if (!material.name.trim()) {
        return 'settings.documents.reimbursement.errorMaterialName'
      }
      if (material.linkedTypeKeys.some(isInvalidTypeKey)) {
        return 'settings.documents.reimbursement.errorTypeKeyInvalid'
      }
    }
  }
  return null
})

onMounted(() => {
  void retryLoad()
})

async function loadDraft() {
  const config = store.reimbursementConfig ?? (await store.loadReimbursementConfig())
  applyConfig(config)
}

async function retryLoad() {
  loadError.value = false
  try {
    await loadDraft()
    isLoaded.value = true
  } catch (error) {
    console.error('[ReimbursementConfigPage] load failed', error)
    loadError.value = true
  }
}

function applyConfig(config: ReimbursementConfig) {
  // toRaw first: structuredClone cannot clone reactive proxies.
  Object.assign(draft, structuredClone(toRaw(config)))
}

function parseKeyList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function updateCategoryName(category: ReimbursementCategory, value: string) {
  category.name = value
}

function updateCategoryLinkedKeys(category: ReimbursementCategory, value: string) {
  category.linkedTypeKeys = parseKeyList(value)
}

function updateGlobalKeys(target: string[], value: string) {
  const parsed = parseKeyList(value)
  target.splice(0, target.length, ...parsed)
}

function updateMaterialName(category: ReimbursementCategory, materialIndex: number, value: string) {
  const material = category.requiredMaterials[materialIndex]
  if (material) {
    material.name = value
  }
}

function updateMaterialLinkedKeys(
  category: ReimbursementCategory,
  materialIndex: number,
  value: string
) {
  const material = category.requiredMaterials[materialIndex]
  if (material) {
    material.linkedTypeKeys = parseKeyList(value)
  }
}

function addCategory() {
  draft.categories.push({
    id: `cat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    requiredMaterials: [],
    linkedTypeKeys: [],
    sortOrder: draft.categories.length + 1
  })
}

function removeCategory(index: number) {
  draft.categories.splice(index, 1)
  renumberCategories()
}

function moveCategory(index: number, delta: number) {
  const targetIndex = index + delta
  if (targetIndex < 0 || targetIndex >= draft.categories.length) {
    return
  }
  const [moved] = draft.categories.splice(index, 1)
  draft.categories.splice(targetIndex, 0, moved)
  renumberCategories()
}

function renumberCategories() {
  draft.categories.forEach((category, index) => {
    category.sortOrder = index + 1
  })
}

function addMaterial(category: ReimbursementCategory) {
  category.requiredMaterials.push({ name: '', linkedTypeKeys: [] })
}

function removeMaterial(category: ReimbursementCategory, materialIndex: number) {
  category.requiredMaterials.splice(materialIndex, 1)
}

function onDateGroupingChange(event: Event) {
  draft.dateGrouping = (event.target as HTMLSelectElement).value === 'day' ? 'day' : 'month'
}

function notifyTransient(kind: 'success' | 'error', code: string, title: string) {
  try {
    rendererNotificationManager.notify({ kind, code, title })
  } catch (error) {
    console.error('[ReimbursementConfigPage] Failed to present notification', error)
  }
}

async function onReset() {
  if (isSaving.value) {
    return
  }
  try {
    const config = await store.loadReimbursementConfig()
    applyConfig(config)
  } catch (error) {
    console.error('[ReimbursementConfigPage] reset failed', error)
    loadError.value = true
  }
}

async function onSave() {
  if (validationError.value !== null || isSaving.value) {
    return
  }
  isSaving.value = true
  try {
    const payload = structuredClone(toRaw(draft))
    payload.categories = payload.categories.map((category, index) => ({
      ...category,
      sortOrder: index + 1
    }))
    const saved = await store.saveReimbursementConfig(payload)
    applyConfig(saved)
    notifyTransient(
      'success',
      'documents.reimbursement.configSaved',
      t('documents.reimbursement.configSaved')
    )
  } catch (error) {
    console.error('[ReimbursementConfigPage] save failed', error)
    notifyTransient(
      'error',
      'documents.reimbursement.configSaveFailed',
      t('documents.reimbursement.configSaveFailed')
    )
  } finally {
    isSaving.value = false
  }
}
</script>
