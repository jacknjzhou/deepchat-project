import { describe, expect, it, vi } from 'vitest'
import {
  DocumentRecognitionToolHandler,
  documentRecognitionActionNeedsPermission
} from '@/tool/agentTools/documentRecognitionTool'
import { DOCUMENT_RECOGNITION_AGENT_TOOL_NAME } from '@shared/agentTools'

const makePort = () => ({
  listTemplates: vi.fn(async () => [
    {
      id: 'tpl-1',
      typeKey: 'invoice_special',
      name: '增值税专用发票',
      fields: [{ key: 'invoice_code', label: '发票代码', valueType: 'text', required: true, order: 1 }]
    }
  ]),
  extractAndDraft: vi.fn(async () => ({
    document: {
      id: 'd1',
      typeKey: 'invoice_special',
      status: 'draft',
      fields: { invoice_code: { value: '123', uncertain: false } },
      fileUris: ['/tmp/a.jpg']
    },
    meta: { route: 'vision', durationMs: 10, issues: [] }
  })),
  confirmDocument: vi.fn(async (): Promise<{ id: string; status: string } | null> => ({
    id: 'd1',
    status: 'confirmed'
  }))
})

describe('documentRecognitionTool', () => {
  it('definition 暴露 tool 名与 json schema', () => {
    const definition = new DocumentRecognitionToolHandler().getToolDefinition()
    expect(definition.function.name).toBe(DOCUMENT_RECOGNITION_AGENT_TOOL_NAME)
    expect(definition.function.parameters).toBeDefined()
  })

  it('list_templates 返回模板列表且免权限', async () => {
    const port = makePort()
    const result = await new DocumentRecognitionToolHandler().call({ action: 'list_templates' }, port)
    expect(result.ok).toBe(true)
    expect(port.listTemplates).toHaveBeenCalled()
    expect(documentRecognitionActionNeedsPermission({ action: 'list_templates' })).toBe(false)
  })

  it('recognize 需要 templateId+file 并透传 source=chat', async () => {
    const port = makePort()
    const handler = new DocumentRecognitionToolHandler()
    const ok = await handler.call(
      { action: 'recognize', templateId: 'tpl-1', file: { path: '/tmp/a.jpg' } },
      port
    )
    expect(ok.ok).toBe(true)
    expect(port.extractAndDraft).toHaveBeenCalledWith({
      templateId: 'tpl-1',
      file: { path: '/tmp/a.jpg' },
      source: 'chat'
    })
    const missing = await handler.call({ action: 'recognize' }, port)
    expect(missing.ok).toBe(false)
    expect(documentRecognitionActionNeedsPermission({ action: 'recognize' })).toBe(true)
  })

  it('confirm 需要 documentId；未找到返回错误', async () => {
    const handler = new DocumentRecognitionToolHandler()
    const missing = await handler.call({ action: 'confirm' }, makePort())
    expect(missing.ok).toBe(false)
    const port = makePort()
    port.confirmDocument.mockResolvedValueOnce(null)
    const notFound = await handler.call({ action: 'confirm', documentId: 'x' }, port)
    expect(notFound.ok).toBe(false)
    const ok = await handler.call({ action: 'confirm', documentId: 'd1' }, port)
    expect(ok.ok).toBe(true)
    expect(documentRecognitionActionNeedsPermission({ action: 'confirm' })).toBe(true)
  })

  it('非法输入返回 INVALID_INPUT 错误', async () => {
    const result = await new DocumentRecognitionToolHandler().call({ action: 'nope' }, makePort())
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('INVALID_INPUT')
    expect(documentRecognitionActionNeedsPermission({ action: 'nope' })).toBe(true)
  })
})
