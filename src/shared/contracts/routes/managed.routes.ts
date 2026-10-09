import { z } from 'zod'
import { defineRouteContract } from '../common'

const ManagedModelRefLikeSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  endpointType: z.string().optional()
})

const ManagedDocumentsStatusSchema = z
  .object({
    textModel: ManagedModelRefLikeSchema.nullable(),
    visionModel: ManagedModelRefLikeSchema.nullable(),
    concurrency: z.number().nullable(),
    temperature: z.number().nullable(),
    maxTokens: z.number().nullable()
  })
  .nullable()

export const ManagedConfigStatusSchema = z.object({
  managed: z.boolean(),
  username: z.string(),
  endpoint: z.string(),
  fetchedAt: z.number().int().nullable(),
  providerIds: z.array(z.string()),
  documentsLocked: z.boolean(),
  documents: ManagedDocumentsStatusSchema
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
