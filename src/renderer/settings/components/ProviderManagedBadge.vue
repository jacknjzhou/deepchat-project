<template>
  <span
    v-if="managed"
    :data-testid="testId"
    class="inline-flex items-center rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400"
  >
    {{ t(labelKey) }}
  </span>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

withDefaults(
  defineProps<{
    managed: boolean
    labelKey?: string
    testId?: string
  }>(),
  {
    labelKey: 'settings.managed.providerBadge',
    testId: 'provider-managed-badge'
  }
)

const { t } = useI18n()
</script>
