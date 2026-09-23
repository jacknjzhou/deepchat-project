import { z } from 'zod'
import { toDeepChatJsonSchema } from '@shared/lib/zodJsonSchema'
import { TOOL_EXECUTION, type MCPToolDefinition } from '@shared/types/mcp'
import { DOCUMENT_RECOGNITION_AGENT_TOOL_NAME, DOCUMENT_RECOGNITION_TOOL_SERVER_NAME } from '@shared/agentTools'
import {
  createAgentToolErrorResult,
  createAgentToolSuccessResult,
  type AgentToolResult
} from '@shared/lib/agentToolResultEnvelope'
import type { AgentDocumentsToolPort } from '../runtimePorts'

const fileSchema = z.strictObject({
  path: z.string().trim().min(1),
  name: z.string().trim().min(1).max(255).optional(),
  mimeType: z.string().trim().min(1).max(128).optional()
})

const documentRecognitionToolSchema = z.strictObject({
  action: z.enum(['list_templates', 'recognize', 'confirm']),
  templateId: z.string().trim().min(1).optional(),
  file: fileSchema.optional(),
  documentId: z.string().trim().min(1).optional(),
  fields: z
    .record(z.string(), z.object({ value: z.unknown(), uncertain: z.boolean() }))
    .optional()
})

type DocumentRecognitionToolInput = z.infer<typeof documentRecognitionToolSchema>

export function documentRecognitionActionNeedsPermission(args: unknown): boolean {
  const parsed = documentRecognitionToolSchema.safeParse(args)
  if (!parsed.success) {
    return true
  }
  return parsed.data.action !== 'list_templates'
}

const TOOL_DESCRIPTION = [
  'Recognize administrative documents (invoices, contracts, travel tickets, hotel receipts,',
  'purchase orders, payment screenshots, ...) and archive the extracted fields.',
  'Actions: list_templates — list available document templates with their fields;',
  'recognize — extract fields from a local file with the chosen template and save a draft',
  'archive record; confirm — mark the draft as confirmed after the user reviews the fields.'
].join(' ')

export class DocumentRecognitionToolHandler {
  getToolDefinition(): MCPToolDefinition {
    return {
      execution: TOOL_EXECUTION.write,
      type: 'function',
      function: {
        name: DOCUMENT_RECOGNITION_AGENT_TOOL_NAME,
        description: TOOL_DESCRIPTION,
        parameters: toDeepChatJsonSchema(documentRecognitionToolSchema) as {
          type: string
          properties: Record<string, unknown>
          required?: string[]
        }
      },
      server: {
        name: DOCUMENT_RECOGNITION_TOOL_SERVER_NAME,
        icons: '📄',
        description: 'DeepChat document recognition tools'
      }
    }
  }

  isDocumentRecognitionTool(toolName: string): boolean {
    return toolName === DOCUMENT_RECOGNITION_AGENT_TOOL_NAME
  }

  async call(args: unknown, port: AgentDocumentsToolPort): Promise<AgentToolResult> {
    let input: DocumentRecognitionToolInput
    try {
      input = documentRecognitionToolSchema.parse(args)
    } catch (error) {
      return createAgentToolErrorResult(
        DOCUMENT_RECOGNITION_AGENT_TOOL_NAME,
        error instanceof Error ? error.message : String(error),
        { code: 'INVALID_INPUT' }
      )
    }

    if (input.action === 'list_templates') {
      const templates = await port.listTemplates()
      return createAgentToolSuccessResult(DOCUMENT_RECOGNITION_AGENT_TOOL_NAME, templates, {
        summary: `Found ${templates.length} document template(s).`,
        data: { templates },
        meta: { resultCount: templates.length }
      })
    }

    if (input.action === 'recognize') {
      if (!input.templateId || !input.file) {
        return createAgentToolErrorResult(
          DOCUMENT_RECOGNITION_AGENT_TOOL_NAME,
          'templateId and file.path are required for the recognize action.',
          { code: 'MISSING_ARGUMENTS', recoverable: true }
        )
      }
      const result = await port.extractAndDraft({
        templateId: input.templateId,
        file: input.file,
        source: 'chat'
      })
      return createAgentToolSuccessResult(DOCUMENT_RECOGNITION_AGENT_TOOL_NAME, result, {
        summary:
          `Recognized document ${result.document.id} (type ${result.document.typeKey}) and saved ` +
          'a draft archive. Show the extracted fields to the user, highlight uncertain fields, ' +
          'and ask for confirmation before calling confirm.',
        data: result
      })
    }

    if (!input.documentId) {
      return createAgentToolErrorResult(
        DOCUMENT_RECOGNITION_AGENT_TOOL_NAME,
        'documentId is required for the confirm action.',
        { code: 'MISSING_ARGUMENTS', recoverable: true }
      )
    }
    const updated = await port.confirmDocument({ id: input.documentId, fields: input.fields })
    if (!updated) {
      return createAgentToolErrorResult(
        DOCUMENT_RECOGNITION_AGENT_TOOL_NAME,
        `Document not found: ${input.documentId}`,
        { code: 'NOT_FOUND', recoverable: true }
      )
    }
    return createAgentToolSuccessResult(DOCUMENT_RECOGNITION_AGENT_TOOL_NAME, updated, {
      summary: `Document ${updated.id} confirmed.`
    })
  }
}
