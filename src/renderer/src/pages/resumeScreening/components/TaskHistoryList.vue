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
    <template v-else>
      <ul class="min-h-0 flex-1 space-y-1">
        <li
          v-for="task in pagedTasks"
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
      <div
        v-if="totalPages > 1"
        class="flex shrink-0 items-center justify-between pt-1"
        data-testid="history-pagination"
      >
        <DcButton
          size="icon-xs"
          variant="ghost"
          icon="lucide:chevron-left"
          :disabled="page === 1"
          :label="t('resumeScreening.historyPrevPage')"
          data-testid="history-prev"
          @click="page--"
        />
        <span class="text-xs text-muted-foreground" data-testid="history-page-indicator">
          {{ t('resumeScreening.historyPageIndicator', { page, total: totalPages }) }}
        </span>
        <DcButton
          size="icon-xs"
          variant="ghost"
          icon="lucide:chevron-right"
          :disabled="page >= totalPages"
          :label="t('resumeScreening.historyNextPage')"
          data-testid="history-next"
          @click="page++"
        />
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { DcBadge } from '@dc-ui/components/badge'
import { DcButton } from '@dc-ui/components/button'
import type { ResumeScreeningTaskDto } from '@api/resumeScreeningTasks'
import { statusLabel, statusVariant } from './statusPresentation'

// 用户要求每页 3-5 条，取中间值 4
const PAGE_SIZE = 4

const props = defineProps<{
  tasks: ResumeScreeningTaskDto[]
  tasksLoaded: boolean
  selectedId: string | null
}>()

const emit = defineEmits<{
  select: [taskId: string]
}>()

const { t } = useI18n()

const page = ref(1)

const totalPages = computed(() => Math.max(1, Math.ceil(props.tasks.length / PAGE_SIZE)))

const pagedTasks = computed(() =>
  props.tasks.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE)
)

// 列表刷新后页码越界时收敛到最后一页
watch(
  () => props.tasks.length,
  () => {
    if (page.value > totalPages.value) page.value = totalPages.value
  }
)
</script>
