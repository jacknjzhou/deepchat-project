<template>
  <div
    v-if="templates.length > 0"
    data-testid="image-template-cards"
    class="flex flex-wrap items-center gap-2 px-1 py-2"
  >
    <span class="text-xs text-muted-foreground">
      {{ t('chat.imageTemplates.emptyCardsHint') }}
    </span>
    <button
      v-for="tpl in templates"
      :key="tpl.id"
      type="button"
      data-testid="image-template-card"
      class="rounded-full border px-3 py-1 text-xs hover:bg-accent"
      @click="applyTemplate(tpl)"
    >
      {{ tpl.title }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type {
  ImagePromptTemplateApplyPayload,
  ResolvedImagePromptTemplate
} from '@shared/imagePromptTemplates'

defineProps<{ templates: ResolvedImagePromptTemplate[] }>()

const emit = defineEmits<{ 'apply-template': [payload: ImagePromptTemplateApplyPayload] }>()

const { t } = useI18n()

const applyTemplate = (tpl: ResolvedImagePromptTemplate) => {
  emit('apply-template', {
    prompt: tpl.prompt,
    ...(tpl.size !== undefined ? { size: tpl.size } : {}),
    ...(tpl.quality !== undefined ? { quality: tpl.quality } : {})
  })
}
</script>
