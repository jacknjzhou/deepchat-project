import { z } from 'zod'
import { TimestampMsSchema, defineEventContract } from '../common'
import { documentTaskSchema } from '../routes/documents.routes'

export const documentsTaskUpdatedEvent = defineEventContract({
  name: 'documents.task.updated',
  payload: documentTaskSchema.extend({
    doneCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    version: TimestampMsSchema
  })
})
