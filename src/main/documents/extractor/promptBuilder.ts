import type { DocumentTemplate, DocumentTemplateField } from '@shared/documents'

const VALUE_TYPE_RULES: Record<DocumentTemplateField['valueType'], string> = {
  text: '字符串；无法确定时填 null',
  number: '纯数字（不要单位、不要千分位逗号、不要货币符号）；无法确定时填 null',
  date: 'YYYY-MM-DD 格式字符串；无法确定时填 null',
  array: 'JSON 数组（每项为对象）；无法确定时填 []',
  enum: '只能取下方枚举选项之一；无法确定时填 null'
}

const formatField = (field: DocumentTemplateField): string => {
  const lines = [
    `- key: ${field.key}`,
    `  名称: ${field.label}`,
    `  类型: ${field.valueType}（${VALUE_TYPE_RULES[field.valueType]}）`,
    `  必填: ${field.required ? '是' : '否'}`
  ]
  if (field.promptHint) {
    lines.push(`  提示: ${field.promptHint}`)
  }
  if (field.valueType === 'enum' && field.enumOptions && field.enumOptions.length > 0) {
    lines.push(`  枚举选项: ${field.enumOptions.join(' | ')}`)
  }
  return lines.join('\n')
}

export function buildExtractionSystemPrompt(template: DocumentTemplate): string {
  const fieldSections = template.fields
    .slice()
    .sort((a, b) => a.order - b.order)
    .map(formatField)
    .join('\n')

  const parts = [
    '你是行政单据信息提取助手。根据给定的单据内容，严格按照字段模板提取结构化信息。',
    '',
    `单据类型：${template.name}`,
    '',
    '字段清单：',
    fieldSections,
    '',
    '输出要求：',
    '1. 只输出一个 JSON 对象，不要输出任何其他文字、解释或 Markdown 代码围栏。',
    '2. JSON 结构固定为：',
    '   { "fields": { "<字段key>": <提取值> }, "uncertain_fields": ["<不确定的字段key>"] }',
    '3. fields 必须包含字段清单中的每一个 key；单据上不存在或无法识别的字段值填 null。',
    '4. 禁止臆造、推测或补全单据上不存在的信息；看不清、不确定的字段 key 加入 uncertain_fields。',
    '5. 金额保留两位小数；日期统一为 YYYY-MM-DD。'
  ]

  const firstKey = template.fields.slice().sort((a, b) => a.order - b.order)[0]?.key
  if (firstKey) {
    parts.push(
      '',
      '输出示例（仅示意结构，值必须替换为单据实际内容，其余字段同样按清单逐个输出）：',
      `   { "fields": { "${firstKey}": "<该字段提取值>" }, "uncertain_fields": [] }`
    )
  }

  parts.push(
    '',
    '通用提取要求（适用于所有单据类型，包括自定义模板）：',
    '- 先逐个字段在单据内容中定位文字依据，再输出该字段的值。',
    '- 字段清单中的提示（hint）是字段含义的权威定义；单据内容与提示含义不符时不要硬套。',
    '- 单据上找不到明确依据的字段填 null 并加入 uncertain_fields；禁止用常识或经验推断补全。'
  )

  if (template.category === '发票类') {
    parts.push(
      '',
      '发票类专项提示：',
      '- 发票号码通常为 8 位数字（全电发票为 20 位），发票代码为 10 或 12 位数字，不要把两者混填。',
      '- 税率若为文本字段输出如 13% 的形式；若为数值字段输出纯数字（如 13）。金额为纯数字，不要包含 ¥ 符号或千分位逗号。',
      '- 价税合计需与“金额大写”一致，若明显不一致，把相关金额字段加入 uncertain_fields。',
      '- 明细行逐行完整提取，不要省略、合并或概括行。',
      '- 印章遮挡、反光或打印模糊导致无法确认的字符不要猜测，相应字段加入 uncertain_fields。'
    )
  }

  if (template.promptPreset && template.promptPreset.trim().length > 0) {
    parts.push('', '用户附加提取指令：', template.promptPreset.trim())
  }

  return parts.join('\n')
}

export function buildExtractionUserPrompt(
  _template: DocumentTemplate,
  documentText: string | null,
  segment?: { segmentIndex: number; segmentCount: number }
): string {
  const parts: string[] = []
  if (segment) {
    parts.push(
      `文档过长，当前是第 ${segment.segmentIndex}/${segment.segmentCount} 段。只提取本段中出现的字段值；本段没有的字段填 null，后续段落会补充。`
    )
  }
  if (documentText !== null) {
    parts.push('以下是需要识别的文档内容：', '', documentText)
  } else {
    parts.push('请识别图片中的单据信息。')
  }
  return parts.join('\n')
}

export function buildClassificationPrompts(templates: DocumentTemplate[]): {
  system: string
  user: string
} {
  const system = [
    '你是单据类型分类助手。根据给定的单据内容，从候选类型中选出最匹配的一个。',
    '注意区分字段集合不同但名称相近的类型，以单据上实际出现的字段和版式为准。',
    '只输出一个 JSON 对象：{ "typeKey": "<选中的typeKey>" }，不要输出任何其他文字。'
  ].join('\n')

  const catalog = templates
    .map((template) => {
      const keys = template.fields
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((field) => field.key)
        .join(', ')
      return `- ${template.typeKey}（${template.category}）: ${template.name}；典型字段: ${keys}`
    })
    .join('\n')

  const user = ['候选类型清单：', catalog, '', '请判断这份单据属于哪个类型。'].join('\n')

  return { system, user }
}
