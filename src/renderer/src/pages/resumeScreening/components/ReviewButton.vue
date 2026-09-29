<template>
  <div class="flex items-center gap-2" data-testid="review-actions">
    <DcButton
      v-if="isRunning"
      variant="destructive"
      icon="lucide:square"
      data-testid="review-cancel"
      @click="emit('cancel')"
    >
      {{ t('resumeScreening.reviewCancel') }}
    </DcButton>
    <DcButton
      v-else
      :disabled="!canReview"
      :loading="isCreating"
      data-testid="review-start"
      @click="emit('review')"
    >
      {{ t('resumeScreening.reviewStart') }}
    </DcButton>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { DcButton } from '@dc-ui/components/button'

defineProps<{
  canReview: boolean
  isRunning: boolean
  isCreating: boolean
}>()

const emit = defineEmits<{
  review: []
  cancel: []
}>()

const { t } = useI18n()
</script>
