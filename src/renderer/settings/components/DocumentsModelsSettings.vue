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

    <div class="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
      <div class="flex min-w-0 flex-col gap-4">
        <div data-testid="documents-models-model-card" class="rounded-lg border border-border p-4">
          <div class="mb-3 text-sm font-medium">
            {{ t('settings.documentsModels.models.title') }}
          </div>

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
                      'h-8 w-full max-w-[320px] justify-between text-sm',
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
                      'h-8 w-full max-w-[320px] justify-between text-sm',
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
      </div>

      <div data-testid="documents-auto-watch-card" class="rounded-lg border border-border p-4">
        <div class="mb-2 text-sm font-medium">
          {{ t('settings.documents.archive.autoWatchTitle') }}
        </div>
        <div class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <input
              data-testid="auto-watch-enable"
              type="checkbox"
              class="size-4 accent-primary"
              :checked="autoWatchEnabled"
              @change="onAutoWatchEnabledChange"
            />
            <span class="text-xs font-medium text-muted-foreground">
              {{ t('settings.documents.archive.autoWatchEnable') }}
            </span>
            <span class="text-xs text-muted-foreground">
              {{ t('settings.documents.archive.autoWatchDir') }}:
            </span>
            <span data-testid="auto-watch-dir" class="min-w-0 flex-1 truncate text-xs">
              {{ autoWatchDir || '—' }}
            </span>
            <DcButton
              data-testid="auto-watch-choose-dir"
              variant="outline"
              @click="onChooseAutoWatchDir"
            >
              {{ t('settings.documents.archive.autoWatchChooseDir') }}
            </DcButton>
          </div>

          <div class="flex flex-wrap items-center gap-4">
            <label class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              {{ t('settings.documents.archive.autoWatchIntervalHours') }}
              <Input
                data-testid="auto-watch-interval"
                type="number"
                :min="1"
                :max="72"
                :step="1"
                class="w-20"
                :model-value="autoWatchIntervalInput"
                @update:model-value="onAutoWatchIntervalInput"
              />
            </label>
            <label class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              {{ t('settings.documents.archive.autoWatchRoundLimit') }}
              <Input
                data-testid="auto-watch-round-limit"
                type="number"
                :min="1"
                :max="20"
                :step="1"
                class="w-20"
                :model-value="autoWatchRoundLimitInput"
                @update:model-value="onAutoWatchRoundLimitInput"
              />
            </label>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <span class="text-xs font-medium text-muted-foreground">
              {{ t('settings.documents.archive.autoWatchExtensions') }}
            </span>
            <label
              v-for="ext in autoWatchExtensionOptions"
              :key="ext"
              class="flex items-center gap-1 text-xs text-muted-foreground"
            >
              <input
                type="checkbox"
                class="size-4 accent-primary"
                :checked="autoWatchExtensions.includes(ext)"
                :data-testid="`auto-watch-ext-${ext.slice(1)}`"
                @change="onAutoWatchExtensionChange(ext, $event)"
              />
              {{ ext }}
            </label>
          </div>

          <div class="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span data-testid="auto-watch-last-run">
              {{ t('settings.documents.archive.autoWatchLastRun') }}:
              {{ autoWatchLastRunText }}
            </span>
            <span
              v-if="autoWatchState.lastError"
              data-testid="auto-watch-error"
              class="text-destructive"
            >
              {{ autoWatchState.lastError }}
            </span>
          </div>

          <p
            v-if="autoWatchValidationError"
            data-testid="auto-watch-validation"
            class="text-xs text-destructive"
          >
            {{ autoWatchValidationError }}
          </p>
          <p v-if="autoWatchSaveState === 'error'" class="text-xs text-destructive">
            {{ t('settings.documentsModels.saveError') }}
          </p>

          <div>
            <DcButton
              data-testid="auto-watch-save"
              :disabled="autoWatchSaving"
              @click="saveAutoWatch"
            >
              {{
                autoWatchSaveState === 'saved'
                  ? t('settings.documentsModels.saved')
                  : t('settings.documentsModels.save')
              }}
            </DcButton>
          </div>
        </div>
      </div>
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
import { createDocumentsClient } from '@api/DocumentsClient'
import {
  DOCUMENTS_AUTO_WATCH_DEFAULT,
  DOCUMENTS_AUTO_WATCH_EXTENSIONS,
  type DocumentsAutoWatchConfig
} from '@shared/documents'
import type { RENDERER_MODEL_META } from '@shared/types/provider'

type ModelRef = { providerId: string; modelId: string }
type InvalidReason = 'providerMissing' | 'providerDisabled' | 'modelMissing'
type SaveState = 'idle' | 'saved' | 'error'
type AutoWatchState = { lastRunAt: number | null; lastError: string | null }

const { t } = useI18n()
const configClient = createConfigClient()
const documentsClient = createDocumentsClient()
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

const AUTO_WATCH_EXT_PATTERN = /^\.[A-Za-z0-9]+$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const normalizeAutoWatchConfig = (raw: unknown): DocumentsAutoWatchConfig => {
  if (!isRecord(raw)) return { ...DOCUMENTS_AUTO_WATCH_DEFAULT }
  const extensions = Array.isArray(raw.extensions)
    ? raw.extensions.filter(
        (ext): ext is string => typeof ext === 'string' && AUTO_WATCH_EXT_PATTERN.test(ext)
      )
    : DOCUMENTS_AUTO_WATCH_DEFAULT.extensions
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DOCUMENTS_AUTO_WATCH_DEFAULT.enabled,
    dir: typeof raw.dir === 'string' ? raw.dir : DOCUMENTS_AUTO_WATCH_DEFAULT.dir,
    intervalHours:
      typeof raw.intervalHours === 'number' && Number.isFinite(raw.intervalHours)
        ? raw.intervalHours
        : DOCUMENTS_AUTO_WATCH_DEFAULT.intervalHours,
    extensions,
    roundLimit:
      typeof raw.roundLimit === 'number' && Number.isFinite(raw.roundLimit)
        ? raw.roundLimit
        : DOCUMENTS_AUTO_WATCH_DEFAULT.roundLimit
  }
}

const normalizeAutoWatchState = (raw: unknown): AutoWatchState => {
  if (!isRecord(raw)) return { lastRunAt: null, lastError: null }
  return {
    lastRunAt: typeof raw.lastRunAt === 'number' ? raw.lastRunAt : null,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null
  }
}

const autoWatchExtensionOptions = DOCUMENTS_AUTO_WATCH_EXTENSIONS
const autoWatchEnabled = ref(DOCUMENTS_AUTO_WATCH_DEFAULT.enabled)
const autoWatchDir = ref(DOCUMENTS_AUTO_WATCH_DEFAULT.dir)
const autoWatchIntervalInput = ref(String(DOCUMENTS_AUTO_WATCH_DEFAULT.intervalHours))
const autoWatchRoundLimitInput = ref(String(DOCUMENTS_AUTO_WATCH_DEFAULT.roundLimit))
const autoWatchExtensions = ref<string[]>([...DOCUMENTS_AUTO_WATCH_DEFAULT.extensions])
const autoWatchState = ref<AutoWatchState>({ lastRunAt: null, lastError: null })
const autoWatchValidationError = ref<string | null>(null)
const autoWatchSaveState = ref<SaveState>('idle')
const autoWatchSaving = ref(false)

const autoWatchLastRunText = computed(() =>
  autoWatchState.value.lastRunAt === null
    ? '—'
    : new Date(autoWatchState.value.lastRunAt).toLocaleString()
)

const clampAutoWatchNumber = (raw: string | number, min: number, max: number): number => {
  const parsed = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(parsed)) return min
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

const onAutoWatchIntervalInput = (raw: string | number) => {
  autoWatchIntervalInput.value = String(clampAutoWatchNumber(raw, 1, 72))
}

const onAutoWatchRoundLimitInput = (raw: string | number) => {
  autoWatchRoundLimitInput.value = String(clampAutoWatchNumber(raw, 1, 20))
}

const onAutoWatchEnabledChange = (event: Event) => {
  autoWatchEnabled.value = (event.target as HTMLInputElement).checked
  autoWatchSaveState.value = 'idle'
}

const onAutoWatchExtensionChange = (ext: string, event: Event) => {
  const checked = (event.target as HTMLInputElement).checked
  autoWatchExtensions.value = checked
    ? [...autoWatchExtensions.value, ext]
    : autoWatchExtensions.value.filter((item) => item !== ext)
  autoWatchSaveState.value = 'idle'
}

const onChooseAutoWatchDir = async (): Promise<void> => {
  try {
    const dir = await documentsClient.chooseAutoWatchDir()
    if (dir) {
      autoWatchDir.value = dir
      autoWatchValidationError.value = null
      autoWatchSaveState.value = 'idle'
    }
  } catch (error) {
    console.error('[DocumentsModelsSettings] Failed to choose auto watch directory:', error)
  }
}

const saveAutoWatch = async (): Promise<void> => {
  if (autoWatchSaving.value) return
  autoWatchValidationError.value = null
  const dir = autoWatchDir.value.trim()
  if (autoWatchEnabled.value && !dir) {
    autoWatchValidationError.value = t('settings.documents.archive.autoWatchNeedDir')
    return
  }
  const extensions = autoWatchExtensionOptions.filter((ext) =>
    autoWatchExtensions.value.includes(ext)
  )
  if (extensions.length === 0) {
    autoWatchValidationError.value = t('settings.documents.archive.autoWatchInvalidExtensions')
    return
  }
  autoWatchSaving.value = true
  autoWatchSaveState.value = 'idle'
  try {
    await configClient.setSetting('documents.autoWatch', {
      enabled: autoWatchEnabled.value,
      dir,
      intervalHours: clampAutoWatchNumber(autoWatchIntervalInput.value, 1, 72),
      extensions,
      roundLimit: clampAutoWatchNumber(autoWatchRoundLimitInput.value, 1, 20)
    })
    autoWatchSaveState.value = 'saved'
  } catch (error) {
    console.error('[DocumentsModelsSettings] Failed to save auto watch settings:', error)
    autoWatchSaveState.value = 'error'
  } finally {
    autoWatchSaving.value = false
  }
}

onMounted(async () => {
  await managedStore.load()

  const [
    textModel,
    visionModel,
    savedConcurrency,
    savedTemperature,
    savedMaxTokens,
    savedAutoWatch,
    savedAutoWatchState
  ] = await Promise.all([
    configClient.getSetting('documents.textModel'),
    configClient.getSetting('documents.visionModel'),
    configClient.getSetting('documents.concurrency'),
    configClient.getSetting('documents.temperature'),
    configClient.getSetting('documents.maxTokens'),
    configClient.getSetting('documents.autoWatch'),
    configClient.getSetting('documents.autoWatchState')
  ])

  const userTextModel = textModel ?? null
  const userVisionModel = visionModel ?? null
  const userConcurrency =
    typeof savedConcurrency === 'number' ? clampConcurrency(savedConcurrency) : 4
  const userTemperature = typeof savedTemperature === 'number' ? String(savedTemperature) : ''
  const userMaxTokens = typeof savedMaxTokens === 'number' ? String(savedMaxTokens) : ''

  const autoWatch = normalizeAutoWatchConfig(savedAutoWatch)
  autoWatchEnabled.value = autoWatch.enabled
  autoWatchDir.value = autoWatch.dir
  autoWatchIntervalInput.value = String(clampAutoWatchNumber(autoWatch.intervalHours, 1, 72))
  autoWatchRoundLimitInput.value = String(clampAutoWatchNumber(autoWatch.roundLimit, 1, 20))
  autoWatchExtensions.value = autoWatch.extensions.filter((ext) =>
    autoWatchExtensionOptions.includes(ext)
  )
  autoWatchState.value = normalizeAutoWatchState(savedAutoWatchState)

  savedTextModel.value = userTextModel
  savedVisionModel.value = userVisionModel

  // 托管锁定态：展示真正生效的托管文档模型值（与 resolveDocumentsModelSettings 叠加语义一致：
  // 模型/并发托管值优先、null 回退用户值；temperature/maxTokens 以托管值为准，null 表示不传参）。
  // 非托管或托管无 documents 段时回退到用户键值，行为与现状完全一致。
  const managedDocuments = locked.value ? managedStore.documents : null
  if (managedDocuments) {
    draftTextModel.value = managedDocuments.textModel ?? userTextModel
    draftVisionModel.value = managedDocuments.visionModel ?? userVisionModel
    concurrency.value =
      typeof managedDocuments.concurrency === 'number'
        ? clampConcurrency(managedDocuments.concurrency)
        : userConcurrency
    temperatureInput.value =
      typeof managedDocuments.temperature === 'number' ? String(managedDocuments.temperature) : ''
    maxTokensInput.value =
      typeof managedDocuments.maxTokens === 'number' ? String(managedDocuments.maxTokens) : ''
  } else {
    draftTextModel.value = userTextModel
    draftVisionModel.value = userVisionModel
    concurrency.value = userConcurrency
    temperatureInput.value = userTemperature
    maxTokensInput.value = userMaxTokens
  }
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
