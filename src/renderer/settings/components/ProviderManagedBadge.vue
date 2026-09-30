<template>
  <span
    v-if="managed"
    data-testid="provider-managed-badge"
    class="inline-flex items-center rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400"
  >
    {{ t('settings.managed.providerBadge') }}
  </span>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{ managed: boolean }>()

const { t } = useI18n()
</script>
