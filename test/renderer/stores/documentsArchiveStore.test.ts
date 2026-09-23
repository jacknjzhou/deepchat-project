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
const stats = vi.fn()
const listTasks = vi.fn()
const createTasks = vi.fn()

vi.doMock('@api/DocumentsClient', () => ({
  createDocumentsClient: () => ({
    listDocuments,
    updateDocument,
    deleteDocument,
    extractAndDraft,
    exportCsv,
    previewFile,
    stats,
    listTasks,
    createTasks
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

const makeTask = () => ({
  id: 't1',
  batchId: 'b1',
  filePath: 'C:\\a.png',
  fileName: 'a.png',
  templateId: 'auto',
  status: 'pending',
  typeKey: null,
  documentId: null,
  error: null,
  createdAt: 1,
  updatedAt: 1
})

const makeTaskEvent = () => ({
  ...makeTask(),
  status: 'running' as const,
  doneCount: 0,
  totalCount: 1,
  version: 1
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('documents archive store', () => {
  it('loadArchiveDocuments 按页码计算 offset 并记录 total/page', async () => {
    listDocuments.mockResolvedValue({ documents: [draft], total: 51 })
    const store = useDocumentsStore()
    await store.loadArchiveDocuments(2)
    expect(listDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 50, offset: 50 })
    )
    expect(store.archivePage).toBe(2)
    expect(store.archiveTotal).toBe(51)
    expect(store.archiveTotalPages).toBe(2)
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

  it('loadArchiveStats 按当前日期筛选拉取分类型统计', async () => {
    stats.mockResolvedValue({
      stats: [{ typeKey: 'invoice_special', total: 3, draft: 2, confirmed: 1 }]
    })
    const store = useDocumentsStore()
    store.archiveFilter.dateFrom = 100
    await store.loadArchiveStats()
    expect(stats).toHaveBeenCalledWith({ dateFrom: 100, dateTo: undefined })
    expect(store.archiveStats).toEqual([
      { typeKey: 'invoice_special', total: 3, draft: 2, confirmed: 1 }
    ])
  })

  it('loadArchiveTasks 拉取任务列表', async () => {
    listTasks.mockResolvedValue({ tasks: [makeTask()] })
    const store = useDocumentsStore()
    await store.loadArchiveTasks()
    expect(store.tasks).toHaveLength(1)
    expect(store.tasks[0]?.id).toBe('t1')
  })

  it('handleTaskUpdated upsert 任务并在完成时刷新统计与当前页', async () => {
    listTasks.mockResolvedValue({ tasks: [] })
    stats.mockResolvedValue({ stats: [] })
    listDocuments.mockResolvedValue({ documents: [], total: 0 })
    const store = useDocumentsStore()
    await store.loadArchiveTasks()
    store.handleTaskUpdated(makeTaskEvent())
    expect(store.tasks).toHaveLength(1)
    listDocuments.mockClear()
    stats.mockClear()
    store.handleTaskUpdated({
      ...makeTaskEvent(),
      status: 'done',
      typeKey: 'invoice_special',
      documentId: 'd1'
    })
    expect(store.tasks[0]?.status).toBe('done')
    expect(stats).toHaveBeenCalled()
    expect(listDocuments).toHaveBeenCalled()
  })

  it('createRecognitionTasks 创建任务并插入列表头部', async () => {
    createTasks.mockResolvedValue({ tasks: [makeTask()] })
    const store = useDocumentsStore()
    const created = await store.createRecognitionTasks({
      files: [{ path: 'C:\\a.png', name: 'a.png' }],
      templateId: 'auto'
    })
    expect(createTasks).toHaveBeenCalledWith({
      files: [{ path: 'C:\\a.png', name: 'a.png' }],
      templateId: 'auto',
      source: 'manual'
    })
    expect(created).toHaveLength(1)
    expect(store.tasks[0]?.id).toBe('t1')
  })
})
