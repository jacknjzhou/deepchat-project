<template>
  <div class="p-6 text-sm text-muted-foreground">
    {{ t('settings.documents.description') }}
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>
