import type { DeepchatBridge } from '@shared/contracts/bridge'
import {
  resumeScreeningCancelTaskRoute,
  resumeScreeningCreateTaskRoute,
  resumeScreeningGetProfileRoute,
  resumeScreeningGetTaskRoute,
  resumeScreeningListModelsRoute,
  resumeScreeningListTasksRoute,
  resumeScreeningUpdateProfileRoute
} from '@shared/contracts/routes'
import {
  resumeScreeningResumeUpdatedEvent,
  resumeScreeningTaskUpdatedEvent
} from '@shared/contracts/events'
import type { z } from 'zod'
import { getDeepchatBridge } from './core'

export type ResumeScreeningCreateTaskInput = z.input<typeof resumeScreeningCreateTaskRoute.input>
export type ResumeScreeningUpdateProfileInput = z.input<
  typeof resumeScreeningUpdateProfileRoute.input
>

export function createResumeScreeningClient(bridge: DeepchatBridge = getDeepchatBridge()) {
  return {
    createTask: (input: ResumeScreeningCreateTaskInput) =>
      bridge.invoke(resumeScreeningCreateTaskRoute.name, input),
    getTask: (taskId: string) => bridge.invoke(resumeScreeningGetTaskRoute.name, { taskId }),
    listTasks: (limit?: number) =>
      bridge.invoke(resumeScreeningListTasksRoute.name, limit === undefined ? {} : { limit }),
    cancelTask: (taskId: string) => bridge.invoke(resumeScreeningCancelTaskRoute.name, { taskId }),
    getProfile: () => bridge.invoke(resumeScreeningGetProfileRoute.name, {}),
    updateProfile: (input: ResumeScreeningUpdateProfileInput) =>
      bridge.invoke(resumeScreeningUpdateProfileRoute.name, input),
    listModels: () => bridge.invoke(resumeScreeningListModelsRoute.name, {}),
    onTaskUpdated: (
      listener: (payload: z.infer<typeof resumeScreeningTaskUpdatedEvent.payload>) => void
    ) => bridge.on(resumeScreeningTaskUpdatedEvent.name, listener),
    onResumeUpdated: (
      listener: (payload: z.infer<typeof resumeScreeningResumeUpdatedEvent.payload>) => void
    ) => bridge.on(resumeScreeningResumeUpdatedEvent.name, listener)
  }
}

export type ResumeScreeningClient = ReturnType<typeof createResumeScreeningClient>
