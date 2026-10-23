<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { StaffdeckAwaitingInput } from '@shared/contracts/routes'

/**
 * 远端 run 处于 awaiting_input 时的提示条。
 *
 * 刻意不内嵌输入框：追问的回答就是下一条普通消息，直接复用现有 ChatInputBox，
 * 否则会出现两个输入框并让「发到哪个通道」变得含糊。
 */
const props = defineProps<{
  awaitingInput: StaffdeckAwaitingInput | null
}>()

const { t } = useI18n()

const fields = computed(() => props.awaitingInput?.expected_fields ?? [])
const summary = computed(() => props.awaitingInput?.question_summary?.trim() ?? '')
</script>

<template>
  <div
    v-if="awaitingInput"
    data-testid="remote-awaiting-panel"
    class="mx-auto w-full max-w-3xl rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
  >
    <div class="flex items-start gap-2">
      <span class="mt-0.5 shrink-0 text-amber-600">●</span>
      <div class="min-w-0 flex-1">
        <p class="font-medium text-foreground">{{ t('digitalEmployee.remote.awaitingTitle') }}</p>
        <p v-if="summary" class="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">
          {{ summary }}
        </p>
        <p v-if="fields.length > 0" class="mt-0.5 break-words text-muted-foreground">
          {{ t('digitalEmployee.remote.awaitingFields', { fields: fields.join('、') }) }}
        </p>
        <p class="mt-1 text-xs text-muted-foreground">
          {{ t('digitalEmployee.remote.awaitingHint') }}
        </p>
      </div>
    </div>
  </div>
</template>
