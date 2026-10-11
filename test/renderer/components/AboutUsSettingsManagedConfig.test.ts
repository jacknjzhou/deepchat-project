import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

vi.mock('@renderer-notifications/rendererNotificationPort', () => ({
  notifyRenderer: vi.fn()
}))

const buttonStub = defineComponent({
  name: 'Button',
  emits: ['click'],
  template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>'
})

const passthroughStub = (name: string) =>
  defineComponent({
    name,
    template: '<div><slot /></div>'
  })

const selectStub = defineComponent({
  name: 'Select',
  props: {
    modelValue: { type: String, default: '' },
    disabled: { type: Boolean, default: false }
  },
  emits: ['update:modelValue'],
  template: '<div><slot /></div>'
})

const route = {
  name: 'settings-about'
}

const configClientMock = vi.hoisted(() => ({
  getUpdateChannel: vi.fn(),
  setUpdateChannel: vi.fn()
}))
const deviceClientMock = vi.hoisted(() => ({
  getAppVersion: vi.fn(),
  getManagedConfigEndpoint: vi.fn(),
  getDeviceInfo: vi.fn(),
  copyText: vi.fn()
}))
const browserClientMock = vi.hoisted(() => ({
  openExternal: vi.fn()
}))
const windowClientMock = vi.hoisted(() => ({
  startGuidedOnboarding: vi.fn(),
  onSettingsCheckForUpdates: vi.fn().mockImplementation((listener: () => void) => {
    const wrapped = () => listener()
    window.electron?.ipcRenderer?.on('settings:check-for-updates', wrapped)
    return () => window.electron?.ipcRenderer?.removeListener('settings:check-for-updates', wrapped)
  })
}))

const upgradeStoreMock = {
  shouldShowUpdateNotes: false,
  updateInfo: null,
  showManualDownloadOptions: false,
  updateError: null,
  isChecking: false,
  isDownloading: false,
  isRestarting: false,
  updateProgress: null,
  isReadyToInstall: false,
  isMockUpdate: false,
  updateState: 'idle',
  refreshStatus: vi.fn().mockResolvedValue('idle'),
  checkUpdate: vi.fn().mockResolvedValue('error'),
  handleUpdate: vi.fn().mockResolvedValue(undefined)
}

vi.mock('@api/ConfigClient', () => ({
  createConfigClient: () => configClientMock
}))
vi.mock('@api/DeviceClient', () => ({
  createDeviceClient: () => deviceClientMock
}))
vi.mock('@api/BrowserClient', () => ({
  createBrowserClient: () => browserClientMock
}))
vi.mock('@api/WindowClient', () => ({
  createWindowClient: () => windowClientMock
}))

vi.mock('@/stores/upgrade', () => ({
  useUpgradeStore: () => upgradeStoreMock
}))

vi.mock('@/stores/language', () => ({
  useLanguageStore: () => ({
    dir: 'ltr'
  })
}))

vi.mock('@/stores/theme', () => ({
  useThemeStore: () => ({
    isDark: true
  })
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: { version?: string; title?: string; count?: number }) => {
      const messages: Record<string, string> = {
        'about.title': 'SRIBD Office Agent',
        'about.description': 'SRIBD Office Agent description',
        'about.website': 'Visit Our Website',
        'about.updateChannel': 'Update Channel',
        'about.stableChannel': 'Stable',
        'about.betaChannel': 'Beta',
        'about.feedbackButton': 'Feedback',
        'about.disclaimerButton': 'Disclaimer',
        'about.disclaimerTitle': 'Terms of Use Statement',
        'about.checkUpdateButton': 'Check for Updates',
        'about.managedConfig.title': 'Managed Configuration',
        'about.managedConfig.endpoint': 'Config Service URL',
        'about.managedConfig.sourceLabel': 'Source',
        'about.managedConfig.sourceEnv': 'Environment variable',
        'about.managedConfig.sourceBuiltin': 'Built-in',
        'about.managedConfig.notConfigured': 'Not configured',
        'update.versionAvailable': `${params?.version ?? ''} available`,
        'update.autoUpdateFailed': 'Auto update may be unstable, please download manually',
        'update.githubDownload': 'GitHub Download',
        'update.officialDownload': 'Official Download',
        'update.installNow': 'Install Now',
        'update.installUpdate': 'Install Update',
        'update.downloading': 'Downloading',
        'settings.about.checking': 'Checking',
        'common.close': 'Close',
        searchDisclaimer: 'disclaimer'
      }

      return messages[key] ?? key
    }
  })
}))

vi.mock('vue-router', () => ({
  useRoute: () => route
}))

const mountPage = async () => {
  const { default: AboutUsSettings } =
    await import('../../../src/renderer/settings/components/AboutUsSettings.vue')

  return mount(AboutUsSettings, {
    global: {
      stubs: {
        DcButton: buttonStub,
        Icon: true,
        Dialog: passthroughStub('Dialog'),
        DialogContent: passthroughStub('DialogContent'),
        DialogDescription: passthroughStub('DialogDescription'),
        DialogFooter: passthroughStub('DialogFooter'),
        DialogHeader: passthroughStub('DialogHeader'),
        DialogTitle: passthroughStub('DialogTitle'),
        Select: selectStub,
        SelectContent: passthroughStub('SelectContent'),
        SelectItem: passthroughStub('SelectItem'),
        SelectTrigger: passthroughStub('SelectTrigger'),
        SelectValue: passthroughStub('SelectValue'),
        NodeRenderer: passthroughStub('NodeRenderer')
      }
    }
  })
}

describe('AboutUsSettings (managed config)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configClientMock.getUpdateChannel.mockReset()
    configClientMock.setUpdateChannel.mockReset()
    deviceClientMock.getAppVersion.mockReset()
    deviceClientMock.getManagedConfigEndpoint.mockReset()
    deviceClientMock.getDeviceInfo.mockReset()
    deviceClientMock.copyText.mockReset()
    browserClientMock.openExternal.mockReset()
    configClientMock.getUpdateChannel.mockResolvedValue('stable')
    configClientMock.setUpdateChannel.mockResolvedValue('stable')
    deviceClientMock.getAppVersion.mockResolvedValue('1.2.3')
    deviceClientMock.getManagedConfigEndpoint.mockResolvedValue({
      endpoint: '',
      source: 'none'
    })
    deviceClientMock.getDeviceInfo.mockResolvedValue({ winAccount: null })
    deviceClientMock.copyText.mockResolvedValue(undefined)
    browserClientMock.openExternal.mockResolvedValue(undefined)
    Object.assign(window, {
      electron: {
        ipcRenderer: {
          on: vi.fn(),
          removeListener: vi.fn()
        }
      }
    })
  })

  it('shows the managed endpoint with its env source label and copy button', async () => {
    deviceClientMock.getManagedConfigEndpoint.mockResolvedValue({
      endpoint: 'https://config.example.com/api',
      source: 'env'
    })

    const wrapper = await mountPage()
    await flushPromises()

    const card = wrapper.find('[data-testid="managed-config-card"]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('Managed Configuration')
    expect(card.text()).toContain('Config Service URL')
    expect(card.text()).toContain('https://config.example.com/api')
    expect(card.text()).toContain('Environment variable')
    expect(wrapper.find('[data-testid="managed-config-copy"]').exists()).toBe(true)

    wrapper.unmount()
  })

  it('shows the built-in source label for a build-time managed endpoint', async () => {
    deviceClientMock.getManagedConfigEndpoint.mockResolvedValue({
      endpoint: 'https://builtin.example.com/api',
      source: 'builtin'
    })

    const wrapper = await mountPage()
    await flushPromises()

    const card = wrapper.find('[data-testid="managed-config-card"]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('https://builtin.example.com/api')
    expect(card.text()).toContain('Built-in')
    expect(wrapper.find('[data-testid="managed-config-copy"]').exists()).toBe(true)

    wrapper.unmount()
  })

  it('shows the not-configured text without a copy button when no endpoint exists', async () => {
    const wrapper = await mountPage()
    await flushPromises()

    const card = wrapper.find('[data-testid="managed-config-card"]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('Not configured')
    expect(wrapper.find('[data-testid="managed-config-copy"]').exists()).toBe(false)

    wrapper.unmount()
  })
})
