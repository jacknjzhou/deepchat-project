import type { ChatMessage } from '@shared/types/core/chat-message'
import type { DocumentFieldEntry, DocumentTemplate } from '@shared/documents'
import type { DocumentsRepository } from '@/documents/repository'
import {
  buildClassificationPrompts,
  buildExtractionSystemPrompt,
  buildExtractionUserPrompt
} from './promptBuilder'
import { parseModelOutput, validateTemplateRules, type ParsedModelOutput } from './fieldValidator'
import { mergeSegmentOutputs, splitTextIntoSegments } from './segmentMerger'
import { PDF_VISION_MAX_PAGES } from '@/file/adapters/pdfPageRenderer'

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

export type ModelTarget = { providerId: string; modelId: string }

export interface DocumentExtractorDeps {
  repository: Pick<DocumentsRepository, 'getTemplate' | 'getTemplateByTypeKey' | 'listTemplates'>
  generateCompletion: (input: CompletionRequest) => Promise<string>
  resolveVisionTarget: () => ModelTarget | null | Promise<ModelTarget | null>
  resolveTextTarget: () => ModelTarget | null | Promise<ModelTarget | null>
  readImageAsDataUrl: (filePath: string) => Promise<string>
  extractPdfText: (filePath: string) => Promise<{
    text: string
    hasTextLayer: boolean
    pageCount?: number
  }>
  renderPdfPages: (
    filePath: string,
    options?: { maxPages?: number }
  ) => Promise<{ dataUrls: string[]; pageCount: number }>
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

export class DocumentExtractor {
  constructor(private readonly deps: DocumentExtractorDeps) {}

  async extract(input: {
    templateId: string
    file: DocumentExtractFileInput
    signal?: AbortSignal
  }): Promise<DocumentExtractResult> {
    const startedAt = this.deps.now?.() ?? Date.now()
    const pdfText = isPdfFile(input.file) ? await this.deps.extractPdfText(input.file.path) : null
    const template = await this.resolveTemplate(input.templateId, input.file, pdfText)
    const plan = await this.buildRoutePlan(template, input.file, pdfText)

    const issues: string[] = []
    let fields: Record<string, DocumentFieldEntry>
    let rawOutput = ''

    if (plan.route === 'vision') {
      const target = this.requireTarget(await this.deps.resolveVisionTarget(), 'defaultVisionModel')
      if (isPdfFile(input.file)) {
        const { dataUrls, pageCount } = await this.deps.renderPdfPages(input.file.path)
        if (pageCount > dataUrls.length) {
          issues.push(
            `pdf has ${pageCount} pages; only first ${dataUrls.length} processed by vision`
          )
        }
        const partials: Record<string, DocumentFieldEntry>[] = []
        for (let index = 0; index < dataUrls.length; index += 1) {
          if (input.signal?.aborted) {
            throw new Error('extraction aborted')
          }
          const messages: ChatMessage[] = [
            { role: 'system', content: buildExtractionSystemPrompt(template) },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    dataUrls.length > 1
                      ? `这是扫描件第 ${index + 1}/${dataUrls.length} 页。只提取本页出现的字段值；本页没有的字段填 null，后续页面会补充。`
                      : buildExtractionUserPrompt(template, null)
                },
                { type: 'image_url', image_url: { url: dataUrls[index], detail: 'auto' } }
              ]
            }
          ]
          const output = await this.completeWithRetry(template, messages, target, {
            allowRequiredGapRetry: false
          })
          partials.push(parseModelOutput(output, template).fields)
          rawOutput += (rawOutput ? '\n---\n' : '') + output
        }
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
            issues.push(`${field.key}: conflicting values across pages`)
            fields[field.key] = { ...(fields[field.key] ?? { value: null }), uncertain: true }
          }
        }
      } else {
        const dataUrl = await this.deps.readImageAsDataUrl(input.file.path)
        const messages: ChatMessage[] = [
          { role: 'system', content: buildExtractionSystemPrompt(template) },
          {
            role: 'user',
            content: [
              { type: 'text', text: buildExtractionUserPrompt(template, null) },
              { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } }
            ]
          }
        ]
        rawOutput = await this.completeWithRetry(template, messages, target)
        const parsed = parseModelOutput(rawOutput, template)
        fields = parsed.fields
        issues.push(...parsed.issues)
      }
    } else {
      const text =
        plan.route === 'ocr' ? await this.deps.extractOcrText(input.file.path) : (plan.text ?? '')
      if (plan.route === 'ocr' && text.trim() === '') {
        issues.push('ocr produced no text')
      }
      const target = this.requireTarget(await this.deps.resolveTextTarget(), 'defaultModel')
      const segments = splitTextIntoSegments(text)
      if (segments.length === 1) {
        const messages: ChatMessage[] = [
          { role: 'system', content: buildExtractionSystemPrompt(template) },
          { role: 'user', content: buildExtractionUserPrompt(template, text) }
        ]
        rawOutput = await this.completeWithRetry(template, messages, target)
        const parsed = parseModelOutput(rawOutput, template)
        fields = parsed.fields
        issues.push(...parsed.issues)
      } else {
        const partials: Record<string, DocumentFieldEntry>[] = []
        const segmentOutputs: string[] = []
        const systemMessage: ChatMessage = {
          role: 'system',
          content: buildExtractionSystemPrompt(template)
        }
        for (let index = 0; index < segments.length; index += 1) {
          if (input.signal?.aborted) {
            throw new Error('extraction aborted')
          }
          const messages: ChatMessage[] = [
            systemMessage,
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

  private scoreParsed(template: DocumentTemplate, parsed: ParsedModelOutput): number {
    if (parsed.issues.includes('model output is not valid JSON')) {
      return Number.NEGATIVE_INFINITY
    }
    const filledRequired = template.fields.filter(
      (field) => field.required && parsed.fields[field.key]?.value !== null
    ).length
    return filledRequired * 100 - parsed.issues.length
  }

  private async completeWithRetry(
    template: DocumentTemplate,
    messages: ChatMessage[],
    target: ModelTarget,
    options: { allowRequiredGapRetry?: boolean } = {}
  ): Promise<string> {
    const { allowRequiredGapRetry = true } = options
    const request = { providerId: target.providerId, modelId: target.modelId }
    const first = await this.deps.generateCompletion({
      ...request,
      messages,
      temperature: EXTRACT_TEMPERATURE,
      maxTokens: EXTRACT_MAX_TOKENS
    })
    const firstParsed = parseModelOutput(first, template)
    const firstScore = this.scoreParsed(template, firstParsed)
    const requiredFields = template.fields.filter((field) => field.required)
    const hasRequiredGap =
      allowRequiredGapRetry &&
      requiredFields.length > 0 &&
      requiredFields.every((field) => firstParsed.fields[field.key]?.value === null)
    if (!firstParsed.issues.includes('model output is not valid JSON') && !hasRequiredGap) {
      return first
    }
    const reasons: string[] = []
    if (firstParsed.issues.includes('model output is not valid JSON')) {
      reasons.push('上一次输出无法解析（不是合法 JSON）')
    }
    if (hasRequiredGap) {
      reasons.push('上一次输出中必填字段全部为空')
    }
    let retried: string
    try {
      retried = await this.deps.generateCompletion({
        ...request,
        messages: [
          ...messages,
          { role: 'assistant', content: first },
          {
            role: 'user',
            content: `${reasons.join('，')}。请严格按系统提示重新输出一个完整的 JSON 对象，不要输出任何其他文字。`
          }
        ],
        temperature: EXTRACT_TEMPERATURE,
        maxTokens: EXTRACT_MAX_TOKENS
      })
    } catch {
      return first
    }
    const retriedParsed = parseModelOutput(retried, template)
    return this.scoreParsed(template, retriedParsed) > firstScore ? retried : first
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
    file: DocumentExtractFileInput,
    pdfText: { text: string; hasTextLayer: boolean; pageCount?: number } | null
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
    let target: ModelTarget
    if (isImageFile(file)) {
      target = this.requireTarget(await this.deps.resolveVisionTarget(), 'defaultVisionModel')
      const dataUrl = await this.deps.readImageAsDataUrl(file.path)
      messages = [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: user },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
          ]
        }
      ]
    } else if (isPdfFile(file)) {
      const scanned = pdfText !== null && !pdfText.hasTextLayer
      let visionTarget: ModelTarget | null = null
      let visionMessages: ChatMessage[] | null = null
      if (scanned) {
        const candidate = await this.deps.resolveVisionTarget()
        if (candidate) {
          const { dataUrls } = await this.deps.renderPdfPages(file.path, { maxPages: 1 })
          const firstPage = dataUrls[0]
          if (firstPage) {
            visionTarget = candidate
            visionMessages = [
              { role: 'system', content: system },
              {
                role: 'user',
                content: [
                  { type: 'text', text: user },
                  { type: 'image_url', image_url: { url: firstPage, detail: 'low' } }
                ]
              }
            ]
          }
        }
      }
      if (visionTarget !== null && visionMessages !== null) {
        target = visionTarget
        messages = visionMessages
      } else {
        target = this.requireTarget(await this.deps.resolveTextTarget(), 'defaultModel')
        const sample = (pdfText?.text ?? '').slice(0, 4000)
        messages = [
          { role: 'system', content: system },
          { role: 'user', content: [user, '', sample].join('\n') }
        ]
      }
    } else {
      throw new Error(`unsupported file type for extraction: ${file.mimeType ?? file.path}`)
    }
    const output = await this.deps.generateCompletion({
      providerId: target.providerId,
      modelId: target.modelId,
      messages,
      temperature: CLASSIFY_TEMPERATURE
    })
    const template = this.resolveClassifiedTemplate(output, candidates)
    if (!template) {
      const flattened = output.replace(/\s+/g, ' ').trim().slice(0, 200)
      throw new Error(`auto classification failed: no matching template in output: ${flattened}`)
    }
    return template
  }

  // Models occasionally drift from the strict JSON contract: uppercase keys,
  // prose answers, or echoing the template name. Try those rescues before
  // giving up so weak models still classify into a real template.
  private resolveClassifiedTemplate(
    output: string,
    candidates: DocumentTemplate[]
  ): DocumentTemplate | null {
    const match = output.match(/"typeKey"\s*:\s*"([a-zA-Z0-9_-]+)"/)
    const raw = match?.[1]
    if (raw) {
      const exact = this.deps.repository.getTemplateByTypeKey(raw)
      if (exact) return exact
      const lowered = this.deps.repository.getTemplateByTypeKey(raw.toLowerCase())
      if (lowered) return lowered
    }
    const loweredOutput = output.toLowerCase()
    const ordered = [...candidates].sort((a, b) => b.typeKey.length - a.typeKey.length)
    for (const candidate of ordered) {
      if (loweredOutput.includes(candidate.typeKey.toLowerCase())) return candidate
      if (output.includes(candidate.name)) return candidate
    }
    return null
  }

  private async buildRoutePlan(
    template: DocumentTemplate,
    file: DocumentExtractFileInput,
    pdfText: { text: string; hasTextLayer: boolean; pageCount?: number } | null
  ): Promise<{ route: DocumentExtractRoute; text?: string }> {
    const mode = template.extractionMode
    if (isImageFile(file)) {
      if (mode === 'text') {
        return { route: 'ocr' }
      }
      if (mode === 'auto') {
        // Prefer the multimodal model (fast, accurate); fall back to local OCR
        // + text model only when no vision model is configured.
        const visionAvailable = (await this.deps.resolveVisionTarget()) !== null
        return visionAvailable ? { route: 'vision' } : { route: 'ocr' }
      }
      return { route: 'vision' }
    }
    if (isPdfFile(file)) {
      if (mode === 'vision') {
        return { route: 'vision' }
      }
      if (pdfText?.hasTextLayer) {
        return { route: 'text', text: pdfText.text }
      }
      const visionAvailable = (await this.deps.resolveVisionTarget()) !== null
      const withinPageLimit = (pdfText?.pageCount ?? 0) <= PDF_VISION_MAX_PAGES
      return visionAvailable && withinPageLimit ? { route: 'vision' } : { route: 'ocr' }
    }
    throw new Error(`unsupported file type for extraction: ${file.mimeType ?? file.path}`)
  }
}
