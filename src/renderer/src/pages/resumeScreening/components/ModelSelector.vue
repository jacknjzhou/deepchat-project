<template>
  <div class="flex items-center justify-between text-sm">
    <span>{{ t('resumeScreening.modelLabel') }}</span>
    <Select
      :model-value="modelKey ?? ''"
      @update:model-value="(value) => emit('update:modelKey', String(value))"
    >
      <SelectTrigger class="h-8 min-w-48" data-testid="model-select-trigger">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="model in models" :key="modelKeyOf(model)" :value="modelKeyOf(model)">
          {{ model.providerName }} / {{ model.modelName }}
        </SelectItem>
      </SelectContent>
    </Select>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shadcn/components/ui/select'
import type { ResumeScreeningModelOption } from '@/stores/resumeScreening'

defineProps<{
  models: ResumeScreeningModelOption[]
  modelKey: string | null
}>()

const emit = defineEmits<{
  'update:modelKey': [key: string]
}>()

const { t } = useI18n()

function modelKeyOf(model: ResumeScreeningModelOption) {
  return `${model.providerId}::${model.modelId}`
}
</script>
