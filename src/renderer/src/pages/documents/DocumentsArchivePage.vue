<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="border-b px-6 py-4">
      <h1 class="text-2xl font-semibold tracking-normal">
        {{ t('settings.documents.archive.title') }}
      </h1>
    </header>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>
