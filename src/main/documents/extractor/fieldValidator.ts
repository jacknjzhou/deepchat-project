import type { DocumentFieldEntry, DocumentTemplate } from '@shared/documents'

export interface ParsedModelOutput {
  fields: Record<string, DocumentFieldEntry>
  issues: string[]
}

// 从模型输出中截取第一个平衡的 JSON 对象（容忍围栏与前后杂文）
export function extractJsonBlock(raw: string): unknown {
  let start = raw.indexOf('{')
  while (start >= 0) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index]
      if (inString) {
        if (escaped) {
          escaped = false
        } else if (char === '\\') {
          escaped = true
        } else if (char === '"') {
          inString = false
        }
        continue
      }
      if (char === '"') {
        inString = true
      } else if (char === '{') {
        depth += 1
      } else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            return JSON.parse(raw.slice(start, index + 1))
          } catch {
            break
          }
        }
      }
    }
    start = raw.indexOf('{', start + 1)
  }
  return null
}

const DATE_PATTERNS = [/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/, /^(\d{4})(\d{2})(\d{2})$/]

export function normalizeDateValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  for (const pattern of DATE_PATTERNS) {
    const match = trimmed.match(pattern)
    if (!match) continue
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    if (
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      !Number.isInteger(day) ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > 31
    ) {
      continue
    }
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  return null
}

export function normalizeNumberValue(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/[¥￥$€£,\s元]/g, '').trim()
  if (cleaned.length === 0) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

const coerceFieldValue = (
  valueType: DocumentTemplate['fields'][number]['valueType'],
  raw: unknown,
  enumOptions: string[] | null
): { value: unknown; issue: string | null } => {
  if (raw === null || raw === undefined) {
    return { value: null, issue: null }
  }
  switch (valueType) {
    case 'text': {
      if (typeof raw === 'string') return { value: raw, issue: null }
      if (typeof raw === 'number' || typeof raw === 'boolean') {
        return { value: String(raw), issue: null }
      }
      return { value: null, issue: 'expected string' }
    }
    case 'number': {
      const value = normalizeNumberValue(raw)
      return value === null
        ? { value: null, issue: `cannot normalize number: ${JSON.stringify(raw)}` }
        : { value, issue: null }
    }
    case 'date': {
      const value = normalizeDateValue(raw)
      return value === null
        ? { value: null, issue: `cannot normalize date: ${JSON.stringify(raw)}` }
        : { value, issue: null }
    }
    case 'array': {
      if (Array.isArray(raw)) return { value: raw, issue: null }
      if (typeof raw === 'string') {
        try {
          const parsed: unknown = JSON.parse(raw)
          if (Array.isArray(parsed)) return { value: parsed, issue: null }
        } catch {
          // fall through
        }
      }
      return { value: null, issue: 'expected JSON array' }
    }
    case 'enum': {
      if (typeof raw === 'string' && enumOptions?.includes(raw)) {
        return { value: raw, issue: null }
      }
      return {
        value: null,
        issue: `value not in enum options: ${JSON.stringify(raw)}`
      }
    }
  }
}

export function parseModelOutput(raw: string, template: DocumentTemplate): ParsedModelOutput {
  const issues: string[] = []
  const parsed: unknown = extractJsonBlock(raw)
  if (parsed === null || typeof parsed !== 'object') {
    issues.push('model output is not valid JSON')
    const fields: Record<string, DocumentFieldEntry> = {}
    for (const field of template.fields) {
      fields[field.key] = { value: null, uncertain: field.required }
    }
    return { fields, issues }
  }

  const payload = parsed as {
    fields?: Record<string, unknown>
    uncertain_fields?: unknown
  }
  const rawFields = payload.fields ?? {}
  const uncertainKeys = new Set(
    Array.isArray(payload.uncertain_fields)
      ? payload.uncertain_fields.filter((key): key is string => typeof key === 'string')
      : []
  )

  const fields: Record<string, DocumentFieldEntry> = {}
  for (const field of template.fields) {
    const coerced = coerceFieldValue(field.valueType, rawFields[field.key], field.enumOptions)
    if (coerced.issue) {
      issues.push(`${field.key}: ${coerced.issue}`)
    }
    const value = coerced.value
    const missingRequired = field.required && (value === null || value === undefined)
    fields[field.key] = {
      value: value ?? null,
      uncertain: uncertainKeys.has(field.key) || missingRequired
    }
  }
  return { fields, issues }
}

const AMOUNT_TOLERANCE = 0.02
const AMOUNT_CONSERVATION_TOTAL_KEYS = ['total_amount', 'totalAmount', 'price_total']
const AMOUNT_CONSERVATION_SUM_KEYS: string[][] = [
  ['amount_ex_tax', 'tax_amount'],
  ['amount', 'tax_amount'],
  ['net_amount', 'tax_amount']
]
const DATE_FORMAT_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const matchesAmountConservation = (template: DocumentTemplate): boolean => {
  const keys = new Set(template.fields.map((field) => field.key))
  if (!AMOUNT_CONSERVATION_TOTAL_KEYS.some((key) => keys.has(key))) return false
  return AMOUNT_CONSERVATION_SUM_KEYS.some((pair) => pair.every((key) => keys.has(key)))
}

const asNumber = (entry: DocumentFieldEntry | undefined): number | null => {
  if (!entry || typeof entry.value !== 'number' || !Number.isFinite(entry.value)) return null
  return entry.value
}

export function validateTemplateRules(
  template: DocumentTemplate,
  fields: Record<string, DocumentFieldEntry>
): string[] {
  const issues: string[] = []

  for (const field of template.fields) {
    const entry = fields[field.key]
    const value = entry?.value

    if (
      field.validation &&
      field.validation !== 'amount_conservation' &&
      field.validation !== 'date_format'
    ) {
      if (value !== null && value !== undefined) {
        try {
          if (!new RegExp(field.validation).test(String(value))) {
            issues.push(`${field.key}: validation regex failed`)
          }
        } catch {
          issues.push(`${field.key}: invalid validation regex`)
        }
      }
    }

    if (
      (field.validation === 'date_format' || field.valueType === 'date') &&
      typeof value === 'string' &&
      !DATE_FORMAT_PATTERN.test(value)
    ) {
      issues.push(`${field.key}: date_format validation failed`)
    }
  }

  if (matchesAmountConservation(template)) {
    const totalKey = AMOUNT_CONSERVATION_TOTAL_KEYS.find((key) => key in fields)
    const sumPair = AMOUNT_CONSERVATION_SUM_KEYS.find((pair) => pair.every((key) => key in fields))
    if (totalKey && sumPair) {
      const total = asNumber(fields[totalKey])
      const first = asNumber(fields[sumPair[0]])
      const second = asNumber(fields[sumPair[1]])
      if (total !== null && first !== null && second !== null) {
        if (Math.abs(first + second - total) > AMOUNT_TOLERANCE) {
          issues.push(`amount_conservation violated: ${sumPair[0]} + ${sumPair[1]} != ${totalKey}`)
        }
      }
    }
  }

  return issues
}
