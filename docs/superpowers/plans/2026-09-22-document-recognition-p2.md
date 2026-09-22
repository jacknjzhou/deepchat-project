# 单据识别 P2（提取服务）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 DocumentExtractor 提取服务——文件形态智能路由（图片→视觉模型 / 文本层 PDF→文本提取→文本模型 / 扫描件 PDF→LightOCR→文本模型）+ 模板驱动的动态 prompt + zod 校验与归一化 + 超长文本分段合并，并落地 `documentTemplates.testExtract` 与 `documents.extractAndDraft` 两条 typed IPC 路由。

**Architecture:** 主进程新模块 `src/main/documents/extractor/`，四个单一职责文件（promptBuilder / fieldValidator / segmentMerger / documentExtractor）。提取器依赖全部函数化注入（模型调用、视觉目标解析、PDF 文本提取、OCR、图片读取），单测零 Electron/网络依赖；composition.ts 负责把真实实现（providerRuntime、providerSettings、PdfFileAdapter、ImageFileAdapter、ocrRuntimeService）包装注入。

**Tech Stack:** TypeScript、zod（校验与 IPC 契约）、Vitest。无新依赖。

**Spec:** `docs/superpowers/specs/2026-09-22-document-recognition-design.md` 第 6 节（提取服务）、第 7 节（IPC 契约）、第 11 节（测试策略）。

---

## 已确认的设计决策（实施者不得偏离）

1. **一次提取只处理一个文件**。多附件（多张发票）由调用方逐个调用（P4 skill 循环），route 语义保持单一。Spec 第 6 节输入 `fileUris + templateId` 在 P2 收敛为单文件输入。
2. **扫描件 PDF（无文本层）→ LightOCR 提取文本 → 文本模型**（用户已确认接入 LightOCR）。主进程无 PDF→图片能力，视觉模型不处理 PDF。
3. **extractionMode 语义**：`auto` 按文件形态路由（默认）；`text` 强制文本通道（图片走 OCR→文本模型）；`vision` 强制视觉通道（仅图片文件支持，PDF 文件抛错提示改用 auto/text）。
4. **`templateId === 'auto'`**：先做类型分类（文本模型对提取文本、视觉模型对图片），从模板列表中选出 typeKey，再按选中模板提取。
5. **视觉模型解析**：`providerSettings.getSetting<{ providerId: string; modelId: string }>('defaultVisionModel')`；文本模型：同法读 `'defaultModel'`。缺失时抛带引导语错误。
6. **amount_conservation 为自动探测规则**：模板字段同时含 `total_amount` 与 `tax_amount` + (`amount_ex_tax`|`amount`) 时自动执行守恒校验（容差 0.02）——预置模板 seed 不带 validation 也开箱可用；字段 `validation` 显式写 `'amount_conservation'`/`'date_format'` 时同样执行（幂等）。
7. **文本层判定**：PDF 提取出的全文（去空白后）≥ 200 字符视为有文本层（本 P2 不依赖 PdfEmbeddedTextCoverage 细粒度统计）。
8. **分段常量**（spec 第 6 节）：全文 > 60000 字符 → 按 40000 字符切段。

## 既有 API 速查（实施者直接引用，勿重读源码）

| 能力 | 用法 |
|---|---|
| 模型调用 | `providerRuntime.generateCompletionStandalone(providerId, messages: ChatMessage[], modelId, temperature?, maxTokens?, { signal? }): Promise<string>`（`src/main/provider/index.ts:491`） |
| 带图消息 | `ChatMessage` content 数组项 `{ type: 'text', text }` / `{ type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } }`（`@shared/types/core/chat-message`；范本 `src/main/tool/agentTools/agentToolManager.ts:2521-2535`） |
| 模型配置 | `providerSettings.getModelConfig(modelId, providerId)` → `{ vision?: boolean; temperature?: number; maxTokens?: number; ... }`；`isKnownModel(providerId, modelId): boolean` |
| 图片→dataUrl | `new ImageFileAdapter(path, maxFileSize).getLLMContent(): Promise<string | undefined>` → `data:image/jpeg;base64,...`（`src/main/file/adapters/ImageFileAdapter.ts:66`，sharp 压缩 1200px q70） |
| PDF 文本 | `new PdfFileAdapter(path, maxFileSize)` → `getAllPagesMarkdown(): Promise<string[] | undefined>`、`getLLMContent(): Promise<string | undefined>`、`getTextCoverage()`（`src/main/file/adapters/PdfFileAdapter.ts`，pdf-parse-new） |
| LightOCR | `ocrRuntimeService.extractDocument({ filePath, maxFileSize, backend: 'auto', priority: 'interactive', signal? }): Promise<DocumentTextExtractionResult>`，结果 `.text` / `.timingMs.total`；失败抛 `DocumentTextExtractionError`（code ∈ cancelled/empty_input/input_too_large/invalid_input/queue_full/runtime_failure/runtime_identity_mismatch 等）（`src/main/ocr/ocrRuntimeService.ts:126`） |
| maxFileSize | `dependencies.settingsStore.get<number>('maxFileSize') ?? 30 * 1024 * 1024`（composition.ts:1303 同款） |
| P1 类型 | `DocumentTemplate` / `DocumentTemplateField` / `DocumentFieldEntry { value: unknown; uncertain: boolean }` / `DocumentRecord`（`src/shared/documents.ts`） |
| P1 repository | `getTemplate(id): DocumentTemplate | null`、`getTemplateByTypeKey(typeKey)`、`listTemplates()`、`insertDocument(input): DocumentRecord`（`src/main/documents/repository.ts`） |
| P1 契约 | `documentRecordSchema` / `defineRouteContract`（`src/shared/contracts/routes/documents.routes.ts`，166 行现有 9 条 route） |
| P1 handler 范式 | `routes.output.parse({...})` 包返回值（`src/main/documents/routes.ts`） |
| 测试命令 | 主进程 sqlite 相关：`$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run <file>`（PowerShell；普通 vitest 会因 Node/Electron ABI 不匹配 skip sqlite 测试）；纯逻辑测试可直接 `pnpm exec vitest run <file>`；渲染层：`pnpm exec vitest run <file> --config vitest.config.renderer.ts` |

---

### Task 1: 动态 prompt 构建（promptBuilder）

**Files:**
- Create: `src/main/documents/extractor/promptBuilder.ts`
- Test: `test/main/documents/extractorPrompt.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// test/main/documents/extractorPrompt.test.ts
import { describe, expect, it } from 'vitest'
import {
  buildClassificationPrompts,
  buildExtractionSystemPrompt,
  buildExtractionUserPrompt
} from '@/documents/extractor/promptBuilder'
import type { DocumentTemplate } from '@/shared/documents'

const makeTemplate = (overrides: Partial<DocumentTemplate> = {}): DocumentTemplate => ({
  id: 'tpl-1',
  typeKey: 'invoice_special',
  name: '增值税专用发票',
  icon: null,
  category: '发票类',
  fields: [
    {
      key: 'invoice_code',
      label: '发票代码',
      valueType: 'text',
      required: true,
      promptHint: '12位发票代码',
      validation: null,
      enumOptions: null,
      order: 1
    },
    {
      key: 'total_amount',
      label: '价税合计',
      valueType: 'number',
      required: true,
      promptHint: null,
      validation: null,
      enumOptions: null,
      order: 2
    },
    {
      key: 'invoice_date',
      label: '开票日期',
      valueType: 'date',
      required: true,
      promptHint: 'YYYY-MM-DD',
      validation: null,
      enumOptions: null,
      order: 3
    },
    {
      key: 'line_items',
      label: '明细行',
      valueType: 'array',
      required: false,
      promptHint: null,
      validation: null,
      enumOptions: null,
      order: 4
    }
  ],
  extractionMode: 'auto',
  promptPreset: null,
  isBuiltin: true,
  builtinSourceId: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('buildExtractionSystemPrompt', () => {
  it('包含字段清单、valueType 指引与禁止臆造原则', () => {
    const prompt = buildExtractionSystemPrompt(makeTemplate())
    expect(prompt).toContain('invoice_code')
    expect(prompt).toContain('12位发票代码')
    expect(prompt).toContain('total_amount')
    expect(prompt).toContain('number')
    expect(prompt).toContain('YYYY-MM-DD')
    expect(prompt).toContain('null')
    expect(prompt).toContain('line_items')
    expect(prompt).toContain('uncertain_fields')
  })

  it('promptPreset 非空时附加到末尾', () => {
    const prompt = buildExtractionSystemPrompt(makeTemplate({ promptPreset: '额外注意盖章日期' }))
    expect(prompt).toContain('额外注意盖章日期')
  })
})

describe('buildExtractionUserPrompt', () => {
  it('文本通道携带文档文本', () => {
    const prompt = buildExtractionUserPrompt(makeTemplate(), '发票抬头：某某公司')
    expect(prompt).toContain('发票抬头：某某公司')
  })

  it('视觉通道不携带文档文本', () => {
    const prompt = buildExtractionUserPrompt(makeTemplate(), null)
    expect(prompt).not.toContain('以下是需要识别的文档内容')
  })

  it('分段模式包含分段提示', () => {
    const prompt = buildExtractionUserPrompt(makeTemplate(), '片段内容', {
      segmentIndex: 1,
      segmentCount: 3
    })
    expect(prompt).toContain('1/3')
  })
})

describe('buildClassificationPrompts', () => {
  it('枚举候选模板 typeKey 与名称', () => {
    const { system, user } = buildClassificationPrompts([makeTemplate()])
    expect(system).toContain('invoice_special')
    expect(user).toContain('增值税专用发票')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run test/main/documents/extractorPrompt.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// src/main/documents/extractor/promptBuilder.ts
import type { DocumentTemplate, DocumentTemplateField } from '@/shared/documents'

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
    '只输出一个 JSON 对象：{ "typeKey": "<选中的typeKey>" }，不要输出任何其他文字。'
  ].join('\n')

  const catalog = templates
    .map((template) => `- ${template.typeKey}: ${template.name}`)
    .join('\n')

  const user = ['候选类型清单：', catalog, '', '请判断这份单据属于哪个类型。'].join('\n')

  return { system, user }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run test/main/documents/extractorPrompt.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 5: Commit**

```bash
git add src/main/documents/extractor/promptBuilder.ts test/main/documents/extractorPrompt.test.ts
git commit -m "feat(documents): add extraction prompt builder"
```

---

### Task 2: 输出解析、归一化与规则校验（fieldValidator）

**Files:**
- Create: `src/main/documents/extractor/fieldValidator.ts`
- Test: `test/main/documents/extractorValidator.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// test/main/documents/extractorValidator.test.ts
import { describe, expect, it } from 'vitest'
import {
  parseModelOutput,
  validateTemplateRules
} from '@/documents/extractor/fieldValidator'
import type { DocumentTemplate } from '@/shared/documents'

const field = (key: string, valueType: 'text' | 'number' | 'date' | 'array' | 'enum', overrides: Record<string, unknown> = {}) => ({
  key,
  label: key,
  valueType,
  required: false,
  promptHint: null,
  validation: null,
  enumOptions: valueType === 'enum' ? ['专票', '普票'] : null,
  order: 1,
  ...overrides
})

const makeTemplate = (fields: ReturnType<typeof field>[]): DocumentTemplate => ({
  id: 'tpl-1',
  typeKey: 'invoice_special',
  name: '增值税专用发票',
  icon: null,
  category: '发票类',
  fields,
  extractionMode: 'auto',
  promptPreset: null,
  isBuiltin: true,
  builtinSourceId: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1
})

describe('parseModelOutput', () => {
  it('解析裸 JSON 输出', () => {
    const template = makeTemplate([field('invoice_code', 'text')])
    const result = parseModelOutput(
      '{"fields": {"invoice_code": "12345678"}, "uncertain_fields": []}',
      template
    )
    expect(result.fields.invoice_code).toEqual({ value: '12345678', uncertain: false })
    expect(result.issues).toEqual([])
  })

  it('剥离 Markdown 代码围栏', () => {
    const template = makeTemplate([field('invoice_code', 'text')])
    const result = parseModelOutput(
      '```json\n{"fields": {"invoice_code": "12345678"}, "uncertain_fields": []}\n```',
      template
    )
    expect(result.fields.invoice_code?.value).toBe('12345678')
  })

  it('缺失字段补 null，required 字段标记 uncertain', () => {
    const template = makeTemplate([
      field('invoice_code', 'text', { required: true }),
      field('drawer', 'text')
    ])
    const result = parseModelOutput('{"fields": {}, "uncertain_fields": []}', template)
    expect(result.fields.invoice_code).toEqual({ value: null, uncertain: true })
    expect(result.fields.drawer).toEqual({ value: null, uncertain: false })
  })

  it('uncertain_fields 命中时标记 uncertain', () => {
    const template = makeTemplate([field('invoice_code', 'text')])
    const result = parseModelOutput(
      '{"fields": {"invoice_code": "12345678"}, "uncertain_fields": ["invoice_code"]}',
      template
    )
    expect(result.fields.invoice_code).toEqual({ value: '12345678', uncertain: true })
  })

  it('number 接受带货币符号与千分位的字符串并归一化', () => {
    const template = makeTemplate([field('total_amount', 'number')])
    const result = parseModelOutput(
      '{"fields": {"total_amount": "¥1,234.50"}, "uncertain_fields": []}',
      template
    )
    expect(result.fields.total_amount).toEqual({ value: 1234.5, uncertain: false })
  })

  it('number 无法解析时置 null 并记录 issue', () => {
    const template = makeTemplate([field('total_amount', 'number')])
    const result = parseModelOutput(
      '{"fields": {"total_amount": "see attached"}, "uncertain_fields": []}',
      template
    )
    expect(result.fields.total_amount?.value).toBeNull()
    expect(result.issues.length).toBeGreaterThan(0)
  })

  it('date 接受斜杠与中文格式并归一化为 YYYY-MM-DD', () => {
    const template = makeTemplate([field('invoice_date', 'date')])
    for (const raw of ['2026/09/22', '2026年9月22日', '2026-9-2']) {
      const result = parseModelOutput(
        `{"fields": {"invoice_date": "${raw}"}, "uncertain_fields": []}`,
        template
      )
      expect(result.fields.invoice_date?.value).toBe('2026-09-22')
    }
  })

  it('array 接受 JSON 字符串并解析为数组', () => {
    const template = makeTemplate([field('line_items', 'array')])
    const result = parseModelOutput(
      '{"fields": {"line_items": "[{\\"name\\": \\"a\\"}]"}, "uncertain_fields": []}',
      template
    )
    expect(result.fields.line_items?.value).toEqual([{ name: 'a' }])
  })

  it('enum 值不在选项内时置 null 并记录 issue', () => {
    const template = makeTemplate([field('invoice_type', 'enum')])
    const result = parseModelOutput(
      '{"fields": {"invoice_type": "收据"}, "uncertain_fields": []}',
      template
    )
    expect(result.fields.invoice_type?.value).toBeNull()
    expect(result.issues.length).toBeGreaterThan(0)
  })

  it('非 JSON 输出返回全 null fields 并记录 issue', () => {
    const template = makeTemplate([field('invoice_code', 'text')])
    const result = parseModelOutput('抱歉，我无法识别', template)
    expect(result.fields.invoice_code?.value).toBeNull()
    expect(result.issues.length).toBeGreaterThan(0)
  })
})

describe('validateTemplateRules', () => {
  it('date_format：date 字段值不符合 YYYY-MM-DD 时报 issue', () => {
    const template = makeTemplate([field('invoice_date', 'date')])
    const issues = validateTemplateRules(template, {
      invoice_date: { value: '22/09/2026', uncertain: false }
    })
    expect(issues.some((issue) => issue.includes('invoice_date'))).toBe(true)
  })

  it('amount_conservation：amount_ex_tax + tax_amount ≠ total_amount 时报 issue', () => {
    const template = makeTemplate([
      field('total_amount', 'number'),
      field('amount_ex_tax', 'number'),
      field('tax_amount', 'number')
    ])
    const issues = validateTemplateRules(template, {
      total_amount: { value: 113, uncertain: false },
      amount_ex_tax: { value: 100, uncertain: false },
      tax_amount: { value: 9, uncertain: false }
    })
    expect(issues.length).toBe(1)
    expect(issues[0]).toContain('amount_conservation')
  })

  it('amount_conservation：金额守恒通过时不报 issue', () => {
    const template = makeTemplate([
      field('total_amount', 'number'),
      field('amount_ex_tax', 'number'),
      field('tax_amount', 'number')
    ])
    const issues = validateTemplateRules(template, {
      total_amount: { value: 113, uncertain: false },
      amount_ex_tax: { value: 100, uncertain: false },
      tax_amount: { value: 13, uncertain: false }
    })
    expect(issues).toEqual([])
  })

  it('正则 validation：字段值不匹配时报 issue', () => {
    const template = makeTemplate([
      field('invoice_code', 'text', { validation: '^\\d{12}$' })
    ])
    const issues = validateTemplateRules(template, {
      invoice_code: { value: '123', uncertain: false }
    })
    expect(issues.length).toBe(1)
  })

  it('正则 validation：null 值跳过', () => {
    const template = makeTemplate([
      field('invoice_code', 'text', { validation: '^\\d{12}$' })
    ])
    const issues = validateTemplateRules(template, {
      invoice_code: { value: null, uncertain: false }
    })
    expect(issues).toEqual([])
  })

  it('正则 validation：非法正则表达式报 issue 而非抛错', () => {
    const template = makeTemplate([field('invoice_code', 'text', { validation: '[' })])
    const issues = validateTemplateRules(template, {
      invoice_code: { value: 'abc', uncertain: false }
    })
    expect(issues.length).toBe(1)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run test/main/documents/extractorValidator.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// src/main/documents/extractor/fieldValidator.ts
import type { DocumentFieldEntry, DocumentTemplate } from '@/shared/documents'

export interface ParsedModelOutput {
  fields: Record<string, DocumentFieldEntry>
  issues: string[]
}

// 从模型输出中截取第一个平衡的 JSON 对象（容忍围栏与前后杂文）
export function extractJsonBlock(raw: string): unknown {
  const start = raw.indexOf('{')
  if (start < 0) return null
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
          return null
        }
      }
    }
  }
  return null
}

const DATE_PATTERNS = [
  /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/,
  /^(\d{4})(\d{2})(\d{2})$/
]

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

    if (field.validation && field.validation !== 'amount_conservation' && field.validation !== 'date_format') {
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
    const sumPair = AMOUNT_CONSERVATION_SUM_KEYS.find((pair) =>
      pair.every((key) => key in fields)
    )
    if (totalKey && sumPair) {
      const total = asNumber(fields[totalKey])
      const first = asNumber(fields[sumPair[0]])
      const second = asNumber(fields[sumPair[1]])
      if (total !== null && first !== null && second !== null) {
        if (Math.abs(first + second - total) > AMOUNT_TOLERANCE) {
          issues.push(
            `amount_conservation violated: ${sumPair[0]} + ${sumPair[1]} != ${totalKey}`
          )
        }
      }
    }
  }

  return issues
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run test/main/documents/extractorValidator.test.ts`
Expected: PASS（16 tests）

- [ ] **Step 5: Commit**

```bash
git add src/main/documents/extractor/fieldValidator.ts test/main/documents/extractorValidator.test.ts
git commit -m "feat(documents): add field validation and normalization"
```

---

### Task 3: 长文本分段与合并（segmentMerger）

**Files:**
- Create: `src/main/documents/extractor/segmentMerger.ts`
- Test: `test/main/documents/extractorMerger.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// test/main/documents/extractorMerger.test.ts
import { describe, expect, it } from 'vitest'
import {
  SEGMENT_SIZE_CHARS,
  SEGMENT_THRESHOLD_CHARS,
  splitTextIntoSegments,
  mergeSegmentOutputs
} from '@/documents/extractor/segmentMerger'

describe('splitTextIntoSegments', () => {
  it('短文本不分段', () => {
    expect(splitTextIntoSegments('短文本')).toEqual(['短文本'])
  })

  it('阈值长度文本不分段', () => {
    const text = 'a'.repeat(SEGMENT_THRESHOLD_CHARS)
    expect(splitTextIntoSegments(text)).toEqual([text])
  })

  it('超长文本按段落边界切分为 ≤40000 字符的段', () => {
    const paragraph = `${'x'.repeat(5000)}\n\n`
    const text = paragraph.repeat(20) // 100200 chars
    const segments = splitTextIntoSegments(text)
    expect(segments.length).toBeGreaterThan(1)
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(SEGMENT_SIZE_CHARS + 2)
    }
    expect(segments.join('')).toBe(text)
  })

  it('无段落边界的超长文本硬切', () => {
    const text = 'y'.repeat(SEGMENT_THRESHOLD_CHARS + 1)
    const segments = splitTextIntoSegments(text)
    expect(segments.length).toBe(2)
    expect(segments.join('')).toBe(text)
  })
})

describe('mergeSegmentOutputs', () => {
  const entry = (value: unknown, uncertain = false) => ({ value, uncertain })

  it('空段与 null 值由后续段补齐', () => {
    const merged = mergeSegmentOutputs({
      a: entry(null),
      b: entry(null)
    }, [
      { a: entry(null), b: entry(null) },
      { a: entry('v1'), b: entry('v2') }
    ])
    expect(merged.a).toEqual({ value: 'v1', uncertain: false })
    expect(merged.b).toEqual({ value: 'v2', uncertain: false })
  })

  it('一致的非空值不标 uncertain', () => {
    const merged = mergeSegmentOutputs({}, [
      { a: entry('same') },
      { a: entry('same') }
    ])
    expect(merged.a).toEqual({ value: 'same', uncertain: false })
  })

  it('冲突值取首个并标 uncertain', () => {
    const merged = mergeSegmentOutputs({}, [
      { a: entry('first') },
      { a: entry('second') }
    ])
    expect(merged.a).toEqual({ value: 'first', uncertain: true })
  })

  it('array 字段跨段拼接去重', () => {
    const merged = mergeSegmentOutputs({}, [
      { items: entry([{ n: 1 }, { n: 2 }]) },
      { items: entry([{ n: 2 }, { n: 3 }]) }
    ])
    expect(merged.items).toEqual({ value: [{ n: 1 }, { n: 2 }, { n: 3 }], uncertain: false })
  })

  it('首个非空值已 uncertain 时合并结果保持 uncertain', () => {
    const merged = mergeSegmentOutputs({}, [
      { a: entry('v', true) },
      { a: entry('v', false) }
    ])
    expect(merged.a).toEqual({ value: 'v', uncertain: true })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run test/main/documents/extractorMerger.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// src/main/documents/extractor/segmentMerger.ts
import type { DocumentFieldEntry } from '@/shared/documents'

export const SEGMENT_THRESHOLD_CHARS = 60000
export const SEGMENT_SIZE_CHARS = 40000

export function splitTextIntoSegments(text: string): string[] {
  if (text.length <= SEGMENT_THRESHOLD_CHARS) {
    return [text]
  }

  const segments: string[] = []
  let cursor = 0
  while (cursor < text.length) {
    if (text.length - cursor <= SEGMENT_SIZE_CHARS) {
      segments.push(text.slice(cursor))
      break
    }
    let end = cursor + SEGMENT_SIZE_CHARS
    const boundary = text.lastIndexOf('\n\n', end)
    if (boundary > cursor) {
      end = boundary + 2
    }
    segments.push(text.slice(cursor, end))
    cursor = end
  }
  return segments
}

type FieldMap = Record<string, DocumentFieldEntry>

const sameValue = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

export function mergeSegmentOutputs(base: FieldMap, outputs: FieldMap[]): FieldMap {
  const merged: FieldMap = { ...base }

  for (const output of outputs) {
    for (const [key, entry] of Object.entries(output)) {
      const current = merged[key]
      if (!current || current.value === null || current.value === undefined) {
        merged[key] = { ...entry }
        continue
      }
      if (entry.value === null || entry.value === undefined) {
        continue
      }
      if (Array.isArray(current.value) && Array.isArray(entry.value)) {
        const seen = new Set(
          current.value.map((item) => JSON.stringify(item))
        )
        for (const item of entry.value) {
          const serialized = JSON.stringify(item)
          if (!seen.has(serialized)) {
            seen.add(serialized)
            current.value.push(item)
          }
        }
        continue
      }
      if (sameValue(current.value, entry.value)) {
        current.uncertain = current.uncertain || entry.uncertain
        continue
      }
      // 冲突：保留首个非空值并标 uncertain
      current.uncertain = true
    }
  }

  return merged
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run test/main/documents/extractorMerger.test.ts`
Expected: PASS（9 tests）

- [ ] **Step 5: Commit**

```bash
git add src/main/documents/extractor/segmentMerger.ts test/main/documents/extractorMerger.test.ts
git commit -m "feat(documents): add segment merge for long texts"
```

---

### Task 4: 提取服务编排与智能路由（documentExtractor）

**Files:**
- Create: `src/main/documents/extractor/documentExtractor.ts`
- Test: `test/main/documents/extractorService.test.ts`

依赖全部函数化注入，测试零 I/O。

- [ ] **Step 1: 写失败测试**

```typescript
// test/main/documents/extractorService.test.ts
import { describe, expect, it, vi } from 'vitest'
import { DocumentExtractor } from '@/documents/extractor/documentExtractor'
import type { DocumentExtractorDeps } from '@/documents/extractor/documentExtractor'
import type { DocumentTemplate } from '@/shared/documents'

const makeTemplate = (overrides: Partial<DocumentTemplate> = {}): DocumentTemplate => ({
  id: 'tpl-1',
  typeKey: 'invoice_special',
  name: '增值税专用发票',
  icon: null,
  category: '发票类',
  fields: [
    {
      key: 'invoice_code',
      label: '发票代码',
      valueType: 'text',
      required: true,
      promptHint: '12位发票代码',
      validation: null,
      enumOptions: null,
      order: 1
    }
  ],
  extractionMode: 'auto',
  promptPreset: null,
  isBuiltin: true,
  builtinSourceId: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const makeDeps = (overrides: Partial<DocumentExtractorDeps> = {}): DocumentExtractorDeps => ({
  repository: {
    getTemplate: vi.fn(() => makeTemplate()),
    getTemplateByTypeKey: vi.fn(() => null),
    listTemplates: vi.fn(() => [makeTemplate()])
  },
  generateCompletion: vi.fn(async () =>
    '{"fields": {"invoice_code": "123456789012"}, "uncertain_fields": []}'
  ),
  resolveVisionTarget: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4o' })),
  resolveTextTarget: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4o-mini' })),
  readImageAsDataUrl: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
  extractPdfText: vi.fn(async () => ({ text: '', hasTextLayer: false })),
  extractOcrText: vi.fn(async () => ''),
  now: () => 1000,
  ...overrides
})

describe('DocumentExtractor.extract 路由', () => {
  it('图片走视觉模型', async () => {
    const deps = makeDeps()
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
    })
    expect(result.route).toBe('vision')
    expect(deps.readImageAsDataUrl).toHaveBeenCalledWith('/tmp/a.jpg')
    expect(deps.generateCompletion).toHaveBeenCalledTimes(1)
    const call = vi.mocked(deps.generateCompletion).mock.calls[0][0]
    expect(call.providerId).toBe('openai')
    expect(call.modelId).toBe('gpt-4o')
    const content = call.messages[0]?.content
    expect(Array.isArray(content)).toBe(true)
    expect(JSON.stringify(content)).toContain('image_url')
    expect(result.fields.invoice_code).toEqual({ value: '123456789012', uncertain: false })
    expect(result.durationMs).toBe(0)
  })

  it('文本层 PDF 走文本模型', async () => {
    const deps = makeDeps({
      extractPdfText: vi.fn(async () => ({ text: '发票全文内容', hasTextLayer: true }))
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
    })
    expect(result.route).toBe('text')
    expect(deps.extractOcrText).not.toHaveBeenCalled()
    const call = vi.mocked(deps.generateCompletion).mock.calls[0][0]
    expect(call.messages[0]?.content).toContain('发票全文内容')
  })

  it('扫描件 PDF 走 OCR 再走文本模型', async () => {
    const deps = makeDeps({
      extractPdfText: vi.fn(async () => ({ text: '', hasTextLayer: false })),
      extractOcrText: vi.fn(async () => 'OCR 识别出的文本')
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
    })
    expect(result.route).toBe('ocr')
    expect(deps.extractOcrText).toHaveBeenCalledWith('/tmp/a.pdf')
    const call = vi.mocked(deps.generateCompletion).mock.calls[0][0]
    expect(call.messages[0]?.content).toContain('OCR 识别出的文本')
  })

  it('extractionMode=text 强制图片走 OCR 通道', async () => {
    const deps = makeDeps({
      extractOcrText: vi.fn(async () => '图片 OCR 文本'),
      repository: {
        getTemplate: vi.fn(() => makeTemplate({ extractionMode: 'text' })),
        getTemplateByTypeKey: vi.fn(() => null),
        listTemplates: vi.fn(() => [])
      }
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
    })
    expect(result.route).toBe('ocr')
    expect(deps.readImageAsDataUrl).not.toHaveBeenCalled()
  })

  it('extractionMode=vision 对 PDF 抛错', async () => {
    const deps = makeDeps({
      repository: {
        getTemplate: vi.fn(() => makeTemplate({ extractionMode: 'vision' })),
        getTemplateByTypeKey: vi.fn(() => null),
        listTemplates: vi.fn(() => [])
      }
    })
    const extractor = new DocumentExtractor(deps)
    await expect(
      extractor.extract({
        templateId: 'tpl-1',
        file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
      })
    ).rejects.toThrow(/vision/)
  })

  it('视觉模型未配置时抛带引导语的错误', async () => {
    const deps = makeDeps({ resolveVisionTarget: vi.fn(() => null) })
    const extractor = new DocumentExtractor(deps)
    await expect(
      extractor.extract({
        templateId: 'tpl-1',
        file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
      })
    ).rejects.toThrow(/defaultVisionModel/)
  })

  it('不支持的文件类型抛错', async () => {
    const extractor = new DocumentExtractor(makeDeps())
    await expect(
      extractor.extract({
        templateId: 'tpl-1',
        file: { path: '/tmp/a.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
      })
    ).rejects.toThrow(/unsupported/i)
  })

  it('模板不存在时抛错', async () => {
    const deps = makeDeps({
      repository: {
        getTemplate: vi.fn(() => null),
        getTemplateByTypeKey: vi.fn(() => null),
        listTemplates: vi.fn(() => [])
      }
    })
    const extractor = new DocumentExtractor(deps)
    await expect(
      extractor.extract({
        templateId: 'missing',
        file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
      })
    ).rejects.toThrow(/template/i)
  })
})

describe('DocumentExtractor.extract auto 分类', () => {
  it('templateId=auto 时图片先分类再提取', async () => {
    const secondTemplate = makeTemplate({ id: 'tpl-2', typeKey: 'hotel_receipt', name: '住宿单模板' })
    const deps = makeDeps({
      repository: {
        getTemplate: vi.fn((id: string) =>
          id === 'tpl-1' ? makeTemplate() : id === 'tpl-2' ? secondTemplate : null
        ),
        getTemplateByTypeKey: vi.fn((typeKey: string) =>
          typeKey === 'hotel_receipt' ? secondTemplate : null
        ),
        listTemplates: vi.fn(() => [makeTemplate(), secondTemplate])
      },
      generateCompletion: vi
        .fn()
        .mockResolvedValueOnce('{"typeKey": "hotel_receipt"}')
        .mockResolvedValueOnce('{"fields": {"invoice_code": null}, "uncertain_fields": []}')
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'auto',
      file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
    })
    expect(result.template.typeKey).toBe('hotel_receipt')
    expect(deps.generateCompletion).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.generateCompletion).mock.calls[1][0].modelId).toBe('gpt-4o')
  })

  it('auto 分类返回未知 typeKey 时抛错', async () => {
    const deps = makeDeps({
      generateCompletion: vi.fn().mockResolvedValue('{"typeKey": "unknown_type"}')
    })
    const extractor = new DocumentExtractor(deps)
    await expect(
      extractor.extract({
        templateId: 'auto',
        file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
      })
    ).rejects.toThrow(/classif/i)
  })
})

describe('DocumentExtractor.extract 分段', () => {
  it('超长文本分段提取并合并', async () => {
    const longText = 'z'.repeat(60001)
    const deps = makeDeps({
      extractPdfText: vi.fn(async () => ({ text: longText, hasTextLayer: true })),
      generateCompletion: vi
        .fn()
        .mockResolvedValueOnce('{"fields": {"invoice_code": "111111111111"}, "uncertain_fields": []}')
        .mockResolvedValueOnce('{"fields": {"invoice_code": "222222222222"}, "uncertain_fields": []}')
    })
    const extractor = new DocumentExtractor(deps)
    const result = await extractor.extract({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.pdf', mimeType: 'application/pdf' }
    })
    expect(deps.generateCompletion).toHaveBeenCalledTimes(2)
    expect(result.fields.invoice_code).toEqual({ value: '111111111111', uncertain: true })
    expect(result.issues).toContain('invoice_code: conflicting values across segments')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run test/main/documents/extractorService.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// src/main/documents/extractor/documentExtractor.ts
import type { ChatMessage } from '@shared/types/core/chat-message'
import type { DocumentFieldEntry, DocumentTemplate } from '@/shared/documents'
import type { DocumentsRepository } from '@/documents/repository'
import { buildClassificationPrompts, buildExtractionSystemPrompt, buildExtractionUserPrompt } from './promptBuilder'
import { parseModelOutput, validateTemplateRules } from './fieldValidator'
import { SEGMENT_THRESHOLD_CHARS, mergeSegmentOutputs, splitTextIntoSegments } from './segmentMerger'

export type DocumentExtractRoute = 'vision' | 'text' | 'ocr'

export interface DocumentExtractFileInput {
  path: string
  name?: string
  mimeType?: string
}

export interface DocumentExtractResult {
  template: DocumentTemplate
  route: DocumentExtractRoute
  fields: Record<string, DocumentFieldEntry>
  rawOutput: string
  durationMs: number
  issues: string[]
}

export interface CompletionRequest {
  providerId: string
  modelId: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
}

export interface DocumentExtractorDeps {
  repository: Pick<
    DocumentsRepository,
    'getTemplate' | 'getTemplateByTypeKey' | 'listTemplates'
  >
  generateCompletion: (input: CompletionRequest) => Promise<string>
  resolveVisionTarget: () => { providerId: string; modelId: string } | null
  resolveTextTarget: () => { providerId: string; modelId: string } | null
  readImageAsDataUrl: (filePath: string) => Promise<string>
  extractPdfText: (filePath: string) => Promise<{ text: string; hasTextLayer: boolean }>
  extractOcrText: (filePath: string) => Promise<string>
  now?: () => number
}

const IMAGE_MIME_PREFIX = 'image/'
const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp)$/i
const CLASSIFY_TEMPERATURE = 0
const EXTRACT_TEMPERATURE = 0.2
const EXTRACT_MAX_TOKENS = 4096

const isImageFile = (file: DocumentExtractFileInput): boolean => {
  if (file.mimeType) return file.mimeType.startsWith(IMAGE_MIME_PREFIX)
  return IMAGE_EXTENSIONS.test(file.path)
}

const isPdfFile = (file: DocumentExtractFileInput): boolean => {
  if (file.mimeType) return file.mimeType === 'application/pdf'
  return /\.pdf$/i.test(file.path)
}

const firstUserText = (messages: ChatMessage[]): string | null => {
  const content = messages[0]?.content
  return typeof content === 'string' ? content : null
}

export class DocumentExtractor {
  constructor(private readonly deps: DocumentExtractorDeps) {}

  async extract(input: {
    templateId: string
    file: DocumentExtractFileInput
    signal?: AbortSignal
  }): Promise<DocumentExtractResult> {
    const startedAt = this.deps.now?.() ?? Date.now()
    const template = await this.resolveTemplate(input.templateId, input.file)
    const plan = await this.buildRoutePlan(template, input.file)

    const issues: string[] = []
    let fields: Record<string, DocumentFieldEntry>
    let rawOutput = ''

    if (plan.route === 'vision') {
      const target = this.requireTarget(this.deps.resolveVisionTarget(), 'defaultVisionModel')
      const dataUrl = await this.deps.readImageAsDataUrl(input.file.path)
      const messages: ChatMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: buildExtractionUserPrompt(template, null) },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } }
          ]
        }
      ]
      rawOutput = await this.deps.generateCompletion({
        providerId: target.providerId,
        modelId: target.modelId,
        messages,
        temperature: EXTRACT_TEMPERATURE,
        maxTokens: EXTRACT_MAX_TOKENS
      })
      const parsed = parseModelOutput(rawOutput, template)
      fields = parsed.fields
      issues.push(...parsed.issues)
    } else {
      const text =
        plan.route === 'ocr'
          ? await this.deps.extractOcrText(input.file.path)
          : plan.text ?? ''
      const target = this.requireTarget(this.deps.resolveTextTarget(), 'defaultModel')
      const segments = splitTextIntoSegments(text)
      if (segments.length === 1) {
        const messages: ChatMessage[] = [
          {
            role: 'user',
            content: buildExtractionUserPrompt(template, text)
          }
        ]
        rawOutput = await this.deps.generateCompletion({
          providerId: target.providerId,
          modelId: target.modelId,
          messages,
          temperature: EXTRACT_TEMPERATURE,
          maxTokens: EXTRACT_MAX_TOKENS
        })
        const parsed = parseModelOutput(rawOutput, template)
        fields = parsed.fields
        issues.push(...parsed.issues)
      } else {
        const partials: Record<string, DocumentFieldEntry>[] = []
        const segmentOutputs: string[] = []
        for (let index = 0; index < segments.length; index += 1) {
          if (input.signal?.aborted) {
            throw new Error('extraction aborted')
          }
          const messages: ChatMessage[] = [
            {
              role: 'user',
              content: buildExtractionUserPrompt(template, segments[index], {
                segmentIndex: index + 1,
                segmentCount: segments.length
              })
            }
          ]
          const output = await this.deps.generateCompletion({
            providerId: target.providerId,
            modelId: target.modelId,
            messages,
            temperature: EXTRACT_TEMPERATURE,
            maxTokens: EXTRACT_MAX_TOKENS
          })
          segmentOutputs.push(output)
          partials.push(parseModelOutput(output, template).fields)
        }
        rawOutput = segmentOutputs.join('\n---\n')
        fields = mergeSegmentOutputs(
          Object.fromEntries(
            template.fields.map((field) => [field.key, { value: null, uncertain: false }])
          ),
          partials
        )
        for (const field of template.fields) {
          const values = partials
            .map((partial) => partial[field.key]?.value)
            .filter((value) => value !== null && value !== undefined)
          const distinct = new Set(values.map((value) => JSON.stringify(value)))
          if (distinct.size > 1) {
            issues.push(`${field.key}: conflicting values across segments`)
            fields[field.key] = { ...(fields[field.key] ?? { value: null }), uncertain: true }
          }
        }
      }
    }

    issues.push(...validateTemplateRules(template, fields))
    const endedAt = this.deps.now?.() ?? Date.now()

    return {
      template,
      route: plan.route,
      fields,
      rawOutput,
      durationMs: endedAt - startedAt,
      issues
    }
  }

  private requireTarget(
    target: { providerId: string; modelId: string } | null,
    settingName: string
  ): { providerId: string; modelId: string } {
    if (!target) {
      throw new Error(
        `No model available for extraction: configure "${settingName}" in provider settings first`
      )
    }
    return target
  }

  private async resolveTemplate(
    templateId: string,
    file: DocumentExtractFileInput
  ): Promise<DocumentTemplate> {
    if (templateId !== 'auto') {
      const template = this.deps.repository.getTemplate(templateId)
      if (!template) {
        throw new Error(`Unknown template: ${templateId}`)
      }
      return template
    }
    const candidates = this.deps.repository.listTemplates()
    if (candidates.length === 0) {
      throw new Error('No templates available for auto classification')
    }
    const { system, user } = buildClassificationPrompts(candidates)
    let messages: ChatMessage[]
    let target: { providerId: string; modelId: string }
    if (isImageFile(file)) {
      target = this.requireTarget(this.deps.resolveVisionTarget(), 'defaultVisionModel')
      const dataUrl = await this.deps.readImageAsDataUrl(file.path)
      messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: user },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } }
          ]
        }
      ]
    } else if (isPdfFile(file)) {
      target = this.requireTarget(this.deps.resolveTextTarget(), 'defaultModel')
      const { text } = await this.deps.extractPdfText(file.path)
      const sample = text.slice(0, 4000)
      messages = [
        {
          role: 'user',
          content: [system, '', user, '', sample].join('\n')
        }
      ]
    } else {
      throw new Error(
        `unsupported file type for extraction: ${file.mimeType ?? file.path}`
      )
    }
    const output = await this.deps.generateCompletion({
      providerId: target.providerId,
      modelId: target.modelId,
      messages,
      temperature: CLASSIFY_TEMPERATURE
    })
    const match = output.match(/"typeKey"\s*:\s*"([a-z0-9_]+)"/)
    const typeKey = match?.[1]
    const template = typeKey ? this.deps.repository.getTemplateByTypeKey(typeKey) : null
    if (!template) {
      throw new Error(`auto classification failed: unknown typeKey ${typeKey ?? '(none)'}`)
    }
    return template
  }

  private async buildRoutePlan(
    template: DocumentTemplate,
    file: DocumentExtractFileInput
  ): Promise<{ route: DocumentExtractRoute; text?: string }> {
    const mode = template.extractionMode
    if (isImageFile(file)) {
      if (mode === 'text') {
        return { route: 'ocr' }
      }
      return { route: 'vision' }
    }
    if (isPdfFile(file)) {
      if (mode === 'vision') {
        throw new Error(
          'extractionMode=vision only supports image files; use auto or text mode for PDFs'
        )
      }
      const { text, hasTextLayer } = await this.deps.extractPdfText(file.path)
      if (hasTextLayer) {
        return { route: 'text', text }
      }
      return { route: 'ocr' }
    }
    throw new Error(`unsupported file type for extraction: ${file.mimeType ?? file.path}`)
  }
}

// 供分类 prompt 在文本通道复用 system（buildClassificationPrompts 同时返回 system/user）
export { buildClassificationPrompts }
void firstUserText
```

等等——上面 `firstUserText` 是残留辅助函数，删除它和最后的 `void firstUserText`、重复的 re-export。最终实现文件不包含 `firstUserText` 与末尾三行 re-export（`buildClassificationPrompts` 已在文件顶部 import，无需 re-export）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run test/main/documents/extractorService.test.ts`
Expected: PASS（11 tests）

- [ ] **Step 5: Commit**

```bash
git add src/main/documents/extractor/documentExtractor.ts test/main/documents/extractorService.test.ts
git commit -m "feat(documents): add document extractor with smart routing"
```

---

### Task 5: IPC 路由契约（testExtract / extractAndDraft）

**Files:**
- Modify: `src/shared/contracts/routes/documents.routes.ts`（末尾追加 2 条 route）
- Modify: `src/shared/contracts/routes.ts`（barrel 三件套：具名 import + `export *`（已有）+ `DEEPCHAT_ROUTE_CATALOG_PART_1` 追加 2 条）
- Test: `test/main/documents/documentsRoutes.test.ts`（追加契约测试）

**警告（P1 踩坑）**：漏加 `DEEPCHAT_ROUTE_CATALOG` 条目会导致 `dispatchDeepchatRoute` 抛 "Unknown deepchat route"。三件套缺一不可。

- [ ] **Step 1: 在 `src/shared/contracts/routes/documents.routes.ts` 末尾追加契约**

```typescript
export const documentExtractFileSchema = z.object({
  path: z.string().min(1),
  name: z.string().max(255).optional(),
  mimeType: z.string().max(128).optional()
})

export const documentExtractionMetaSchema = z.object({
  route: z.enum(['vision', 'text', 'ocr']),
  rawOutput: z.string(),
  durationMs: z.number().nonnegative(),
  issues: z.array(z.string())
})

export const documentTemplatesTestExtractRoute = defineRouteContract({
  name: 'documentTemplates.testExtract',
  input: z.object({
    templateId: z.string().min(1),
    file: documentExtractFileSchema
  }),
  output: z.object({
    fields: z.array(
      z.object({
        key: z.string(),
        value: z.unknown(),
        uncertain: z.boolean()
      })
    ),
    meta: documentExtractionMetaSchema
  })
})

export const documentsExtractAndDraftRoute = defineRouteContract({
  name: 'documents.extractAndDraft',
  input: z.object({
    templateId: z.string().min(1),
    file: documentExtractFileSchema,
    source: documentSourceSchema.optional(),
    sessionId: z.string().min(1).optional()
  }),
  output: z.object({
    document: documentRecordSchema,
    meta: documentExtractionMetaSchema
  })
})
```

- [ ] **Step 2: 更新 barrel `src/shared/contracts/routes.ts`**

1. documents.routes.ts 的具名 import 块追加：`documentTemplatesTestExtractRoute,`、`documentsExtractAndDraftRoute,`（按现有字母序插入）
2. `export * from './routes/documents.routes'` 已存在，不动
3. `DEEPCHAT_ROUTE_CATALOG_PART_1` 的 documents 分组末尾追加：

```typescript
  'documentTemplates.testExtract',
  'documents.extractAndDraft',
```

- [ ] **Step 3: 在 `test/main/documents/documentsRoutes.test.ts` 追加契约测试**

```typescript
import {
  documentTemplatesTestExtractRoute,
  documentsExtractAndDraftRoute
} from '@shared/contracts/routes'

describe('documents extraction route contracts', () => {
  it('testExtract 契约解析合法输入', () => {
    const input = documentTemplatesTestExtractRoute.input.parse({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
    })
    expect(input.templateId).toBe('tpl-1')

    const output = documentTemplatesTestExtractRoute.output.parse({
      fields: [{ key: 'invoice_code', value: '123', uncertain: false }],
      meta: { route: 'vision', rawOutput: '{}', durationMs: 12, issues: [] }
    })
    expect(output.fields[0]?.key).toBe('invoice_code')
  })

  it('testExtract 契约拒绝空 file.path', () => {
    expect(() =>
      documentTemplatesTestExtractRoute.input.parse({
        templateId: 'tpl-1',
        file: { path: '' }
      })
    ).toThrow()
  })

  it('extractAndDraft 契约解析合法输入并默认 source', () => {
    const input = documentsExtractAndDraftRoute.input.parse({
      templateId: 'auto',
      file: { path: '/tmp/a.pdf' }
    })
    expect(input.source).toBe('manual')
  })
})
```

注意：该测试文件的既有 import 与 describe 结构由实现者按现状对齐（追加而非重写）；`@shared/contracts/routes` 路径别名以文件内既有 import 为准。

- [ ] **Step 4: 运行契约与既有 documents 测试确认通过**

Run: `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/documentsRoutes.test.ts`
Expected: PASS（4 + 3 = 7 tests）

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts/routes/documents.routes.ts src/shared/contracts/routes.ts test/main/documents/documentsRoutes.test.ts
git commit -m "feat(documents): add extraction route contracts"
```

---

### Task 6: 主进程 handler 与 composition 接线

**Files:**
- Modify: `src/main/documents/routes.ts`（`createDocumentsRoutes` 增加第二参数 extractor + 2 个 handler）
- Modify: `src/main/app/composition.ts`（构造 `DocumentExtractor`，传入 `createDocumentsRoutes`）
- Test: `test/main/documents/documentsRoutes.test.ts`（追加 handler 测试）

- [ ] **Step 1: 写失败测试（追加到 `test/main/documents/documentsRoutes.test.ts`）**

该文件既有测试直接调用 `createDocumentsRoutes(repository)`。追加的测试传入 mock extractor：

```typescript
describe('documents extraction handlers', () => {
  const makeExtractorStub = () => ({
    extract: vi.fn(async () => ({
      template: {
        id: 'tpl-1',
        typeKey: 'invoice_special',
        name: '增值税专用发票',
        icon: null,
        category: '发票类',
        fields: [],
        extractionMode: 'auto',
        promptPreset: null,
        isBuiltin: true,
        builtinSourceId: null,
        version: 1,
        createdAt: 1,
        updatedAt: 1
      },
      route: 'vision',
      fields: { invoice_code: { value: '123456789012', uncertain: false } },
      rawOutput: '{"fields":{}}',
      durationMs: 42,
      issues: []
    }))
  })

  it('documentTemplates.testExtract 返回字段数组与元信息', async () => {
    const repository = makeRepository() // 复用文件内既有的 repository 构造辅助
    const extractor = makeExtractorStub()
    const routes = createDocumentsRoutes(repository, extractor as never)
    const handler = routes.get('documentTemplates.testExtract')
    expect(handler).toBeDefined()

    const result = await handler!({ templateId: 'tpl-1', file: { path: '/tmp/a.jpg' } })
    expect(result.fields[0]).toEqual({
      key: 'invoice_code',
      value: '123456789012',
      uncertain: false
    })
    expect(result.meta.route).toBe('vision')
    expect(result.meta.durationMs).toBe(42)
  })

  it('documents.extractAndDraft 入库 draft 档案', async () => {
    const repository = makeRepository()
    const extractor = makeExtractorStub()
    const routes = createDocumentsRoutes(repository, extractor as never)
    const handler = routes.get('documents.extractAndDraft')
    expect(handler).toBeDefined()

    const result = await handler!({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg' },
      source: 'manual'
    })
    expect(result.document.status).toBe('draft')
    expect(result.document.typeKey).toBe('invoice_special')
    expect(result.document.fileUris).toEqual(['/tmp/a.jpg'])
    expect(result.document.fields.invoice_code).toEqual({
      value: '123456789012',
      uncertain: false
    })

    const listed = repository.listDocuments({ typeKey: 'invoice_special' })
    expect(listed.length).toBe(1)
  })
})
```

注意：`makeRepository` / sqlite 环境以该文件既有的 describeIfSqlite 与辅助函数为准；新增 describe 放在同一个 `describeIfSqlite` 内或建立新的 `describeIfSqlite`，保证 sqlite 不可用时同样 skip。`createDocumentsRoutes(repository, extractor as never)` 处若签名已改为必填两参，既有单参调用需同步补 mock extractor。

- [ ] **Step 2: 运行确认失败**

Run: `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/documentsRoutes.test.ts`
Expected: FAIL（签名不匹配或 handler 不存在）

- [ ] **Step 3: 修改 `src/main/documents/routes.ts`**

文件顶部 import 追加：

```typescript
import {
  documentTemplatesTestExtractRoute,
  documentsExtractAndDraftRoute
} from '@shared/contracts/routes'
import type { DocumentExtractor } from './extractor/documentExtractor'
```

签名与函数体修改（保持既有 9 个 handler 不变，仅追加）：

```typescript
export function createDocumentsRoutes(
  repository: DocumentsRepository,
  extractor: DocumentExtractor
): DeepchatRouteMap {
  return createRouteMap([
    // ...既有 9 条保持原样...
    [
      documentTemplatesTestExtractRoute.name,
      async (rawInput) => {
        const input = documentTemplatesTestExtractRoute.input.parse(rawInput)
        const result = await extractor.extract({ templateId: input.templateId, file: input.file })
        return documentTemplatesTestExtractRoute.output.parse({
          fields: Object.entries(result.fields).map(([key, entry]) => ({
            key,
            value: entry.value,
            uncertain: entry.uncertain
          })),
          meta: {
            route: result.route,
            rawOutput: result.rawOutput,
            durationMs: result.durationMs,
            issues: result.issues
          }
        })
      }
    ],
    [
      documentsExtractAndDraftRoute.name,
      async (rawInput) => {
        const input = documentsExtractAndDraftRoute.input.parse(rawInput)
        const result = await extractor.extract({ templateId: input.templateId, file: input.file })
        const document = repository.insertDocument({
          templateId: result.template.id,
          typeKey: result.template.typeKey,
          templateSnapshot: result.template,
          fields: result.fields,
          fileUris: [input.file.path],
          source: input.source ?? 'manual',
          sessionId: input.sessionId ?? null,
          status: 'draft',
          now: Date.now()
        })
        return documentsExtractAndDraftRoute.output.parse({
          document,
          meta: {
            route: result.route,
            rawOutput: result.rawOutput,
            durationMs: result.durationMs,
            issues: result.issues
          }
        })
      }
    ]
  ])
}
```

- [ ] **Step 4: composition 接线（`src/main/app/composition.ts`）**

1. import 追加：

```typescript
import { DocumentExtractor } from '@/documents/extractor/documentExtractor'
import { ImageFileAdapter } from '@/file/adapters/ImageFileAdapter'
import { PdfFileAdapter } from '@/file/adapters/PdfFileAdapter'
```

（import 路径以 composition.ts 内既有的 `@/file/...` 或相对路径写法为准，对齐现有风格。）

2. 在 `createDocumentsRoutes` 调用处（约 L2810）之前构造 extractor（此时 `providerSettings`、`providerRuntime`、`ocrRuntimeService` 均已赋值；`ocrRuntimeService` 为 `let` 变量，闭包内运行时解引用，即使构造早于赋值也安全）：

```typescript
const documentsMaxFileSize = () => dependencies.settingsStore.get<number>('maxFileSize') ?? 30 * 1024 * 1024

const documentExtractor = new DocumentExtractor({
  repository: documentsRepository,
  generateCompletion: ({ providerId, modelId, messages, temperature, maxTokens }) =>
    providerRuntime.generateCompletionStandalone(
      providerId,
      messages,
      modelId,
      temperature,
      maxTokens
    ),
  resolveVisionTarget: () => {
    const selection = providerSettings.getSetting<{ providerId: string; modelId: string }>(
      'defaultVisionModel'
    )
    return selection?.providerId && selection?.modelId ? selection : null
  },
  resolveTextTarget: () => {
    const selection = providerSettings.getSetting<{ providerId: string; modelId: string }>(
      'defaultModel'
    )
    return selection?.providerId && selection?.modelId ? selection : null
  },
  readImageAsDataUrl: async (filePath) => {
    const adapter = new ImageFileAdapter(filePath, documentsMaxFileSize())
    const dataUrl = await adapter.getLLMContent()
    if (!dataUrl) {
      throw new Error(`failed to read image for vision extraction: ${filePath}`)
    }
    return dataUrl
  },
  extractPdfText: async (filePath) => {
    const adapter = new PdfFileAdapter(filePath, documentsMaxFileSize())
    const pages = await adapter.getAllPagesMarkdown()
    const text = (pages ?? []).join('\n\n')
    return { text, hasTextLayer: text.replace(/\s/g, '').length >= 200 }
  },
  extractOcrText: async (filePath) => {
    const result = await ocrRuntimeService.extractDocument({
      filePath,
      maxFileSize: documentsMaxFileSize(),
      backend: 'auto',
      priority: 'interactive'
    })
    return result.text
  }
})
```

3. 替换调用：`createDocumentsRoutes(documentsRepository)` → `createDocumentsRoutes(documentsRepository, documentExtractor)`

**注意事项：**
- `ImageFileAdapter` / `PdfFileAdapter` 构造签名为 `(filePath: string, maxFileSize: number)`。
- `ocrRuntimeService.extractDocument` 的 `backend` 类型为 `LightOcrBackendPreference = 'auto' | 'cpu'`。
- 若 `getSetting` 泛型签名不匹配（`getSetting<T>(key: string): T | undefined`，settings.ts:894，应为公开方法），按实际签名微调。
- extractOcrText 中 `DocumentTextExtractionError` 不吞错：向上传播为 route 错误（zod 之外的主进程错误由既有 route 错误通道处理）。

- [ ] **Step 5: 运行确认通过**

Run: `$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents/documentsRoutes.test.ts`
Expected: PASS（7 + 2 = 9 tests）

- [ ] **Step 6: typecheck 确认 composition 接线无类型错误**

Run: `pnpm run typecheck:node`
Expected: 无新增错误

- [ ] **Step 7: Commit**

```bash
git add src/main/documents/routes.ts src/main/app/composition.ts test/main/documents/documentsRoutes.test.ts
git commit -m "feat(documents): wire extraction routes into main process"
```

---

### Task 7: 渲染层 DocumentsClient 扩展

**Files:**
- Modify: `src/renderer/api/DocumentsClient.ts`（追加 2 方法）
- Test: `test/renderer/api/documentsClient.test.ts`（追加 2 测试）

- [ ] **Step 1: 写失败测试（追加到 `test/renderer/api/documentsClient.test.ts`）**

按该文件既有的 mock bridge 模式追加（以文件内现有辅助为准，以下为断言逻辑）：

```typescript
it('testExtract 调用 documentTemplates.testExtract 路由', async () => {
  const { invoke } = vi.mocked(bridge)
  invoke.mockResolvedValue({
    fields: [{ key: 'invoice_code', value: '123', uncertain: false }],
    meta: { route: 'vision', rawOutput: '{}', durationMs: 8, issues: [] }
  })
  const client = createDocumentsClient(bridge)
  const result = await client.testExtract({
    templateId: 'tpl-1',
    file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
  })
  expect(invoke).toHaveBeenCalledWith('documentTemplates.testExtract', {
    templateId: 'tpl-1',
    file: { path: '/tmp/a.jpg', mimeType: 'image/jpeg' }
  })
  expect(result.meta.route).toBe('vision')
})

it('extractAndDraft 调用 documents.extractAndDraft 路由并透传 plain 对象', async () => {
  const { invoke } = vi.mocked(bridge)
  invoke.mockResolvedValue({
    document: makeRecord(), // 复用文件内既有的合法 record 构造辅助
    meta: { route: 'ocr', rawOutput: '{}', durationMs: 5, issues: [] }
  })
  const client = createDocumentsClient(bridge)
  const result = await client.extractAndDraft({
    templateId: 'auto',
    file: { path: '/tmp/a.pdf' }
  })
  expect(invoke).toHaveBeenCalledWith('documents.extractAndDraft', {
    templateId: 'auto',
    file: { path: '/tmp/a.pdf' }
  })
  expect(result.document.status).toBe('draft')
  expect(result.meta.route).toBe('ocr')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run test/renderer/api/documentsClient.test.ts --config vitest.config.renderer.ts`
Expected: FAIL（方法不存在）

- [ ] **Step 3: 实现（`src/renderer/api/DocumentsClient.ts`）**

import 块追加 `documentTemplatesTestExtractRoute` 与 `documentsExtractAndDraftRoute`；在 client 函数体内追加两个方法（风格对齐既有方法，`invokeRoute` 泛型与 `toPlainIpcValue` 沿用现有实现）：

```typescript
async function testExtract(input: {
  templateId: string
  file: { path: string; name?: string; mimeType?: string }
}) {
  return invokeRoute(bridge, documentTemplatesTestExtractRoute.name, toPlainIpcValue(input))
}

async function extractAndDraft(input: {
  templateId: string
  file: { path: string; name?: string; mimeType?: string }
  source?: 'chat' | 'manual'
  sessionId?: string
}) {
  return invokeRoute(bridge, documentsExtractAndDraftRoute.name, toPlainIpcValue(input))
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run test/renderer/api/documentsClient.test.ts --config vitest.config.renderer.ts`
Expected: PASS（2 + 2 = 4 tests）

- [ ] **Step 5: Commit**

```bash
git add src/renderer/api/DocumentsClient.ts test/renderer/api/documentsClient.test.ts
git commit -m "feat(documents): add extraction client methods"
```

---

### Task 8: 收尾验证

**Files:** 无新文件（只验证 + 修复 + 必要小修）

- [ ] **Step 1: 全量 P2 测试**

```bash
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/documents
pnpm exec vitest run test/renderer/api/documentsClient.test.ts --config vitest.config.renderer.ts
```

Expected: 全部 PASS（P1 既有 22 + P2 新增约 45）

- [ ] **Step 2: 全仓 typecheck / lint / format**

```bash
pnpm run typecheck
pnpm run lint
pnpm run format:check
```

Expected: 全部通过。format 问题先运行 `pnpm run format` 再复查。

- [ ] **Step 3: P1 回归确认**

```bash
$env:ELECTRON_RUN_AS_NODE='1'; pnpm exec electron ./node_modules/vitest/vitest.mjs run test/main/contracts
```

Expected: PASS（确认 route catalog 无回归；若该目录不存在则跳过并说明）

- [ ] **Step 4: 修复发现的问题并提交**

任何失败先修复再重跑；仅提交与 P2 相关的修复。

```bash
git add -A
git commit -m "fix(documents): polish extraction service"
```

（若无修改则跳过提交。）

- [ ] **Step 5: 汇报**

向控制者汇报：测试计数、typecheck/lint/format 结果、与 spec 第 6 节的偏差清单（如有）。

---

## Self-Review 结论

1. **Spec 覆盖**：第 6 节五步（文件读取→Task 6 注入适配、智能路由→Task 4、Prompt 构建→Task 1、模型调用→Task 4/6、校验→Task 2）全覆盖；分段合并→Task 3；typeKey=auto→Task 4；视觉不可用降级提示→Task 4 `requireTarget`；两条 IPC→Task 5-7；测试策略（提取服务层 mock provider）→各任务测试。第 7 节其余路由（exportCsv 等）属 P4。
2. **占位符扫描**：无 TBD/TODO；Task 6/7 中"对齐既有风格"处均给出了完整代码与明确的现状对齐点（import 别名、测试辅助函数名），属既有代码适配说明而非占位。
3. **类型一致性**：`DocumentExtractResult`（Task 4）与 Task 6 handler 消费字段一致；`documentExtractionMetaSchema`（Task 5）与 handler 组装的 `{ route, rawOutput, durationMs, issues }` 一致；`route` 枚举 `'vision' | 'text' | 'ocr'` 在 Task 4 类型与 Task 5 zod 一致。
