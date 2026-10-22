import { z } from 'zod'
import { defineRouteContract } from '../common'

export const sopDocumentSchema = z.object({
  title: z.string().min(1).max(100),
  content: z.string().min(1).max(20000)
})

export const digitalEmployeeSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(50),
  role: z.string().min(1).max(50),
  description: z.string().max(500),
  avatar: z.string().max(256).nullable(),
  capabilities: z.array(z.string().min(1).max(30)).max(20),
  greeting: z.string().max(500).nullable(),
  systemPrompt: z.string().min(1).max(10000),
  sops: z.array(sopDocumentSchema).max(20),
  knowledgeBaseIds: z.array(z.string().min(1)).max(10),
  skillIds: z.array(z.string().min(1)).max(20),
  tools: z.array(z.string().min(1)).max(50),
  enabled: z.boolean(),
  updatedAt: z.string().min(1),
  executionMode: z.enum(['local', 'remote', 'hybrid']).default('local'),
  configHash: z.string().max(128).optional(),
  skills: z.array(z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(100),
    downloadUrl: z.string().min(1).max(512)
  })).max(20).optional(),
  knowledgePackagesUrl: z.string().max(512).optional()
})

export type DigitalEmployee = z.infer<typeof digitalEmployeeSchema>

export const digitalEmployeeListRoute = defineRouteContract({
  name: 'digitalEmployee.list',
  input: z.object({}).strict().default({}),
  output: z.object({
    employees: z.array(digitalEmployeeSchema),
    fetchedAt: z.string().min(1),
    degraded: z.boolean().optional(),
    source: z.enum(['http', 'mock']).optional()
  })
})

export const digitalEmployeeGetRoute = defineRouteContract({
  name: 'digitalEmployee.get',
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ employee: digitalEmployeeSchema.nullable() })
})
