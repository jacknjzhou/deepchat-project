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
    </div>

    <UpdateTaskCheckDialog
      :open="upgrade.showTaskRunningDialog ?? false"
      @cancel="upgrade.cancelUpdate()"
      @update-now="upgrade.confirmUpdateNow()"
      @update-after-tasks="upgrade.scheduleUpdateAfterTasks()"
    />
  </SettingsPageShell>
</template>

<script setup lang="ts">
import { createDeviceClient } from '@api/DeviceClient'
import { createWindowClient } from '@api/WindowClient'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import NodeRenderer from 'markstream-vue'
import { useUpgradeStore } from '@/stores/upgrade'
import { useLanguageStore } from '@/stores/language'
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
const deviceClient = createDeviceClient()
const windowClient = createWindowClient()
const appVersion = ref('')
const upgrade = useUpgradeStore()
let cleanupCheckForUpdates: (() => void) | null = null
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
