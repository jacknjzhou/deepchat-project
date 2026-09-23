<template>
  <div v-if="open" data-testid="document-recognize-dialog-placeholder" />
</template>

<script setup lang="ts">
// 占位组件：完整实现由 P4 计划后续任务（新建识别对话框）提供。
import type { DocumentRecord } from '@shared/documents'

defineProps<{
  open: boolean
}>()

defineEmits<{
  'update:open': [open: boolean]
  recognized: [document: DocumentRecord]
}>()
</script>
