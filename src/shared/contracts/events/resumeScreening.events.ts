import { z } from 'zod'
import { TimestampMsSchema, defineEventContract } from '../common'
import {
  resumeScreeningResumeStatusSchema,
  resumeScreeningTaskStatusSchema
} from '../routes/resumeScreening.routes'

export const resumeScreeningTaskUpdatedEvent = defineEventContract({
  name: 'resumeScreening.task.updated',
  payload: z.object({
    taskId: z.string().min(1),
    status: resumeScreeningTaskStatusSchema,
    progress: z.object({
      done: z.number().int().nonnegative(),
      total: z.number().int().nonnegative()
    }),
    stats: z.object({
      succeeded: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      avgScore: z.number().nullable(),
      recommendedCount: z.number().int().nonnegative()
    }),
    version: TimestampMsSchema
  })
})

export const resumeScreeningResumeUpdatedEvent = defineEventContract({
  name: 'resumeScreening.resume.updated',
  payload: z.object({
    taskId: z.string().min(1),
    resumeId: z.string().min(1),
    status: resumeScreeningResumeStatusSchema,
    stage: z.enum(['extracting', 'screening', 'interviewing', 'hr']).nullable(),
    version: TimestampMsSchema
  })
})
