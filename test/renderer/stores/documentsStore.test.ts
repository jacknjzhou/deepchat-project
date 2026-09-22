import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The renderer setup mocks a lightweight pinia without setActivePinia; restore the real one.
vi.mock('pinia', async () => vi.importActual<typeof import('pinia')>('pinia'))

const mockDocumentsClient = () => ({
  listTemplates: vi.fn(),
  getTemplate: vi.fn(),
  upsertTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  forkTemplate: vi.fn(),
  testExtract: vi.fn()
})

const builtinTemplate = {
  id: 'tpl_contract',
  typeKey: 'contract',
  name: 'Contract',
  icon: null,
  category: '合同类',
  fields: [],
  extractionMode: 'auto',
  promptPreset: null,
  isBuiltin: true,
  builtinSourceId: null,
  version: 1,
  createdAt: 1,
  updatedAt: 1
}

const customTemplate = {
  ...builtinTemplate,
  id: 'tpl_custom',
  typeKey: 'custom_doc',
  name: 'Custom Doc',
  isBuiltin: false
}

describe('DocumentsStore', () => {
  let client: ReturnType<typeof mockDocumentsClient>

  beforeEach(async () => {
    setActivePinia(createPinia())
    client = mockDocumentsClient()
    vi.resetModules()
    vi.doMock('@api/DocumentsClient', () => ({
      createDocumentsClient: () => client
    }))
  })

  it('loads templates and separates builtin vs custom', async () => {
    client.listTemplates.mockResolvedValue({
      templates: [builtinTemplate, customTemplate]
    })
    const { useDocumentsStore } = await import('../../../src/renderer/src/stores/documents')
    const store = useDocumentsStore()
    await store.loadTemplates()

    expect(store.builtinTemplates).toHaveLength(1)
    expect(store.customTemplates).toHaveLength(1)
    expect(store.loadError).toBeNull()
    expect(store.isLoading).toBe(false)
  })

  it('captures load error and surfaces user-facing message', async () => {
    client.listTemplates.mockRejectedValue(new Error('boom'))
    const { useDocumentsStore } = await import('../../../src/renderer/src/stores/documents')
    const store = useDocumentsStore()
    await store.loadTemplates()

    expect(store.loadError).toBe('settings.documents.templates.loadFailed')
    expect(store.builtinTemplates).toEqual([])
  })

  it('detects typeKey conflicts using cached templates', async () => {
    client.listTemplates.mockResolvedValue({
      templates: [builtinTemplate, customTemplate]
    })
    const { useDocumentsStore } = await import('../../../src/renderer/src/stores/documents')
    const store = useDocumentsStore()
    await store.loadTemplates()

    expect(store.isTypeKeyTaken('custom_doc')).toBe(true)
    expect(store.isTypeKeyTaken('fresh_key')).toBe(false)
    // editing the same template: exclude its own id
    expect(store.isTypeKeyTaken('custom_doc', 'tpl_custom')).toBe(false)
  })

  it('parses archive reference count from delete error', async () => {
    client.deleteTemplate.mockRejectedValueOnce(
      new Error('Template has 3 archived document(s); pass force to confirm')
    )
    const { useDocumentsStore } = await import('../../../src/renderer/src/stores/documents')
    const store = useDocumentsStore()
    const result = await store.attemptDelete('tpl_custom')

    expect(result).toEqual({ kind: 'force-required', referenceCount: 3 })
    // retry with force
    client.deleteTemplate.mockResolvedValueOnce({ success: true })
    const forced = await store.attemptDelete('tpl_custom', { force: true })
    expect(forced).toEqual({ kind: 'deleted' })
    expect(store.customTemplates).toHaveLength(0)
  })

  it('upserts and updates the cached list', async () => {
    client.listTemplates.mockResolvedValue({ templates: [builtinTemplate] })
    client.upsertTemplate.mockResolvedValue({ template: customTemplate })
    const { useDocumentsStore } = await import('../../../src/renderer/src/stores/documents')
    const store = useDocumentsStore()
    await store.loadTemplates()

    const saved = await store.saveTemplate({
      typeKey: 'custom_doc',
      name: 'Custom Doc',
      category: '自定义',
      fields: [],
      extractionMode: 'auto'
    })

    expect(saved.id).toBe('tpl_custom')
    expect(store.customTemplates[0]).toEqual(customTemplate)
  })

  it('forwards testExtract to the client', async () => {
    client.testExtract.mockResolvedValue({
      fields: [{ key: 'amount', value: 100, uncertain: false }],
      meta: {
        route: 'vision',
        rawOutput: '{}',
        durationMs: 500,
        issues: []
      }
    })
    const { useDocumentsStore } = await import('../../../src/renderer/src/stores/documents')
    const store = useDocumentsStore()
    const result = await store.testExtract({
      templateId: 'tpl_contract',
      file: { path: '/tmp/sample.png', name: 'sample.png' }
    })

    expect(result.fields[0].key).toBe('amount')
    expect(result.meta.route).toBe('vision')
  })
})
