// 渲染层副本：摘要列与 src/main/documents/csv.ts 的 summarizeDocument 逻辑曾经一致，
// 但列表摘要列已改为人类可读格式（复用 documentArchive 的 formatDisplayValue），
// CSV 导出保持 JSON（机器可读），两处自此有意分叉，勿再机械同步。
import type { DocumentRecord } from '@shared/documents'
import { formatDisplayValue } from './documentArchive'

export function summarizeDocument(document: DocumentRecord): string {
  const fields = [...document.templateSnapshot.fields].sort((a, b) => a.order - b.order)
  return fields
    .map((field) => ({ label: field.label, value: document.fields[field.key]?.value }))
    .filter((item) => item.value !== null && item.value !== undefined)
    .map((item) => `${item.label}: ${formatDisplayValue(item.value)}`)
    .join('; ')
}
