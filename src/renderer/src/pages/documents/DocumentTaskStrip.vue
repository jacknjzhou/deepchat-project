<template>
  <div class="border-b bg-muted/30 px-6 py-2" data-testid="archive-task-strip">
    <div class="mb-1 flex items-center gap-2">
      <p class="text-xs font-medium text-muted-foreground">
        {{ t('settings.documents.archive.taskStripTitle') }}
      </p>
      <DcButton
        v-if="hasFailedTasks"
        variant="outline"
        size="sm"
        data-testid="task-clear-failed"
        :disabled="clearing"
        @click="emit('clear-failed')"
      >
        {{ t('settings.documents.archive.taskClearFailed') }}
      </DcButton>
    </div>
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
        <DropdownMenu v-if="task.status === 'failed'">
          <DropdownMenuTrigger as-child>
            <DcButton
              variant="outline"
              size="sm"
              data-testid="task-retry"
              :disabled="retryingTaskIds.has(task.id)"
            >
              {{ t('settings.documents.archive.taskRetry') }}
            </DcButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-testid="task-retry-menu">
            <DropdownMenuItem
              data-testid="task-retry-auto"
              @click="emit('retry', task, AUTO_TEMPLATE_ID)"
            >
              {{ t('settings.documents.archive.autoClassify') }}
            </DropdownMenuItem>
            <DropdownMenuItem
              v-for="tpl in templates"
              :key="tpl.id"
              :data-testid="`task-retry-template-${tpl.typeKey}`"
              @click="emit('retry', task, tpl.id)"
            >
              {{ tpl.name }}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { DcButton } from '@dc-ui/components/button'
import { DcBadge } from '@dc-ui/components/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@shadcn/components/ui/dropdown-menu'
import type { DocumentTemplate } from '@shared/documents'
import type { DocumentsTaskItem } from '@api/documentTasks'

const props = withDefaults(
  defineProps<{
    tasks: DocumentsTaskItem[]
    templates: DocumentTemplate[]
    typeNameFor: (typeKey: string | null) => string | null
    retryingTaskIds?: ReadonlySet<string>
    clearing?: boolean
  }>(),
  { retryingTaskIds: () => new Set<string>(), clearing: false }
)

const emit = defineEmits<{
  retry: [task: DocumentsTaskItem, templateId: string]
  'clear-failed': []
}>()

const AUTO_TEMPLATE_ID = 'auto'
const { t } = useI18n()

const hasFailedTasks = computed(() => props.tasks.some((task) => task.status === 'failed'))

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
