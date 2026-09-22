import { describe, expect, it } from 'vitest'
import {
  addField,
  createEmptyField,
  isFieldKeyValid,
  isTypeKeyValid,
  moveField,
  normalizeOrders,
  parseEnumOptions,
  removeField,
  updateField,
  validateFields,
  type EditableField
} from '../../../../src/renderer/settings/components/documents/templateFields'

const baseField = (key: string, order: number): EditableField => ({
  key,
  label: key.toUpperCase(),
  valueType: 'text',
  required: true,
  promptHint: '',
  validation: '',
  enumOptions: '',
  order
})

describe('templateFields', () => {
  it('creates an empty text field with placeholder key', () => {
    expect(createEmptyField(3)).toEqual({
      key: 'field_3',
      label: '',
      valueType: 'text',
      required: true,
      promptHint: '',
      validation: '',
      enumOptions: '',
      order: 3
    })
  })

  it('validates field key format', () => {
    expect(isFieldKeyValid('amount')).toBe(true)
    expect(isFieldKeyValid('_priv')).toBe(true)
    expect(isFieldKeyValid('1st')).toBe(false)
    expect(isFieldKeyValid('has-dash')).toBe(false)
    expect(isFieldKeyValid('')).toBe(false)
    expect(isFieldKeyValid('a'.repeat(65))).toBe(false)
  })

  it('validates type key format', () => {
    expect(isTypeKeyValid('contract')).toBe(true)
    expect(isTypeKeyValid('lease_contract')).toBe(true)
    expect(isTypeKeyValid('Contract')).toBe(false)
    expect(isTypeKeyValid('1contract')).toBe(false)
    expect(isTypeKeyValid('')).toBe(false)
  })

  it('adds a field at the end and reorders by sequence', () => {
    const fields = [baseField('a', 1), baseField('b', 2)]
    const next = addField(fields, { ...baseField('c', 99), order: 99 })
    expect(next.map((f) => f.key)).toEqual(['a', 'b', 'c'])
    expect(next.map((f) => f.order)).toEqual([1, 2, 3])
  })

  it('removes a field and renumbers', () => {
    const fields = [baseField('a', 1), baseField('b', 2), baseField('c', 3)]
    const next = removeField(fields, 1)
    expect(next.map((f) => f.key)).toEqual(['a', 'c'])
    expect(next.map((f) => f.order)).toEqual([1, 2])
  })

  it('updates a field by index without mutating the original array', () => {
    const fields = [baseField('a', 1)]
    const next = updateField(fields, 0, { label: 'A New' })
    expect(fields[0].label).toBe('A')
    expect(next[0].label).toBe('A New')
  })

  it('moves a field forward and backward and renumbers', () => {
    const fields = [baseField('a', 1), baseField('b', 2), baseField('c', 3)]
    const forward = moveField(fields, 0, 2)
    expect(forward.map((f) => f.key)).toEqual(['b', 'c', 'a'])
    const backward = moveField(fields, 2, 0)
    expect(backward.map((f) => f.key)).toEqual(['c', 'a', 'b'])
  })

  it('parses comma-separated enum options and trims blanks', () => {
    expect(parseEnumOptions('  a , b ,, c')).toEqual(['a', 'b', 'c'])
    expect(parseEnumOptions('')).toEqual([])
  })

  it('normalizes orders so sequence starts at 1', () => {
    const fields = [baseField('a', 9), baseField('b', 2), baseField('c', 5)]
    const next = normalizeOrders(fields)
    expect(next.map((f) => f.order)).toEqual([1, 2, 3])
    expect(next.map((f) => f.key)).toEqual(['a', 'b', 'c'])
  })

  it('reports duplicated keys as a map of index to "duplicated"', () => {
    const fields = [baseField('a', 1), baseField('b', 2), baseField('a', 3)]
    const result = validateFields(fields)
    expect(result).toEqual({ 0: 'duplicated', 2: 'duplicated' })
  })

  it('reports invalid keys as a map of index to "invalid"', () => {
    const fields = [
      { ...baseField('a', 1) },
      { ...baseField('1bad', 2) },
      { ...baseField('has-dash', 3) }
    ]
    const result = validateFields(fields)
    expect(result).toEqual({ 1: 'invalid', 2: 'invalid' })
  })

  it('validates empty label-free fields as ok (label optional in editor draft)', () => {
    const fields = [{ ...baseField('a', 1), label: '' }]
    expect(validateFields(fields)).toEqual({})
  })
})
