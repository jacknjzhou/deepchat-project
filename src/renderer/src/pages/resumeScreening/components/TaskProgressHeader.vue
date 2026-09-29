<template>
  <div class="rounded-lg border p-4">
    <div class="flex items-center gap-2">
      <DcBadge :variant="statusVariant(task.status)">
        {{ statusLabel(t, task.status) }}
      </DcBadge>
      <span class="min-w-0 truncate text-xs text-muted-foreground">
        {{ task.providerId }} / {{ task.modelId }}
      </span>
    </div>

    <div class="mt-3 grid grid-cols-5 gap-2 text-center text-sm">
      <div data-testid="progress-total">
        <p class="text-lg font-semibold">{{ task.total }}</p>
        <p class="text-xs text-muted-foreground">{{ t('resumeScreening.progressTotal') }}</p>
      </div>
      <div data-testid="progress-succeeded">
        <p class="text-lg font-semibold">{{ task.succeeded }}</p>
        <p class="text-xs text-muted-foreground">{{ t('resumeScreening.progressSucceeded') }}</p>
      </div>
      <div data-testid="progress-failed">
        <p class="text-lg font-semibold">{{ task.failed }}</p>
        <p class="text-xs text-muted-foreground">{{ t('resumeScreening.progressFailed') }}</p>
      </div>
      <div data-testid="progress-avg-score">
        <p class="text-lg font-semibold">{{ task.avgScore ?? '—' }}</p>
        <p class="text-xs text-muted-foreground">{{ t('resumeScreening.progressAvgScore') }}</p>
      </div>
      <div data-testid="progress-recommended">
        <p class="text-lg font-semibold">{{ task.recommendedCount }}</p>
        <p class="text-xs text-muted-foreground">{{ t('resumeScreening.progressRecommended') }}</p>
      </div>
    </div>

    <div class="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        class="h-full rounded-full bg-primary transition-all"
        :style="{ width: `${progressPercent}%` }"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { DcBadge } from '@dc-ui/components/badge'
import type { ResumeScreeningTaskDto } from '@api/resumeScreeningTasks'
import { statusLabel, statusVariant } from './statusPresentation'

const props = defineProps<{
  task: ResumeScreeningTaskDto
}>()

const { t } = useI18n()

// 已处理（成功+失败）/总数，total=0 时显示 0% 避免除零
const progressPercent = computed(() => {
  if (props.task.total === 0) return 0
  return Math.round(((props.task.succeeded + props.task.failed) / props.task.total) * 100)
})
</script>
