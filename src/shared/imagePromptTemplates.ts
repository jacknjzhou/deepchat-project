import { z } from 'zod'
import {
  IMAGE_GENERATION_QUALITY_VALUES,
  isValidOpenAIImageGenerationSize,
  type ImageGenerationQuality
} from './imageGenerationSettings'

export const MAX_USER_IMAGE_PROMPT_TEMPLATES = 50

export const UserImagePromptTemplateSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(8000),
  size: z.string().refine(isValidOpenAIImageGenerationSize).optional(),
  quality: z.enum(IMAGE_GENERATION_QUALITY_VALUES).optional(),
  createdAt: z.number().int().positive()
})

export type UserImagePromptTemplate = z.infer<typeof UserImagePromptTemplateSchema>
export const UserImagePromptTemplatesSchema = z.array(UserImagePromptTemplateSchema)

export interface ResolvedImagePromptTemplate {
  id: string
  title: string
  prompt: string
  size?: string
  quality?: ImageGenerationQuality
}

export interface ImagePromptTemplateApplyPayload {
  prompt: string
  size?: string
  quality?: ImageGenerationQuality
}
