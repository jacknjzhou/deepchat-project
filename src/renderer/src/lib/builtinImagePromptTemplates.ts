import type { ImageGenerationQuality } from '@shared/imageGenerationSettings'

interface BuiltinImagePromptTemplate {
  id: string
  titleKey: string
  promptKey: string
  size?: string
  quality?: ImageGenerationQuality
}

export const BUILTIN_IMAGE_PROMPT_TEMPLATES: BuiltinImagePromptTemplate[] = [
  {
    id: 'builtin-design',
    titleKey: 'chat.imageTemplates.builtin.design.title',
    promptKey: 'chat.imageTemplates.builtin.design.prompt',
    size: '1024x1024',
    quality: 'high'
  },
  {
    id: 'builtin-commodity',
    titleKey: 'chat.imageTemplates.builtin.commodity.title',
    promptKey: 'chat.imageTemplates.builtin.commodity.prompt',
    size: '1024x1536',
    quality: 'high'
  },
  {
    id: 'builtin-poster',
    titleKey: 'chat.imageTemplates.builtin.poster.title',
    promptKey: 'chat.imageTemplates.builtin.poster.prompt',
    size: '1024x1536',
    quality: 'high'
  },
  {
    id: 'builtin-beautify',
    titleKey: 'chat.imageTemplates.builtin.beautify.title',
    promptKey: 'chat.imageTemplates.builtin.beautify.prompt',
    size: '1024x1024',
    quality: 'high'
  },
  {
    id: 'builtin-portrait',
    titleKey: 'chat.imageTemplates.builtin.portrait.title',
    promptKey: 'chat.imageTemplates.builtin.portrait.prompt',
    size: '1024x1536',
    quality: 'high'
  },
  {
    id: 'builtin-style',
    titleKey: 'chat.imageTemplates.builtin.style.title',
    promptKey: 'chat.imageTemplates.builtin.style.prompt',
    size: '1024x1024',
    quality: 'high'
  },
  {
    id: 'builtin-photorealistic',
    titleKey: 'chat.imageTemplates.builtin.photorealistic.title',
    promptKey: 'chat.imageTemplates.builtin.photorealistic.prompt',
    size: '1536x1024',
    quality: 'high'
  }
]
