import { describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import {
  resumeScreeningCancelTaskRoute,
  resumeScreeningGetTaskRoute
} from '@shared/contracts/routes'
import {
  createResumeScreeningRoutes,
  toResumeScreeningResumeDto,
  toResumeScreeningTaskDto
} from '@/resumeScreening/routes'
import type { ResumeScreeningResumeRow } from '@/resumeScreening/data/tables/resumeScreeningResumes'
import type { ResumeScreeningTaskRow } from '@/resumeScreening/data/tables/resumeScreeningTasks'
import type { ResumeScreeningService } from '@/resumeScreening/service'
import { createRendererRouteContext } from '@/routes/routeRegistry'

function makeTaskRow(overrides: Partial<ResumeScreeningTaskRow> = {}): ResumeScreeningTaskRow {
  return {
    id: 'task-1',
    status: 'completed',
    jd_source: 'text',
    jd_text: '高级前端工程师 JD',
    jd_file_name: null,
    jd_analysis_json:
      '{"responsibilities":["开发"],"requirements":["五年经验"],"preferred":["英语"]}',
    config_json: '{"generateExplanation":true,"includeRawText":true,"maxConcurrency":2}',
    provider_id: 'provider-1',
    model_id: 'model-1',
    total: 1,
    succeeded: 1,
    failed: 0,
    avg_score: 88,
    recommended_count: 1,
    created_by_name: '张三',
    created_by_email: 'zhang@example.com',
    started_at: 1000,
    finished_at: 2000,
    created_at: 1000,
    updated_at: 2000,
    ...overrides
  }
}

function makeResumeRow(
  overrides: Partial<ResumeScreeningResumeRow> = {}
): ResumeScreeningResumeRow {
  return {
    id: 'resume-1',
    task_id: 'task-1',
    file_name: '张三.pdf',
    file_path: '/storage/task-1/resume-1.pdf',
    mime_type: 'application/pdf',
    size: 1024,
    candidate_name: '张三',
    raw_text: '张三的简历内容',
    resume_info_json: '{"name":"张三"}',
    screening_json: '{"score":88,"recommended":true,"conclusion":"推荐","strengths":["基础扎实"]}',
    interview_json: null,
    hr_json: null,
    score: 88,
    recommended: 1,
    status: 'done',
    error: null,
    created_at: 1000,
    updated_at: 2000,
    ...overrides
  }
}

type GetTaskResult =
  | { task: ResumeScreeningTaskRow; resumes: ResumeScreeningResumeRow[] }
  | undefined

// 路由工厂只依赖 service 的少量方法，用局部 stub 避免构造真实服务（无需 sqlite）
function makeServiceStub(methods: {
  getTask?: (taskId: string) => GetTaskResult
  cancelTask?: (taskId: string) => boolean
}): ResumeScreeningService {
  return methods as unknown as ResumeScreeningService
}

describe('resumeScreening routes', () => {
  it('task DTO 把 snake_case 行转换为 camelCase', () => {
    const dto = toResumeScreeningTaskDto(makeTaskRow())
    expect(dto).toEqual({
      id: 'task-1',
      status: 'completed',
      jdSource: 'text',
      jdText: '高级前端工程师 JD',
      jdFileName: null,
      jdAnalysis: { responsibilities: ['开发'], requirements: ['五年经验'], preferred: ['英语'] },
      config: { generateExplanation: true, includeRawText: true, maxConcurrency: 2 },
      providerId: 'provider-1',
      modelId: 'model-1',
      total: 1,
      succeeded: 1,
      failed: 0,
      avgScore: 88,
      recommendedCount: 1,
      createdByName: '张三',
      createdByEmail: 'zhang@example.com',
      startedAt: 1000,
      finishedAt: 2000,
      createdAt: 1000,
      updatedAt: 2000
    })
  })

  it('resume DTO 把 0/1 转成 boolean 并按 includeRawText 门控原文', () => {
    const withRaw = toResumeScreeningResumeDto(makeResumeRow(), { includeRawText: true })
    expect(withRaw.recommended).toBe(true)
    expect(withRaw.rawText).toBe('张三的简历内容')
    expect(withRaw.screening).toEqual({
      score: 88,
      recommended: true,
      conclusion: '推荐',
      strengths: ['基础扎实']
    })

    const withoutRaw = toResumeScreeningResumeDto(makeResumeRow(), { includeRawText: false })
    expect(withoutRaw.rawText).toBeNull()

    const notRecommended = toResumeScreeningResumeDto(makeResumeRow({ recommended: 0 }), {
      includeRawText: true
    })
    expect(notRecommended.recommended).toBe(false)

    const unknownRecommended = toResumeScreeningResumeDto(makeResumeRow({ recommended: null }), {
      includeRawText: true
    })
    expect(unknownRecommended.recommended).toBeNull()

    const brokenJson = toResumeScreeningResumeDto(makeResumeRow({ resume_info_json: 'not-json' }), {
      includeRawText: true
    })
    expect(brokenJson.resumeInfo).toBeNull()
  })

  it('getTask 未知 taskId 返回 task=null 且 resumes 为空数组', async () => {
    const routes = createResumeScreeningRoutes(
      makeServiceStub({
        getTask: () => undefined
      })
    )
    const handler = routes.get(resumeScreeningGetTaskRoute.name)!
    const result = await handler({ taskId: 'missing' }, createRendererRouteContext(1, null))
    expect(result).toEqual({ task: null, resumes: [] })
  })

  it('getTask 返回任务与简历，并按 config.includeRawText 门控原文', async () => {
    const routes = createResumeScreeningRoutes(
      makeServiceStub({
        getTask: (taskId) =>
          taskId === 'task-1' ? { task: makeTaskRow(), resumes: [makeResumeRow()] } : undefined
      })
    )
    const handler = routes.get(resumeScreeningGetTaskRoute.name)!
    const result = (await handler(
      { taskId: 'task-1' },
      createRendererRouteContext(1, null)
    )) as z.infer<typeof resumeScreeningGetTaskRoute.output>
    expect(result.task).toMatchObject({ id: 'task-1', avgScore: 88 })
    expect(result.resumes).toHaveLength(1)
    expect(result.resumes[0]).toMatchObject({ id: 'resume-1', rawText: '张三的简历内容' })
  })

  it('cancelTask 把结果透传为 ok', async () => {
    const routes = createResumeScreeningRoutes(
      makeServiceStub({
        cancelTask: (taskId) => taskId === 'task-1'
      })
    )
    const handler = routes.get(resumeScreeningCancelTaskRoute.name)!
    expect(await handler({ taskId: 'task-1' }, createRendererRouteContext(1, null))).toEqual({
      ok: true
    })
    expect(await handler({ taskId: 'other' }, createRendererRouteContext(1, null))).toEqual({
      ok: false
    })
  })

  it('config_json 损坏时降级为 FALLBACK_CONFIG 隐私默认且不下发原文', async () => {
    const routes = createResumeScreeningRoutes(
      makeServiceStub({
        getTask: () => ({
          task: makeTaskRow({ config_json: 'not-json' }),
          resumes: [makeResumeRow()]
        })
      })
    )
    const handler = routes.get(resumeScreeningGetTaskRoute.name)!
    const result = (await handler(
      { taskId: 'task-1' },
      createRendererRouteContext(1, null)
    )) as z.infer<typeof resumeScreeningGetTaskRoute.output>
    expect(result.task?.config).toEqual({
      generateExplanation: false,
      includeRawText: false,
      maxConcurrency: 1
    })
    expect(result.resumes[0]?.rawText).toBeNull()
  })

  it('单条简历 DTO 校验失败时跳过该条并记录日志，不影响其余简历', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const routes = createResumeScreeningRoutes(
        makeServiceStub({
          getTask: () => ({
            task: makeTaskRow(),
            resumes: [
              makeResumeRow({ id: 'resume-bad', screening_json: '{"score":88}' }),
              makeResumeRow({ id: 'resume-good' })
            ]
          })
        })
      )
      const handler = routes.get(resumeScreeningGetTaskRoute.name)!
      const result = (await handler(
        { taskId: 'task-1' },
        createRendererRouteContext(1, null)
      )) as z.infer<typeof resumeScreeningGetTaskRoute.output>
      expect(result.resumes.map((resume) => resume.id)).toEqual(['resume-good'])
      expect(errorSpy).toHaveBeenCalledTimes(1)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('任务行 DTO 校验失败时 getTask 返回空详情而非抛错', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const routes = createResumeScreeningRoutes(
        makeServiceStub({
          getTask: () => ({
            task: makeTaskRow({
              config_json: '{"generateExplanation":true,"includeRawText":true,"maxConcurrency":99}'
            }),
            resumes: [makeResumeRow()]
          })
        })
      )
      const handler = routes.get(resumeScreeningGetTaskRoute.name)!
      const result = (await handler(
        { taskId: 'task-1' },
        createRendererRouteContext(1, null)
      )) as z.infer<typeof resumeScreeningGetTaskRoute.output>
      expect(result).toEqual({ task: null, resumes: [] })
      expect(errorSpy).toHaveBeenCalledTimes(1)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
