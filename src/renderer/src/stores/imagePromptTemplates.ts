import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import { createConfigClient } from '@api/ConfigClient'
import {
  MAX_USER_IMAGE_PROMPT_TEMPLATES,
  UserImagePromptTemplateSchema,
  UserImagePromptTemplatesSchema,
  type ResolvedImagePromptTemplate,
  type UserImagePromptTemplate
} from '@shared/imagePromptTemplates'
import { BUILTIN_IMAGE_PROMPT_TEMPLATES } from '@/lib/builtinImagePromptTemplates'

const CONFIG_KEY = 'user_image_prompt_templates'

export interface NewImagePromptTemplateInput {
  title: string
  prompt: string
  size?: string
  quality?: UserImagePromptTemplate['quality']
}

export const useImagePromptTemplatesStore = defineStore('imagePromptTemplates', () => {
  const configClient = createConfigClient()
  const userTemplates = ref<UserImagePromptTemplate[]>([])
  const loaded = ref(false)
  const canAdd = computed(() => userTemplates.value.length < MAX_USER_IMAGE_PROMPT_TEMPLATES)

  const persist = () => {
    void configClient.setSetting(CONFIG_KEY, [...userTemplates.value])
  }

  const load = async () => {
    if (loaded.value) return
    try {
      const raw = await configClient.getSetting(CONFIG_KEY)
      const parsed = UserImagePromptTemplatesSchema.safeParse(raw ?? [])
      if (parsed.success) {
        userTemplates.value = parsed.data
      } else {
        console.warn('[imagePromptTemplates] invalid stored templates, falling back to empty list')
        userTemplates.value = []
      }
    } catch (error) {
      console.warn(
        '[imagePromptTemplates] failed to load templates, falling back to empty list',
        error
      )
      userTemplates.value = []
    } finally {
      loaded.value = true
    }
  }

  const add = (input: NewImagePromptTemplateInput): UserImagePromptTemplate => {
    if (!canAdd.value) {
      throw new Error('Image prompt template limit reached')
    }
    const candidate = {
      id: nanoid(),
      title: input.title,
      prompt: input.prompt,
      ...(input.size !== undefined ? { size: input.size } : {}),
      ...(input.quality !== undefined ? { quality: input.quality } : {}),
      createdAt: Date.now()
    }
    const parsed = UserImagePromptTemplateSchema.safeParse(candidate)
    if (!parsed.success) {
      throw new Error('Invalid image prompt template')
    }
    userTemplates.value = [...userTemplates.value, parsed.data]
    persist()
    return parsed.data
  }

  const update = (id: string, input: NewImagePromptTemplateInput): void => {
    const target = userTemplates.value.find((tpl) => tpl.id === id)
    if (!target) {
      throw new Error('Image prompt template not found')
    }
    const candidate = {
      id,
      title: input.title,
      prompt: input.prompt,
      ...(input.size !== undefined ? { size: input.size } : {}),
      ...(input.quality !== undefined ? { quality: input.quality } : {}),
      createdAt: target.createdAt
    }
    const parsed = UserImagePromptTemplateSchema.safeParse(candidate)
    if (!parsed.success) {
      throw new Error('Invalid image prompt template')
    }
    userTemplates.value = userTemplates.value.map((tpl) => (tpl.id === id ? parsed.data : tpl))
    persist()
  }

  const remove = (id: string): void => {
    userTemplates.value = userTemplates.value.filter((tpl) => tpl.id !== id)
    persist()
  }

  return { userTemplates, loaded, canAdd, load, add, update, remove }
})

export const useBuiltinImagePromptTemplates = (): {
  builtinTemplates: ReturnType<typeof computed<ResolvedImagePromptTemplate[]>>
} => {
  const { t } = useI18n()
  const builtinTemplates = computed<ResolvedImagePromptTemplate[]>(() =>
    BUILTIN_IMAGE_PROMPT_TEMPLATES.map((tpl) => ({
      id: tpl.id,
      title: t(tpl.titleKey),
      prompt: t(tpl.promptKey),
      ...(tpl.size !== undefined ? { size: tpl.size } : {}),
      ...(tpl.quality !== undefined ? { quality: tpl.quality } : {})
    }))
  )
  return { builtinTemplates }
}
