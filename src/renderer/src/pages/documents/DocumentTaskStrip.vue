<template>
  <div class="border-b bg-muted/30 px-6 py-2" data-testid="archive-task-strip">
    <p class="mb-1 text-xs font-medium text-muted-foreground">
      {{ t('settings.documents.archive.taskStripTitle') }}
    </p>
    <ul class="space-y-1">
      <li
        v-for="task in tasks"
        :key="task.id"
        class="flex items-center gap-2 text-sm"
        :data-testid="`archive-task-${task.id}`"
      >
        <Icon
          :icon="statusIcon(task.status)"
          :class="['size-4 shrink-0', task.status === 'running' ? 'animate-spin' : '']"
        />
        <span class="truncate">{{ task.fileName }}</span>
        <DcBadge v-if="typeNameFor(task.typeKey)" variant="outline">
          {{ typeNameFor(task.typeKey) }}
        </DcBadge>
        <span v-else-if="task.templateId === 'auto'" class="text-xs text-muted-foreground">
          {{ t('settings.documents.archive.taskClassifying') }}
        </span>
        <span v-if="task.error" class="truncate text-xs text-destructive" :title="task.error">
          {{ task.error }}
        </span>
        <span class="ml-auto shrink-0 text-xs text-muted-foreground">
          {{ statusText(task.status) }}
        </span>
        <DcButton
          v-if="task.status === 'failed'"
          variant="outline"
          size="sm"
          data-testid="task-retry"
          @click="emit('retry', task)"
        >
          {{ t('settings.documents.archive.taskRetry') }}
        </DcButton>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { DcButton } from '@dc-ui/components/button'
import { DcBadge } from '@dc-ui/components/badge'
import type { DocumentsTaskItem } from './documentTasks'

defineProps<{
  tasks: DocumentsTaskItem[]
  typeNameFor: (typeKey: string | null) => string | null
}>()

const emit = defineEmits<{ retry: [task: DocumentsTaskItem] }>()
const { t } = useI18n()

function statusIcon(status: DocumentsTaskItem['status']): string {
  if (status === 'running') return 'lucide:loader-2'
  if (status === 'done') return 'lucide:check-circle-2'
  if (status === 'failed') return 'lucide:x-circle'
  return 'lucide:clock'
}

function statusText(status: DocumentsTaskItem['status']): string {
  if (status === 'running') return t('settings.documents.archive.taskRunning')
  if (status === 'done') return t('settings.documents.archive.taskDone')
  if (status === 'failed') return t('settings.documents.archive.taskFailed')
  return t('settings.documents.archive.taskQueued')
}
</script>
