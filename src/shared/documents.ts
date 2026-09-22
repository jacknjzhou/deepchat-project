export const DOCUMENT_FIELD_VALUE_TYPES = ['text', 'number', 'date', 'array', 'enum'] as const
export type DocumentFieldValueType = (typeof DOCUMENT_FIELD_VALUE_TYPES)[number]

export const DOCUMENT_EXTRACTION_MODES = ['auto', 'vision', 'text'] as const
export type DocumentExtractionMode = (typeof DOCUMENT_EXTRACTION_MODES)[number]

export const DOCUMENT_TEMPLATE_CATEGORIES = [
  '合同类',
  '出行票据类',
  '采购类',
  '支付凭证类',
  '发票类',
  '自定义'
] as const
export type DocumentTemplateCategory = (typeof DOCUMENT_TEMPLATE_CATEGORIES)[number]

export const DOCUMENT_SOURCES = ['chat', 'manual'] as const
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number]

export const DOCUMENT_STATUSES = ['draft', 'confirmed'] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

export interface DocumentTemplateField {
  key: string
  label: string
  valueType: DocumentFieldValueType
  required: boolean
  promptHint: string | null
  validation: string | null
  enumOptions: string[] | null
  order: number
}

export interface DocumentTemplate {
  id: string
  typeKey: string
  name: string
  icon: string | null
  category: DocumentTemplateCategory
  fields: DocumentTemplateField[]
  extractionMode: DocumentExtractionMode
  promptPreset: string | null
  isBuiltin: boolean
  builtinSourceId: string | null
  version: number
  createdAt: number
  updatedAt: number
}

export interface DocumentFieldEntry {
  value: unknown
  uncertain: boolean
}

export interface DocumentRecord {
  id: string
  templateId: string
  typeKey: string
  templateSnapshot: DocumentTemplate
  fields: Record<string, DocumentFieldEntry>
  fileUris: string[]
  source: DocumentSource
  sessionId: string | null
  status: DocumentStatus
  createdAt: number
  updatedAt: number
}

// seed JSON (docs/superpowers/specs/preset_templates.json) → 内部结构的映射表
export const PRESET_TEMPLATE_TYPE_KEY_MAP: Record<string, string> = {
  合同模板: 'contract',
  租赁合同模板: 'lease_contract',
  补充说明模板: 'contract_supplement',
  行程单模板: 'travel_itinerary',
  住宿单模板: 'hotel_receipt',
  餐饮流水单模板: 'catering_receipt',
  订购单模板: 'purchase_order',
  付款截图模板: 'payment_screenshot',
  增值税专用发票: 'invoice_special',
  普通发票: 'invoice_general'
}

export const SEED_VALUE_TYPE_MAP: Record<string, DocumentFieldValueType> = {
  string: 'text',
  number: 'number',
  date: 'date',
  array: 'array'
}
