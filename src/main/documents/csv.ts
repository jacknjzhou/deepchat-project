import type { DocumentRecord, DocumentTemplateField } from '@shared/documents'

const MONEY_FIELD_RE = /amount|total|tax|price|金额|合计|税|价格|价税/i

export const CSV_EXPORT_MAX_ROWS = 10000

export function isMoneyLikeField(field: DocumentTemplateField): boolean {
  return MONEY_FIELD_RE.test(field.key) || MONEY_FIELD_RE.test(field.label)
}

export function formatCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

export function escapeCsvCell(text: string): string {
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export function summarizeDocument(document: DocumentRecord): string {
  const fields = [...document.templateSnapshot.fields].sort((a, b) => a.order - b.order)
  return fields
    .map((field) => ({ label: field.label, value: document.fields[field.key]?.value }))
    .filter((item) => item.value !== null && item.value !== undefined)
    .map((item) => `${item.label}: ${formatCsvValue(item.value)}`)
    .join('; ')
}

export interface DocumentsCsvInput {
  documents: DocumentRecord[]
  templateFields: DocumentTemplateField[] | null
  templateNameById: Map<string, string>
}

export function buildDocumentsCsv(input: DocumentsCsvInput): string {
  const { documents, templateFields, templateNameById } = input
  const fixedHeader = ['id', 'type', 'source', 'status', 'createdAt', 'updatedAt']
  const fieldColumns = templateFields ? [...templateFields].sort((a, b) => a.order - b.order) : null
  const header = [
    ...fixedHeader,
    ...(fieldColumns ? fieldColumns.map((f) => f.label) : ['summary'])
  ]
  const lines = [header.map(escapeCsvCell).join(',')]
  for (const document of documents) {
    const fixedCells = [
      document.id,
      templateNameById.get(document.templateId) ?? document.typeKey,
      document.source,
      document.status,
      new Date(document.createdAt).toISOString(),
      new Date(document.updatedAt).toISOString()
    ]
    const restCells = fieldColumns
      ? fieldColumns.map((f) => formatCsvValue(document.fields[f.key]?.value ?? null))
      : [summarizeDocument(document)]
    lines.push([...fixedCells, ...restCells].map(escapeCsvCell).join(','))
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}
