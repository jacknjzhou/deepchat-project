import { describe, expect, it } from 'vitest'
import {
  documentTemplatesDeleteRoute,
  documentTemplatesForkRoute,
  documentTemplatesGetRoute,
  documentTemplatesListRoute,
  documentTemplatesTestExtractRoute,
  documentTemplatesUpsertRoute,
  documentsDeleteRoute,
  documentsExtractAndDraftRoute,
  documentsGetRoute,
  documentsListRoute,
  documentsUpsertRoute
} from '@shared/contracts/routes'

describe('documents route contracts', () => {
  it('parses template list output', () => {
    const output = documentTemplatesListRoute.output.parse({ templates: [] })
    expect(output.templates).toEqual([])
  })

  it('parses template upsert input and output', () => {
    const input = documentTemplatesUpsertRoute.input.parse({
      typeKey: 'k1',
      name: '模板',
      category: '自定义',
      fields: [
        {
          key: 'f1',
          label: '字段1',
          valueType: 'text',
          required: true,
          promptHint: null,
          validation: null,
          enumOptions: null,
          order: 1
        }
      ]
    })
    expect(input.typeKey).toBe('k1')
    expect(() =>
      documentTemplatesUpsertRoute.input.parse({
        typeKey: 'k2',
        name: 'X',
        category: '自定义',
        fields: [
          {
            key: 'f1',
            label: '字段1',
            valueType: 'money',
            required: true,
            promptHint: null,
            validation: null,
            enumOptions: null,
            order: 1
          }
        ]
      })
    ).toThrow()
    const output = documentTemplatesUpsertRoute.output.parse({
      template: {
        id: 'id-1',
        typeKey: 'k1',
        name: '模板',
        icon: null,
        category: '自定义',
        fields: [],
        extractionMode: 'auto',
        promptPreset: null,
        isBuiltin: false,
        builtinSourceId: null,
        version: 1,
        createdAt: 1,
        updatedAt: 1
      }
    })
    expect(output.template.id).toBe('id-1')
  })

  it('parses document list input filters and record output', () => {
    const input = documentsListRoute.input.parse({
      typeKey: 'contract',
      status: 'draft',
      keyword: '甲',
      limit: 50,
      offset: 0
    })
    expect(input.limit).toBe(50)
    const record = {
      id: 'd1',
      templateId: 't1',
      typeKey: 'contract',
      templateSnapshot: {
        id: 't1',
        typeKey: 'contract',
        name: '合同模板',
        icon: null,
        category: '合同类',
        fields: [],
        extractionMode: 'auto' as const,
        promptPreset: null,
        isBuiltin: true,
        builtinSourceId: null,
        version: 1,
        createdAt: 1,
        updatedAt: 1
      },
      fields: { party_a: { value: '甲公司', uncertain: false } },
      fileUris: ['deepchat-file://a.png'],
      source: 'chat' as const,
      sessionId: 's1',
      status: 'draft' as const,
      createdAt: 1,
      updatedAt: 2
    }
    const output = documentsListRoute.output.parse({ documents: [record] })
    expect(output.documents[0].fields.party_a.value).toBe('甲公司')
  })

  it('exposes route names', () => {
    expect(documentTemplatesGetRoute.name).toBe('documentTemplates.get')
    expect(documentTemplatesForkRoute.name).toBe('documentTemplates.fork')
    expect(documentsGetRoute.name).toBe('documents.get')
    expect(documentsUpsertRoute.name).toBe('documents.upsert')
    expect(documentsDeleteRoute.name).toBe('documents.delete')
  })
})

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
