<template>
  <div class="rounded-lg border p-4">
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-medium">{{ t('resumeScreening.resumeSection') }}</h2>
      <span class="text-xs text-muted-foreground" data-testid="resume-count">
        {{ t('resumeScreening.resumeCount', { current: resumes.length, limit: RESUME_LIMIT }) }}
      </span>
    </div>

    <DcButton
      variant="outline"
      icon="lucide:file-plus"
      :disabled="limitReached"
      data-testid="resume-pick-files"
      class="mt-3 w-full"
      @click="emit('pickFiles')"
    >
      {{ t('resumeScreening.resumeAdd') }}
    </DcButton>

    <ul v-if="resumes.length" class="mt-3 space-y-1" data-testid="resume-list">
      <li
        v-for="(resume, index) in resumes"
        :key="resume.path"
        class="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm"
        :data-testid="`resume-item-${index}`"
      >
        <Icon icon="lucide:file-text" class="size-4 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate">{{ resume.name }}</span>
        <DcButton
          icon="lucide:x"
          size="icon-xs"
          variant="ghost"
          :label="t('resumeScreening.resumeRemove')"
          :data-testid="`resume-remove-${index}`"
          @click="emit('remove', resume.path)"
        />
      </li>
    </ul>
    <p v-else class="mt-3 text-xs text-muted-foreground" data-testid="resume-empty">
      {{ t('resumeScreening.resumeEmpty') }}
    </p>

    <p v-if="limitReached" class="mt-2 text-xs text-destructive" data-testid="resume-limit-hint">
      {{ t('resumeScreening.resumeLimitReached', { limit: RESUME_LIMIT }) }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { DcButton } from '@dc-ui/components/button'
import { RESUME_LIMIT, type PickedResume } from '@/stores/resumeScreening'

const props = defineProps<{
  resumes: PickedResume[]
}>()

const emit = defineEmits<{
  pickFiles: []
  remove: [path: string]
}>()

const { t } = useI18n()

const limitReached = computed(() => props.resumes.length >= RESUME_LIMIT)
</script>
