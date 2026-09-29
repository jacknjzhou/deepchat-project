import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import type { z } from 'zod'
import {
  resumeScreeningTaskUpdatedEvent,
  resumeScreeningResumeUpdatedEvent
} from '@shared/contracts/events/resumeScreening.events'
import type {
  resumeScreeningJdAnalysisSchema,
  resumeScreeningScreeningSchema,
  resumeScreeningInterviewSchema,
  resumeScreeningHrSchema,
  resumeScreeningProfileSchema,
  resumeScreeningTaskStatusSchema,
  resumeScreeningResumeStatusSchema
} from '@shared/contracts/routes/resumeScreening.routes'
import {
  JD_ANALYST_SYSTEM_PROMPT,
  EXTRACTOR_SYSTEM_PROMPT,
  SCREENING_SYSTEM_PROMPT,
  INTERVIEWER_SYSTEM_PROMPT,
  HR_MANAGER_SYSTEM_PROMPT
} from '@/resumeScreening/prompts'
import type { ResumeScreeningDatabase } from '@/resumeScreening/data/database'
import type { ResumeScreeningTaskRow } from '@/resumeScreening/data/tables/resumeScreeningTasks'
import type { ResumeScreeningResumeRow } from '@/resumeScreening/data/tables/resumeScreeningResumes'
import type { ResumeLlmInvoker } from '@/resumeScreening/llmInvoker'
import type { ResumeTextExtractor } from '@/resumeScreening/textExtractor'

export type ResumeScreeningJdAnalysis = z.infer<typeof resumeScreeningJdAnalysisSchema>
export type ResumeScreeningScreening = z.infer<typeof resumeScreeningScreeningSchema>
export type ResumeScreeningInterview = z.infer<typeof resumeScreeningInterviewSchema>
export type ResumeScreeningHr = z.infer<typeof resumeScreeningHrSchema>
export type ResumeScreeningProfile = z.infer<typeof resumeScreeningProfileSchema>
export type ResumeScreeningTaskStatus = z.infer<typeof resumeScreeningTaskStatusSchema>
export type ResumeScreeningResumeStatus = z.infer<typeof resumeScreeningResumeStatusSchema>
export type ResumeScreeningTaskUpdatedPayload = z.infer<
  typeof resumeScreeningTaskUpdatedEvent.payload
>
export type ResumeScreeningResumeUpdatedPayload = z.infer<
  typeof resumeScreeningResumeUpdatedEvent.payload
>

export type ResumeScreeningStage = 'extracting' | 'screening' | 'interviewing' | 'hr'

export interface ResumeScreeningTaskConfig {
  generateExplanation: boolean
  includeRawText: boolean
  maxConcurrency: number
}

export interface ResumeScreeningModelOption {
  providerId: string
  providerName: string
  modelId: string
  modelName: string
  isDefault: boolean
}

export interface CreateResumeScreeningTaskInput {
  jdSource: 'text' | 'file'
  jdText?: string
  jdFilePath?: string
  jdFileName?: string
  resumes: Array<{ path: string; name: string; mimeType?: string; size?: number }>
  config: ResumeScreeningTaskConfig
  providerId?: string
  modelId?: string
}

export interface ResumeScreeningServiceDeps {
  database: ResumeScreeningDatabase
  invoker: Pick<ResumeLlmInvoker, 'invokeJson'>
  textExtractor: Pick<ResumeTextExtractor, 'extract'>
  storageDir: string
  copyFile: (src: string, dest: string) => Promise<void>
  getProfile: () => ResumeScreeningProfile | undefined
  saveProfile: (profile: ResumeScreeningProfile) => void
  getDefaultModel: () => { providerId: string; modelId: string } | undefined
  listModels: () => ResumeScreeningModelOption[]
  publishTaskUpdated: (payload: ResumeScreeningTaskUpdatedPayload) => void
  publishResumeUpdated: (payload: ResumeScreeningResumeUpdatedPayload) => void
  now: () => number
}

/** 五角色简历筛选流水线编排：建任务 → JD 解析 → 并发处理简历 → 终态落库与事件发布 */
export class ResumeScreeningService {
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly resumeStages = new Map<string, ResumeScreeningStage>()

  constructor(private readonly deps: ResumeScreeningServiceDeps) {}

  private get tasksTable() {
    return this.deps.database.tasksTable
  }

  private get resumesTable() {
    return this.deps.database.resumesTable
  }

  async createTask(input: CreateResumeScreeningTaskInput): Promise<ResumeScreeningTaskRow> {
    const providerId = input.providerId ?? this.deps.getDefaultModel()?.providerId
    const modelId = input.modelId ?? this.deps.getDefaultModel()?.modelId
    if ((input.providerId === undefined) !== (input.modelId === undefined)) {
      throw new Error('providerId 与 modelId 必须同时提供')
    }
    if (providerId === undefined || modelId === undefined) {
      throw new Error('未选择模型且应用未设置默认模型')
    }

    let jdText: string
    let jdFileName: string
    if (input.jdSource === 'file') {
      if (!input.jdFilePath) throw new Error('缺少 JD 文件路径')
      jdText = await this.deps.textExtractor.extract(input.jdFilePath)
      jdFileName = input.jdFileName ?? path.basename(input.jdFilePath)
    } else {
      jdText = (input.jdText ?? '').trim()
      jdFileName = input.jdFileName ?? ''
    }
    if (!jdText) throw new Error('请填写岗位 JD 或选择 JD 文件')

    const profile = this.deps.getProfile()
    const task = this.tasksTable.insert({
      jdSource: input.jdSource,
      jdText,
      jdFileName,
      configJson: JSON.stringify(input.config),
      providerId,
      modelId,
      total: input.resumes.length,
      createdByName: profile?.name ?? '',
      createdByEmail: profile?.email ?? '',
      now: this.deps.now()
    })

    const taskDir = path.join(this.deps.storageDir, task.id)
    try {
      await mkdir(taskDir, { recursive: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.tasksTable.update(task.id, {
        status: 'failed',
        finishedAt: this.deps.now(),
        now: this.deps.now()
      })
      this.publishTaskUpdate(task.id)
      throw new Error(`简历筛选目录创建失败: ${message}`)
    }
    for (const item of input.resumes) {
      const id = randomUUID()
      const ext = path.extname(item.name).toLowerCase()
      const destPath = path.join(taskDir, `${id}${ext}`)
      this.resumesTable.insert({
        id,
        taskId: task.id,
        fileName: item.name,
        filePath: destPath,
        mimeType: item.mimeType,
        size: item.size ?? 0,
        now: this.deps.now()
      })
      try {
        await this.deps.copyFile(item.path, destPath)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.resumesTable.update(id, {
          status: 'failed',
          error: `简历文件复制失败: ${message}`,
          now: this.deps.now()
        })
      }
      this.publishResumeUpdate(id)
    }

    const controller = new AbortController()
    this.abortControllers.set(task.id, controller)
    void this.runTask(task.id, controller).catch((error) => {
      console.error('[ResumeScreeningService] 任务执行异常:', error)
    })
    return this.tasksTable.get(task.id)!
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasksTable.get(taskId)
    if (!task || (task.status !== 'queued' && task.status !== 'running')) return false
    this.abortControllers.get(taskId)?.abort()
    this.resumesTable.markUnfinishedAsFailed(taskId, '已取消', this.deps.now())
    const stats = this.resumesTable.getTaskStats(taskId)
    this.tasksTable.update(taskId, {
      status: 'cancelled',
      succeeded: stats.succeeded,
      failed: stats.failed,
      avgScore: stats.avgScore,
      recommendedCount: stats.recommendedCount,
      finishedAt: this.deps.now(),
      now: this.deps.now()
    })
    this.abortControllers.delete(taskId)
    this.publishTaskUpdate(taskId)
    return true
  }

  getTask(
    taskId: string
  ): { task: ResumeScreeningTaskRow; resumes: ResumeScreeningResumeRow[] } | undefined {
    const task = this.tasksTable.get(taskId)
    if (!task) return undefined
    return { task, resumes: this.resumesTable.listByTask(taskId) }
  }

  listTasks(limit = 100): ResumeScreeningTaskRow[] {
    return this.tasksTable.listRecent(limit)
  }

  getProfile(): ResumeScreeningProfile {
    const stored = this.deps.getProfile()
    return { name: stored?.name ?? '', email: stored?.email ?? '' }
  }

  updateProfile(input: Partial<ResumeScreeningProfile>): ResumeScreeningProfile {
    const current = this.getProfile()
    const next: ResumeScreeningProfile = {
      name: input.name ?? current.name,
      email: input.email ?? current.email
    }
    this.deps.saveProfile(next)
    return next
  }

  listModels(): ResumeScreeningModelOption[] {
    return this.deps.listModels()
  }

  /** 应用启动时调用：把上次未跑完的任务统一标记为失败，避免永久卡在 running */
  recoverInterruptedTasks(): void {
    for (const task of this.tasksTable.listActive()) {
      this.tasksTable.update(task.id, {
        status: 'failed',
        finishedAt: this.deps.now(),
        now: this.deps.now()
      })
      this.resumesTable.markUnfinishedAsFailed(task.id, '应用重启导致任务中断', this.deps.now())
      this.publishTaskUpdate(task.id)
    }
  }

  private async runTask(taskId: string, controller: AbortController): Promise<void> {
    const initial = this.tasksTable.get(taskId)
    if (!initial || initial.status !== 'queued') {
      this.abortControllers.delete(taskId)
      return
    }
    this.tasksTable.update(taskId, {
      status: 'running',
      startedAt: this.deps.now(),
      now: this.deps.now()
    })
    this.publishTaskUpdate(taskId)

    const signal = controller.signal
    let jdAnalysis: ResumeScreeningJdAnalysis
    try {
      jdAnalysis = await this.deps.invoker.invokeJson<ResumeScreeningJdAnalysis>({
        providerId: initial.provider_id,
        modelId: initial.model_id,
        systemPrompt: JD_ANALYST_SYSTEM_PROMPT,
        userPrompt: `岗位 JD 原文：\n${initial.jd_text}`,
        signal
      })
    } catch (error) {
      this.abortControllers.delete(taskId)
      if (!signal.aborted) {
        console.error('[ResumeScreeningService] JD 解析失败:', error)
        this.resumesTable.markUnfinishedAsFailed(taskId, 'JD 解析失败，任务中止', this.deps.now())
        const stats = this.resumesTable.getTaskStats(taskId)
        this.tasksTable.update(taskId, {
          status: 'failed',
          succeeded: stats.succeeded,
          failed: stats.failed,
          avgScore: stats.avgScore,
          recommendedCount: stats.recommendedCount,
          finishedAt: this.deps.now(),
          now: this.deps.now()
        })
        this.publishTaskUpdate(taskId)
      }
      return
    }

    if (signal.aborted) {
      this.abortControllers.delete(taskId)
      return
    }

    this.tasksTable.update(taskId, {
      jdAnalysisJson: JSON.stringify(jdAnalysis),
      now: this.deps.now()
    })
    this.publishTaskUpdate(taskId)

    const config = JSON.parse(initial.config_json) as ResumeScreeningTaskConfig
    const resumes = this.resumesTable.listByTask(taskId)
    let cursor = 0
    const concurrency = Math.min(5, Math.max(1, config.maxConcurrency))
    const worker = async () => {
      while (cursor < resumes.length) {
        if (signal.aborted) return
        const resume = resumes[cursor++]!
        await this.processResume(initial, config, jdAnalysis, resume, signal)
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, resumes.length) }, worker))
    } finally {
      this.abortControllers.delete(taskId)
    }
    if (signal.aborted) return

    const stats = this.resumesTable.getTaskStats(taskId)
    const status: ResumeScreeningTaskStatus =
      stats.succeeded === 0 ? 'failed' : stats.failed > 0 ? 'partial' : 'completed'
    this.tasksTable.update(taskId, {
      status,
      succeeded: stats.succeeded,
      failed: stats.failed,
      avgScore: stats.avgScore,
      recommendedCount: stats.recommendedCount,
      finishedAt: this.deps.now(),
      now: this.deps.now()
    })
    this.publishTaskUpdate(taskId)
  }

  private async processResume(
    task: ResumeScreeningTaskRow,
    config: ResumeScreeningTaskConfig,
    jdAnalysis: ResumeScreeningJdAnalysis,
    resume: ResumeScreeningResumeRow,
    signal: AbortSignal
  ): Promise<void> {
    if (resume.status === 'failed') return
    const { id: resumeId } = resume
    try {
      this.resumesTable.update(resumeId, { status: 'running', now: this.deps.now() })
      this.setStageAndPublish(resumeId, 'extracting')

      const rawText = await this.deps.textExtractor.extract(resume.file_path)
      this.resumesTable.update(resumeId, { rawText, now: this.deps.now() })

      const resumeInfo = await this.deps.invoker.invokeJson<Record<string, unknown>>({
        providerId: task.provider_id,
        modelId: task.model_id,
        systemPrompt: EXTRACTOR_SYSTEM_PROMPT,
        userPrompt: `简历原文：\n${rawText}`,
        signal
      })
      const candidateName = typeof resumeInfo.name === 'string' ? resumeInfo.name : ''
      this.resumesTable.update(resumeId, {
        resumeInfoJson: JSON.stringify(resumeInfo),
        candidateName,
        now: this.deps.now()
      })

      this.setStageAndPublish(resumeId, 'screening')
      const screening = await this.deps.invoker.invokeJson<ResumeScreeningScreening>({
        providerId: task.provider_id,
        modelId: task.model_id,
        systemPrompt: SCREENING_SYSTEM_PROMPT,
        userPrompt: [
          '岗位 JD 分析：',
          JSON.stringify(jdAnalysis),
          '',
          '候选人简历结构化信息：',
          JSON.stringify(resumeInfo)
        ].join('\n'),
        signal
      })
      this.resumesTable.update(resumeId, {
        screeningJson: JSON.stringify(screening),
        score: typeof screening.score === 'number' ? screening.score : null,
        recommended: screening.recommended === true,
        now: this.deps.now()
      })

      if (config.generateExplanation) {
        this.setStageAndPublish(resumeId, 'interviewing')
        const interview = await this.deps.invoker.invokeJson<ResumeScreeningInterview>({
          providerId: task.provider_id,
          modelId: task.model_id,
          systemPrompt: INTERVIEWER_SYSTEM_PROMPT,
          userPrompt: [
            '岗位 JD 分析：',
            JSON.stringify(jdAnalysis),
            '',
            '候选人简历结构化信息：',
            JSON.stringify(resumeInfo),
            '',
            '初筛结论：',
            JSON.stringify(screening)
          ].join('\n'),
          signal
        })
        this.resumesTable.update(resumeId, {
          interviewJson: JSON.stringify(interview),
          now: this.deps.now()
        })

        this.setStageAndPublish(resumeId, 'hr')
        const hr = await this.deps.invoker.invokeJson<ResumeScreeningHr>({
          providerId: task.provider_id,
          modelId: task.model_id,
          systemPrompt: HR_MANAGER_SYSTEM_PROMPT,
          userPrompt: [
            '岗位 JD 分析：',
            JSON.stringify(jdAnalysis),
            '',
            '候选人简历结构化信息：',
            JSON.stringify(resumeInfo),
            '',
            '初筛结论：',
            JSON.stringify(screening),
            '',
            '面试官评估：',
            JSON.stringify(interview)
          ].join('\n'),
          signal
        })
        this.resumesTable.update(resumeId, { hrJson: JSON.stringify(hr), now: this.deps.now() })
      }

      this.resumesTable.update(resumeId, { status: 'done', error: null, now: this.deps.now() })
      this.resumeStages.delete(resumeId)
      this.publishResumeUpdate(resumeId)
    } catch (error) {
      const message = signal.aborted
        ? '已取消'
        : error instanceof Error
          ? error.message
          : String(error)
      this.resumesTable.update(resumeId, { status: 'failed', error: message, now: this.deps.now() })
      this.resumeStages.delete(resumeId)
      this.publishResumeUpdate(resumeId)
    } finally {
      this.syncTaskProgress(task.id)
    }
  }

  private setStageAndPublish(resumeId: string, stage: ResumeScreeningStage): void {
    this.resumeStages.set(resumeId, stage)
    this.publishResumeUpdate(resumeId)
  }

  private syncTaskProgress(taskId: string): void {
    const stats = this.resumesTable.getTaskStats(taskId)
    this.tasksTable.update(taskId, {
      succeeded: stats.succeeded,
      failed: stats.failed,
      avgScore: stats.avgScore,
      recommendedCount: stats.recommendedCount,
      now: this.deps.now()
    })
    this.publishTaskUpdate(taskId)
  }

  private publishTaskUpdate(taskId: string): void {
    const task = this.tasksTable.get(taskId)
    if (!task) return
    const stats = this.resumesTable.getTaskStats(taskId)
    this.deps.publishTaskUpdated({
      taskId,
      status: task.status as ResumeScreeningTaskStatus,
      progress: { done: stats.succeeded + stats.failed, total: task.total },
      stats: {
        succeeded: stats.succeeded,
        failed: stats.failed,
        avgScore: stats.avgScore,
        recommendedCount: stats.recommendedCount
      },
      version: this.deps.now()
    })
  }

  private publishResumeUpdate(resumeId: string): void {
    const resume = this.resumesTable.get(resumeId)
    if (!resume) return
    this.deps.publishResumeUpdated({
      taskId: resume.task_id,
      resumeId,
      status: resume.status as ResumeScreeningResumeStatus,
      stage: resume.status === 'running' ? (this.resumeStages.get(resumeId) ?? null) : null,
      version: this.deps.now()
    })
  }
}
