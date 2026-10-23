<template>
  <SettingsPageShell
    :title="t('routes.settings-digital-employee-service')"
    :description="t('digitalEmployee.service.description')"
    :eyebrow="t('settings.controlCenter.groups.models')"
    data-testid="settings-digital-employee-service-page"
  >
    <SettingsSectionCard
      :title="t('digitalEmployee.service.connection')"
      :description="t('digitalEmployee.service.connectionDescription')"
    >
      <template #actions>
        <Switch
          data-testid="digital-employee-staffdeck-switch"
          :aria-label="t('digitalEmployee.service.enabled')"
          :model-value="form.enabled"
          :disabled="!settingsReady || saving"
          @update:model-value="(value: boolean) => (form.enabled = value)"
        />
      </template>

      <div class="space-y-4">
        <p class="text-sm text-muted-foreground" data-testid="digital-employee-mode">
          {{
            form.enabled
              ? t('digitalEmployee.service.modeRemote')
              : t('digitalEmployee.service.modeMock')
          }}
        </p>

        <Alert v-if="loadFailed" variant="destructive" data-testid="digital-employee-load-failed">
          <Icon icon="lucide:circle-alert" class="size-4" />
          <AlertTitle>{{ t('common.error.operationFailed') }}</AlertTitle>
          <AlertDescription>{{ t('digitalEmployee.service.loadFailed') }}</AlertDescription>
        </Alert>

        <div class="space-y-2">
          <Label for="staffdeck-base-url">{{ t('digitalEmployee.service.baseUrl') }}</Label>
          <Input
            id="staffdeck-base-url"
            v-model="form.baseUrl"
            data-testid="digital-employee-base-url-input"
            type="url"
            placeholder="https://staffdeck.example.com"
            :disabled="saving"
            :aria-invalid="baseUrlInvalid"
          />
          <DcInlineError
            v-if="baseUrlInvalid"
            :error="t('digitalEmployee.service.invalidBaseUrl')"
            data-testid="digital-employee-base-url-error"
          />
        </div>

        <div class="space-y-2">
          <Label for="staffdeck-api-key">{{ t('digitalEmployee.service.apiKey') }}</Label>
          <div class="relative">
            <Input
              id="staffdeck-api-key"
              v-model="form.apiKey"
              data-testid="digital-employee-api-key-input"
              :type="showApiKey ? 'text' : 'password'"
              :placeholder="
                state?.apiKeyConfigured
                  ? t('digitalEmployee.service.apiKeyKeepPlaceholder')
                  : t('digitalEmployee.service.apiKeyPlaceholder')
              "
              :disabled="saving"
              autocomplete="off"
              style="padding-right: 2.5rem !important"
            />
            <DcButton
              variant="ghost"
              size="icon-sm"
              data-testid="digital-employee-toggle-api-key"
              :icon="showApiKey ? 'lucide:eye-off' : 'lucide:eye'"
              :label="t('digitalEmployee.service.toggleApiKeyVisibility')"
              :tooltip="t('digitalEmployee.service.toggleApiKeyVisibility')"
              class="absolute right-2 top-1/2 h-7 w-7 -translate-y-1/2 transform p-0 hover:bg-transparent"
              @click="showApiKey = !showApiKey"
            />
          </div>
          <p class="text-xs text-muted-foreground" data-testid="digital-employee-api-key-state">
            {{
              state?.apiKeyConfigured
                ? t('digitalEmployee.service.apiKeyConfigured')
                : t('digitalEmployee.service.apiKeyNotConfigured')
            }}
          </p>
        </div>

        <div class="space-y-2">
          <Label for="staffdeck-external-user-id">
            {{ t('digitalEmployee.service.externalUserId') }}
          </Label>
          <Input
            id="staffdeck-external-user-id"
            v-model="form.externalUserId"
            data-testid="digital-employee-external-user-id-input"
            :disabled="saving"
          />
          <p class="text-xs text-muted-foreground">
            {{ t('digitalEmployee.service.externalUserIdHint') }}
          </p>
        </div>

        <div class="space-y-2 rounded-lg border border-border/60 p-3">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 space-y-1">
              <Label for="staffdeck-backflow" class="text-sm">
                {{ t('digitalEmployee.service.backflowLabel') }}
              </Label>
              <p class="text-xs text-muted-foreground">
                {{ t('digitalEmployee.service.backflowEnabledHint') }}
              </p>
            </div>
            <Switch
              id="staffdeck-backflow"
              data-testid="digital-employee-backflow-switch"
              :aria-label="t('digitalEmployee.service.backflowLabel')"
              :model-value="form.backflowEnabled"
              :disabled="!settingsReady || saving"
              @update:model-value="(value: boolean) => (form.backflowEnabled = value)"
            />
          </div>
          <!-- 关闭状态必须显式说出来：默认开启，用户不会主动去确认它开着，
               但关掉之后的后果（审计里没有这些会话）只能在这里讲清。 -->
          <p
            v-if="!form.backflowEnabled"
            data-testid="digital-employee-backflow-disabled-warning"
            class="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400"
          >
            <Icon icon="lucide:triangle-alert" class="mt-0.5 size-3.5 shrink-0" />
            <span>{{ t('digitalEmployee.service.backflowDisabledWarning') }}</span>
          </p>
          <p v-else class="text-xs text-muted-foreground">
            {{ t('digitalEmployee.service.backflowSaveHint') }}
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <DcButton
            variant="outline"
            size="sm"
            data-testid="digital-employee-test-connection"
            :disabled="testing || saving"
            @click="testConnection"
          >
            <Spinner v-if="testing" class="mr-2 size-4" />
            {{ t('digitalEmployee.service.testConnection') }}
          </DcButton>

          <DcButton
            variant="default"
            size="sm"
            data-testid="digital-employee-save"
            :disabled="saving || baseUrlInvalid"
            @click="save"
          >
            <Spinner v-if="saving" class="mr-2 size-4" />
            {{ t('digitalEmployee.service.save') }}
          </DcButton>

          <DcButton
            variant="outline"
            size="sm"
            data-testid="digital-employee-clear-api-key"
            :disabled="!state?.apiKeyConfigured || saving"
            @click="clearConfirmOpen = true"
          >
            {{ t('digitalEmployee.service.clearApiKey') }}
          </DcButton>
        </div>

        <Alert v-if="testResult" :variant="testResult.ok ? 'default' : 'destructive'">
          <Icon
            :icon="testResult.ok ? 'lucide:circle-check' : 'lucide:circle-alert'"
            class="size-4"
          />
          <AlertDescription data-testid="digital-employee-test-result">
            {{ t(`digitalEmployee.service.testResults.${testResult.messageCode}`) }}
          </AlertDescription>
        </Alert>

        <Alert v-if="saveError" variant="destructive">
          <Icon icon="lucide:circle-alert" class="size-4" />
          <AlertDescription data-testid="digital-employee-save-error">
            {{ t('digitalEmployee.service.saveFailed') }}
          </AlertDescription>
        </Alert>

        <Alert v-if="saved" data-testid="digital-employee-saved">
          <Icon icon="lucide:circle-check" class="size-4" />
          <AlertDescription>{{ t('digitalEmployee.service.saved') }}</AlertDescription>
        </Alert>
      </div>
    </SettingsSectionCard>

    <DcConfirmDialog
      :open="clearConfirmOpen"
      :title="t('digitalEmployee.service.clearApiKey')"
      :description="t('digitalEmployee.service.clearApiKeyConfirm')"
      :confirm-label="t('digitalEmployee.service.clearApiKey')"
      data-testid="digital-employee-clear-api-key-dialog"
      @update:open="clearConfirmOpen = $event"
      @confirm="clearApiKey"
    />
  </SettingsPageShell>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import type { DigitalEmployeeSettingsState, DigitalEmployeeTestMessageCode } from '@shared/contracts/routes'
import { createDigitalEmployeeSettingsClient } from '@api/DigitalEmployeeSettingsClient'
import { Alert, AlertDescription, AlertTitle } from '@shadcn/components/ui/alert'
import { Input } from '@shadcn/components/ui/input'
import { Label } from '@shadcn/components/ui/label'
import { Spinner } from '@shadcn/components/ui/spinner'
import { Switch } from '@shadcn/components/ui/switch'
import { DcButton } from '@dc-ui/components/button'
import { DcConfirmDialog } from '@dc-ui/components/confirm-dialog'
import { DcInlineError } from '@dc-ui/components/inline-error'
import SettingsPageShell from './control-center/SettingsPageShell.vue'
import SettingsSectionCard from './control-center/SettingsSectionCard.vue'

const { t } = useI18n()
const client = createDigitalEmployeeSettingsClient()

const state = ref<DigitalEmployeeSettingsState | null>(null)
const settingsReady = ref(false)
const loadFailed = ref(false)
const saving = ref(false)
const testing = ref(false)
const saved = ref(false)
const saveError = ref(false)
const showApiKey = ref(false)
const clearConfirmOpen = ref(false)
const testResult = ref<{ ok: boolean; messageCode: DigitalEmployeeTestMessageCode } | null>(null)

// apiKey 初始恒为空：renderer 从不读取已保存的明文密钥。
const form = reactive({
  enabled: false,
  baseUrl: '',
  externalUserId: '',
  apiKey: '',
  // 与 main 侧 `!== false` 一致：未设置过就是开启。
  backflowEnabled: true
})

const baseUrlInvalid = computed(() => {
  const value = form.baseUrl.trim()
  if (!value) return false
  try {
    const url = new URL(value)
    return !['http:', 'https:'].includes(url.protocol) || Boolean(url.username || url.password)
  } catch {
    return true
  }
})

const applyState = (next: DigitalEmployeeSettingsState): void => {
  state.value = next
  form.enabled = next.enabled
  form.baseUrl = next.baseUrl
  form.externalUserId = next.externalUserId
  form.backflowEnabled = next.backflowEnabled
  // 保存/清除后输入框总是回到空值，避免明文密钥停留或被当成本地副本。
  form.apiKey = ''
}

const loadSettings = async (): Promise<void> => {
  loadFailed.value = false
  try {
    applyState(await client.get())
    settingsReady.value = true
  } catch {
    loadFailed.value = true
  }
}

const testConnection = async (): Promise<void> => {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await client.testConnection({
      ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
      ...(form.externalUserId.trim() ? { externalUserId: form.externalUserId.trim() } : {}),
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {})
    })
  } catch {
    testResult.value = { ok: false, messageCode: 'networkError' }
  } finally {
    testing.value = false
  }
}

const save = async (): Promise<void> => {
  // 前端先拦一次，避免把明显非法的 URL 发到 main；main 仍会二次校验。
  if (baseUrlInvalid.value) return
  saving.value = true
  saveError.value = false
  saved.value = false
  try {
    applyState(
      await client.save({
        enabled: form.enabled,
        baseUrl: form.baseUrl.trim(),
        externalUserId: form.externalUserId.trim(),
        backflowEnabled: form.backflowEnabled,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {})
      })
    )
    saved.value = true
  } catch {
    saveError.value = true
  } finally {
    saving.value = false
  }
}

const clearApiKey = async (): Promise<void> => {
  clearConfirmOpen.value = false
  try {
    await client.clearApiKey()
    if (state.value) state.value = { ...state.value, apiKeyConfigured: false }
    form.apiKey = ''
  } catch {
    saveError.value = true
  }
}

onMounted(() => {
  void loadSettings()
})
</script>
