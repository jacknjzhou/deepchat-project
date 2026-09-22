<template>
  <SettingsPageShell
    :title="pageTitle"
    :description="t('settings.documents.description')"
    :eyebrow="t('routes.settings-documents')"
    data-testid="template-editor-page"
  >
    <template v-if="notFound">
      <Alert variant="destructive">
        <Icon icon="lucide:circle-alert" class="size-4" />
        <AlertDescription>{{ t('settings.documents.editor.notFound') }}</AlertDescription>
      </Alert>
      <DcButton variant="outline" size="sm" data-testid="template-back" @click="goBack">
        <Icon icon="lucide:arrow-left" class="mr-2 size-4" />
        {{ t('settings.documents.editor.back') }}
      </DcButton>
    </template>

    <template v-else>
      <div class="mb-4 flex items-center justify-between">
        <DcButton variant="ghost" size="sm" data-testid="template-back" @click="goBack">
          <Icon icon="lucide:arrow-left" class="mr-2 size-4" />
          {{ t('settings.documents.editor.back') }}
        </DcButton>
        <div class="flex items-center gap-2">
          <Badge v-if="isReadonly" variant="secondary">
            {{ t('settings.documents.editor.builtinBadge') }}
          </Badge>
          <Badge v-if="isDirty" variant="outline">
            {{ t('settings.documents.editor.dirty') }}
          </Badge>
          <DcButton
            v-if="!isReadonly"
            size="sm"
            :disabled="isSaving"
            data-testid="template-save"
            @click="onSave"
          >
            <Spinner v-if="isSaving" class="mr-2 size-4" />
            <Icon v-else icon="lucide:save" class="mr-2 size-4" />
            {{
              isSaving ? t('settings.documents.editor.saving') : t('settings.documents.editor.save')
            }}
          </DcButton>
        </div>
      </div>

      <Alert v-if="saveError" variant="destructive" class="mb-4">
        <Icon icon="lucide:circle-alert" class="size-4" />
        <AlertDescription>{{ t('settings.documents.editor.saveFailed') }}</AlertDescription>
      </Alert>

      <SettingsSectionCard>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="text-sm font-medium" for="template-name">
              {{ t('settings.documents.editor.nameLabel') }}
            </label>
            <Input
              id="template-name"
              :model-value="draft.name"
              :placeholder="t('settings.documents.editor.namePlaceholder')"
              :disabled="isReadonly"
              data-testid="template-name"
              class="mt-1"
              @update:model-value="(value) => updateField('name', String(value))"
            />
            <p v-if="errors.name" class="mt-1 text-xs text-destructive">
              {{ t('settings.documents.editor.nameRequired') }}
            </p>
          </div>
          <div>
            <label class="text-sm font-medium" for="template-type-key">
              {{ t('settings.documents.editor.typeKeyLabel') }}
            </label>
            <Input
              id="template-type-key"
              :model-value="draft.typeKey"
              :placeholder="t('settings.documents.editor.typeKeyHint')"
              :disabled="isReadonly || isEditing"
              data-testid="template-type-key"
              class="mt-1"
              @update:model-value="(value) => updateField('typeKey', String(value))"
            />
            <p v-if="errors.typeKeyInvalid" class="mt-1 text-xs text-destructive">
              {{ t('settings.documents.editor.typeKeyInvalid') }}
            </p>
            <p v-else-if="errors.typeKeyTaken" class="mt-1 text-xs text-destructive">
              {{ t('settings.documents.editor.typeKeyTaken', { typeKey: draft.typeKey }) }}
            </p>
            <p v-else class="mt-1 text-xs text-muted-foreground">
              {{
                isEditing
                  ? t('settings.documents.editor.typeKeyImmutableHint')
                  : t('settings.documents.editor.typeKeyHint')
              }}
            </p>
          </div>
          <div>
            <label class="text-sm font-medium" for="template-icon">
              {{ t('settings.documents.editor.iconLabel') }}
            </label>
            <Input
              id="template-icon"
              :model-value="draft.icon ?? ''"
              :placeholder="t('settings.documents.editor.iconPlaceholder')"
              :disabled="isReadonly"
              data-testid="template-icon"
              class="mt-1"
              @update:model-value="(value) => updateField('icon', String(value))"
            />
          </div>
          <div>
            <label class="text-sm font-medium">{{
              t('settings.documents.editor.extractionModeLabel')
            }}</label>
            <Select
              :model-value="draft.extractionMode"
              :disabled="isReadonly"
              @update:model-value="
                (value) => updateField('extractionMode', value as DocumentExtractionMode)
              "
            >
              <SelectTrigger class="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in extractionModes" :key="option" :value="option">
                  {{ t(`settings.documents.editor.mode.${option}`) }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p class="mt-1 text-xs text-muted-foreground">
              {{ t('settings.documents.editor.extractionModeHint') }}
            </p>
          </div>
        </div>

        <div class="mt-4">
          <label class="text-sm font-medium" for="template-prompt-preset">
            {{ t('settings.documents.editor.promptPresetLabel') }}
          </label>
          <Textarea
            id="template-prompt-preset"
            :model-value="draft.promptPreset ?? ''"
            :placeholder="t('settings.documents.editor.promptPresetPlaceholder')"
            :disabled="isReadonly"
            data-testid="template-prompt-preset"
            class="mt-1 min-h-[80px]"
            @update:model-value="(value) => updateField('promptPreset', String(value))"
          />
        </div>
      </SettingsSectionCard>

      <SettingsSectionCard class="mt-4">
        <TemplateFieldsEditor
          :fields="editableFields"
          :readonly="isReadonly"
          @update:fields="updateFields"
          @add="addField"
        />
      </SettingsSectionCard>

      <div v-if="isReadonly" class="mt-4">
        <Alert>
          <Icon icon="lucide:info" class="size-4" />
          <AlertDescription>{{ t('settings.documents.editor.readonlyHint') }}</AlertDescription>
        </Alert>
        <DcButton
          variant="default"
          size="sm"
          class="mt-3"
          data-testid="builtin-fork-cta"
          @click="forkBuiltin"
        >
          <Icon icon="lucide:copy" class="mr-2 size-4" />
          {{ t('settings.documents.editor.forkCta') }}
        </DcButton>
      </div>

      <TemplateTestExtract v-if="savedId" :template-id="savedId" class="mt-4" />
    </template>
  </SettingsPageShell>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Input } from '@shadcn/components/ui/input'
import { Textarea } from '@shadcn/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shadcn/components/ui/select'
import { Badge } from '@shadcn/components/ui/badge'
import { Alert, AlertDescription } from '@shadcn/components/ui/alert'
import { Spinner } from '@shadcn/components/ui/spinner'
import { DcButton } from '@dc-ui/components/button'
import SettingsPageShell from '../control-center/SettingsPageShell.vue'
import SettingsSectionCard from '../control-center/SettingsSectionCard.vue'
import TemplateFieldsEditor from './TemplateFieldsEditor.vue'
import TemplateTestExtract from './TemplateTestExtract.vue'
import { useDocumentsStore, type EditableTemplateDraft } from '@/stores/documents'
import { settingsLeaveGuard } from '../../services/settingsLeaveGuard'
import {
  DOCUMENT_EXTRACTION_MODES,
  type DocumentExtractionMode,
  type DocumentTemplate,
  type DocumentTemplateCategory,
  type DocumentTemplateField
} from '@shared/documents'
import {
  addField as addFieldHelper,
  createEmptyField,
  isTypeKeyValid,
  normalizeOrders,
  validateFields,
  type EditableField
} from './templateFields'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const store = useDocumentsStore()

const extractionModes = DOCUMENT_EXTRACTION_MODES

const notFound = ref(false)
const isSaving = ref(false)
const saveError = ref(false)
const isDirty = ref(false)
const savedId = ref<string | undefined>(undefined)

interface Draft {
  id?: string
  typeKey: string
  name: string
  icon: string | null
  category: DocumentTemplateCategory
  fields: EditableField[]
  extractionMode: DocumentExtractionMode
  promptPreset: string | null
  isBuiltin: boolean
  builtinSourceId?: string | null
}

const draft = reactive<Draft>({
  typeKey: '',
  name: '',
  icon: null,
  category: '自定义',
  fields: [],
  extractionMode: 'auto',
  promptPreset: null,
  isBuiltin: false,
  builtinSourceId: null
})

let savedSnapshot: Draft | null = null

const isEditing = computed(() => Boolean(draft.id))
const isReadonly = computed(() => draft.isBuiltin)
const pageTitle = computed(() =>
  isEditing.value ? draft.name : t('settings.documents.editor.newTitle')
)

const editableFields = computed(() => draft.fields)

const errors = computed(() => ({
  name: !draft.name.trim(),
  typeKeyInvalid: !isTypeKeyValid(draft.typeKey),
  typeKeyTaken: isTypeKeyValid(draft.typeKey) && store.isTypeKeyTaken(draft.typeKey, draft.id)
}))

const fieldValidation = computed(() => validateFields(draft.fields))

const leaveGuardLease = settingsLeaveGuard.register({
  id: 'documents-template-editor',
  onDiscard: () => {
    if (savedSnapshot) {
      Object.assign(draft, savedSnapshot)
      draft.fields = savedSnapshot.fields.map((f) => ({ ...f }))
      isDirty.value = false
    }
  }
})

watch(
  draft,
  () => {
    const dirty = !savedSnapshot || !shallowEqualDraft(draft, savedSnapshot)
    isDirty.value = dirty
    leaveGuardLease.setRisk(dirty ? 'dirty' : 'clean')
  },
  { deep: true }
)

onBeforeUnmount(() => {
  leaveGuardLease.release()
})

function shallowEqualDraft(a: Draft, b: Draft | null): boolean {
  if (!b) return false
  return (
    a.id === b.id &&
    a.typeKey === b.typeKey &&
    a.name === b.name &&
    a.icon === b.icon &&
    a.category === b.category &&
    a.extractionMode === b.extractionMode &&
    a.promptPreset === b.promptPreset &&
    a.fields.length === b.fields.length &&
    a.fields.every((f, i) => shallowEqualField(f, b.fields[i]))
  )
}

function shallowEqualField(a: EditableField, b: EditableField): boolean {
  return (
    a.key === b.key &&
    a.label === b.label &&
    a.valueType === b.valueType &&
    a.required === b.required &&
    a.promptHint === b.promptHint &&
    a.validation === b.validation &&
    a.enumOptions === b.enumOptions &&
    a.order === b.order
  )
}

async function loadTemplate(id: string) {
  if (id === 'new') {
    const forkFrom = route.query.forkFrom as string | undefined
    if (forkFrom) {
      const source = store.templates.find((t) => t.id === forkFrom)
      if (source) {
        applyTemplateToDraft(source, { fork: true })
      } else {
        await store.loadTemplates()
        const fetched = store.templates.find((t) => t.id === forkFrom)
        if (fetched) applyTemplateToDraft(fetched, { fork: true })
      }
    }
    savedSnapshot = null
    return
  }

  let template: DocumentTemplate | undefined = store.templates.find((t) => t.id === id)
  if (!template) {
    await store.loadTemplates()
    template = store.templates.find((t) => t.id === id)
  }
  if (!template) {
    notFound.value = true
    return
  }
  applyTemplateToDraft(template)
  savedId.value = template.id
}

function applyTemplateToDraft(template: DocumentTemplate, options?: { fork?: boolean }) {
  draft.id = options?.fork ? undefined : template.id
  draft.typeKey = options?.fork ? '' : template.typeKey
  draft.name = template.name
  draft.icon = template.icon
  draft.category = template.category
  draft.fields = template.fields.map((f) => toEditableField(f))
  draft.extractionMode = template.extractionMode
  draft.promptPreset = template.promptPreset
  // A fork is always a new custom template, even when forked from a builtin.
  draft.isBuiltin = options?.fork ? false : template.isBuiltin
  draft.builtinSourceId = options?.fork ? template.id : template.builtinSourceId
  savedSnapshot = JSON.parse(JSON.stringify(draft))
}

function toEditableField(field: DocumentTemplateField): EditableField {
  return {
    key: field.key,
    label: field.label,
    valueType: field.valueType,
    required: field.required,
    promptHint: field.promptHint ?? '',
    validation: field.validation ?? '',
    enumOptions: field.enumOptions?.join(', ') ?? '',
    order: field.order
  }
}

function updateField<K extends keyof Draft>(key: K, value: Draft[K]) {
  draft[key] = value
}

function updateFields(fields: EditableField[]) {
  draft.fields = normalizeOrders(fields)
}

function addField() {
  draft.fields = addFieldHelper(draft.fields, createEmptyField(draft.fields.length + 1))
}

async function onSave() {
  if (errors.value.name) return
  if (errors.value.typeKeyInvalid || errors.value.typeKeyTaken) return
  if (Object.keys(fieldValidation.value).length > 0) return

  isSaving.value = true
  saveError.value = false
  try {
    const input: EditableTemplateDraft = {
      typeKey: draft.typeKey,
      name: draft.name,
      icon: draft.icon || null,
      category: draft.category,
      fields: draft.fields.map((f) => ({
        key: f.key,
        label: f.label,
        valueType: f.valueType,
        required: f.required,
        promptHint: f.promptHint || null,
        validation: f.validation || null,
        enumOptions: f.enumOptions
          ? f.enumOptions
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : null,
        order: f.order
      })),
      extractionMode: draft.extractionMode,
      promptPreset: draft.promptPreset || null,
      ...(draft.id ? { id: draft.id } : {}),
      ...(draft.builtinSourceId ? { builtinSourceId: draft.builtinSourceId } : {})
    }
    const saved = await store.saveTemplate(input)
    draft.id = saved.id
    savedId.value = saved.id
    savedSnapshot = JSON.parse(JSON.stringify(draft))
    isDirty.value = false
    leaveGuardLease.setRisk('clean')
  } catch (error) {
    console.error('[TemplateEditorPage] save failed', error)
    saveError.value = true
  } finally {
    isSaving.value = false
  }
}

function forkBuiltin() {
  if (!draft.builtinSourceId && !draft.id) return
  const sourceId = draft.builtinSourceId ?? draft.id!
  router.push({
    name: 'settings-documents-template',
    params: { id: 'new' },
    query: { forkFrom: sourceId }
  })
}

function goBack() {
  router.push({ name: 'settings-documents' })
}

loadTemplate(route.params.id as string)

// The route reuses this component instance when the fork CTA pushes
// /documents/template/new?forkFrom=... from an existing template page.
watch(
  () => route.params.id,
  (nextId) => {
    notFound.value = false
    savedId.value = undefined
    saveError.value = false
    loadTemplate(nextId as string)
  }
)
</script>
