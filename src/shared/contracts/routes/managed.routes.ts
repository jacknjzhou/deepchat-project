import { z } from 'zod'
import { defineRouteContract } from '../common'

export const ManagedConfigStatusSchema = z.object({
  managed: z.boolean(),
  username: z.string(),
  endpoint: z.string(),
  fetchedAt: z.number().int().nullable(),
  providerIds: z.array(z.string()),
  documentsLocked: z.boolean()
})

export type ManagedConfigStatus = z.infer<typeof ManagedConfigStatusSchema>

export const managedGetStatusRoute = defineRouteContract({
  name: 'managed.getStatus',
  input: z.object({}).default({}),
  output: ManagedConfigStatusSchema
})

export const managedRefreshRoute = defineRouteContract({
  name: 'managed.refresh',
  input: z.object({}).default({}),
  output: ManagedConfigStatusSchema
})
