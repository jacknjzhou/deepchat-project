<template>
  <div data-testid="documents-models-page" class="flex flex-col gap-4 p-6 text-sm">
    <ProviderManagedBadge
      :managed="locked"
      label-key="settings.managed.documentsBadge"
      test-id="documents-models-managed-badge"
    />

    <div>
      <h2 class="text-base font-semibold">{{ t('settings.documentsModels.title') }}</h2>
      <p class="mt-1 text-xs text-muted-foreground">
        {{ t('settings.documentsModels.description') }}
      </p>
    </div>

    <div data-testid="documents-models-model-card" class="rounded-lg border border-border p-4">
      <div class="mb-3 text-sm font-medium">{{ t('settings.documentsModels.models.title') }}</div>

      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
          <span class="text-xs font-medium text-muted-foreground">
            {{ t('settings.documentsModels.textModel') }}
          </span>
          <Popover v-model:open="textSelectOpen">
            <PopoverTrigger as-child>
              <DcButton
                data-testid="documents-text-model-trigger"
                variant="outline"
                :disabled="locked"
                :class="[
                  'h-8 w-[320px] justify-between text-sm',
                  textInvalidReason
                    ? 'border-destructive text-destructive hover:text-destructive'
                    : 'border-border hover:bg-accent'
                ]"
              >
                <span class="min-w-0 truncate">{{ textModelLabel }}</span>
                <Icon icon="lucide:chevron-down" class="h-4 w-4 shrink-0 opacity-50" />
              </DcButton>
            </PopoverTrigger>
            <PopoverContent class="w-[320px] p-0" align="start">
              <ModelSelect
                :exclude-providers="['acp']"
                :respect-chat-mode="false"
                :selected-provider-id="draftTextModel?.providerId ?? ''"
                :selected-model-id="draftTextModel?.modelId ?? ''"
                @update:model="selectTextModel"
              />
            </PopoverContent>
          </Popover>
          <p
            v-if="textInvalidReason"
            data-testid="documents-text-model-invalid"
            class="text-xs text-destructive"
          >
            {{ t(`settings.documentsModels.invalid.${textInvalidReason}`) }}
          </p>
        </div>

        <div class="flex flex-col gap-1.5">
          <span class="text-xs font-medium text-muted-foreground">
            {{ t('settings.documentsModels.visionModel') }}
          </span>
          <Popover v-model:open="visionSelectOpen">
            <PopoverTrigger as-child>
              <DcButton
                data-testid="documents-vision-model-trigger"
                variant="outline"
                :disabled="locked"
                :class="[
                  'h-8 w-[320px] justify-between text-sm',
                  visionInvalidReason
                    ? 'border-destructive text-destructive hover:text-destructive'
                    : 'border-border hover:bg-accent'
                ]"
              >
                <span class="min-w-0 truncate">{{ visionModelLabel }}</span>
                <Icon icon="lucide:chevron-down" class="h-4 w-4 shrink-0 opacity-50" />
              </DcButton>
            </PopoverTrigger>
            <PopoverContent class="w-[320px] p-0" align="start">
              <ModelSelect
                :exclude-providers="['acp']"
                :respect-chat-mode="false"
                :vision-only="true"
                :selected-provider-id="draftVisionModel?.providerId ?? ''"
                :selected-model-id="draftVisionModel?.modelId ?? ''"
                @update:model="selectVisionModel"
              />
            </PopoverContent>
          </Popover>
          <p
            v-if="visionInvalidReason"
            data-testid="documents-vision-model-invalid"
            class="text-xs text-destructive"
          >
            {{ t(`settings.documentsModels.invalid.${visionInvalidReason}`) }}
          </p>
        </div>
      </div>
    </div>

    <div
      data-testid="documents-models-concurrency-card"
      class="rounded-lg border border-border p-4"
    >
      <div class="mb-2 text-sm font-medium">
        {{ t('settings.documentsModels.concurrency.title') }}
      </div>
      <Input
        data-testid="documents-concurrency-input"
        type="number"
        :min="1"
        :max="10"
        :step="1"
        class="w-24"
        :disabled="locked"
        :model-value="String(concurrency)"
        @update:model-value="onConcurrencyInput"
      />
      <p class="mt-1.5 text-xs text-muted-foreground">
        {{ t('settings.documentsModels.concurrency.hint') }}
      </p>
    </div>

    <details class="rounded-lg border border-border p-4">
      <summary class="cursor-pointer text-sm font-medium">
        {{ t('settings.documentsModels.advanced.title') }}
      </summary>
      <div class="mt-3 flex flex-col gap-3">
        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-medium text-muted-foreground" for="documents-temperature">
            {{ t('settings.documentsModels.advanced.temperature') }}
          </label>
          <Input
            id="documents-temperature"
            data-testid="documents-temperature-input"
            type="number"
            :min="0"
            :max="2"
            :step="0.1"
            class="w-32"
            :disabled="locked"
            :placeholder="defaultPlaceholder"
            :model-value="temperatureInput"
            @update:model-value="
              (value: string | number) => (temperatureInput = String(value ?? ''))
            "
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-medium text-muted-foreground" for="documents-max-tokens">
            {{ t('settings.documentsModels.advanced.maxTokens') }}
          </label>
          <Input
            id="documents-max-tokens"
            data-testid="documents-max-tokens-input"
            type="number"
            :min="1"
            :step="1"
            class="w-32"
            :disabled="locked"
            :placeholder="defaultPlaceholder"
            :model-value="maxTokensInput"
            @update:model-value="(value: string | number) => (maxTokensInput = String(value ?? ''))"
          />
        </div>
      </div>
    </details>

    <div v-if="!locked" class="flex items-center gap-2">
      <DcButton data-testid="documents-models-save" :disabled="!canSave || saving" @click="save">
        {{
          saveState === 'saved'
            ? t('settings.documentsModels.saved')
            : t('settings.documentsModels.save')
        }}
      </DcButton>
      <span v-if="saveState === 'error'" class="text-xs text-destructive">
        {{ t('settings.documentsModels.saveError') }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { DcButton } from '@dc-ui/components/button'
import { Popover, PopoverContent, PopoverTrigger } from '@shadcn/components/ui/popover'
import { Input } from '@shadcn/components/ui/input'
import ModelSelect from '@/components/ModelSelect.vue'
import ProviderManagedBadge from './ProviderManagedBadge.vue'
import { useProviderStore } from '@/stores/providerStore'
import { useModelStore } from '@/stores/modelStore'
import { useManagedStore } from '@/stores/managedStore'
import { createConfigClient } from '@api/ConfigClient'
import type { RENDERER_MODEL_META } from '@shared/types/provider'

type ModelRef = { providerId: string; modelId: string }
type InvalidReason = 'providerMissing' | 'providerDisabled' | 'modelMissing'
type SaveState = 'idle' | 'saved' | 'error'

const { t } = useI18n()
const configClient = createConfigClient()
const providerStore = useProviderStore()
const modelStore = useModelStore()
const managedStore = useManagedStore()

const locked = computed(() => managedStore.loading || managedStore.documentsLocked)

const draftTextModel = ref<ModelRef | null>(null)
const draftVisionModel = ref<ModelRef | null>(null)
const savedTextModel = ref<ModelRef | null>(null)
const savedVisionModel = ref<ModelRef | null>(null)
const concurrency = ref(4)
const temperatureInput = ref('')
const maxTokensInput = ref('')
const textSelectOpen = ref(false)
const visionSelectOpen = ref(false)
const saveState = ref<SaveState>('idle')
const saving = ref(false)
const defaultPlaceholder = t('settings.documentsModels.advanced.defaultPlaceholder')

const resolveInvalidReason = (modelRef: ModelRef | null): InvalidReason | null => {
  if (!modelRef) return null
  const provider = providerStore.providers.find((item) => item.id === modelRef.providerId)
  if (!provider) return 'providerMissing'
  if (!provider.enable) return 'providerDisabled'
  const models =
    modelStore.allProviderModels.find((item) => item.providerId === modelRef.providerId)?.models ??
    []
  if (!models.some((model) => model.id === modelRef.modelId)) return 'modelMissing'
  return null
}

const textInvalidReason = computed(() => resolveInvalidReason(draftTextModel.value))
const visionInvalidReason = computed(() => resolveInvalidReason(draftVisionModel.value))

const canSave = computed(
  () =>
    Boolean(draftTextModel.value) &&
    Boolean(draftVisionModel.value) &&
    textInvalidReason.value === null &&
    visionInvalidReason.value === null
)

const modelLabel = (modelRef: ModelRef | null): string => {
  if (!modelRef) return t('settings.documentsModels.notSet')
  const provider = providerStore.providers.find((item) => item.id === modelRef.providerId)
  const model = modelStore.allProviderModels
    .find((item) => item.providerId === modelRef.providerId)
    ?.models.find((item) => item.id === modelRef.modelId)
  return `${provider?.name ?? modelRef.providerId} / ${model?.name ?? modelRef.modelId}`
}

const textModelLabel = computed(() => modelLabel(draftTextModel.value))
const visionModelLabel = computed(() => modelLabel(draftVisionModel.value))

const selectTextModel = (model: RENDERER_MODEL_META, providerId: string) => {
  if (locked.value) return
  draftTextModel.value = { providerId, modelId: model.id }
  savedTextModel.value = null
  textSelectOpen.value = false
  saveState.value = 'idle'
}

const selectVisionModel = (model: RENDERER_MODEL_META, providerId: string) => {
  if (locked.value) return
  draftVisionModel.value = { providerId, modelId: model.id }
  savedVisionModel.value = null
  visionSelectOpen.value = false
  saveState.value = 'idle'
}

const clampConcurrency = (value: number): number =>
  Number.isFinite(value) ? Math.min(10, Math.max(1, Math.round(value))) : 4

const onConcurrencyInput = (raw: string | number) => {
  const parsed = typeof raw === 'number' ? raw : Number(raw)
  concurrency.value = clampConcurrency(parsed)
}

const parseOptionalNumber = (
  raw: string,
  bounds: { min?: number; max?: number }
): number | null => {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return null
  let value = parsed
  if (bounds.min !== undefined) value = Math.max(bounds.min, value)
  if (bounds.max !== undefined) value = Math.min(bounds.max, value)
  return value
}

const temperatureValue = computed(() =>
  parseOptionalNumber(temperatureInput.value, { min: 0, max: 2 })
)
const maxTokensValue = computed(() => parseOptionalNumber(maxTokensInput.value, { min: 1 }))

const save = async (): Promise<void> => {
  if (locked.value) return
  if (!canSave.value || saving.value) return
  saving.value = true
  saveState.value = 'idle'
  try {
    await Promise.all([
      configClient.setSetting('documents.textModel', draftTextModel.value),
      configClient.setSetting('documents.visionModel', draftVisionModel.value),
      configClient.setSetting('documents.concurrency', concurrency.value),
      configClient.setSetting('documents.temperature', temperatureValue.value),
      configClient.setSetting('documents.maxTokens', maxTokensValue.value)
    ])
    savedTextModel.value = draftTextModel.value ? { ...draftTextModel.value } : null
    savedVisionModel.value = draftVisionModel.value ? { ...draftVisionModel.value } : null
    saveState.value = 'saved'
  } catch (error) {
    console.error('[DocumentsModelsSettings] Failed to save document model settings:', error)
    saveState.value = 'error'
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  await managedStore.load()

  const [textModel, visionModel, savedConcurrency, savedTemperature, savedMaxTokens] =
    await Promise.all([
      configClient.getSetting('documents.textModel'),
      configClient.getSetting('documents.visionModel'),
      configClient.getSetting('documents.concurrency'),
      configClient.getSetting('documents.temperature'),
      configClient.getSetting('documents.maxTokens')
    ])

  draftTextModel.value = textModel ?? null
  draftVisionModel.value = visionModel ?? null
  savedTextModel.value = textModel ?? null
  savedVisionModel.value = visionModel ?? null
  concurrency.value = typeof savedConcurrency === 'number' ? clampConcurrency(savedConcurrency) : 4
  temperatureInput.value = typeof savedTemperature === 'number' ? String(savedTemperature) : ''
  maxTokensInput.value = typeof savedMaxTokens === 'number' ? String(savedMaxTokens) : ''

  await managedStore.load()
})

defineExpose({
  savedTextModel,
  savedVisionModel,
  canSave,
  textInvalidReason,
  visionInvalidReason,
  concurrency,
  save
})
</script>
