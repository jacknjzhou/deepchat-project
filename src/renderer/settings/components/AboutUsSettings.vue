<template>
  <SettingsPageShell
    :title="t('routes.settings-about')"
    :eyebrow="t('settings.controlCenter.groups.system')"
    data-testid="settings-about-page"
  >
    <div class="flex min-h-[520px] w-full flex-col items-center justify-center gap-2">
      <img src="@/assets/logo.png" class="h-10 w-10" :alt="t('about.title')" />
      <div class="flex flex-col items-center gap-2" :dir="languageStore.dir">
        <h1 class="text-2xl font-bold">{{ t('about.title') }}</h1>
        <p class="pb-4 text-xs text-muted-foreground">v{{ appVersion }}</p>
        <p class="px-8 text-sm text-muted-foreground">
          {{ t('about.description') }}
        </p>
        <div class="flex gap-2">
          <a
            class="flex items-center text-xs text-muted-foreground hover:text-primary"
            href="https://deepchat.thinkinai.xyz/"
            target="_blank"
            rel="noopener noreferrer"
            @click.prevent="openExternalLink('https://deepchat.thinkinai.xyz/')"
          >
            <Icon icon="lucide:globe" class="mr-1 h-3 w-3" />
            {{ t('about.website') }}</a
          >
          <a
            class="flex items-center text-xs text-muted-foreground hover:text-primary"
            href="https://github.com/ThinkInAIXYZ/deepchat"
            target="_blank"
            rel="noopener noreferrer"
            @click.prevent="openExternalLink('https://github.com/ThinkInAIXYZ/deepchat')"
          >
            <Icon icon="lucide:github" class="mr-1 h-3 w-3" />
            GitHub
          </a>
          <a
            class="flex items-center text-xs text-muted-foreground hover:text-primary"
            href="https://github.com/ThinkInAIXYZ/deepchat/blob/dev/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
            @click.prevent="
              openExternalLink('https://github.com/ThinkInAIXYZ/deepchat/blob/dev/LICENSE')
            "
          >
            <Icon icon="lucide:scale" class="mr-1 h-3 w-3" />
            Apache License 2.0
          </a>
        </div>
      </div>

      <div class="mt-4 flex items-center gap-4">
        <label class="text-sm font-medium">{{ t('about.updateChannel') }}:</label>
        <div class="min-w-32 max-w-48">
          <Select
            :model-value="updateChannel"
            :disabled="!updateChannelReady || updateChannelSaving"
            @update:model-value="setUpdateChannel"
          >
            <SelectTrigger>
              <SelectValue :placeholder="t('about.updateChannel')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stable">
                {{ t('about.stableChannel') }}
              </SelectItem>
              <SelectItem value="beta">
                {{ t('about.betaChannel') }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div
        v-if="winAccount"
        data-testid="system-info-card"
        class="mt-2 w-full max-w-xl rounded-xl border border-border/80 bg-card/70 p-4 shadow-sm"
      >
        <div class="text-sm font-medium">{{ t('about.systemInfo.title') }}</div>
        <div class="mt-3 flex flex-col gap-1.5 text-sm">
          <div
            v-for="row in systemInfoRows"
            :key="row.key"
            class="flex items-center justify-between gap-2"
          >
            <span class="shrink-0 text-muted-foreground">{{ row.label }}</span>
            <span class="flex min-w-0 items-center gap-1">
              <span class="truncate font-mono text-xs" :title="row.value">{{ row.value }}</span>
              <button
                class="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                :aria-label="row.label"
                @click="copySystemInfo(row.key, row.copyValue)"
              >
                <Icon
                  :icon="copiedKey === row.key ? 'lucide:check' : 'lucide:copy'"
                  class="h-3 w-3"
                />
              </button>
            </span>
          </div>
        </div>
      </div>

      <div
        data-testid="managed-config-card"
        class="mt-2 w-full max-w-xl rounded-xl border border-border/80 bg-card/70 p-4 shadow-sm"
      >
        <div class="text-sm font-medium">{{ t('about.managedConfig.title') }}</div>
        <div class="mt-3 flex flex-col gap-1.5 text-sm">
          <div class="flex items-center justify-between gap-2">
            <span class="shrink-0 text-muted-foreground">{{
              t('about.managedConfig.endpoint')
            }}</span>
            <span class="flex min-w-0 items-center gap-1">
              <span
                class="truncate font-mono text-xs"
                :title="managedEndpoint || t('about.managedConfig.notConfigured')"
              >
                {{ managedEndpoint || t('about.managedConfig.notConfigured') }}
              </span>
              <button
                v-if="managedEndpoint"
                class="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                :aria-label="t('about.managedConfig.endpoint')"
                data-testid="managed-config-copy"
                @click="copyManagedEndpoint"
              >
                <Icon
                  :icon="managedEndpointCopied ? 'lucide:check' : 'lucide:copy'"
                  class="h-3 w-3"
                />
              </button>
            </span>
          </div>
          <div v-if="managedEndpoint" class="flex items-center justify-between gap-2">
            <span class="shrink-0 text-muted-foreground">
              {{ t('about.managedConfig.sourceLabel') }}
            </span>
            <span class="text-xs">{{ managedEndpointSourceLabel }}</span>
          </div>
        </div>
      </div>

      <div
        v-if="upgrade.shouldShowUpdateNotes"
        class="mt-2 w-full max-w-xl rounded-xl border border-border/80 bg-card/70 p-4 shadow-sm"
      >
        <div class="text-sm font-medium">
          {{ t('update.versionAvailable', { version: formattedUpdateVersion }) }}
        </div>
        <div
          v-if="upgrade.updateInfo?.releaseNotes"
          class="mt-3 max-h-40 overflow-y-auto pr-2 text-sm text-muted-foreground"
        >
          <NodeRenderer
            :isDark="themeStore.isDark"
            :content="upgrade.updateInfo.releaseNotes"
            :typewriter="false"
            :final="true"
            :codeBlockStream="false"
          ></NodeRenderer>
        </div>
      </div>

      <div
        v-if="upgrade.showManualDownloadOptions"
        class="mt-2 flex w-full max-w-xl flex-col items-center gap-1"
      >
        <p class="text-center text-xs text-muted-foreground">
          {{ t('update.autoUpdateFailed') }}
        </p>
      </div>

      <div class="mt-2 flex flex-wrap justify-center gap-2">
        <DcButton
          variant="outline"
          size="sm"
          class="mb-2 text-xs"
          @click="openExternalLink('https://github.com/ThinkInAIXYZ/deepchat/discussions/1226')"
        >
          <Icon icon="lucide:message-square" class="mr-1 h-3 w-3" />
          {{ t('about.feedbackButton') }}
        </DcButton>

        <DcButton variant="outline" size="sm" class="mb-2 text-xs" @click="openDisclaimerDialog">
          <Icon icon="lucide:info" class="mr-1 h-3 w-3" />
          {{ t('about.disclaimerButton') }}
        </DcButton>

        <DcButton
          v-if="upgrade.showManualDownloadOptions"
          variant="outline"
          size="sm"
          class="mb-2 text-xs"
          @click="handleManualDownload('github')"
        >
          {{ t('update.githubDownload') }}
        </DcButton>

        <DcButton
          v-if="upgrade.showManualDownloadOptions"
          variant="outline"
          size="sm"
          class="mb-2 text-xs"
          @click="handleManualDownload('official')"
        >
          {{ t('update.officialDownload') }}
        </DcButton>

        <DcButton
          v-if="!upgrade.showManualDownloadOptions"
          variant="outline"
          size="sm"
          class="mb-2 text-xs"
          :disabled="
            upgrade.isChecking ||
            upgrade.isDownloading ||
            upgrade.isRestarting ||
            updateCheckPending
          "
          @click="handlePrimaryAction"
        >
          <Spinner
            v-if="upgrade.isChecking || upgrade.isDownloading"
            class="mr-1 size-3"
            data-icon="inline-start"
          />
          <Icon v-else icon="lucide:refresh-cw" class="mr-1 size-3" data-icon="inline-start" />
          <span v-if="upgrade.isDownloading">
            <template v-if="upgrade.updateProgress">
              {{ t('update.downloading') }}: {{ Math.round(upgrade.updateProgress.percent) }}%
            </template>
            <template v-else>{{ t('update.downloading') }}</template>
          </span>
          <span v-else-if="upgrade.isReadyToInstall">
            {{ upgrade.isRestarting ? t('update.restarting') : t('update.installNow') }}
          </span>
          <span v-else-if="upgrade.updateState === 'available'">
            {{ t('update.installUpdate') }}
          </span>
          <span v-else-if="upgrade.isChecking">
            {{ t('settings.about.checking') }}
          </span>
          <span v-else>
            {{ t('about.checkUpdateButton') }}
          </span>
        </DcButton>
      </div>
    </div>

    <UpdateTaskCheckDialog
      :open="upgrade.showTaskRunningDialog ?? false"
      @cancel="upgrade.cancelUpdate()"
      @update-now="upgrade.confirmUpdateNow()"
      @update-after-tasks="upgrade.scheduleUpdateAfterTasks()"
    />
  </SettingsPageShell>

  <Dialog :open="isDisclaimerOpen" @update:open="isDisclaimerOpen = $event">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ t('about.disclaimerTitle') }}</DialogTitle>
        <DialogDescription>
          <NodeRenderer
            class="max-h-[300px] overflow-y-auto"
            :isDark="themeStore.isDark"
            :content="t('searchDisclaimer')"
            :typewriter="false"
            :final="true"
            :codeBlockStream="false"
          ></NodeRenderer>
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DcButton @click="isDisclaimerOpen = false">{{ t('common.close') }}</DcButton>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { createBrowserClient } from '@api/BrowserClient'
import { createConfigClient } from '@api/ConfigClient'
import { createDeviceClient } from '@api/DeviceClient'
import { createWindowClient } from '@api/WindowClient'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { DcButton } from '@dc-ui/components/button'
import { Icon } from '@iconify/vue'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shadcn/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shadcn/components/ui/select'
import { Spinner } from '@shadcn/components/ui/spinner'
import NodeRenderer from 'markstream-vue'
import { useUpgradeStore } from '@/stores/upgrade'
import { useLanguageStore } from '@/stores/language'
import type { AcceptableValue } from 'reka-ui'
import type { WindowsAccountInfo } from '@shared/types/device'
import { useThemeStore } from '@/stores/theme'
import { useRoute } from 'vue-router'
import SettingsPageShell from './control-center/SettingsPageShell.vue'
import { notifyRenderer } from '@renderer-notifications/rendererNotificationPort'
import UpdateTaskCheckDialog from '@/components/ui/UpdateTaskCheckDialog.vue'

const { t } = useI18n()
const themeStore = useThemeStore()
const languageStore = useLanguageStore()
const route = useRoute()
const browserClient = createBrowserClient()
const configClient = createConfigClient()
const deviceClient = createDeviceClient()
const windowClient = createWindowClient()
const appVersion = ref('')
const upgrade = useUpgradeStore()
const updateChannel = ref('stable')
const updateChannelReady = ref(false)
const isDisclaimerOpen = ref(false)
let cleanupCheckForUpdates: (() => void) | null = null
const updateChannelSaving = ref(false)
const updateCheckPending = ref(false)
const winAccount = ref<WindowsAccountInfo | null>(null)
const copiedKey = ref<string | null>(null)
let copiedResetTimer: ReturnType<typeof setTimeout> | null = null

const systemInfoRows = computed(() => {
  if (!winAccount.value) return []
  const account = winAccount.value
  const entries: Array<{ key: string; value: string | null }> = [
    { key: 'username', value: account.username },
    { key: 'domain', value: account.domain },
    { key: 'hostname', value: account.hostname },
    { key: 'homeDir', value: account.homeDir },
    { key: 'sid', value: account.sid }
  ]
  return entries.map(({ key, value }) => ({
    key,
    label: t(`about.systemInfo.${key}`),
    value: value ?? '—',
    copyValue: value
  }))
})

const copySystemInfo = (key: string, copyValue: string | null) => {
  if (!copyValue) return
  void navigator.clipboard.writeText(copyValue).catch(() => {
    deviceClient.copyText(copyValue)
  })
  copiedKey.value = key
  if (copiedResetTimer) {
    clearTimeout(copiedResetTimer)
  }
  copiedResetTimer = setTimeout(() => {
    copiedKey.value = null
  }, 1500)
}

const managedEndpoint = ref('')
const managedEndpointSource = ref<'env' | 'builtin' | 'none'>('none')
const managedEndpointCopied = ref(false)
let managedEndpointCopiedResetTimer: ReturnType<typeof setTimeout> | null = null
const managedEndpointSourceLabel = computed(() =>
  managedEndpointSource.value === 'env'
    ? t('about.managedConfig.sourceEnv')
    : t('about.managedConfig.sourceBuiltin')
)

const copyManagedEndpoint = () => {
  if (!managedEndpoint.value) return
  void navigator.clipboard.writeText(managedEndpoint.value).catch(() => {
    deviceClient.copyText(managedEndpoint.value)
  })
  managedEndpointCopied.value = true
  if (managedEndpointCopiedResetTimer) {
    clearTimeout(managedEndpointCopiedResetTimer)
  }
  managedEndpointCopiedResetTimer = setTimeout(() => {
    managedEndpointCopied.value = false
  }, 1500)
}

const formattedUpdateVersion = computed(() => {
  const version = upgrade.updateInfo?.version ?? ''
  if (!version) return ''
  return version.startsWith('v') ? version : `v${version}`
})

const openDisclaimerDialog = () => {
  isDisclaimerOpen.value = true
}

const setUpdateChannel = async (channel: AcceptableValue) => {
  if (
    (channel !== 'stable' && channel !== 'beta') ||
    updateChannelSaving.value ||
    channel === updateChannel.value
  ) {
    return
  }

  updateChannelSaving.value = true
  try {
    updateChannel.value = await configClient.setUpdateChannel(channel)
    notifyRenderer({
      kind: 'success',
      code: 'settings.about.updateChannelSaved',
      title: t('common.saved')
    })
  } catch (error) {
    console.error('[AboutUsSettings] Failed to update channel', error)
    notifyRenderer({
      kind: 'error',
      code: 'settings.about.updateChannelSaveFailed',
      title: t('common.error.operationFailed')
    })
  } finally {
    updateChannelSaving.value = false
  }
}

const loadUpdateChannel = async () => {
  if (updateChannelSaving.value) return

  updateChannelSaving.value = true
  try {
    updateChannel.value = await configClient.getUpdateChannel()
    updateChannelReady.value = true
  } catch (error) {
    updateChannelReady.value = false
    console.error('[AboutUsSettings] Failed to load update channel', error)
    notifyRenderer({
      kind: 'error',
      code: 'settings.about.updateChannelLoadFailed',
      title: t('common.error.operationFailed')
    })
  } finally {
    updateChannelSaving.value = false
  }
}

const handlePrimaryAction = async () => {
  if (
    upgrade.isChecking ||
    upgrade.isDownloading ||
    upgrade.isRestarting ||
    updateCheckPending.value
  ) {
    return
  }

  if (upgrade.updateState === 'available' || upgrade.isReadyToInstall) {
    upgrade.checkRunningTasksAndUpdate(() => {
      void upgrade.handleUpdate('auto')
    })
    return
  }

  updateCheckPending.value = true
  try {
    const status = await upgrade.checkUpdate(false)
    if (status === 'not-available') {
      notifyRenderer({
        kind: 'success',
        code: 'settings.about.alreadyUpToDate',
        title: t('update.alreadyUpToDate'),
        description: t('update.alreadyUpToDateDesc')
      })
    } else if (status === 'error') {
      notifyRenderer({
        kind: 'error',
        code: 'settings.about.updateCheckFailed',
        title: t('common.error.operationFailed')
      })
    }
  } catch (error) {
    console.error('[AboutUsSettings] Failed to check for updates', error)
    notifyRenderer({
      kind: 'error',
      code: 'settings.about.updateCheckFailed',
      title: t('common.error.operationFailed')
    })
  } finally {
    updateCheckPending.value = false
  }
}

const handleManualDownload = async (type: 'github' | 'official') => {
  await upgrade.handleUpdate(type)
}

const handleExternalCheckUpdate = async () => {
  if (upgrade.isChecking || upgrade.isDownloading || upgrade.isRestarting) {
    return
  }

  if (upgrade.updateState === 'available' || upgrade.isReadyToInstall) {
    return
  }

  await handlePrimaryAction()
}

const syncUpdateStatus = async () => {
  try {
    await upgrade.refreshStatus()
  } catch (error) {
    console.error('[AboutUsSettings] Failed to synchronize update status', error)
  }
}

const openExternalLink = (url: string) => {
  void browserClient.openExternal(url).catch(() => {
    window.open(url, '_blank', 'noopener,noreferrer')
  })
}

const loadAppVersion = async () => {
  try {
    appVersion.value = await deviceClient.getAppVersion()
  } catch (error) {
    console.error('[AboutUsSettings] Failed to load app version', error)
  }
}

const loadWinAccount = async () => {
  try {
    const info = await deviceClient.getDeviceInfo()
    winAccount.value = info.winAccount
  } catch (error) {
    console.error('[AboutUsSettings] Failed to load device info', error)
  }
}

onMounted(() => {
  cleanupCheckForUpdates = windowClient.onSettingsCheckForUpdates(() => {
    void handleExternalCheckUpdate()
  })
  void loadAppVersion()
  void loadUpdateChannel()
  void syncUpdateStatus()
  void loadWinAccount()
  deviceClient
    .getManagedConfigEndpoint()
    .then((info) => {
      managedEndpoint.value = info.endpoint
      managedEndpointSource.value = info.source
    })
    .catch((error) => {
      console.error('[AboutUsSettings] Failed to load managed config endpoint', error)
    })
})

watch(
  () => route.name,
  async (routeName) => {
    if (routeName === 'settings-about') {
      await syncUpdateStatus()
    }
  }
)

onBeforeUnmount(() => {
  cleanupCheckForUpdates?.()
  cleanupCheckForUpdates = null
  if (copiedResetTimer) {
    clearTimeout(copiedResetTimer)
    copiedResetTimer = null
  }
  if (managedEndpointCopiedResetTimer) {
    clearTimeout(managedEndpointCopiedResetTimer)
    managedEndpointCopiedResetTimer = null
  }
})
</script>
