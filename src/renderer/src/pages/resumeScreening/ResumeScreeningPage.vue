<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex items-center justify-between border-b px-6 py-4">
      <h1 class="text-2xl font-semibold tracking-normal">{{ t('resumeScreening.title') }}</h1>
    </header>

    <div class="min-h-0 flex-1" data-testid="resume-screening-workspace">
      <!-- Task 13/14 在此填充任务工作区（左栏任务列表 + 右栏详情） -->
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>
