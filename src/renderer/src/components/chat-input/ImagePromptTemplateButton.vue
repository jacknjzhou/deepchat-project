<template>
  <Popover v-model:open="panelOpen">
    <PopoverTrigger as-child>
      <DcButton
        variant="ghost"
        size="icon-sm"
        icon="lucide:images"
        :label="t('chat.imageTemplates.button')"
        :tooltip="t('chat.imageTemplates.button')"
        :tooltip-delay-duration="200"
        data-testid="image-template-button"
      />
    </PopoverTrigger>
    <PopoverContent align="start" class="w-80 p-0">
      <div class="px-3 pt-3 text-sm font-medium">
        {{ t('chat.imageTemplates.panelTitle') }}
      </div>
      <Tabs default-value="featured" class="mt-1">
        <TabsList class="mx-3 grid grid-cols-2">
          <TabsTrigger value="featured" data-testid="image-template-tab-featured">
            {{ t('chat.imageTemplates.tabFeatured') }}
          </TabsTrigger>
          <TabsTrigger value="mine" data-testid="image-template-tab-mine">
            {{ t('chat.imageTemplates.tabMine') }}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="featured" class="min-h-0">
          <div class="max-h-80 overflow-y-auto px-1 py-1">
            <button
              v-for="tpl in builtinTemplates"
              :key="tpl.id"
              type="button"
              data-testid="image-template-card"
              class="block w-full rounded-lg px-2 py-2 text-left hover:bg-accent"
              @click="applyTemplate(tpl)"
            >
              <span class="flex items-center gap-2">
                <span class="text-sm">{{ tpl.title }}</span>
                <span v-if="templateMeta(tpl)" class="text-[11px] text-muted-foreground">
                  {{ templateMeta(tpl) }}
                </span>
              </span>
              <span class="mt-1 block line-clamp-2 text-xs text-muted-foreground">
                {{ tpl.prompt }}
              </span>
            </button>
          </div>
        </TabsContent>

        <TabsContent value="mine" class="min-h-0">
          <div class="max-h-80 overflow-y-auto px-1 py-1">
            <DcButton
              v-if="store.canAdd && !formMode"
              data-testid="image-template-add"
              variant="outline"
              size="sm"
              class="mx-1 my-1"
              icon="lucide:plus"
              @click="openCreate"
            >
              {{ t('chat.imageTemplates.add') }}
            </DcButton>
            <p
              v-else-if="!formMode"
              data-testid="image-template-limit"
              class="px-2 py-2 text-xs text-muted-foreground"
            >
              {{ t('chat.imageTemplates.limitReached', { max: MAX_USER_IMAGE_PROMPT_TEMPLATES }) }}
            </p>

            <form
              v-if="formMode"
              data-testid="image-template-form"
              class="flex flex-col gap-2 px-2 py-2"
              @submit.prevent="saveForm"
            >
              <Label for="image-template-form-title">
                {{ t('chat.imageTemplates.formTitle') }}
              </Label>
              <Input
                id="image-template-form-title"
                v-model="formTitle"
                data-testid="image-template-form-title"
                :placeholder="t('chat.imageTemplates.formTitlePlaceholder')"
              />
              <Label for="image-template-form-prompt">
                {{ t('chat.imageTemplates.formPrompt') }}
              </Label>
              <Textarea
                id="image-template-form-prompt"
                v-model="formPrompt"
                rows="4"
                data-testid="image-template-form-prompt"
                :placeholder="t('chat.imageTemplates.formPromptPlaceholder')"
              />
              <Label>{{ t('chat.imageTemplates.formSize') }}</Label>
              <Select :model-value="formSize" @update:model-value="onSizeSelect">
                <SelectTrigger data-testid="image-template-form-size">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem :value="DEFAULT_SELECT_VALUE">
                    {{ t('chat.imageTemplates.sizeDefault') }}
                  </SelectItem>
                  <SelectItem
                    v-for="size in OPENAI_IMAGE_GENERATION_SIZE_PRESETS"
                    :key="size"
                    :value="size"
                  >
                    {{ size }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Label>{{ t('chat.imageTemplates.formQuality') }}</Label>
              <Select :model-value="formQuality" @update:model-value="onQualitySelect">
                <SelectTrigger data-testid="image-template-form-quality">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem :value="DEFAULT_SELECT_VALUE">
                    {{ t('chat.imageTemplates.qualityDefault') }}
                  </SelectItem>
                  <SelectItem
                    v-for="quality in IMAGE_GENERATION_QUALITY_VALUES"
                    :key="quality"
                    :value="quality"
                  >
                    {{ quality }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p
                v-if="formError"
                data-testid="image-template-form-error"
                class="text-xs text-destructive"
              >
                {{
                  formError === 'title'
                    ? t('chat.imageTemplates.titleRequired')
                    : t('chat.imageTemplates.promptRequired')
                }}
              </p>
              <div class="flex justify-end gap-2">
                <DcButton
                  data-testid="image-template-form-cancel"
                  variant="ghost"
                  size="sm"
                  @click="cancelForm"
                >
                  {{ t('chat.imageTemplates.cancel') }}
                </DcButton>
                <DcButton data-testid="image-template-form-save" size="sm" type="submit">
                  {{ t('chat.imageTemplates.save') }}
                </DcButton>
              </div>
            </form>

            <template v-else>
              <div
                v-if="store.userTemplates.length === 0"
                data-testid="image-template-empty"
                class="px-2 py-4 text-center"
              >
                <p class="text-sm">{{ t('chat.imageTemplates.emptyMine') }}</p>
                <p class="mt-1 text-xs text-muted-foreground">
                  {{ t('chat.imageTemplates.emptyMineHint') }}
                </p>
              </div>
              <div
                v-for="tpl in store.userTemplates"
                :key="tpl.id"
                data-testid="image-template-user-item"
                class="flex items-start gap-1 rounded-lg px-2 py-2 hover:bg-accent"
              >
                <button type="button" class="min-w-0 flex-1 text-left" @click="applyTemplate(tpl)">
                  <span class="block text-sm">{{ tpl.title }}</span>
                  <span class="mt-1 block line-clamp-2 text-xs text-muted-foreground">
                    {{ tpl.prompt }}
                  </span>
                </button>
                <DcButton
                  data-testid="image-template-edit"
                  variant="ghost"
                  size="icon-sm"
                  icon="lucide:pencil"
                  :label="t('chat.imageTemplates.edit')"
                  @click="openEdit(tpl)"
                />
                <DcButton
                  data-testid="image-template-delete"
                  variant="ghost"
                  size="icon-sm"
                  icon="lucide:trash-2"
                  :label="t('chat.imageTemplates.delete')"
                  @click="deleteTarget = tpl"
                />
              </div>
            </template>
          </div>
        </TabsContent>
      </Tabs>
    </PopoverContent>
  </Popover>

  <DcConfirmDialog
    :open="deleteTarget !== null"
    :title="t('chat.imageTemplates.deleteConfirmTitle')"
    :description="deleteConfirmText"
    :confirm-label="t('chat.imageTemplates.delete')"
    :cancel-label="t('chat.imageTemplates.cancel')"
    danger
    @confirm="confirmDelete"
    @update:open="
      (value: boolean) => {
        if (!value) deleteTarget = null
      }
    "
  />
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Popover, PopoverContent, PopoverTrigger } from '@shadcn/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@shadcn/components/ui/tabs'
import { Input } from '@shadcn/components/ui/input'
import { Label } from '@shadcn/components/ui/label'
import { Textarea } from '@shadcn/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shadcn/components/ui/select'
import { DcButton } from '@dc-ui/components/button'
import { DcConfirmDialog } from '@dc-ui/components/confirm-dialog'
import {
  IMAGE_GENERATION_QUALITY_VALUES,
  OPENAI_IMAGE_GENERATION_SIZE_PRESETS
} from '@shared/imageGenerationSettings'
import {
  MAX_USER_IMAGE_PROMPT_TEMPLATES,
  type ImagePromptTemplateApplyPayload,
  type ResolvedImagePromptTemplate,
  type UserImagePromptTemplate
} from '@shared/imagePromptTemplates'
import {
  useBuiltinImagePromptTemplates,
  useImagePromptTemplatesStore
} from '@/stores/imagePromptTemplates'

const DEFAULT_SELECT_VALUE = '__default'

const emit = defineEmits<{ 'apply-template': [payload: ImagePromptTemplateApplyPayload] }>()

const { t } = useI18n()
const store = useImagePromptTemplatesStore()
const { builtinTemplates } = useBuiltinImagePromptTemplates()

const panelOpen = ref(false)
type FormMode = 'create' | 'edit' | null
const formMode = ref<FormMode>(null)
const editingId = ref<string | null>(null)
const formTitle = ref('')
const formPrompt = ref('')
const formSize = ref<string>(DEFAULT_SELECT_VALUE)
const formQuality = ref<string>(DEFAULT_SELECT_VALUE)
const formError = ref<'title' | 'prompt' | null>(null)
const deleteTarget = ref<UserImagePromptTemplate | null>(null)

const deleteConfirmText = computed(() =>
  deleteTarget.value
    ? t('chat.imageTemplates.deleteConfirmDescription', { title: deleteTarget.value.title })
    : ''
)

const templateMeta = (tpl: ResolvedImagePromptTemplate): string =>
  [tpl.size, tpl.quality].filter(Boolean).join(' · ')

onMounted(() => {
  if (!store.loaded) void store.load()
})

watch(panelOpen, (open) => {
  if (!open) {
    cancelForm()
    deleteTarget.value = null
  }
})

const openCreate = () => {
  formMode.value = 'create'
  editingId.value = null
  formTitle.value = ''
  formPrompt.value = ''
  formSize.value = DEFAULT_SELECT_VALUE
  formQuality.value = DEFAULT_SELECT_VALUE
  formError.value = null
}

const openEdit = (tpl: UserImagePromptTemplate) => {
  formMode.value = 'edit'
  editingId.value = tpl.id
  formTitle.value = tpl.title
  formPrompt.value = tpl.prompt
  formSize.value = tpl.size ?? DEFAULT_SELECT_VALUE
  formQuality.value = tpl.quality ?? DEFAULT_SELECT_VALUE
  formError.value = null
}

const cancelForm = () => {
  formMode.value = null
  editingId.value = null
  formError.value = null
}

const onSizeSelect = (value: unknown) => {
  formSize.value = String(value)
}

const onQualitySelect = (value: unknown) => {
  formQuality.value = String(value)
}

const saveForm = () => {
  const title = formTitle.value.trim()
  const prompt = formPrompt.value.trim()
  if (!title) {
    formError.value = 'title'
    return
  }
  if (!prompt) {
    formError.value = 'prompt'
    return
  }
  const size = formSize.value === DEFAULT_SELECT_VALUE ? undefined : formSize.value
  const quality =
    formQuality.value === DEFAULT_SELECT_VALUE
      ? undefined
      : (formQuality.value as UserImagePromptTemplate['quality'])
  const input = {
    title,
    prompt,
    ...(size !== undefined ? { size } : {}),
    ...(quality !== undefined ? { quality } : {})
  }
  if (formMode.value === 'edit' && editingId.value) {
    store.update(editingId.value, input)
  } else {
    store.add(input)
  }
  cancelForm()
}

const applyTemplate = (tpl: ResolvedImagePromptTemplate) => {
  emit('apply-template', {
    prompt: tpl.prompt,
    ...(tpl.size !== undefined ? { size: tpl.size } : {}),
    ...(tpl.quality !== undefined ? { quality: tpl.quality } : {})
  })
  panelOpen.value = false
}

const confirmDelete = () => {
  if (deleteTarget.value) {
    store.remove(deleteTarget.value.id)
  }
  deleteTarget.value = null
}
</script>
