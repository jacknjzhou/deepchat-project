import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { z } from 'zod'
import type {
  resumeScreeningResumeUpdatedEvent,
  resumeScreeningTaskUpdatedEvent
} from '@shared/contracts/events'
import type {
  ResumeScreeningClient,
  ResumeScreeningUpdateProfileInput
} from '@api/ResumeScreeningClient'
import {
  resumeScreeningApi,
  type ResumeScreeningResumeDto,
  type ResumeScreeningTaskDto
} from '@api/resumeScreeningTasks'

type ResumeScreeningTaskUpdatedPayload = z.infer<typeof resumeScreeningTaskUpdatedEvent.payload>
type ResumeScreeningResumeUpdatedPayload = z.infer<typeof resumeScreeningResumeUpdatedEvent.payload>

export const RESUME_LIMIT = 20

const TASK_LIST_LIMIT = 20
const REFRESH_DEBOUNCE_MS = 300

export interface PickedResume {
  path: string
  name: string
}

export interface ResumeScreeningDraft {
  jdSource: 'text' | 'file'
  jdText: string
  jdFilePath: string | null
  jdFileName: string | null
  resumes: PickedResume[]
  config: {
    generateExplanation: boolean
    includeRawText: boolean
    maxConcurrency: number
  }
  providerId: string | null
  modelId: string | null
}

export interface ResumeScreeningModelOption {
  providerId: string
  providerName: string
  modelId: string
  modelName: string
  isDefault: boolean
}

export function createDefaultDraft(): ResumeScreeningDraft {
  return {
    jdSource: 'text',
    jdText: '',
    jdFilePath: null,
    jdFileName: null,
    resumes: [],
    config: { generateExplanation: true, includeRawText: true, maxConcurrency: 5 },
    providerId: null,
    modelId: null
  }
}

// 简历筛选页全局状态：左栏草稿、任务历史、当前任务详情与实时事件同步
export const useResumeScreeningStore = defineStore('resumeScreening', () => {
  const defaultClient = resumeScreeningApi

  const draft = reactive<ResumeScreeningDraft>(createDefaultDraft())
  const tasks = ref<ResumeScreeningTaskDto[]>([])
  const tasksLoaded = ref(false)
  const currentTaskId = ref<string | null>(null)
  const currentTask = ref<ResumeScreeningTaskDto | null>(null)
  const currentResumes = ref<ResumeScreeningResumeDto[]>([])
  const selectedResumeId = ref<string | null>(null)
  const profile = ref<{ name: string; email: string } | null>(null)
  const models = ref<ResumeScreeningModelOption[]>([])
  const isCreating = ref(false)
  const createError = ref<string | null>(null)
  const cancelError = ref<string | null>(null)

  let loadTaskSeq = 0
  let refreshTimer: ReturnType<typeof setTimeout> | null = null

  const selectedResume = computed(
    () => currentResumes.value.find((item) => item.id === selectedResumeId.value) ?? null
  )
  const isTaskActive = computed(
    () => currentTask.value?.status === 'queued' || currentTask.value?.status === 'running'
  )
  const hasValidDraft = computed(() => {
    const jdValid =
      draft.jdSource === 'file' ? draft.jdFilePath !== null : draft.jdText.trim().length > 0
    return jdValid && draft.resumes.length > 0
  })
  const canReview = computed(() => hasValidDraft.value && !isTaskActive.value && !isCreating.value)
  const selectedModelKey = computed(() =>
    draft.providerId && draft.modelId ? `${draft.providerId}::${draft.modelId}` : null
  )

  // 事件风暴下 300ms 防抖全量重同步当前任务（镜像 documents store 的 scheduleArchiveRefresh）
  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      if (currentTaskId.value) void loadTask(currentTaskId.value)
    }, REFRESH_DEBOUNCE_MS)
  }

  async function loadTasks(client: ResumeScreeningClient = defaultClient) {
    try {
      const result = await client.listTasks(TASK_LIST_LIMIT)
      tasks.value = result.tasks
    } catch (error) {
      console.error('[ResumeScreeningStore] loadTasks failed', error)
    } finally {
      // 失败时也置位，避免任务历史区因 tasksLoaded=false 永久空白死态
      tasksLoaded.value = true
    }
  }

  // seq 防乱序：用户切换历史任务时丢弃迟到的旧响应；失败时保留现有数据避免详情闪空白
  async function loadTask(taskId: string, client: ResumeScreeningClient = defaultClient) {
    const seq = ++loadTaskSeq
    try {
      const result = await client.getTask(taskId)
      if (seq !== loadTaskSeq) return
      currentTaskId.value = result.task ? taskId : null
      currentTask.value = result.task
      currentResumes.value = result.resumes
      selectedResumeId.value = result.resumes[0]?.id ?? null
    } catch (error) {
      console.error('[ResumeScreeningStore] loadTask failed', error)
    }
  }

  async function createTask(client: ResumeScreeningClient = defaultClient) {
    if (!hasValidDraft.value || isCreating.value) return null
    isCreating.value = true
    createError.value = null
    try {
      const result = await client.createTask({
        jdSource: draft.jdSource,
        jdText: draft.jdSource === 'text' ? draft.jdText.trim() : '',
        jdFilePath: draft.jdSource === 'file' ? (draft.jdFilePath ?? undefined) : undefined,
        jdFileName: draft.jdSource === 'file' ? (draft.jdFileName ?? undefined) : undefined,
        resumes: draft.resumes.map((item) => ({ path: item.path, name: item.name })),
        config: { ...draft.config },
        providerId: draft.providerId ?? undefined,
        modelId: draft.modelId ?? undefined
      })
      const index = tasks.value.findIndex((task) => task.id === result.task.id)
      if (index >= 0) tasks.value.splice(index, 1, result.task)
      else tasks.value.unshift(result.task)
      await loadTask(result.task.id, client)
      resetDraft()
      return result.task
    } catch (error) {
      createError.value = error instanceof Error ? error.message : String(error)
      return null
    } finally {
      isCreating.value = false
    }
  }

  async function cancelTask(client: ResumeScreeningClient = defaultClient) {
    const taskId = currentTask.value?.id
    if (!taskId) return
    cancelError.value = null
    try {
      await client.cancelTask(taskId)
    } catch (error) {
      console.error('[ResumeScreeningStore] cancel task failed', error)
      cancelError.value = error instanceof Error ? error.message : String(error)
    }
  }

  async function loadProfile(client: ResumeScreeningClient = defaultClient) {
    try {
      profile.value = (await client.getProfile()).profile
    } catch (error) {
      console.error('[ResumeScreeningStore] loadProfile failed', error)
    }
  }

  async function saveProfile(
    input: ResumeScreeningUpdateProfileInput,
    client: ResumeScreeningClient = defaultClient
  ) {
    const result = await client.updateProfile(input)
    profile.value = result.profile
    return result.profile
  }

  async function loadModels(client: ResumeScreeningClient = defaultClient) {
    try {
      models.value = (await client.listModels()).models
      // 草稿未选模型时默认选中系统默认模型
      if (!draft.providerId && !draft.modelId) {
        const preferred = models.value.find((item) => item.isDefault) ?? models.value[0]
        if (preferred) {
          draft.providerId = preferred.providerId
          draft.modelId = preferred.modelId
        }
      }
    } catch (error) {
      console.error('[ResumeScreeningStore] loadModels failed', error)
    }
  }

  function selectModel(providerId: string, modelId: string) {
    draft.providerId = providerId
    draft.modelId = modelId
  }

  function handleTaskUpdated(payload: ResumeScreeningTaskUpdatedPayload) {
    const patch = {
      status: payload.status,
      total: payload.progress.total,
      succeeded: payload.stats.succeeded,
      failed: payload.stats.failed,
      avgScore: payload.stats.avgScore,
      recommendedCount: payload.stats.recommendedCount,
      updatedAt: payload.version
    }
    const index = tasks.value.findIndex((task) => task.id === payload.taskId)
    if (index >= 0) {
      tasks.value[index] = { ...tasks.value[index], ...patch }
    } else {
      void loadTasks()
    }
    const current = currentTask.value
    if (current && current.id === payload.taskId) {
      currentTask.value = { ...current, ...patch }
      scheduleRefresh()
    }
  }

  function handleResumeUpdated(payload: ResumeScreeningResumeUpdatedPayload) {
    // payload.stage（简历内角色阶段）有意不消费：任务级进度与简历状态已覆盖展示需求，
    // 详情内容由 scheduleRefresh 全量重同步兜底
    const current = currentTask.value
    if (!current || current.id !== payload.taskId) return
    const index = currentResumes.value.findIndex((item) => item.id === payload.resumeId)
    if (index < 0) return
    currentResumes.value[index] = {
      ...currentResumes.value[index],
      status: payload.status,
      updatedAt: payload.version
    }
    scheduleRefresh()
  }

  function resetDraft() {
    // 提交任务后保留模型选择，连续创建任务无需重新选择
    const { providerId, modelId } = draft
    Object.assign(draft, createDefaultDraft())
    draft.providerId = providerId
    draft.modelId = modelId
  }

  return {
    draft,
    tasks,
    tasksLoaded,
    currentTaskId,
    currentTask,
    currentResumes,
    selectedResumeId,
    selectedResume,
    profile,
    models,
    isCreating,
    createError,
    cancelError,
    isTaskActive,
    hasValidDraft,
    canReview,
    selectedModelKey,
    loadTasks,
    loadTask,
    createTask,
    cancelTask,
    loadProfile,
    saveProfile,
    loadModels,
    selectModel,
    handleTaskUpdated,
    handleResumeUpdated,
    resetDraft
  }
})
