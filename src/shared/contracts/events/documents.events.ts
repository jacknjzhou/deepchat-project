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

/** 自动监控提交时被内容去重拦截的文件数量（renderer 用于提示用户） */
export const documentsWatchDuplicatesEvent = defineEventContract({
  name: 'documents.watch.duplicates',
  payload: z.object({ count: z.number().int().nonnegative() })
})
