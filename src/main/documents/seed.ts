import presetJson from './presetTemplates.json'
import {
  PRESET_TEMPLATE_TYPE_KEY_MAP,
  SEED_VALUE_TYPE_MAP,
  type DocumentTemplateCategory,
  type DocumentFieldValueType,
  type DocumentTemplateField
} from '@shared/documents'
import type { DocumentsDatabase } from './data/database'

interface SeedFieldRaw {
  key: string
  label: string
  type: string
  desc: string
  required?: boolean
}

interface SeedTemplateRaw {
  name: string
  category: string
  description: string
  fields: SeedFieldRaw[]
}

// JSON 将 line_items 的 type 标为 string（内容为 JSON 数组文本），seed 时语义修正为 array
const SEED_FIELD_VALUE_TYPE_OVERRIDES: Record<string, DocumentFieldValueType> = {
  line_items: 'array'
}

const toFields = (raw: SeedFieldRaw[]): DocumentTemplateField[] =>
  raw.map((field, index) => ({
    key: field.key,
    label: field.label,
    valueType: (SEED_FIELD_VALUE_TYPE_OVERRIDES[field.key] ??
      SEED_VALUE_TYPE_MAP[field.type] ??
      'text') as DocumentFieldValueType,
    required: field.required ?? true,
    promptHint: field.desc,
    validation: null,
    enumOptions: null,
    order: index + 1
  }))

export function seedPresetTemplates(
  database: DocumentsDatabase,
  options: { now?: number } = {}
): number {
  const now = options.now ?? Date.now()
  let inserted = 0
  const templates = (presetJson as { templates: SeedTemplateRaw[] }).templates
  for (const template of templates) {
    const typeKey = PRESET_TEMPLATE_TYPE_KEY_MAP[template.name]
    if (!typeKey) {
      throw new Error(`Unmapped preset template name: ${template.name}`)
    }
    if (database.documentTemplatesTable.getByTypeKey(typeKey)) {
      continue
    }
    database.documentTemplatesTable.upsert({
      typeKey,
      name: template.name,
      category: template.category as DocumentTemplateCategory,
      fields: toFields(template.fields) as unknown[],
      isBuiltin: true,
      now
    })
    inserted += 1
  }
  return inserted
}
