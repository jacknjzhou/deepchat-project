import { z } from 'zod'
import { defineRouteContract } from '../common'

const timestampMsSchema = z.number().int().nonnegative()

export const resumeScreeningTaskStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'partial',
  'failed',
  'cancelled'
])

export const resumeScreeningResumeStatusSchema = z.enum(['pending', 'running', 'done', 'failed'])

export const resumeScreeningJdAnalysisSchema = z.object({
  responsibilities: z.array(z.string()),
  requirements: z.array(z.string()),
  preferred: z.array(z.string())
})

export const resumeScreeningScreeningSchema = z.object({
  score: z.number().min(0).max(100),
  recommended: z.boolean(),
  conclusion: z.string(),
  strengths: z.array(z.string())
})

export const resumeScreeningInterviewSchema = z.object({
  highlights: z.array(z.string()),
  risks: z.array(z.string()),
  questions: z.array(z.string())
})

export const resumeScreeningHrSchema = z.object({
  finalSummary: z.string(),
  hrOpinion: z.string()
})

export const resumeScreeningProfileSchema = z.object({
  name: z.string(),
  email: z.string()
})

export const resumeScreeningResumeDtoSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  fileName: z.string(),
  mimeType: z.string().nullable(),
  size: z.number().int().nonnegative(),
  candidateName: z.string().nullable(),
  rawText: z.string().nullable(),
  // 结构化简历信息，字段对齐 docs/superpowers/specs/templates/resume.yaml（resume_v1），
  // 由 LLM 输出结构多变，契约层保持宽松、展示层按需取字段
  resumeInfo: z.unknown().nullable(),
  screening: resumeScreeningScreeningSchema.nullable(),
  interview: resumeScreeningInterviewSchema.nullable(),
  hr: resumeScreeningHrSchema.nullable(),
  score: z.number().nullable(),
  recommended: z.boolean().nullable(),
  status: resumeScreeningResumeStatusSchema,
  error: z.string().nullable(),
  createdAt: timestampMsSchema,
  updatedAt: timestampMsSchema
})

export const resumeScreeningTaskDtoSchema = z.object({
  id: z.string().min(1),
  status: resumeScreeningTaskStatusSchema,
  jdSource: z.enum(['text', 'file']),
  jdText: z.string(),
  jdFileName: z.string().nullable(),
  jdAnalysis: resumeScreeningJdAnalysisSchema.nullable(),
  config: z.object({
    generateExplanation: z.boolean(),
    includeRawText: z.boolean(),
    maxConcurrency: z.number().int().min(1).max(5)
  }),
  providerId: z.string(),
  modelId: z.string(),
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  avgScore: z.number().nullable(),
  recommendedCount: z.number().int().nonnegative(),
  createdByName: z.string(),
  createdByEmail: z.string(),
  startedAt: timestampMsSchema.nullable(),
  finishedAt: timestampMsSchema.nullable(),
  createdAt: timestampMsSchema,
  updatedAt: timestampMsSchema
})

export const resumeScreeningCreateTaskRoute = defineRouteContract({
  name: 'resumeScreening.createTask',
  input: z.object({
    jdSource: z.enum(['text', 'file']),
    jdText: z.string().max(60000).default(''),
    jdFilePath: z.string().min(1).optional(),
    jdFileName: z.string().min(1).optional(),
    resumes: z
      .array(
        z.object({
          path: z.string().min(1),
          name: z.string().min(1),
          mimeType: z.string().min(1).optional(),
          // 渲染层选择文件时拿不到文件大小，改为可选，由服务端兜底 0
          size: z.number().int().nonnegative().optional()
        })
      )
      .min(1)
      .max(20),
    config: z.object({
      generateExplanation: z.boolean(),
      includeRawText: z.boolean(),
      maxConcurrency: z.number().int().min(1).max(5)
    }),
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional()
  }),
  output: z.object({ task: resumeScreeningTaskDtoSchema })
})

export const resumeScreeningGetTaskRoute = defineRouteContract({
  name: 'resumeScreening.getTask',
  input: z.object({ taskId: z.string().min(1) }),
  output: z.object({
    task: resumeScreeningTaskDtoSchema.nullable(),
    resumes: z.array(resumeScreeningResumeDtoSchema)
  })
})

export const resumeScreeningListTasksRoute = defineRouteContract({
  name: 'resumeScreening.listTasks',
  input: z.object({ limit: z.number().int().positive().max(100).optional() }),
  output: z.object({ tasks: z.array(resumeScreeningTaskDtoSchema) })
})

export const resumeScreeningCancelTaskRoute = defineRouteContract({
  name: 'resumeScreening.cancelTask',
  input: z.object({ taskId: z.string().min(1) }),
  output: z.object({ ok: z.boolean() })
})

export const resumeScreeningGetProfileRoute = defineRouteContract({
  name: 'resumeScreening.getProfile',
  input: z.object({}).default({}),
  output: z.object({ profile: resumeScreeningProfileSchema })
})

export const resumeScreeningUpdateProfileRoute = defineRouteContract({
  name: 'resumeScreening.updateProfile',
  input: z.object({
    name: z.string().min(1).max(100).optional(),
    email: z.string().max(200).optional()
  }),
  output: z.object({ profile: resumeScreeningProfileSchema })
})

export const resumeScreeningListModelsRoute = defineRouteContract({
  name: 'resumeScreening.listModels',
  input: z.object({}).default({}),
  output: z.object({
    models: z.array(
      z.object({
        providerId: z.string().min(1),
        providerName: z.string().min(1),
        modelId: z.string().min(1),
        modelName: z.string().min(1),
        isDefault: z.boolean()
      })
    )
  })
})
