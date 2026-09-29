<template>
  <div class="rounded-lg border p-4">
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-medium">{{ t('resumeScreening.jdSection') }}</h2>
      <div class="flex items-center gap-1">
        <DcButton
          size="xs"
          :variant="jdSource === 'text' ? 'secondary' : 'ghost'"
          :active="jdSource === 'text'"
          data-testid="jd-tab-text"
          @click="emit('update:jdSource', 'text')"
        >
          {{ t('resumeScreening.jdTextTab') }}
        </DcButton>
        <DcButton
          size="xs"
          :variant="jdSource === 'file' ? 'secondary' : 'ghost'"
          :active="jdSource === 'file'"
          data-testid="jd-tab-file"
          @click="emit('update:jdSource', 'file')"
        >
          {{ t('resumeScreening.jdFileTab') }}
        </DcButton>
      </div>
    </div>

    <Textarea
      v-if="jdSource === 'text'"
      :model-value="jdText"
      :placeholder="t('resumeScreening.jdTextPlaceholder')"
      :maxlength="JD_TEXT_MAX_LENGTH"
      data-testid="jd-text-input"
      class="mt-3 min-h-32"
      @update:model-value="(value) => emit('update:jdText', String(value))"
    />

    <div v-else class="mt-3">
      <div
        v-if="jdFilePath"
        data-testid="jd-file-info"
        class="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm"
      >
        <Icon icon="lucide:file-text" class="size-4 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate">{{ jdFileName ?? jdFilePath }}</span>
        <DcButton
          icon="lucide:x"
          size="icon-xs"
          variant="ghost"
          :label="t('resumeScreening.jdClearFile')"
          data-testid="jd-clear-file"
          @click="emit('clearFile')"
        />
      </div>
      <DcButton
        v-else
        variant="outline"
        icon="lucide:file-up"
        data-testid="jd-pick-file"
        @click="emit('pickFile')"
      >
        {{ t('resumeScreening.jdPickFile') }}
      </DcButton>
      <p class="mt-2 text-xs text-muted-foreground">{{ t('resumeScreening.jdFileHint') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { DcButton } from '@dc-ui/components/button'
import { Textarea } from '@shadcn/components/ui/textarea'

defineProps<{
  jdSource: 'text' | 'file'
  jdText: string
  jdFilePath: string | null
  jdFileName: string | null
}>()

const emit = defineEmits<{
  'update:jdSource': [value: 'text' | 'file']
  'update:jdText': [value: string]
  pickFile: []
  clearFile: []
}>()

const { t } = useI18n()

// 与 Task 1 契约的 jdText 上限（60000）保持一致
const JD_TEXT_MAX_LENGTH = 60000
</script>
