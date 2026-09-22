import type { DocumentFieldValueType } from '@shared/documents'

export interface EditableField {
  key: string
  label: string
  valueType: DocumentFieldValueType
  required: boolean
  promptHint: string
  validation: string
  enumOptions: string
  order: number
}

const FIELD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const TYPE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/

export function isFieldKeyValid(key: string): boolean {
  return FIELD_KEY_RE.test(key)
}

export function isTypeKeyValid(key: string): boolean {
  return TYPE_KEY_RE.test(key)
}

export function createEmptyField(order: number): EditableField {
  return {
    key: `field_${order}`,
    label: '',
    valueType: 'text',
    required: true,
    promptHint: '',
    validation: '',
    enumOptions: '',
    order
  }
}

export function normalizeOrders(fields: EditableField[]): EditableField[] {
  return fields.map((field, index) => ({ ...field, order: index + 1 }))
}

export function addField(fields: EditableField[], field: EditableField): EditableField[] {
  return normalizeOrders([...fields, field])
}

export function removeField(fields: EditableField[], index: number): EditableField[] {
  return normalizeOrders(fields.filter((_, idx) => idx !== index))
}

export function updateField(
  fields: EditableField[],
  index: number,
  patch: Partial<EditableField>
): EditableField[] {
  return fields.map((field, idx) => (idx === index ? { ...field, ...patch } : field))
}

export function moveField(fields: EditableField[], from: number, to: number): EditableField[] {
  if (from === to || from < 0 || to < 0 || from >= fields.length || to >= fields.length) {
    return fields
  }
  const next = [...fields]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return normalizeOrders(next)
}

export function parseEnumOptions(raw: string): string[] {
  return raw
    .split(',')
    .map((option) => option.trim())
    .filter((option) => option.length > 0)
}

export type FieldValidationIssue = 'invalid' | 'duplicated'

export function validateFields(fields: EditableField[]): Record<number, FieldValidationIssue> {
  const issues: Record<number, FieldValidationIssue> = {}
  const keyCounts = new Map<string, number>()
  fields.forEach((field) => {
    if (isFieldKeyValid(field.key)) {
      keyCounts.set(field.key, (keyCounts.get(field.key) ?? 0) + 1)
    }
  })
  fields.forEach((field, index) => {
    if (!isFieldKeyValid(field.key)) {
      issues[index] = 'invalid'
      return
    }
    if ((keyCounts.get(field.key) ?? 0) > 1) {
      issues[index] = 'duplicated'
    }
  })
  return issues
}
