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
  '财务类',
  '资产类',
  '行政类',
  '人事类',
  '招投标类',
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

// seed JSON (src/main/documents/presetTemplates.json) → 内部结构的映射表
// 键必须与 presetTemplates.json 的 name 逐字一致；seed 新增/改名时需同步两处。
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
  普通发票: 'invoice_general',
  报销单: 'expense_claim',
  资产验收单: 'asset_acceptance',
  银行回单: 'bank_receipt',
  会议纪要: 'meeting_minutes',
  '红头文件/收文': 'official_incoming',
  '入职/离职单': 'onboarding_offboarding',
  简历: 'resume',
  报价单: 'quotation',
  '保密协议（NDA）': 'nda',
  '招标公告/招标文件': 'tender_notice'
}

export const SEED_VALUE_TYPE_MAP: Record<string, DocumentFieldValueType> = {
  string: 'text',
  number: 'number',
  date: 'date',
  array: 'array',
  enum: 'enum'
}
