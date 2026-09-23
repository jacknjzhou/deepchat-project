<template>
  <div v-if="open" data-testid="document-detail-dialog-placeholder" />
</template>

<script setup lang="ts">
// 占位组件：完整实现由 P4 计划 Task 9（详情对话框：字段编辑 + 预览 + 确认/删除/重识别）提供。
import type { DocumentRecord } from '@shared/documents'

defineProps<{
  open: boolean
  document: DocumentRecord | null
}>()

defineEmits<{
  'update:open': [open: boolean]
  're-recognized': [document: DocumentRecord]
}>()
</script>
