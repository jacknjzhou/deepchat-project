// 渲染层副本：与 src/main/documents/csv.ts 的 summarizeDocument/formatCsvValue 逻辑一致。
// 主进程模块不可被渲染层 import，两处用途不同，允许重复；修改时需同步两处。
import type { DocumentRecord } from '@shared/documents'

export function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

export function summarizeDocument(document: DocumentRecord): string {
  const fields = [...document.templateSnapshot.fields].sort((a, b) => a.order - b.order)
  return fields
    .map((field) => ({ label: field.label, value: document.fields[field.key]?.value }))
    .filter((item) => item.value !== null && item.value !== undefined)
    .map((item) => `${item.label}: ${formatFieldValue(item.value)}`)
    .join('; ')
}
