import type { DocumentFieldEntry, DocumentRecord } from '@shared/documents'

const MONEY_FIELD_RE = /amount|total|tax|price|金额|合计|税|价格|价税/i

export interface MoneyColumn {
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

export function formatArrayLine(item: unknown): string {
  if (typeof item === 'object' && item !== null) {
    return JSON.stringify(item)
  }
  return String(item)
}

// Read-only display formatting for archive cells and the summary column. Edit
// states keep using formatFieldValue/formatArrayLine so the JSON round-trip
// stays lossless; this path optimizes for human readability instead.
export function formatDisplayValue(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (Array.isArray(value)) {
    const hasObject = value.some((item) => item !== null && typeof item === 'object')
    return value.map((item) => formatDisplayItem(item)).join(hasObject ? '；' : '、')
  }
  if (typeof value === 'object') {
    return formatDisplayObject(value as Record<string, unknown>, '，', false)
  }
  return String(value)
}

function formatDisplayItem(item: unknown): string {
  if (item === null || item === undefined) {
    return ''
  }
  if (typeof item === 'object') {
    // Array entries read as bare values joined by '·' (resume-style rows);
    // start/end keys collapse into a （起~止） range suffix.
    return formatDisplayObject(item as Record<string, unknown>, '·', true)
  }
  return String(item)
}

function formatDisplayObject(
  value: Record<string, unknown>,
  separator: string,
  bareValues: boolean
): string {
  const parts: string[] = []
  let range: string[] = []
  // start/end collapse into a （起~止） suffix attached to the previous value
  // (e.g. 公司·职位（2022-09-01~2023-01-01）·描述), rendered where the keys occur.
  const flushRange = () => {
    if (range.length === 0) {
      return
    }
    const text = `（${range.join('~')}）`
    if (parts.length > 0) {
      parts[parts.length - 1] += text
    } else {
      parts.push(text)
    }
    range = []
  }
  for (const [key, val] of Object.entries(value)) {
    if (val === null || val === undefined || val === '') {
      continue
    }
    if (key === 'start' || key === 'end') {
      range.push(formatDisplayValue(val))
      continue
    }
    flushRange()
    parts.push(bareValues ? formatDisplayValue(val) : `${key}: ${formatDisplayValue(val)}`)
  }
  flushRange()
  return parts.join(separator)
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
      if (!seen.has(field.key)) {
        seen.set(field.key, { key: field.key, label: field.label })
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

export function buildDefaultDateRangeTexts(now = new Date()): { from: string; to: string } {
  const toText = (date: Date): string =>
    [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-')
  return {
    from: toText(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)),
    to: toText(now)
  }
}

export interface FieldEditState {
  key: string
  label: string
  valueType: DocumentRecord['templateSnapshot']['fields'][number]['valueType']
  required: boolean
  enumOptions: string[] | null
  raw: string
  entry: DocumentFieldEntry | null
}

export function buildFieldEditStates(document: DocumentRecord): FieldEditState[] {
  return orderedSnapshotFields(document.templateSnapshot).map((field) => {
    const entry = document.fields[field.key] ?? null
    const raw =
      field.valueType === 'array' && Array.isArray(entry?.value)
        ? (entry.value as unknown[]).map((item) => formatArrayLine(item)).join('\n')
        : entry
          ? formatFieldValue(entry.value)
          : ''
    return {
      key: field.key,
      label: field.label,
      valueType: field.valueType,
      required: field.required,
      enumOptions: field.enumOptions,
      raw,
      entry
    }
  })
}

export function parseFieldEditState(
  state: FieldEditState
): { ok: true; value: unknown } | { ok: false; error: 'required' | 'number' | 'json' } {
  const text = state.raw
  if (state.valueType === 'array') {
    if (!text.trim()) {
      return state.required ? { ok: false, error: 'required' } : { ok: true, value: null }
    }
    return {
      ok: true,
      value: text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            const parsed: unknown = JSON.parse(line)
            // Only adopt structured lines back as objects; primitive strings
            // stay strings to avoid silent type drift (e.g. "300" -> 300).
            if (typeof parsed === 'object' && parsed !== null) {
              return parsed
            }
          } catch {
            // not JSON, keep the raw string
          }
          return line
        })
    }
  }
  if (!text.trim()) {
    return state.required ? { ok: false, error: 'required' } : { ok: true, value: null }
  }
  if (state.valueType === 'number') {
    const parsed = Number(text.trim())
    return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false, error: 'number' }
  }
  if (state.valueType === 'enum' && state.enumOptions && !state.enumOptions.includes(text)) {
    return { ok: false, error: 'json' }
  }
  return { ok: true, value: text }
}
