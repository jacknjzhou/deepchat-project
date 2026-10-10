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
