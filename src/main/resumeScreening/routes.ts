import type { z } from 'zod'
import type {
  resumeScreeningResumeDtoSchema,
  resumeScreeningTaskDtoSchema
} from '@shared/contracts/routes'
import {
  resumeScreeningCancelTaskRoute,
  resumeScreeningCreateTaskRoute,
  resumeScreeningGetProfileRoute,
  resumeScreeningGetTaskRoute,
  resumeScreeningListModelsRoute,
  resumeScreeningListTasksRoute,
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

export function toResumeScreeningTaskDto(task: ResumeScreeningTaskRow): ResumeScreeningTaskDto {
  return {
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
  }
}

export function toResumeScreeningResumeDto(
  resume: ResumeScreeningResumeRow,
  options: { includeRawText: boolean }
): ResumeScreeningResumeDto {
  return {
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
  }
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
        const config =
          parseJsonOrNull<ResumeScreeningTaskConfig>(found.task.config_json) ?? FALLBACK_CONFIG
        return resumeScreeningGetTaskRoute.output.parse({
          task: toResumeScreeningTaskDto(found.task),
          resumes: found.resumes.map((resume) =>
            toResumeScreeningResumeDto(resume, { includeRawText: config.includeRawText })
          )
        })
      }
    ],
    [
      resumeScreeningListTasksRoute.name,
      async (rawInput) => {
        const input = resumeScreeningListTasksRoute.input.parse(rawInput)
        return resumeScreeningListTasksRoute.output.parse({
          tasks: service.listTasks(input.limit).map(toResumeScreeningTaskDto)
        })
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
