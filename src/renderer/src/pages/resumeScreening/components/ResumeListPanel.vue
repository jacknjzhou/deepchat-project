<template>
  <section class="flex min-h-0 flex-col">
    <h3 class="mb-2 shrink-0 text-sm font-medium">
      {{ t('resumeScreening.resumeListSection') }}
    </h3>
    <p
      v-if="resumes.length === 0"
      data-testid="resume-list-empty"
      class="py-4 text-center text-sm text-muted-foreground"
    >
      {{ t('resumeScreening.resumeListEmpty') }}
    </p>
    <ul v-else class="space-y-1 overflow-y-auto">
      <li
        v-for="resume in resumes"
        :key="resume.id"
        :data-testid="`result-item-${resume.id}`"
        :class="[
          'flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm transition-colors hover:bg-muted/50',
          resume.id === selectedId ? 'bg-muted' : ''
        ]"
        @click="emit('select', resume.id)"
      >
        <Icon icon="lucide:file-text" class="size-4 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate">{{ resume.candidateName ?? resume.fileName }}</span>
        <span
          v-if="resume.recommended"
          data-testid="recommended-mark"
          class="shrink-0 text-emerald-600"
        >
          <Icon icon="lucide:thumbs-up" class="size-4" />
        </span>
        <span v-if="resume.score !== null" class="shrink-0 text-xs font-medium">
          {{ resume.score }}
        </span>
        <DcBadge :variant="statusVariant(resume.status)">
          {{ statusLabel(t, resume.status) }}
        </DcBadge>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { DcBadge } from '@dc-ui/components/badge'
import type { ResumeScreeningResumeDto } from '@api/resumeScreeningTasks'
import { statusLabel, statusVariant } from './statusPresentation'

defineProps<{
  resumes: ResumeScreeningResumeDto[]
  selectedId: string | null
}>()

const emit = defineEmits<{
  select: [resumeId: string]
}>()

const { t } = useI18n()
</script>
