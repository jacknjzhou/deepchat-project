import type { z } from 'zod'
import {
  resumeScreeningCancelTaskRoute,
  resumeScreeningCreateTaskRoute,
  resumeScreeningGetProfileRoute,
  resumeScreeningGetTaskRoute,
  resumeScreeningListModelsRoute,
  resumeScreeningListTasksRoute,
  resumeScreeningResumeDtoSchema,
  resumeScreeningTaskDtoSchema,
  resumeScreeningUpdateProfileRoute
} from '@shared/contracts/routes'
import { createRouteMap, type DeepchatRouteMap } from '@/routes/routeRegistry'
import type { ResumeScreeningResumeRow } from '@/resumeScreening/data/tables/resumeScreeningResumes'
import type { ResumeScreeningTaskRow } from '@/resumeScreening/data/tables/resumeScreeningTasks'
import {
  ResumeScreeningService,
  type ResumeScreeningHr,
  type ResumeScreeningInterview,
  type ResumeScreeningJdAnalysis,
  type ResumeScreeningResumeStatus,
  type ResumeScreeningScreening,
  type ResumeScreeningTaskConfig,
  type ResumeScreeningTaskStatus
} from '@/resumeScreening/service'

type ResumeScreeningTaskDto = z.infer<typeof resumeScreeningTaskDtoSchema>
type ResumeScreeningResumeDto = z.infer<typeof resumeScreeningResumeDtoSchema>

// config_json 损坏时的兜底配置，保证 DTO 满足契约
const FALLBACK_CONFIG: ResumeScreeningTaskConfig = {
  generateExplanation: false,
  includeRawText: false,
  maxConcurrency: 1
}

function parseJsonOrNull<T>(raw: string | null): T | null {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** 取首个校验问题作为简要原因，用于跳过坏数据时的日志定位 */
function describeFirstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  return issue ? `${issue.path.join('.')}: ${issue.message}` : 'unknown'
}

/** 单条坏数据（如旧版本写入的记录缺字段）只跳过该条，不让整个任务详情/列表抛错 */
export function toResumeScreeningTaskDto(
  task: ResumeScreeningTaskRow
): ResumeScreeningTaskDto | null {
  const parsed = resumeScreeningTaskDtoSchema.safeParse({
    id: task.id,
    status: task.status as ResumeScreeningTaskStatus,
    jdSource: task.jd_source as ResumeScreeningTaskDto['jdSource'],
    jdText: task.jd_text,
    jdFileName: task.jd_file_name,
    jdAnalysis: parseJsonOrNull<ResumeScreeningJdAnalysis>(task.jd_analysis_json),
    config: parseJsonOrNull<ResumeScreeningTaskConfig>(task.config_json) ?? FALLBACK_CONFIG,
    providerId: task.provider_id,
    modelId: task.model_id,
    total: task.total,
    succeeded: task.succeeded,
    failed: task.failed,
    avgScore: task.avg_score,
    recommendedCount: task.recommended_count,
    createdByName: task.created_by_name,
    createdByEmail: task.created_by_email,
    startedAt: task.started_at,
    finishedAt: task.finished_at,
    createdAt: task.created_at,
    updatedAt: task.updated_at
  })
  if (!parsed.success) {
    console.error(
      '[ResumeScreeningRoutes] 任务 DTO 校验失败，已跳过:',
      task.id,
      describeFirstIssue(parsed.error)
    )
    return null
  }
  return parsed.data
}

export function toResumeScreeningResumeDto(
  resume: ResumeScreeningResumeRow,
  options: { includeRawText: boolean }
): ResumeScreeningResumeDto | null {
  const parsed = resumeScreeningResumeDtoSchema.safeParse({
    id: resume.id,
    taskId: resume.task_id,
    fileName: resume.file_name,
    mimeType: resume.mime_type,
    size: resume.size,
    candidateName: resume.candidate_name,
    // includeRawText 只控制原文是否下发渲染层，提取阶段始终读取原文
    rawText: options.includeRawText ? resume.raw_text : null,
    resumeInfo: parseJsonOrNull<unknown>(resume.resume_info_json),
    screening: parseJsonOrNull<ResumeScreeningScreening>(resume.screening_json),
    interview: parseJsonOrNull<ResumeScreeningInterview>(resume.interview_json),
    hr: parseJsonOrNull<ResumeScreeningHr>(resume.hr_json),
    score: resume.score,
    recommended: resume.recommended === null ? null : resume.recommended === 1,
    status: resume.status as ResumeScreeningResumeStatus,
    error: resume.error,
    createdAt: resume.created_at,
    updatedAt: resume.updated_at
  })
  if (!parsed.success) {
    console.error(
      '[ResumeScreeningRoutes] 简历 DTO 校验失败，已跳过:',
      resume.task_id,
      resume.id,
      describeFirstIssue(parsed.error)
    )
    return null
  }
  return parsed.data
}

/** 简历筛选域 7 条路由：契约解析输入 → 调用服务 → 契约校验输出 */
export function createResumeScreeningRoutes(service: ResumeScreeningService): DeepchatRouteMap {
  return createRouteMap([
    [
      resumeScreeningCreateTaskRoute.name,
      async (rawInput) => {
        const input = resumeScreeningCreateTaskRoute.input.parse(rawInput)
        const task = await service.createTask({
          jdSource: input.jdSource,
          jdText: input.jdText,
          jdFilePath: input.jdFilePath,
          jdFileName: input.jdFileName,
          resumes: input.resumes,
          config: input.config,
          providerId: input.providerId,
          modelId: input.modelId
        })
        return resumeScreeningCreateTaskRoute.output.parse({
          task: toResumeScreeningTaskDto(task)
        })
      }
    ],
    [
      resumeScreeningGetTaskRoute.name,
      async (rawInput) => {
        const input = resumeScreeningGetTaskRoute.input.parse(rawInput)
        const found = service.getTask(input.taskId)
        if (!found) {
          return resumeScreeningGetTaskRoute.output.parse({ task: null, resumes: [] })
        }
        const taskDto = toResumeScreeningTaskDto(found.task)
        if (!taskDto) {
          // 任务行本身损坏：返回空详情，避免整个路由抛错导致详情页永久不可加载
          return resumeScreeningGetTaskRoute.output.parse({ task: null, resumes: [] })
        }
        // config 只在任务 DTO 转换处解析一次（损坏时 FALLBACK_CONFIG 隐私默认），简历门控复用其结果
        const resumes = found.resumes.flatMap((resume) => {
          const dto = toResumeScreeningResumeDto(resume, {
            includeRawText: taskDto.config.includeRawText
          })
          return dto ? [dto] : []
        })
        return resumeScreeningGetTaskRoute.output.parse({ task: taskDto, resumes })
      }
    ],
    [
      resumeScreeningListTasksRoute.name,
      async (rawInput) => {
        const input = resumeScreeningListTasksRoute.input.parse(rawInput)
        const tasks = service
          .listTasks(input.limit)
          .map(toResumeScreeningTaskDto)
          .filter((task): task is ResumeScreeningTaskDto => task !== null)
        return resumeScreeningListTasksRoute.output.parse({ tasks })
      }
    ],
    [
      resumeScreeningCancelTaskRoute.name,
      async (rawInput) => {
        const input = resumeScreeningCancelTaskRoute.input.parse(rawInput)
        return resumeScreeningCancelTaskRoute.output.parse({ ok: service.cancelTask(input.taskId) })
      }
    ],
    [
      resumeScreeningGetProfileRoute.name,
      async (rawInput) => {
        resumeScreeningGetProfileRoute.input.parse(rawInput)
        return resumeScreeningGetProfileRoute.output.parse({ profile: service.getProfile() })
      }
    ],
    [
      resumeScreeningUpdateProfileRoute.name,
      async (rawInput) => {
        const input = resumeScreeningUpdateProfileRoute.input.parse(rawInput)
        return resumeScreeningUpdateProfileRoute.output.parse({
          profile: service.updateProfile({ name: input.name, email: input.email })
        })
      }
    ],
    [
      resumeScreeningListModelsRoute.name,
      async (rawInput) => {
        resumeScreeningListModelsRoute.input.parse(rawInput)
        return resumeScreeningListModelsRoute.output.parse({ models: service.listModels() })
      }
    ]
  ])
}
