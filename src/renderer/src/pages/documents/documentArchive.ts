import type { DocumentRecord } from '@shared/documents'

const MONEY_FIELD_RE = /amount|total|tax|price|金额|合计|税|价格|价税/i

export interface MoneyColumn {
  typeKey: string
  key: string
  label: string
}

export function orderedSnapshotFields(snapshot: DocumentRecord['templateSnapshot']) {
  return [...snapshot.fields].sort((a, b) => a.order - b.order)
}

export function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

export function buildMoneyColumns(documents: DocumentRecord[]): MoneyColumn[] {
  const seen = new Map<string, MoneyColumn>()
  for (const document of documents) {
    for (const field of document.templateSnapshot.fields) {
      if (!MONEY_FIELD_RE.test(field.key) && !MONEY_FIELD_RE.test(field.label)) {
        continue
      }
      if (document.fields[field.key]?.value == null) {
        continue
      }
      const columnKey = `${document.typeKey}:${field.key}`
      if (!seen.has(columnKey)) {
        seen.set(columnKey, { typeKey: document.typeKey, key: field.key, label: field.label })
      }
    }
  }
  return [...seen.values()]
}

export function formatDateRangeToMs(
  value: string,
  boundary: 'start' | 'end' = 'start'
): number | undefined {
  if (!value) {
    return undefined
  }
  const [year, month, day] = value.split('-').map((part) => Number(part))
  if (!year || !month || !day) {
    return undefined
  }
  return boundary === 'start'
    ? new Date(year, month - 1, day, 0, 0, 0, 0).getTime()
    : new Date(year, month - 1, day, 23, 59, 59, 999).getTime()
}
