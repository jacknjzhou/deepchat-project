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
  rule?: string
  enum_values?: string[]
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
    validation: field.rule ?? null,
    enumOptions: field.enum_values ?? null,
    order: index + 1
  }))

export function seedPresetTemplates(
  database: DocumentsDatabase,
  options: { now?: number } = {}
): number {
  const now = options.now ?? Date.now()
  let changed = 0
  const templates = (presetJson as { templates: SeedTemplateRaw[] }).templates
  for (const template of templates) {
    const typeKey = PRESET_TEMPLATE_TYPE_KEY_MAP[template.name]
    if (!typeKey) {
      throw new Error(`Unmapped preset template name: ${template.name}`)
    }
    const fields = toFields(template.fields)
    const existing = database.documentTemplatesTable.getByTypeKey(typeKey)
    if (existing) {
      // fork 出的自定义模板使用独立 typeKey，不应命中此处；isBuiltin 检查防御性保护用户数据
      if (existing.is_builtin !== 1) {
        continue
      }
      const upgraded =
        existing.name !== template.name ||
        existing.category !== template.category ||
        JSON.stringify(JSON.parse(existing.fields_json)) !== JSON.stringify(fields)
      if (!upgraded) {
        continue
      }
      database.documentTemplatesTable.upsert({
        id: existing.id,
        typeKey,
        name: template.name,
        category: template.category as DocumentTemplateCategory,
        fields: fields as unknown[],
        isBuiltin: true,
        now
      })
    } else {
      database.documentTemplatesTable.upsert({
        typeKey,
        name: template.name,
        category: template.category as DocumentTemplateCategory,
        fields: fields as unknown[],
        isBuiltin: true,
        now
      })
    }
    changed += 1
  }
  return changed
}
