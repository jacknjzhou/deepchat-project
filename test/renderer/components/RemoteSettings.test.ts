import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('qrcode', () => ({
  toDataURL: vi.fn(
    async (value: string) => `data:image/png;base64,${Buffer.from(value).toString('base64')}`
  )
}))
import { defineComponent, h, inject, provide, reactive, ref, watch, type Ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

type ChannelBindingFixture = {
  endpointKey: string
  sessionId: string
  chatId: string
  threadId: string | null
  kind: 'dm' | 'group' | 'topic'
  updatedAt: number
}

type SetupOptions = {
  failInitialLoad?: boolean
  feishuChannelSettingsOverride?: Record<string, unknown>
  qqbotChannelSettingsOverride?: Record<string, unknown>
  weixinIlinkChannelSettingsOverride?: Record<string, unknown>
  feishuPairingSnapshot?: {
    pairCode: string | null
    pairCodeExpiresAt: number | null
    pairedUserOpenIds: string[]
  }
  feishuBindings?: ChannelBindingFixture[]
  agents?: Array<{
    id: string
    name: string
    type: 'deepchat' | 'acp'
    enabled: boolean
  }>
  recentProjects?: Array<{
    name: string
    path: string
    icon?: string | null
  }>
  selectedDirectory?: string | null
}

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

const setup = async (options: SetupOptions = {}) => {
  vi.resetModules()
  vi.useFakeTimers()

  const feishuState = reactive({
    settings: {
      brand: 'feishu' as const,
      appId: '',
      appSecret: '',
      verificationToken: '',
      encryptKey: '',
      remoteEnabled: false,
      enableStreamingCards: false,
      defaultAgentId: 'deepchat',
      defaultWorkdir: '',
      pairedUserOpenIds: [] as string[]
    },
    status: {
      channel: 'feishu' as const,
      enabled: false,
      state: 'disabled' as const,
      bindingCount: 0,
      pairedUserCount: 0,
      lastError: null,
      botUser: null
    },
    pairingSnapshot: {
      pairCode: null,
      pairCodeExpiresAt: null,
      pairedUserOpenIds: [] as string[],
      ...(options.feishuPairingSnapshot ?? {})
    },
    bindings: [...(options.feishuBindings ?? [])] as ChannelBindingFixture[]
  })

  const qqbotState = reactive({
    settings: {
      appId: '',
      clientSecret: '',
      remoteEnabled: false,
      defaultAgentId: 'deepchat',
      defaultWorkdir: '',
      pairedUserIds: [] as string[]
    },
    status: {
      channel: 'qqbot' as const,
      enabled: false,
      state: 'disabled' as const,
      bindingCount: 0,
      pairedUserCount: 0,
      lastError: null,
      botUser: null
    },
    pairingSnapshot: {
      pairCode: null,
      pairCodeExpiresAt: null,
      pairedUserIds: [] as string[]
    },
    bindings: [] as ChannelBindingFixture[]
  })

  const weixinIlinkState = reactive({
    settings: {
      remoteEnabled: false,
      defaultAgentId: 'deepchat',
      defaultWorkdir: '',
      accounts: [] as Array<{
        accountId: string
        ownerUserId: string
        baseUrl: string
        enabled: boolean
      }>
    },
    status: {
      channel: 'weixin-ilink' as const,
      enabled: false,
      state: 'disabled' as const,
      bindingCount: 0,
      accountCount: 0,
      connectedAccountCount: 0,
      lastError: null,
      accounts: [] as Array<{
        accountId: string
        ownerUserId: string
        baseUrl: string
        enabled: boolean
        state: 'disabled' | 'stopped' | 'starting' | 'running' | 'backoff' | 'error'
        connected: boolean
        bindingCount: number
        lastError: string | null
      }>
    }
  })

  const feishuSettingsSnapshot = () => ({
    ...feishuState.settings,
    ...(options.feishuChannelSettingsOverride ?? {})
  })

  const qqbotSettingsSnapshot = () => ({
    ...qqbotState.settings,
    ...(options.qqbotChannelSettingsOverride ?? {})
  })

  const weixinIlinkSettingsSnapshot = () => ({
    ...weixinIlinkState.settings,
    ...(options.weixinIlinkChannelSettingsOverride ?? {}),
    accounts: [
      ...((options.weixinIlinkChannelSettingsOverride?.accounts ??
        weixinIlinkState.settings.accounts) as typeof weixinIlinkState.settings.accounts)
    ]
  })

  const syncWeixinIlinkStatusFromSettings = () => {
    weixinIlinkState.status.enabled = weixinIlinkState.settings.remoteEnabled
    weixinIlinkState.status.accountCount = weixinIlinkState.settings.accounts.length
    weixinIlinkState.status.accounts = weixinIlinkState.settings.accounts.map((account) => ({
      ...account,
      state: weixinIlinkState.settings.remoteEnabled && account.enabled ? 'running' : 'disabled',
      connected: Boolean(weixinIlinkState.settings.remoteEnabled && account.enabled),
      bindingCount: 0,
      lastError: null
    }))
    weixinIlinkState.status.connectedAccountCount = weixinIlinkState.status.accounts.filter(
      (account) => account.connected
    ).length
    weixinIlinkState.status.bindingCount = weixinIlinkState.status.accounts.reduce(
      (total, account) => total + account.bindingCount,
      0
    )
    weixinIlinkState.status.state =
      weixinIlinkState.status.connectedAccountCount > 0
        ? 'running'
        : weixinIlinkState.status.enabled
          ? 'stopped'
          : 'disabled'
  }

  syncWeixinIlinkStatusFromSettings()

  const remoteControlPresenter = {
    listRemoteChannels: vi.fn(async () => [
      {
        id: 'feishu' as const,
        titleKey: 'settings.remote.feishu.title',
        descriptionKey: 'settings.remote.feishu.description',
        supportsCronDelivery: true
      },
      {
        id: 'qqbot' as const,
        titleKey: 'settings.remote.qqbot.title',
        descriptionKey: 'settings.remote.qqbot.description',
        supportsCronDelivery: false
      },
      {
        id: 'weixin-ilink' as const,
        titleKey: 'settings.remote.weixinIlink.title',
        descriptionKey: 'settings.remote.weixinIlink.description',
        supportsCronDelivery: true
      }
    ]),
    getChannelSettings: vi.fn(async (channel: 'feishu' | 'qqbot' | 'weixin-ilink') => {
      if (channel === 'feishu') {
        return feishuSettingsSnapshot()
      }

      if (channel === 'qqbot') {
        return qqbotSettingsSnapshot()
      }

      return weixinIlinkSettingsSnapshot()
    }),
    saveChannelSettings: vi.fn(
      async (channel: 'feishu' | 'qqbot' | 'weixin-ilink', nextSettings: any) => {
        const clonedSettings = structuredClone(nextSettings)

        if (channel === 'feishu') {
          feishuState.settings = { ...clonedSettings }
          feishuState.status.enabled = clonedSettings.remoteEnabled
          return { ...feishuState.settings }
        }

        if (channel === 'qqbot') {
          qqbotState.settings = { ...clonedSettings }
          qqbotState.status.enabled = clonedSettings.remoteEnabled
          return { ...qqbotState.settings }
        }

        weixinIlinkState.settings = {
          ...clonedSettings,
          accounts: [...clonedSettings.accounts]
        }
        syncWeixinIlinkStatusFromSettings()
        return {
          ...weixinIlinkState.settings,
          accounts: [...weixinIlinkState.settings.accounts]
        }
      }
    ),
    getChannelStatus: vi.fn(async (channel: 'feishu' | 'qqbot' | 'weixin-ilink') => {
      if (channel === 'feishu') {
        return {
          ...feishuState.status
        }
      }

      if (channel === 'qqbot') {
        return {
          ...qqbotState.status
        }
      }

      return {
        ...weixinIlinkState.status,
        accounts: [...weixinIlinkState.status.accounts]
      }
    }),
    getChannelPairingSnapshot: vi.fn(async (channel: 'feishu' | 'qqbot') => {
      if (channel === 'feishu') {
        return {
          ...feishuState.pairingSnapshot,
          pairedUserOpenIds: [...feishuState.pairingSnapshot.pairedUserOpenIds]
        }
      }

      return {
        ...qqbotState.pairingSnapshot,
        pairedUserIds: [...qqbotState.pairingSnapshot.pairedUserIds]
      }
    }),
    createChannelPairCode: vi.fn(async (channel: 'feishu' | 'qqbot') => {
      if (channel === 'feishu') {
        feishuState.pairingSnapshot.pairCode = '654321'
        feishuState.pairingSnapshot.pairCodeExpiresAt = 123456789
      } else {
        qqbotState.pairingSnapshot.pairCode = '654321'
        qqbotState.pairingSnapshot.pairCodeExpiresAt = 123456789
      }
      return {
        code: '654321',
        expiresAt: 123456789
      }
    }),
    clearChannelPairCode: vi.fn(async (channel: 'feishu' | 'qqbot') => {
      if (channel === 'feishu') {
        feishuState.pairingSnapshot.pairCode = null
        feishuState.pairingSnapshot.pairCodeExpiresAt = null
      } else {
        qqbotState.pairingSnapshot.pairCode = null
        qqbotState.pairingSnapshot.pairCodeExpiresAt = null
      }
    }),
    getChannelBindings: vi.fn(async (channel: 'feishu' | 'qqbot' | 'weixin-ilink') => {
      if (channel === 'feishu') {
        return feishuState.bindings.map((binding) => ({
          channel: 'feishu' as const,
          ...binding
        }))
      }

      if (channel === 'qqbot') {
        return qqbotState.bindings.map((binding) => ({
          channel: 'qqbot' as const,
          ...binding
        }))
      }

      return []
    }),
    removeChannelBinding: vi.fn(
      async (channel: 'feishu' | 'qqbot' | 'weixin-ilink', endpointKey: string) => {
        if (channel === 'feishu') {
          feishuState.bindings = feishuState.bindings.filter(
            (binding) => binding.endpointKey !== endpointKey
          )
          feishuState.status.bindingCount = feishuState.bindings.length
        } else if (channel === 'qqbot') {
          qqbotState.bindings = qqbotState.bindings.filter(
            (binding) => binding.endpointKey !== endpointKey
          )
          qqbotState.status.bindingCount = qqbotState.bindings.length
        }
      }
    ),
    removeChannelPrincipal: vi.fn(async (channel: 'feishu' | 'qqbot', principalId) => {
      if (channel === 'feishu') {
        feishuState.pairingSnapshot.pairedUserOpenIds =
          feishuState.pairingSnapshot.pairedUserOpenIds.filter((value) => value !== principalId)
        feishuState.status.pairedUserCount = feishuState.pairingSnapshot.pairedUserOpenIds.length
        return
      }

      qqbotState.pairingSnapshot.pairedUserIds = qqbotState.pairingSnapshot.pairedUserIds.filter(
        (value) => value !== principalId
      )
      qqbotState.status.pairedUserCount = qqbotState.pairingSnapshot.pairedUserIds.length
    }),
    startFeishuAuth: vi.fn(async () => ({
      sessionKey: 'feishu-session',
      authUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?state=mock',
      redirectUri: 'http://127.0.0.1:32178/remote/feishu/auth/callback',
      expiresAt: Date.now() + 300000,
      messageKey: 'settings.remote.feishu.authStarted'
    })),
    waitForFeishuAuth: vi.fn(async () => {
      feishuState.settings.pairedUserOpenIds = [
        ...new Set([...feishuState.settings.pairedUserOpenIds, 'ou_scan'])
      ]
      feishuState.pairingSnapshot.pairedUserOpenIds = [...feishuState.settings.pairedUserOpenIds]
      feishuState.status.pairedUserCount = feishuState.settings.pairedUserOpenIds.length
      return {
        authorized: true,
        openId: 'ou_scan',
        messageKey: 'settings.remote.feishu.authSuccess'
      }
    }),
    cancelFeishuAuth: vi.fn(async () => undefined),
    startFeishuInstall: vi.fn(async () => ({
      sessionKey: 'feishu-install-session',
      installUrl: 'https://open.feishu.cn/page/launcher?user_code=INSTALL',
      userCode: 'INSTALL',
      expiresAt: Date.now() + 300000,
      intervalMs: 3000,
      messageKey: 'settings.remote.feishu.installStarted'
    })),
    waitForFeishuInstall: vi.fn(async () => {
      feishuState.settings.appId = 'cli_personal'
      feishuState.settings.appSecret = 'secret_personal'
      feishuState.settings.pairedUserOpenIds = [
        ...new Set([...feishuState.settings.pairedUserOpenIds, 'ou_install'])
      ]
      feishuState.pairingSnapshot.pairedUserOpenIds = [...feishuState.settings.pairedUserOpenIds]
      feishuState.status.pairedUserCount = feishuState.settings.pairedUserOpenIds.length
      return {
        installed: true,
        brand: 'feishu',
        appId: 'cli_personal',
        openId: 'ou_install',
        messageKey: 'settings.remote.feishu.installSuccess'
      }
    }),
    cancelFeishuInstall: vi.fn(async () => undefined),
    startWeixinIlinkLogin: vi.fn(async () => ({
      sessionKey: 'weixin-session',
      loginUrl: 'https://ilinkai.weixin.qq.com/login/mock-session',
      messageKey: 'settings.remote.weixinIlink.loginWindowOpened'
    })),
    waitForWeixinIlinkLogin: vi.fn(async () => ({
      connected: true,
      account: {
        accountId: 'wx-account-1',
        ownerUserId: 'owner-1',
        baseUrl: 'https://ilinkai.weixin.qq.com',
        enabled: true
      },
      message: 'Connected'
    })),
    removeWeixinIlinkAccount: vi.fn(async (accountId: string) => {
      weixinIlinkState.settings.accounts = weixinIlinkState.settings.accounts.filter(
        (account) => account.accountId !== accountId
      )
      syncWeixinIlinkStatusFromSettings()
    }),
    restartWeixinIlinkAccount: vi.fn(async () => undefined)
  }
  if (options.failInitialLoad) {
    remoteControlPresenter.listRemoteChannels.mockRejectedValueOnce(
      new Error('remote settings secret diagnostics')
    )
  }

  const sessionClient = {
    getAgents: vi.fn(async () => [
      { id: 'deepchat', name: 'DeepChat', type: 'deepchat', enabled: true },
      { id: 'deepchat-alt', name: 'DeepChat Alt', type: 'deepchat', enabled: false },
      { id: 'acp-agent', name: 'ACP Agent', type: 'acp', enabled: true },
      ...(options.agents ?? [])
    ])
  }
  const projectPresenter = {
    getRecentProjects: vi.fn(async () => options.recentProjects ?? []),
    selectDirectory: vi.fn(async () => options.selectedDirectory ?? null)
  }

  const openExternal = vi.fn(async () => undefined)
  const tabsContextKey = Symbol('remote-settings-tabs')
  const tabsComponents = {
    Tabs: defineComponent({
      props: {
        modelValue: {
          type: String,
          default: ''
        }
      },
      emits: ['update:modelValue'],
      setup(props, { emit, slots }) {
        const currentValue = ref(String(props.modelValue ?? ''))
        watch(
          () => props.modelValue,
          (value) => {
            currentValue.value = String(value ?? '')
          }
        )

        provide(tabsContextKey, {
          currentValue,
          setValue: (value: string) => {
            currentValue.value = value
            emit('update:modelValue', value)
          }
        })

        return () => h('div', slots.default?.())
      }
    }),
    TabsList: defineComponent({
      setup(_props, { slots }) {
        return () => h('div', slots.default?.())
      }
    }),
    TabsTrigger: defineComponent({
      inheritAttrs: false,
      props: {
        value: {
          type: String,
          required: true
        }
      },
      setup(props, { attrs, slots }) {
        const tabs = inject<{
          currentValue: Ref<string>
          setValue: (value: string) => void
        }>(tabsContextKey)

        if (!tabs) {
          throw new Error('TabsTrigger must be used inside Tabs')
        }

        return () =>
          h(
            'button',
            {
              ...attrs,
              'data-state': tabs.currentValue.value === props.value ? 'active' : 'inactive',
              onClick: () => tabs.setValue(props.value)
            },
            slots.default?.()
          )
      }
    }),
    TabsContent: defineComponent({
      inheritAttrs: false,
      props: {
        value: {
          type: String,
          required: true
        }
      },
      setup(props, { attrs, slots }) {
        const tabs = inject<{
          currentValue: Ref<string>
          setValue: (value: string) => void
        }>(tabsContextKey)

        if (!tabs) {
          throw new Error('TabsContent must be used inside Tabs')
        }

        return () =>
          h(
            'div',
            {
              ...attrs,
              'data-state': tabs.currentValue.value === props.value ? 'active' : 'inactive',
              'data-tabs-content-value': props.value,
              style: tabs.currentValue.value === props.value ? undefined : { display: 'none' }
            },
            slots.default?.()
          )
      }
    })
  }

  vi.doMock('@api/RemoteControlClient', () => ({
    createRemoteControlClient: () => remoteControlPresenter
  }))
  const notifyRenderer = vi.fn(() => true)
  vi.doMock('@renderer-notifications/rendererNotificationPort', () => ({
    notifyRenderer
  }))
  vi.doMock('@api/SessionClient', () => ({
    createSessionClient: () => sessionClient
  }))
  vi.doMock('@api/ProjectClient', () => ({
    createProjectClient: () => ({
      listRecent: projectPresenter.getRecentProjects,
      selectDirectory: projectPresenter.selectDirectory
    })
  }))
  vi.doMock('@api/runtime', () => ({
    openRuntimeExternal: openExternal
  }))
  vi.doMock('vue-i18n', () => ({
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) => {
        if (!params) {
          return key
        }

        return Object.entries(params).reduce(
          (message, [paramKey, value]) => message.replace(`{${paramKey}}`, String(value)),
          key
        )
      }
    })
  }))
  vi.doMock('@shadcn/components/ui/tabs', () => tabsComponents)

  const passthrough = defineComponent({
    template: '<div><slot /></div>'
  })

  const dropdownMenuItemStub = defineComponent({
    emits: ['select'],
    template:
      '<button v-bind="$attrs" type="button" @click="$emit(\'select\', $event)"><slot /></button>'
  })

  const inputStub = defineComponent({
    props: {
      modelValue: {
        type: String,
        default: ''
      }
    },
    emits: ['update:modelValue', 'blur'],
    template:
      '<input v-bind="$attrs" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" @blur="$emit(\'blur\')" />'
  })

  const switchStub = defineComponent({
    props: {
      modelValue: {
        type: Boolean,
        default: false
      }
    },
    emits: ['update:modelValue'],
    template:
      '<input v-bind="$attrs" type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />'
  })

  const checkboxStub = defineComponent({
    props: {
      checked: {
        type: Boolean,
        default: false
      }
    },
    emits: ['update:checked'],
    template:
      '<input type="checkbox" :checked="checked" @change="$emit(\'update:checked\', $event.target.checked)" />'
  })

  const buttonStub = defineComponent({
    emits: ['click'],
    template: '<button v-bind="$attrs" @click="$emit(\'click\', $event)"><slot /></button>'
  })

  const dialogStub = defineComponent({
    props: {
      open: {
        type: Boolean,
        default: false
      }
    },
    template: '<div v-if="open"><slot /></div>'
  })

  const RemoteSettings = (
    await import('../../../src/renderer/settings/components/RemoteSettings.vue')
  ).default
  const wrapper = mount(RemoteSettings, {
    global: {
      stubs: {
        ScrollArea: passthrough,
        Label: passthrough,
        Select: passthrough,
        SelectTrigger: passthrough,
        SelectValue: passthrough,
        SelectContent: passthrough,
        SelectItem: passthrough,
        Dialog: dialogStub,
        DialogContent: passthrough,
        DialogHeader: passthrough,
        DialogTitle: passthrough,
        DialogDescription: passthrough,
        DropdownMenu: passthrough,
        DropdownMenuContent: passthrough,
        DropdownMenuItem: dropdownMenuItemStub,
        DropdownMenuSeparator: passthrough,
        DropdownMenuTrigger: passthrough,
        DcButton: buttonStub,
        Input: inputStub,
        Switch: switchStub,
        Checkbox: checkboxStub,
        Icon: true
      }
    }
  })

  await flushPromises()

  return {
    wrapper,
    feishuState,
    openExternal,
    qqbotState,
    weixinIlinkState,
    remoteControlPresenter,
    sessionClient,
    projectPresenter,
    tabsComponents,
    notifyRenderer
  }
}

describe('RemoteSettings', () => {
  it('keeps initial load failures inline and retries without exposing diagnostics', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { wrapper, remoteControlPresenter } = await setup({ failInitialLoad: true })

    expect(wrapper.text()).toContain('common.error.requestFailed')
    expect(wrapper.text()).not.toContain('remote settings secret diagnostics')

    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(remoteControlPresenter.listRemoteChannels).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="remote-channel-toggle-feishu"]').exists()).toBe(true)
    consoleError.mockRestore()
  })

  it('disables the pair button while the channel remote control is disabled', async () => {
    const { wrapper } = await setup()

    expect(wrapper.find('[data-testid="feishu-pair-button"]').attributes('disabled')).toBeDefined()
  })

  it('shows only the active tab content when switching channels', async () => {
    const { wrapper, tabsComponents } = await setup()

    const feishuPanel = wrapper.find('[data-tabs-content-value="feishu"]')
    const qqbotPanel = wrapper.find('[data-tabs-content-value="qqbot"]')

    expect(feishuPanel.isVisible()).toBe(true)
    expect(qqbotPanel.isVisible()).toBe(false)

    const qqbotTrigger = wrapper
      .findAllComponents(tabsComponents.TabsTrigger)
      .find((component) => component.attributes('data-testid') === 'remote-tab-qqbot')

    expect(qqbotTrigger).toBeDefined()

    await qqbotTrigger!.trigger('click')
    await flushPromises()

    expect(feishuPanel.attributes('data-state')).toBe('inactive')
    expect(qqbotPanel.attributes('data-state')).toBe('active')
    expect(feishuPanel.attributes('style')).toContain('display: none')
    expect(qqbotPanel.attributes('style')).toBeUndefined()
  })

  it('toggles feishu remote control from the tab header', async () => {
    const { wrapper, feishuState, remoteControlPresenter, notifyRenderer } = await setup()

    await wrapper.find('[data-testid="remote-channel-toggle-feishu"]').setValue(true)
    await flushPromises()

    expect(feishuState.settings.remoteEnabled).toBe(true)
    expect(remoteControlPresenter.saveChannelSettings).toHaveBeenCalledWith(
      'feishu',
      expect.objectContaining({
        remoteEnabled: true
      })
    )
    expect(notifyRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'success',
        code: 'settings.remote.feishu.saveSucceeded',
        title: 'common.saved'
      })
    )
    expect(wrapper.find('[data-testid="feishu-bindings-button"]').exists()).toBe(true)
  })

  it('saves remote settings with cloneable array payloads', async () => {
    const { wrapper, qqbotState, weixinIlinkState, remoteControlPresenter } = await setup({
      feishuChannelSettingsOverride: {
        appId: 'feishu-app',
        appSecret: 'feishu-secret',
        remoteEnabled: false,
        pairedUserOpenIds: ['ou_1']
      },
      qqbotChannelSettingsOverride: {
        appId: 'qq-app',
        clientSecret: 'qq-secret',
        remoteEnabled: false,
        pairedUserIds: ['user-openid-1']
      },
      weixinIlinkChannelSettingsOverride: {
        remoteEnabled: false,
        accounts: [
          {
            accountId: 'wx-1',
            ownerUserId: 'owner-1',
            baseUrl: 'https://ilinkai.weixin.qq.com',
            enabled: true
          }
        ]
      }
    })

    await wrapper.find('[data-testid="remote-channel-toggle-feishu"]').setValue(true)
    await flushPromises()
    await wrapper.find('[data-testid="remote-channel-toggle-qqbot"]').setValue(true)
    await flushPromises()
    await wrapper.find('[data-testid="remote-channel-toggle-weixin-ilink"]').setValue(true)
    await flushPromises()

    expect(remoteControlPresenter.saveChannelSettings).toHaveBeenCalledWith(
      'feishu',
      expect.objectContaining({
        remoteEnabled: true,
        pairedUserOpenIds: ['ou_1']
      })
    )
    expect(remoteControlPresenter.saveChannelSettings).toHaveBeenCalledWith(
      'qqbot',
      expect.objectContaining({
        remoteEnabled: true,
        pairedUserIds: ['user-openid-1']
      })
    )
    expect(remoteControlPresenter.saveChannelSettings).toHaveBeenCalledWith(
      'weixin-ilink',
      expect.objectContaining({
        remoteEnabled: true,
        accounts: [
          {
            accountId: 'wx-1',
            ownerUserId: 'owner-1',
            baseUrl: 'https://ilinkai.weixin.qq.com',
            enabled: true
          }
        ]
      })
    )

    expect(qqbotState.settings.remoteEnabled).toBe(true)
    expect(weixinIlinkState.settings.remoteEnabled).toBe(true)
  })

  it('does not let an older save response overwrite a newer draft', async () => {
    const { wrapper, feishuState, remoteControlPresenter, notifyRenderer } = await setup()
    let resolveFirst: (value: Record<string, unknown>) => void = () => undefined
    let resolveSecond: (value: Record<string, unknown>) => void = () => undefined
    remoteControlPresenter.saveChannelSettings
      .mockImplementationOnce(
        async () =>
          await new Promise<Record<string, unknown>>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockImplementationOnce(
        async () =>
          await new Promise<Record<string, unknown>>((resolve) => {
            resolveSecond = resolve
          })
      )

    const appIdInput = wrapper.get('input[placeholder="settings.remote.feishu.appIdPlaceholder"]')
    await appIdInput.setValue('first-app')
    await appIdInput.trigger('blur')
    await Promise.resolve()
    await appIdInput.setValue('second-app')
    await appIdInput.trigger('blur')

    resolveFirst({
      ...feishuState.settings,
      appId: 'normalized-first-app',
      defaultWorkdir: '/normalized-workspace'
    })
    await flushPromises()

    expect(remoteControlPresenter.saveChannelSettings).toHaveBeenNthCalledWith(
      2,
      'feishu',
      expect.objectContaining({
        appId: 'second-app',
        defaultWorkdir: '/normalized-workspace'
      })
    )
    expect((appIdInput.element as HTMLInputElement).value).toBe('second-app')

    resolveSecond({
      ...feishuState.settings,
      appId: 'second-app'
    })
    await flushPromises()
    expect(notifyRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'success',
        code: 'settings.remote.feishu.saveSucceeded',
        title: 'common.saved'
      })
    )
  })

  it('preserves an unsubmitted edit when the active save resolves', async () => {
    const { wrapper, feishuState, remoteControlPresenter, notifyRenderer } = await setup()
    let resolveSave: (value: Record<string, unknown>) => void = () => undefined
    remoteControlPresenter.saveChannelSettings.mockImplementationOnce(
      async () =>
        await new Promise<Record<string, unknown>>((resolve) => {
          resolveSave = resolve
        })
    )

    const appIdInput = wrapper.get('input[placeholder="settings.remote.feishu.appIdPlaceholder"]')
    await appIdInput.setValue('submitted-app')
    await appIdInput.trigger('blur')
    await Promise.resolve()
    await appIdInput.setValue('editing-app')

    resolveSave({
      ...feishuState.settings,
      appId: 'normalized-submitted-app'
    })
    await flushPromises()

    expect((appIdInput.element as HTMLInputElement).value).toBe('editing-app')
    expect(notifyRenderer).not.toHaveBeenCalled()
    const { settingsLeaveGuard } =
      await import('../../../src/renderer/settings/services/settingsLeaveGuard')
    expect(settingsLeaveGuard.getSnapshot().risk).toBe('dirty')

    await appIdInput.trigger('blur')
    await flushPromises()
    expect(notifyRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'success',
        code: 'settings.remote.feishu.saveSucceeded',
        title: 'common.saved'
      })
    )
    expect(settingsLeaveGuard.getSnapshot().risk).toBe('clean')
  })

  it('guards a failed save as dirty and restores the persisted draft on discard', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { wrapper, remoteControlPresenter, notifyRenderer } = await setup({
      feishuChannelSettingsOverride: {
        appId: 'persisted-app',
        remoteEnabled: true
      }
    })
    remoteControlPresenter.saveChannelSettings.mockRejectedValueOnce(
      new Error('save secret diagnostics')
    )

    const appIdInput = wrapper.get('input[placeholder="settings.remote.feishu.appIdPlaceholder"]')
    await appIdInput.setValue('unsaved-app')
    await appIdInput.trigger('blur')
    await flushPromises()

    const { settingsLeaveGuard } =
      await import('../../../src/renderer/settings/services/settingsLeaveGuard')
    expect(settingsLeaveGuard.getSnapshot().risk).toBe('dirty')
    expect(notifyRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'error',
        code: 'settings.remote.feishu.saveFailed',
        title: 'common.error.operationFailed'
      })
    )
    expect(wrapper.text()).not.toContain('save secret diagnostics')

    const leaveRequest = settingsLeaveGuard.requestLeave()
    expect(settingsLeaveGuard.discardAndLeave()).toBe(true)
    await expect(leaveRequest).resolves.toBe(true)
    await flushPromises()

    expect((appIdInput.element as HTMLInputElement).value).toBe('persisted-app')
    expect(notifyRenderer).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })

  it('shows enabled ACP agents in the default agent options', async () => {
    const { wrapper } = await setup()

    expect(wrapper.text()).toContain('ACP Agent (ACP)')
  })

  it('shows and removes authorized principals from the bindings dialog', async () => {
    const { wrapper, feishuState, remoteControlPresenter } = await setup({
      feishuChannelSettingsOverride: {
        remoteEnabled: true,
        pairedUserOpenIds: ['ou_123']
      },
      feishuPairingSnapshot: {
        pairCode: null,
        pairCodeExpiresAt: null,
        pairedUserOpenIds: ['ou_123']
      },
      feishuBindings: [
        {
          endpointKey: 'feishu:oc_100',
          sessionId: 'session-1',
          chatId: 'oc_100',
          threadId: null,
          kind: 'dm',
          updatedAt: 1
        }
      ]
    })

    await wrapper.find('[data-testid="feishu-bindings-button"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="remote-principal-ou_123"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="remote-binding-feishu:oc_100"]').exists()).toBe(true)

    await wrapper.find('[data-testid="remote-principal-ou_123"] button').trigger('click')
    await flushPromises()

    expect(remoteControlPresenter.removeChannelPrincipal).toHaveBeenCalledWith('feishu', 'ou_123')
    expect(feishuState.pairingSnapshot.pairedUserOpenIds).toEqual([])
    expect(wrapper.find('[data-testid="remote-principals-empty"]').exists()).toBe(true)
  })

  it('shows feishu brand switch, setup helper, and scan auth controls', async () => {
    const { wrapper, tabsComponents } = await setup({
      feishuChannelSettingsOverride: {
        appId: 'cli_scan',
        appSecret: 'secret',
        remoteEnabled: true
      }
    })

    const feishuTrigger = wrapper
      .findAllComponents(tabsComponents.TabsTrigger)
      .find((component) => component.attributes('data-testid') === 'remote-tab-feishu')

    expect(feishuTrigger).toBeDefined()

    await feishuTrigger!.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="remote-feishu-paired-user-open-ids-input"]').exists()).toBe(
      false
    )
    expect(wrapper.text()).toContain('settings.remote.feishu.brand')
    expect(wrapper.text()).toContain('settings.remote.feishu.installTitle')
    expect(wrapper.text()).toContain('settings.remote.feishu.openInstallWeb')
    expect(wrapper.text()).toContain('settings.remote.feishu.showInstallQr')
    expect(wrapper.text()).toContain('settings.remote.feishu.manualSetupTitle')
    expect(wrapper.text()).toContain('settings.remote.feishu.userAuthTitle')
    expect(wrapper.text()).toContain('settings.remote.feishu.pairAuthTitle')
    expect(wrapper.text()).toContain('settings.remote.feishu.scanAuthTitle')
    expect(wrapper.text()).toContain('settings.remote.remoteControl.defaultWorkdir')
    expect(wrapper.find('[data-testid="feishu-install-open-web-button"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="feishu-install-show-qr-button"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="feishu-pair-button"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="feishu-scan-auth-button"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="feishu-bindings-button"]').exists()).toBe(true)
  })

  it('persists the feishu streaming card setting', async () => {
    const { wrapper, remoteControlPresenter, tabsComponents } = await setup({
      feishuChannelSettingsOverride: {
        remoteEnabled: true,
        enableStreamingCards: false
      }
    })

    const feishuTrigger = wrapper
      .findAllComponents(tabsComponents.TabsTrigger)
      .find((component) => component.attributes('data-testid') === 'remote-tab-feishu')

    expect(feishuTrigger).toBeDefined()
    await feishuTrigger!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('settings.remote.feishu.streamingCards')
    expect(wrapper.text()).toContain('settings.remote.feishu.streamingCardsDescription')

    const toggle = wrapper.find('[data-testid="feishu-streaming-cards-toggle"]')
    expect(toggle.exists()).toBe(true)
    expect((toggle.element as HTMLInputElement).checked).toBe(false)

    await toggle.setValue(true)
    await flushPromises()

    await vi.waitFor(() => {
      expect(remoteControlPresenter.saveChannelSettings).toHaveBeenCalledWith(
        'feishu',
        expect.objectContaining({
          enableStreamingCards: true
        })
      )
    })
  })

  it('starts the official feishu web install flow and refreshes credentials', async () => {
    const { wrapper, remoteControlPresenter, tabsComponents, openExternal } = await setup({
      feishuChannelSettingsOverride: {
        remoteEnabled: true
      }
    })

    const feishuTrigger = wrapper
      .findAllComponents(tabsComponents.TabsTrigger)
      .find((component) => component.attributes('data-testid') === 'remote-tab-feishu')

    expect(feishuTrigger).toBeDefined()
    await feishuTrigger!.trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="feishu-install-open-web-button"]').trigger('click')
    await flushPromises()

    expect(remoteControlPresenter.startFeishuInstall).toHaveBeenCalledWith({
      brand: 'feishu'
    })
    expect(openExternal).toHaveBeenCalledWith(
      'https://open.feishu.cn/page/launcher?user_code=INSTALL'
    )
    expect(remoteControlPresenter.waitForFeishuInstall).toHaveBeenCalledWith({
      sessionKey: 'feishu-install-session',
      timeoutMs: 300000
    })
    expect(wrapper.text()).toContain('settings.remote.feishu.installSuccess')
  })

  it('shows an in-app QR install dialog without opening the browser', async () => {
    const { wrapper, remoteControlPresenter, tabsComponents, openExternal } = await setup({
      feishuChannelSettingsOverride: {
        remoteEnabled: true
      }
    })
    remoteControlPresenter.waitForFeishuInstall.mockImplementation(
      async () => await new Promise<never>(() => {})
    )

    const feishuTrigger = wrapper
      .findAllComponents(tabsComponents.TabsTrigger)
      .find((component) => component.attributes('data-testid') === 'remote-tab-feishu')

    expect(feishuTrigger).toBeDefined()
    await feishuTrigger!.trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="feishu-install-show-qr-button"]').trigger('click')
    await flushPromises()

    const qrDialog = wrapper.find('[data-testid="feishu-install-qr-dialog"]')
    const qrCode = wrapper.find('[data-testid="feishu-install-qr-code"]')
    expect(qrDialog.exists()).toBe(true)
    expect(qrCode.attributes('data-qr-value')).toBe(
      'https://open.feishu.cn/page/launcher?user_code=INSTALL'
    )
    expect(qrCode.find('img').attributes('src')).toContain('data:image/png;base64,')
    expect(openExternal).not.toHaveBeenCalled()
    expect(remoteControlPresenter.waitForFeishuInstall).toHaveBeenCalledWith({
      sessionKey: 'feishu-install-session',
      timeoutMs: 300000
    })
  })

  it('uses the current lark brand for QR install and disables both install buttons while pending', async () => {
    const { wrapper, remoteControlPresenter, tabsComponents } = await setup({
      feishuChannelSettingsOverride: {
        brand: 'lark',
        remoteEnabled: true
      }
    })

    remoteControlPresenter.waitForFeishuInstall.mockImplementation(
      async () => await new Promise<never>(() => {})
    )

    const feishuTrigger = wrapper
      .findAllComponents(tabsComponents.TabsTrigger)
      .find((component) => component.attributes('data-testid') === 'remote-tab-feishu')

    expect(feishuTrigger).toBeDefined()
    await feishuTrigger!.trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="feishu-install-show-qr-button"]').trigger('click')
    await flushPromises()

    expect(remoteControlPresenter.startFeishuInstall).toHaveBeenLastCalledWith({
      brand: 'lark'
    })
    expect(remoteControlPresenter.startFeishuInstall).toHaveBeenCalledTimes(1)
    expect(
      wrapper.find('[data-testid="feishu-install-open-web-button"]').attributes('disabled')
    ).toBeDefined()
    expect(
      wrapper.find('[data-testid="feishu-install-show-qr-button"]').attributes('disabled')
    ).toBeDefined()
  })

  it('cancels pending feishu install and scan auth sessions on unmount', async () => {
    const { wrapper, remoteControlPresenter, tabsComponents } = await setup({
      feishuChannelSettingsOverride: {
        appId: 'cli_scan',
        appSecret: 'secret',
        remoteEnabled: true
      }
    })

    remoteControlPresenter.waitForFeishuInstall.mockImplementation(
      async () => await new Promise<never>(() => {})
    )
    remoteControlPresenter.waitForFeishuAuth.mockImplementation(
      async () => await new Promise<never>(() => {})
    )

    const feishuTrigger = wrapper
      .findAllComponents(tabsComponents.TabsTrigger)
      .find((component) => component.attributes('data-testid') === 'remote-tab-feishu')

    expect(feishuTrigger).toBeDefined()
    await feishuTrigger!.trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="feishu-install-show-qr-button"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="feishu-scan-auth-button"]').trigger('click')
    await flushPromises()

    wrapper.unmount()

    expect(remoteControlPresenter.cancelFeishuInstall).toHaveBeenCalledWith(
      'feishu-install-session'
    )
    expect(remoteControlPresenter.cancelFeishuAuth).toHaveBeenCalledWith('feishu-session')
  })

  it('opens feishu pair dialog from the combined authorization section', async () => {
    const { wrapper, remoteControlPresenter, tabsComponents } = await setup({
      feishuChannelSettingsOverride: {
        remoteEnabled: true
      }
    })

    const feishuTrigger = wrapper
      .findAllComponents(tabsComponents.TabsTrigger)
      .find((component) => component.attributes('data-testid') === 'remote-tab-feishu')

    expect(feishuTrigger).toBeDefined()
    await feishuTrigger!.trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="feishu-pair-button"]').trigger('click')
    await flushPromises()

    expect(remoteControlPresenter.createChannelPairCode).toHaveBeenCalledWith('feishu')
    expect(wrapper.find('[data-testid="remote-pair-dialog"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('settings.remote.remoteControl.pairDialogInstructionFeishu')
    expect(wrapper.text()).toContain('/pair 654321')
  })

  it('starts the feishu scan auth flow and refreshes paired principals', async () => {
    const { wrapper, remoteControlPresenter, tabsComponents } = await setup({
      feishuChannelSettingsOverride: {
        appId: 'cli_scan',
        appSecret: 'secret',
        remoteEnabled: true
      }
    })

    const feishuTrigger = wrapper
      .findAllComponents(tabsComponents.TabsTrigger)
      .find((component) => component.attributes('data-testid') === 'remote-tab-feishu')

    expect(feishuTrigger).toBeDefined()
    await feishuTrigger!.trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="feishu-scan-auth-button"]').trigger('click')
    await flushPromises()

    expect(remoteControlPresenter.startFeishuAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        brand: 'feishu',
        appId: 'cli_scan',
        appSecret: 'secret'
      })
    )
    expect(remoteControlPresenter.waitForFeishuAuth).toHaveBeenCalledWith({
      sessionKey: 'feishu-session',
      timeoutMs: 300000
    })
    expect(wrapper.text()).toContain('settings.remote.feishu.authSuccess')
  })

  it('normalizes legacy feishu settings without paired user ids', async () => {
    const { wrapper } = await setup({
      feishuChannelSettingsOverride: {
        remoteEnabled: true,
        pairedUserOpenIds: undefined
      }
    })

    await wrapper.find('[data-testid="remote-tab-feishu"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="feishu-bindings-button"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="remote-feishu-paired-user-open-ids-input"]').exists()).toBe(
      false
    )
  })

  it('uses remote control as the channel section title', async () => {
    const { wrapper } = await setup({
      feishuChannelSettingsOverride: {
        remoteEnabled: true
      }
    })

    const text = wrapper.text()
    expect(text).not.toContain('settings.remote.sections.accessRules')
    expect(text.match(/settings\.remote\.sections\.remoteControl/g)).toHaveLength(3)
  })

  it('does not create a separate lark tab when feishu brand switches to lark', async () => {
    const { wrapper } = await setup({
      feishuChannelSettingsOverride: {
        brand: 'lark',
        remoteEnabled: true
      }
    })

    expect(wrapper.find('[data-testid="remote-tab-feishu"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="remote-tab-lark"]').exists()).toBe(false)
  })

  it('starts the wechat ilink qr login flow and shows the dialog', async () => {
    const { wrapper, remoteControlPresenter, tabsComponents } = await setup()
    remoteControlPresenter.waitForWeixinIlinkLogin.mockImplementation(
      async () => await new Promise<never>(() => {})
    )

    const weixinTrigger = wrapper
      .findAllComponents(tabsComponents.TabsTrigger)
      .find((component) => component.attributes('data-testid') === 'remote-tab-weixin-ilink')

    expect(weixinTrigger).toBeDefined()

    await weixinTrigger!.trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="weixin-ilink-connect-button"]').trigger('click')
    await flushPromises()

    const connectButton = wrapper.find('[data-testid="weixin-ilink-connect-button"]')
    expect(connectButton.attributes('disabled')).toBeDefined()

    await connectButton.trigger('click')
    await flushPromises()

    expect(remoteControlPresenter.startWeixinIlinkLogin).toHaveBeenCalledTimes(1)
    expect(remoteControlPresenter.waitForWeixinIlinkLogin).toHaveBeenCalledWith({
      sessionKey: 'weixin-session',
      timeoutMs: 480000
    })
    expect(wrapper.text()).toContain('settings.remote.weixinIlink.loginWindowOpened')
  })

  it('opens the pair dialog and closes it after pairing succeeds', async () => {
    const { wrapper, feishuState, remoteControlPresenter } = await setup({
      feishuChannelSettingsOverride: {
        remoteEnabled: true
      }
    })

    await wrapper.find('[data-testid="feishu-pair-button"]').trigger('click')
    await flushPromises()

    expect(remoteControlPresenter.saveChannelSettings).not.toHaveBeenCalled()
    expect(remoteControlPresenter.createChannelPairCode).toHaveBeenCalledWith('feishu')
    expect(wrapper.find('[data-testid="remote-pair-dialog"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('/pair 654321')

    feishuState.pairingSnapshot = {
      pairCode: null,
      pairCodeExpiresAt: null,
      pairedUserOpenIds: ['ou_1', 'ou_2']
    }

    await vi.advanceTimersByTimeAsync(2_000)
    await flushPromises()

    expect(wrapper.find('[data-testid="remote-pair-dialog"]').exists()).toBe(false)

    await wrapper.find('[data-testid="feishu-bindings-button"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="remote-principal-ou_2"]').exists()).toBe(true)
  })

  it('does not let a stale pairing poll close a newer dialog', async () => {
    const { wrapper, remoteControlPresenter } = await setup({
      feishuChannelSettingsOverride: {
        remoteEnabled: true
      }
    })

    await wrapper.find('[data-testid="feishu-pair-button"]').trigger('click')
    await flushPromises()

    let resolveStalePoll: (value: Record<string, unknown>) => void = () => undefined
    remoteControlPresenter.getChannelPairingSnapshot.mockImplementationOnce(
      async () =>
        await new Promise<Record<string, unknown>>((resolve) => {
          resolveStalePoll = resolve
        })
    )
    vi.advanceTimersByTime(2_000)
    await Promise.resolve()

    await wrapper.get('[data-testid="remote-pair-dialog"] button').trigger('click')
    await flushPromises()

    remoteControlPresenter.createChannelPairCode.mockResolvedValueOnce({
      code: '222222',
      expiresAt: 987654321
    })
    await wrapper.find('[data-testid="feishu-pair-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('/pair 222222')

    resolveStalePoll({
      pairCode: null,
      pairCodeExpiresAt: null,
      pairedUserOpenIds: ['ou_1']
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="remote-pair-dialog"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('/pair 222222')
  })

  it('keeps the pairing dialog open when cancellation fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { wrapper, remoteControlPresenter } = await setup({
      feishuChannelSettingsOverride: {
        remoteEnabled: true
      }
    })

    await wrapper.find('[data-testid="feishu-pair-button"]').trigger('click')
    await flushPromises()
    remoteControlPresenter.clearChannelPairCode.mockRejectedValueOnce(
      new Error('pair code secret diagnostics')
    )

    await wrapper.get('[data-testid="remote-pair-dialog"] button').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="remote-pair-dialog"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="remote-pair-dialog"] [role="alert"]').text()).toContain(
      'common.error.operationFailed'
    )
    expect(wrapper.text()).not.toContain('pair code secret diagnostics')

    await wrapper.get('[data-testid="remote-pair-dialog"] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="remote-pair-dialog"]').exists()).toBe(false)
    consoleError.mockRestore()
  })

  it('does not open the pair dialog when saving feishu settings fails', async () => {
    const { wrapper, remoteControlPresenter, notifyRenderer } = await setup({
      feishuChannelSettingsOverride: {
        remoteEnabled: true
      }
    })

    remoteControlPresenter.saveChannelSettings.mockRejectedValueOnce(new Error('save failed'))
    await wrapper
      .get('input[placeholder="settings.remote.feishu.appIdPlaceholder"]')
      .setValue('changed-app-id')

    await wrapper.find('[data-testid="feishu-pair-button"]').trigger('click')
    await flushPromises()

    expect(remoteControlPresenter.createChannelPairCode).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="remote-pair-dialog"]').exists()).toBe(false)
    expect(notifyRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'error',
        code: 'settings.remote.feishu.saveFailed',
        title: 'common.error.operationFailed'
      })
    )
    expect(wrapper.text()).not.toContain('save failed')
  })

  it('lists only enabled agents in the default agent selector area', async () => {
    const { wrapper } = await setup()

    expect(wrapper.text()).toContain('DeepChat')
    expect(wrapper.text()).not.toContain('DeepChat Alt')
    expect(wrapper.text()).toContain('ACP Agent (ACP)')
  })

  it('opens the bindings dialog and removes a binding from the list', async () => {
    const { wrapper, remoteControlPresenter } = await setup({
      feishuChannelSettingsOverride: {
        remoteEnabled: true
      },
      feishuBindings: [
        {
          endpointKey: 'feishu:oc_100',
          sessionId: 'session-1',
          chatId: 'oc_100',
          threadId: null,
          kind: 'dm',
          updatedAt: 1
        }
      ]
    })

    await wrapper.find('[data-testid="feishu-bindings-button"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="remote-bindings-dialog"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('session-1')

    const deleteButton = wrapper.find('[data-testid="remote-binding-feishu:oc_100"]').find('button')

    await deleteButton.trigger('click')
    await flushPromises()

    expect(remoteControlPresenter.removeChannelBinding).toHaveBeenCalledWith(
      'feishu',
      'feishu:oc_100'
    )
    expect(wrapper.find('[data-testid="remote-bindings-empty"]').exists()).toBe(true)
  })

  it('allows a pending bindings read to be dismissed safely', async () => {
    const { wrapper, remoteControlPresenter } = await setup()
    let resolveBindings: (value: unknown[]) => void = () => undefined
    remoteControlPresenter.getChannelBindings.mockImplementationOnce(
      async () =>
        await new Promise<unknown[]>((resolve) => {
          resolveBindings = resolve
        })
    )

    await wrapper.find('[data-testid="feishu-bindings-button"]').trigger('click')
    await Promise.resolve()
    expect(wrapper.find('[data-testid="remote-bindings-dialog"]').exists()).toBe(true)

    await wrapper.get('[data-testid="remote-bindings-dialog"] button').trigger('click')
    expect(wrapper.find('[data-testid="remote-bindings-dialog"]').exists()).toBe(false)

    resolveBindings([])
    await flushPromises()
    expect(wrapper.find('[data-testid="remote-bindings-dialog"]').exists()).toBe(false)
  })

  it('keeps binding mutation failures in the dialog with truthful local state', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { wrapper, remoteControlPresenter } = await setup({
      feishuBindings: [
        {
          endpointKey: 'feishu:oc_100',
          sessionId: 'session-1',
          chatId: 'oc_100',
          threadId: null,
          kind: 'dm',
          updatedAt: 1
        }
      ]
    })

    await wrapper.find('[data-testid="feishu-bindings-button"]').trigger('click')
    await flushPromises()
    remoteControlPresenter.removeChannelBinding.mockRejectedValueOnce(
      new Error('binding secret diagnostics')
    )

    await wrapper.get('[data-testid="remote-binding-feishu:oc_100"] button').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="remote-bindings-dialog"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="remote-binding-feishu:oc_100"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="remote-bindings-dialog"] [role="alert"]').text()).toContain(
      'common.error.operationFailed'
    )
    expect(wrapper.get('[data-testid="remote-bindings-dialog"]').text()).not.toContain(
      'common.retry'
    )
    expect(wrapper.text()).not.toContain('binding secret diagnostics')
    consoleError.mockRestore()
  })

  it('does not open bindings when saving feishu settings fails', async () => {
    const { wrapper, remoteControlPresenter, tabsComponents, notifyRenderer } = await setup({
      feishuChannelSettingsOverride: {
        remoteEnabled: true
      }
    })

    const feishuTrigger = wrapper
      .findAllComponents(tabsComponents.TabsTrigger)
      .find((component) => component.attributes('data-testid') === 'remote-tab-feishu')

    expect(feishuTrigger).toBeDefined()

    await feishuTrigger!.trigger('click')
    await flushPromises()

    remoteControlPresenter.saveChannelSettings.mockImplementationOnce(async (channel: string) => {
      if (channel === 'feishu') {
        throw new Error('feishu save failed')
      }

      return {}
    })
    await wrapper
      .get('input[placeholder="settings.remote.feishu.appIdPlaceholder"]')
      .setValue('changed-app-id')

    await wrapper.find('[data-testid="feishu-bindings-button"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="remote-bindings-dialog"]').exists()).toBe(false)
    expect(notifyRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'error',
        code: 'settings.remote.feishu.saveFailed',
        title: 'common.error.operationFailed'
      })
    )
    expect(wrapper.text()).not.toContain('feishu save failed')
  })

  it('renders the alias-equivalent agent label when binding holds a legacy ACP agent id', async () => {
    const { wrapper } = await setup({
      feishuChannelSettingsOverride: {
        remoteEnabled: true,
        defaultAgentId: 'claude-code-acp'
      },
      agents: [{ id: 'claude-acp', name: 'Claude', type: 'acp', enabled: true }]
    })

    expect(wrapper.text()).toContain('Claude (ACP)')
    expect(wrapper.text()).not.toContain('claude-code-acp')
  })
})
