import type { ChatMessage } from '@shared/types/core/chat-message'
import type { DocumentFieldEntry, DocumentTemplate } from '@shared/documents'
import type { DocumentsRepository } from '@/documents/repository'
import { buildClassificationPrompts, buildExtractionUserPrompt } from './promptBuilder'
import { parseModelOutput, validateTemplateRules } from './fieldValidator'
import { mergeSegmentOutputs, splitTextIntoSegments } from './segmentMerger'

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
  repository: Pick<DocumentsRepository, 'getTemplate' | 'getTemplateByTypeKey' | 'listTemplates'>
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
        plan.route === 'ocr' ? await this.deps.extractOcrText(input.file.path) : (plan.text ?? '')
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
      throw new Error(`unsupported file type for extraction: ${file.mimeType ?? file.path}`)
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
