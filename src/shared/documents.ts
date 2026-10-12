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

export const DOCUMENT_SOURCES = ['chat', 'manual', 'scheduled'] as const
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

/** 内容去重：提交时被拦截的重复文件（path 供自动监控登记使用，UI 只用 fileName/existingName） */
export interface RecognitionDuplicate {
  fileName: string
  existingName: string
  path: string
}

/** 报销“未分类”哨兵：可写入 reimbursementOverride 强制不归类；报销类别 id 不得占用该值 */
export const REIMBURSEMENT_UNASSIGNED = 'unassigned'

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
  /** 手动报销归类：null=自动；'unassigned'=强制未分类；其余=类别 id */
  reimbursementOverride: string | null
  /** 手动报销细分项分组：null=未分组；其余=所属类别下自定义分组 id */
  reimbursementGroupOverride: string | null
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
  打车行程单模板: 'ride_hailing_itinerary',
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

/** 「智能信息提取」目录自动识别配置（主进程 scheduler 与渲染端设置页共用） */
export interface DocumentsAutoWatchConfig {
  enabled: boolean
  dir: string
  /** 扫描间隔（小时），1-72 */
  intervalHours: number
  /** 识别后缀，格式 /^\.[A-Za-z0-9]+$/ */
  extensions: string[]
  /** 每轮提交上限，1-20 */
  roundLimit: number
}

export const DOCUMENTS_AUTO_WATCH_DEFAULT: DocumentsAutoWatchConfig = {
  enabled: false,
  dir: '',
  intervalHours: 1,
  extensions: ['.pdf', '.png', '.jpg', '.jpeg'],
  roundLimit: 20
}

/** 设置页可勾选的后缀候选（默认值是其子集） */
export const DOCUMENTS_AUTO_WATCH_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif']
