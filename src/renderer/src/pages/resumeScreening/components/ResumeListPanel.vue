<template>
  <section class="shrink-0">
    <h3 class="mb-2 text-sm font-medium">
      {{ t('resumeScreening.resumeListSection') }}
    </h3>
    <p
      v-if="resumes.length === 0"
      data-testid="resume-list-empty"
      class="py-4 text-center text-sm text-muted-foreground"
    >
      {{ t('resumeScreening.resumeListEmpty') }}
    </p>
    <ul v-else class="flex gap-2 overflow-x-auto pb-1" data-testid="resume-list-strip">
      <li
        v-for="resume in resumes"
        :key="resume.id"
        :data-testid="`result-item-${resume.id}`"
        :class="[
          'flex w-40 shrink-0 cursor-pointer flex-col gap-1.5 rounded-md border p-2.5 text-sm transition-colors hover:bg-muted/50',
          resume.id === selectedId ? 'bg-muted' : ''
        ]"
        @click="emit('select', resume.id)"
      >
        <div class="flex min-w-0 items-center gap-1.5">
          <Icon icon="lucide:file-text" class="size-4 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate">
            {{ resume.candidateName ?? resume.fileName }}
          </span>
        </div>
        <div class="flex items-center justify-between gap-1">
          <DcBadge
            :variant="statusVariant(resume.status)"
            class="min-w-0 max-w-full justify-center truncate"
          >
            {{ statusLabel(t, resume.status) }}
          </DcBadge>
          <span class="flex shrink-0 items-center gap-1">
            <span v-if="resume.recommended" data-testid="recommended-mark" class="text-emerald-600">
              <Icon icon="lucide:thumbs-up" class="size-4" />
            </span>
            <span v-if="resume.score !== null" class="text-xs font-medium">
              {{ resume.score }}
            </span>
          </span>
        </div>
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
