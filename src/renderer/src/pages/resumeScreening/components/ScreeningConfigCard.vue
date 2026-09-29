<template>
  <div class="rounded-lg border p-4">
    <h2 class="text-sm font-medium">{{ t('resumeScreening.configSection') }}</h2>

    <div class="mt-3 space-y-3">
      <div class="flex items-center justify-between text-sm" data-testid="config-explanation">
        <span>{{ t('resumeScreening.configGenerateExplanation') }}</span>
        <Switch
          :model-value="config.generateExplanation"
          @update:model-value="(value) => update({ generateExplanation: Boolean(value) })"
        />
      </div>
      <div class="flex items-center justify-between text-sm" data-testid="config-raw-text">
        <span>{{ t('resumeScreening.configIncludeRawText') }}</span>
        <Switch
          :model-value="config.includeRawText"
          @update:model-value="(value) => update({ includeRawText: Boolean(value) })"
        />
      </div>
      <div class="flex items-center justify-between text-sm">
        <span>{{ t('resumeScreening.configMaxConcurrency') }}</span>
        <Select
          :model-value="String(config.maxConcurrency)"
          @update:model-value="(value) => update({ maxConcurrency: Number(value) })"
        >
          <SelectTrigger class="h-8 w-20" data-testid="config-concurrency-trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="n in 5" :key="n" :value="String(n)">{{ n }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Switch } from '@shadcn/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shadcn/components/ui/select'

export interface ScreeningConfig {
  generateExplanation: boolean
  includeRawText: boolean
  maxConcurrency: number
}

const props = defineProps<{
  config: ScreeningConfig
}>()

const emit = defineEmits<{
  'update:config': [config: ScreeningConfig]
}>()

const { t } = useI18n()

function update(patch: Partial<ScreeningConfig>) {
  emit('update:config', { ...props.config, ...patch })
}
</script>
