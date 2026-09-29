<template>
  <section class="flex min-h-0 flex-1 flex-col">
    <h3 class="mb-2 shrink-0 text-sm font-medium">
      {{ t('resumeScreening.historySection') }}
    </h3>
    <p
      v-if="tasksLoaded && tasks.length === 0"
      data-testid="history-empty"
      class="py-4 text-center text-sm text-muted-foreground"
    >
      {{ t('resumeScreening.historyEmpty') }}
    </p>
    <ul v-else class="min-h-0 flex-1 space-y-1 overflow-y-auto">
      <li
        v-for="task in tasks"
        :key="task.id"
        :data-testid="`history-item-${task.id}`"
        :class="[
          'cursor-pointer rounded-md border p-2 transition-colors hover:bg-muted/50',
          task.id === selectedId ? 'bg-muted' : ''
        ]"
        @click="emit('select', task.id)"
      >
        <div class="flex items-center justify-between gap-2">
          <DcBadge :variant="statusVariant(task.status)">
            {{ statusLabel(t, task.status) }}
          </DcBadge>
          <span class="text-xs text-muted-foreground">
            {{ task.succeeded + task.failed }}/{{ task.total }}
          </span>
        </div>
        <p class="mt-1 truncate text-xs text-muted-foreground">
          {{ new Date(task.createdAt).toLocaleString() }}
        </p>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { DcBadge } from '@dc-ui/components/badge'
import type { ResumeScreeningTaskDto } from '@api/resumeScreeningTasks'
import { statusLabel, statusVariant } from './statusPresentation'

defineProps<{
  tasks: ResumeScreeningTaskDto[]
  tasksLoaded: boolean
  selectedId: string | null
}>()

const emit = defineEmits<{
  select: [taskId: string]
}>()

const { t } = useI18n()
</script>
