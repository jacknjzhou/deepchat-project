import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ResumeScreeningTaskDto } from '@api/resumeScreeningTasks'

// The renderer setup mocks a lightweight pinia without setActivePinia; restore the real one.
vi.mock('pinia', async () => vi.importActual<typeof import('pinia')>('pinia'))

const createTaskMock = vi.fn()
const getTask = vi.fn()
const listTasks = vi.fn()
const cancelTask = vi.fn()
const getProfile = vi.fn()
const updateProfile = vi.fn()
const listModels = vi.fn()
const onTaskUpdated = vi.fn()
const onResumeUpdated = vi.fn()

vi.doMock('@api/ResumeScreeningClient', () => ({
  createResumeScreeningClient: () => ({
    createTask: createTaskMock,
    getTask,
    listTasks,
    cancelTask,
    getProfile,
    updateProfile,
    listModels,
    onTaskUpdated,
    onResumeUpdated
  })
}))

const { useResumeScreeningStore } = await import('@/stores/resumeScreening')

const makeTask = (): ResumeScreeningTaskDto => ({
  id: 'task-1',
  status: 'queued',
  jdSource: 'text',
  jdText: '前端工程师',
  jdFileName: null,
  jdAnalysis: null,
  config: { generateExplanation: true, includeRawText: false, maxConcurrency: 3 },
  providerId: 'openai',
  modelId: 'gpt-4o',
  total: 1,
  succeeded: 0,
  failed: 0,
  avgScore: null,
  recommendedCount: 0,
  createdByName: '张三',
  createdByEmail: 'z@example.com',
  startedAt: null,
  finishedAt: null,
  createdAt: 1,
  updatedAt: 1
})

const makeResume = () => ({
  id: 'resume-1',
  taskId: 'task-1',
  fileName: '张三.pdf',
  mimeType: 'application/pdf',
  size: 1024,
  candidateName: '张三',
  rawText: null,
  resumeInfo: null,
  screening: null,
  interview: null,
  hr: null,
  score: null,
  recommended: null,
  status: 'pending',
  error: null,
  createdAt: 1,
  updatedAt: 1
})

describe('resumeScreening store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('createTask sends trimmed draft input, prepends the task and resets the draft', async () => {
    const store = useResumeScreeningStore()
    store.draft.jdText = '  前端工程师  '
    store.draft.resumes.push({ path: 'C:\\a.pdf', name: 'a.pdf' })
    store.draft.providerId = 'openai'
    store.draft.modelId = 'gpt-4o'
    createTaskMock.mockResolvedValue({ task: makeTask() })
    getTask.mockResolvedValue({ task: makeTask(), resumes: [makeResume()] })

    const created = await store.createTask()

    expect(created?.id).toBe('task-1')
    expect(createTaskMock).toHaveBeenCalledWith({
      jdSource: 'text',
      jdText: '前端工程师',
      jdFilePath: undefined,
      jdFileName: undefined,
      resumes: [{ path: 'C:\\a.pdf', name: 'a.pdf' }],
      config: { generateExplanation: true, includeRawText: false, maxConcurrency: 3 },
      providerId: 'openai',
      modelId: 'gpt-4o'
    })
    expect(store.tasks[0].id).toBe('task-1')
    expect(store.currentTask?.id).toBe('task-1')
    expect(store.currentResumes).toHaveLength(1)
    expect(store.selectedResumeId).toBe('resume-1')
    expect(store.draft.jdText).toBe('')
    expect(store.draft.resumes).toHaveLength(0)
    expect(store.isCreating).toBe(false)
  })

  it('createTask rejects an empty draft without calling the client', async () => {
    const store = useResumeScreeningStore()
    store.draft.jdText = '前端工程师'

    await expect(store.createTask()).resolves.toBeNull()
    expect(createTaskMock).not.toHaveBeenCalled()
  })

  it('createTask records the error message when the client call fails', async () => {
    const store = useResumeScreeningStore()
    store.draft.jdText = '前端工程师'
    store.draft.resumes.push({ path: 'C:\\a.pdf', name: 'a.pdf' })
    createTaskMock.mockRejectedValue(new Error('模型不可用'))

    await store.createTask()

    expect(store.createError).toBe('模型不可用')
    expect(store.isCreating).toBe(false)
  })

  it('loadTask selects the first resume and clears state when the task is missing', async () => {
    const store = useResumeScreeningStore()
    getTask.mockResolvedValue({
      task: makeTask(),
      resumes: [makeResume(), { ...makeResume(), id: 'resume-2', fileName: '李四.pdf' }]
    })

    await store.loadTask('task-1')

    expect(store.currentTask?.id).toBe('task-1')
    expect(store.currentResumes).toHaveLength(2)
    expect(store.selectedResumeId).toBe('resume-1')

    getTask.mockResolvedValue({ task: null, resumes: [] })
    await store.loadTask('missing')

    expect(store.currentTask).toBeNull()
    expect(store.currentResumes).toHaveLength(0)
    expect(store.selectedResumeId).toBeNull()
  })

  it('handleTaskUpdated reloads the task list for unknown tasks', async () => {
    const store = useResumeScreeningStore()
    listTasks.mockResolvedValue({ tasks: [makeTask()] })

    store.handleTaskUpdated({
      taskId: 'task-1',
      status: 'running',
      progress: { done: 0, total: 1 },
      stats: { succeeded: 0, failed: 0, avgScore: null, recommendedCount: 0 },
      version: 2
    })

    await vi.waitFor(() => expect(store.tasks).toHaveLength(1))
    expect(store.tasksLoaded).toBe(true)
  })

  it('handleTaskUpdated patches the list and current task, then reloads after debounce', async () => {
    vi.useFakeTimers()
    try {
      const store = useResumeScreeningStore()
      listTasks.mockResolvedValue({ tasks: [makeTask()] })
      getTask.mockResolvedValue({ task: makeTask(), resumes: [makeResume()] })
      await store.loadTasks()
      await store.loadTask('task-1')
      expect(getTask).toHaveBeenCalledTimes(1)

      store.handleTaskUpdated({
        taskId: 'task-1',
        status: 'done',
        progress: { done: 1, total: 1 },
        stats: { succeeded: 1, failed: 0, avgScore: 88, recommendedCount: 1 },
        version: 2
      })

      expect(store.tasks[0].status).toBe('done')
      expect(store.tasks[0].avgScore).toBe(88)
      expect(store.currentTask?.succeeded).toBe(1)
      expect(getTask).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(300)
      expect(getTask).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('handleResumeUpdated patches the matching resume of the current task only', async () => {
    const store = useResumeScreeningStore()
    getTask.mockResolvedValue({ task: makeTask(), resumes: [makeResume()] })
    await store.loadTask('task-1')

    store.handleResumeUpdated({
      taskId: 'task-1',
      resumeId: 'resume-1',
      status: 'done',
      stage: 'hr',
      version: 3
    })

    expect(store.currentResumes[0].status).toBe('done')

    store.handleResumeUpdated({
      taskId: 'other-task',
      resumeId: 'resume-1',
      status: 'failed',
      stage: null,
      version: 4
    })

    expect(store.currentResumes[0].status).toBe('done')
  })

  it('saveProfile persists the profile via updateProfile', async () => {
    const store = useResumeScreeningStore()
    updateProfile.mockResolvedValue({ profile: { name: '李四', email: 'li@example.com' } })

    await store.saveProfile({ name: '李四' })

    expect(updateProfile).toHaveBeenCalledWith({ name: '李四' })
    expect(store.profile?.name).toBe('李四')
  })

  it('loadModels stores models and defaults the draft to the default model', async () => {
    const store = useResumeScreeningStore()
    listModels.mockResolvedValue({
      models: [
        {
          providerId: 'openai',
          providerName: 'OpenAI',
          modelId: 'gpt-4o',
          modelName: 'GPT-4o',
          isDefault: true
        },
        {
          providerId: 'anthropic',
          providerName: 'Anthropic',
          modelId: 'claude',
          modelName: 'Claude',
          isDefault: false
        }
      ]
    })

    await store.loadModels()

    expect(store.models).toHaveLength(2)
    expect(store.selectedModelKey).toBe('openai::gpt-4o')

    store.selectModel('anthropic', 'claude')
    expect(store.selectedModelKey).toBe('anthropic::claude')
  })

  it('canReview requires jd text, at least one resume and an idle state', () => {
    const store = useResumeScreeningStore()
    expect(store.canReview).toBe(false)

    store.draft.jdText = '前端工程师'
    expect(store.canReview).toBe(false)

    store.draft.resumes.push({ path: 'C:\\a.pdf', name: 'a.pdf' })
    expect(store.canReview).toBe(true)

    store.currentTask = { ...makeTask(), status: 'running' }
    expect(store.canReview).toBe(false)
  })
})
