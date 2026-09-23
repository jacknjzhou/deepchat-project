import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The renderer setup mocks a lightweight pinia without setActivePinia; restore the real one.
vi.mock('pinia', async () => vi.importActual<typeof import('pinia')>('pinia'))

const listDocuments = vi.fn()
const updateDocument = vi.fn()
const deleteDocument = vi.fn()
const extractAndDraft = vi.fn()
const exportCsv = vi.fn()
const previewFile = vi.fn()

vi.doMock('@api/DocumentsClient', () => ({
  createDocumentsClient: () => ({
    listDocuments,
    updateDocument,
    deleteDocument,
    extractAndDraft,
    exportCsv,
    previewFile
  })
}))

const { useDocumentsStore } = await import('@/stores/documents')

const draft = {
  id: 'd1',
  templateId: 'tpl-1',
  typeKey: 'contract',
  templateSnapshot: { fields: [] },
  fields: {},
  fileUris: [],
  source: 'manual',
  sessionId: null,
  status: 'draft',
  createdAt: 1,
  updatedAt: 1
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('documents archive store', () => {
  it('loadArchiveDocuments 首页重置 + 追加 + hasMore', async () => {
    listDocuments.mockResolvedValueOnce({
      documents: Array.from({ length: 50 }, (_, i) => ({ ...draft, id: `d${i}` }))
    })
    const store = useDocumentsStore()
    await store.loadArchiveDocuments()
    expect(listDocuments).toHaveBeenCalledWith({ limit: 50, offset: 0 })
    expect(store.archiveDocuments).toHaveLength(50)
    expect(store.archiveHasMore).toBe(true)
    listDocuments.mockResolvedValueOnce({ documents: [{ ...draft, id: 'x' }] })
    await store.loadArchiveDocuments(false)
    expect(listDocuments).toHaveBeenLastCalledWith({ limit: 50, offset: 50 })
    expect(store.archiveDocuments).toHaveLength(51)
    expect(store.archiveHasMore).toBe(false)
  })

  it('筛选参数透传给 listDocuments', async () => {
    listDocuments.mockResolvedValue({ documents: [] })
    const store = useDocumentsStore()
    store.archiveFilter.typeKey = 'contract'
    store.archiveFilter.status = 'draft'
    store.archiveFilter.keyword = '甲'
    store.archiveFilter.dateFrom = 1
    store.archiveFilter.dateTo = 2
    await store.loadArchiveDocuments()
    expect(listDocuments).toHaveBeenCalledWith({
      typeKey: 'contract',
      status: 'draft',
      keyword: '甲',
      dateFrom: 1,
      dateTo: 2,
      limit: 50,
      offset: 0
    })
  })

  it('saveArchiveDocument 保存后替换列表项并置 confirmed', async () => {
    listDocuments.mockResolvedValue({ documents: [draft] })
    updateDocument.mockResolvedValue({ document: { ...draft, status: 'confirmed' } })
    const store = useDocumentsStore()
    await store.loadArchiveDocuments()
    const saved = await store.saveArchiveDocument('d1', {
      buyer: { value: '乙', uncertain: false }
    })
    expect(updateDocument).toHaveBeenCalledWith({
      id: 'd1',
      fields: { buyer: { value: '乙', uncertain: false } },
      status: 'confirmed'
    })
    expect(saved?.status).toBe('confirmed')
    expect(store.archiveDocuments[0].status).toBe('confirmed')
  })

  it('removeArchiveDocument 删除后移出列表', async () => {
    listDocuments.mockResolvedValue({ documents: [draft] })
    deleteDocument.mockResolvedValue({ success: true })
    const store = useDocumentsStore()
    await store.loadArchiveDocuments()
    await store.removeArchiveDocument('d1')
    expect(deleteDocument).toHaveBeenCalledWith('d1')
    expect(store.archiveDocuments).toHaveLength(0)
  })

  it('recognizeDocument 插入新 draft 到列表头部', async () => {
    extractAndDraft.mockResolvedValue({
      document: { ...draft, id: 'new' },
      meta: { route: 'vision', rawOutput: '', durationMs: 1, issues: [] }
    })
    const store = useDocumentsStore()
    const result = await store.recognizeDocument({
      templateId: 'tpl-1',
      file: { path: '/a.png' }
    })
    expect(result.document.id).toBe('new')
    expect(store.archiveDocuments[0].id).toBe('new')
  })

  it('exportArchiveCsv 透传当前筛选', async () => {
    exportCsv.mockResolvedValue({ canceled: false, path: 'C:\\a.csv' })
    const store = useDocumentsStore()
    store.archiveFilter.typeKey = 'contract'
    const result = await store.exportArchiveCsv()
    expect(exportCsv).toHaveBeenCalledWith({ typeKey: 'contract' })
    expect(result).toEqual({ canceled: false, path: 'C:\\a.csv' })
  })

  it('previewArchiveFile 转发 documentId+uriIndex', async () => {
    previewFile.mockResolvedValue({ dataBase64: 'aGk=', mimeType: 'image/png', name: 'a.png' })
    const store = useDocumentsStore()
    const result = await store.previewArchiveFile('d1', 0)
    expect(previewFile).toHaveBeenCalledWith({ documentId: 'd1', uriIndex: 0 })
    expect(result.mimeType).toBe('image/png')
  })
})
