import { createResumeScreeningClient } from './ResumeScreeningClient'
import type {
  resumeScreeningResumeDtoSchema,
  resumeScreeningTaskDtoSchema
} from '@shared/contracts/routes'
import type { z } from 'zod'

export type ResumeScreeningTaskDto = z.infer<typeof resumeScreeningTaskDtoSchema>
export type ResumeScreeningResumeDto = z.infer<typeof resumeScreeningResumeDtoSchema>

// 无状态 bridge 封装单例：筛选 store 与页面组件共享同一实例
export const resumeScreeningApi = createResumeScreeningClient()
