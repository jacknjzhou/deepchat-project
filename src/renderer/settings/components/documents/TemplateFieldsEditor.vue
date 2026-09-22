<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-medium">{{ t('settings.documents.editor.fieldsTitle') }}</h3>
      <DcButton
        v-if="!readonly"
        variant="outline"
        size="sm"
        data-testid="field-add"
        @click="emit('add')"
      >
        <Icon icon="lucide:plus" class="mr-1 size-4" />
        {{ t('settings.documents.editor.addField') }}
      </DcButton>
    </div>

    <div ref="listRef" class="space-y-2">
      <div
        v-for="(field, index) in fields"
        :key="index"
        data-testid="field-row"
        class="grid grid-cols-1 gap-2 rounded-lg border p-3 sm:grid-cols-[auto_1fr_1fr_1fr_auto]"
      >
        <Icon
          v-if="!readonly"
          icon="lucide:grip-vertical"
          class="lucide-grip-vertical size-4 cursor-grab self-center text-muted-foreground"
        />
        <Input
          :model-value="field.key"
          :placeholder="t('settings.documents.editor.fieldKey')"
          :disabled="readonly"
          data-testid="field-key"
          @update:model-value="(value) => update(index, { key: String(value) })"
        />
        <Input
          :model-value="field.label"
          :placeholder="t('settings.documents.editor.fieldLabel')"
          :disabled="readonly"
          data-testid="field-label"
          @update:model-value="(value) => update(index, { label: String(value) })"
        />
        <Select
          :model-value="field.valueType"
          :disabled="readonly"
          @update:model-value="
            (value) => update(index, { valueType: value as DocumentFieldValueType })
          "
        >
          <SelectTrigger data-testid="field-type-trigger">
            <SelectValue :placeholder="t('settings.documents.editor.fieldType')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in valueTypes" :key="option" :value="option">
              {{ t(`settings.documents.valueType.${option}`) }}
            </SelectItem>
          </SelectContent>
        </Select>
        <div class="flex items-center gap-2">
          <Switch
            :model-value="field.required"
            :disabled="readonly"
            :aria-label="t('settings.documents.editor.fieldRequired')"
            data-testid="field-required"
            @update:model-value="(value: boolean) => update(index, { required: value })"
          />
          <DcButton
            v-if="!readonly"
            variant="ghost"
            size="icon"
            data-testid="field-delete"
            @click="requestDelete(index)"
          >
            <Icon icon="lucide:trash-2" class="size-4" />
          </DcButton>
        </div>
        <div v-if="!readonly" class="grid gap-2 sm:col-span-4 sm:col-start-2 sm:grid-cols-2">
          <Input
            :model-value="field.promptHint"
            :placeholder="t('settings.documents.editor.fieldPromptHint')"
            :aria-label="t('settings.documents.editor.fieldPromptHint')"
            data-testid="field-prompt-hint"
            @update:model-value="(value) => update(index, { promptHint: String(value) })"
          />
          <Input
            :model-value="field.validation"
            :placeholder="t('settings.documents.editor.fieldValidationHint')"
            :aria-label="t('settings.documents.editor.fieldValidation')"
            data-testid="field-validation"
            @update:model-value="(value) => update(index, { validation: String(value) })"
          />
          <Input
            v-if="field.valueType === 'enum'"
            :model-value="field.enumOptions"
            class="sm:col-span-2"
            :placeholder="t('settings.documents.editor.fieldEnumOptionsHint')"
            :aria-label="t('settings.documents.editor.fieldEnumOptions')"
            data-testid="field-enum-options"
            @update:model-value="(value) => update(index, { enumOptions: String(value) })"
          />
        </div>
      </div>
    </div>

    <AlertDialog v-model:open="confirmOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {{ t('settings.documents.editor.fieldDeleteRequiredConfirmTitle') }}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {{
              t('settings.documents.editor.fieldDeleteRequiredConfirmDescription', {
                label: pendingLabel
              })
            }}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="field-delete-cancel">
            {{ t('common.cancel') }}
          </AlertDialogCancel>
          <AlertDialogAction data-testid="field-delete-confirm" @click="confirmDelete">
            {{ t('common.confirm') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSortable } from '@vueuse/integrations/useSortable'
import { Icon } from '@iconify/vue'
import { useI18n } from 'vue-i18n'
import { Input } from '@shadcn/components/ui/input'
import { Switch } from '@shadcn/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shadcn/components/ui/select'
import { DcButton } from '@dc-ui/components/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@shadcn/components/ui/alert-dialog'
import { DOCUMENT_FIELD_VALUE_TYPES, type DocumentFieldValueType } from '@shared/documents'
import { moveField, removeField, updateField, type EditableField } from './templateFields'

const props = defineProps<{
  fields: EditableField[]
  readonly?: boolean
}>()

const emit = defineEmits<{
  'update:fields': [fields: EditableField[]]
  add: []
}>()

const { t } = useI18n()
const valueTypes = DOCUMENT_FIELD_VALUE_TYPES

const listRef = ref<HTMLElement | null>(null)
const confirmOpen = ref(false)
const pendingIndex = ref<number | null>(null)
const pendingLabel = computed(() =>
  pendingIndex.value !== null ? (props.fields[pendingIndex.value]?.label ?? '') : ''
)

const sortable = useSortable(listRef, props.fields, {
  animation: 150,
  handle: '.lucide-grip-vertical',
  disabled: props.readonly === true,
  onEnd: (event) => {
    if (event.oldIndex === undefined || event.newIndex === undefined) return
    emit('update:fields', moveField(props.fields, event.oldIndex, event.newIndex))
  }
})

watch(
  () => props.readonly === true,
  (next) => sortable.option('disabled', next)
)

function update(index: number, patch: Partial<EditableField>) {
  emit('update:fields', updateField(props.fields, index, patch))
}

function requestDelete(index: number) {
  const field = props.fields[index]
  if (field?.required) {
    pendingIndex.value = index
    confirmOpen.value = true
    return
  }
  emit('update:fields', removeField(props.fields, index))
}

function confirmDelete() {
  if (pendingIndex.value !== null) {
    emit('update:fields', removeField(props.fields, pendingIndex.value))
  }
  pendingIndex.value = null
  confirmOpen.value = false
}
</script>
