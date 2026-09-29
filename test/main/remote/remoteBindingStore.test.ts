import { describe, expect, it, vi } from 'vitest'
import { RemoteBindingStore } from '@/remote/binding/store'

const createProviderSettings = () => {
  const store = new Map<string, unknown>()
  return {
    get: vi.fn((key: string) => store.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      store.set(key, value)
    })
  }
}

describe('RemoteBindingStore', () => {
  it('persists endpoint bindings through config storage', () => {
    const providerSettings = createProviderSettings()
    const firstStore = new RemoteBindingStore(providerSettings as any)

    firstStore.setBinding('feishu:oc_x:root', 'session-1')

    const secondStore = new RemoteBindingStore(providerSettings as any)
    expect(secondStore.getBinding('feishu:oc_x:root')).toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        updatedAt: expect.any(Number)
      })
    )
  })

  it('clears bindings and returns the cleared count', () => {
    const providerSettings = createProviderSettings()
    const store = new RemoteBindingStore(providerSettings as any)

    store.setBinding('feishu:oc_x:root', 'session-1')
    store.setBinding('feishu:oc_y:root', 'session-2')

    expect(store.clearBindings()).toBe(2)
    expect(store.countBindings()).toBe(0)
  })

  it('removes a single binding without touching others', () => {
    const providerSettings = createProviderSettings()
    const store = new RemoteBindingStore(providerSettings as any)

    store.setBinding('feishu:oc_x:root', 'session-1')
    store.setBinding('feishu:oc_y:root', 'session-2')

    store.clearBinding('feishu:oc_x:root')

    expect(store.getBinding('feishu:oc_x:root')).toBeNull()
    expect(store.getBinding('feishu:oc_y:root')).toEqual(
      expect.objectContaining({
        sessionId: 'session-2',
        updatedAt: expect.any(Number)
      })
    )
  })

  it('normalizes empty defaultAgentId to deepchat', () => {
    const providerSettings = createProviderSettings()
    providerSettings.set('remoteControl', {
      feishu: {
        appId: 'cli_a',
        appSecret: 'secret',
        defaultAgentId: '  '
      }
    })

    const store = new RemoteBindingStore(providerSettings as any)

    expect(store.getFeishuDefaultAgentId()).toBe('deepchat')
  })

  it('migrates legacy root-level feishu config into the nested structure', () => {
    const providerSettings = createProviderSettings()
    providerSettings.set('remoteControl', {
      appId: 'cli_a',
      appSecret: 'secret',
      verificationToken: 'verify',
      encryptKey: 'encrypt',
      enabled: true,
      defaultAgentId: 'deepchat',
      pairedUserOpenIds: ['ou_1', 'ou_2'],
      lastFatalError: 'fatal',
      pairing: {
        code: '123456',
        expiresAt: 456
      },
      bindings: {
        'feishu:oc_x:root': {
          sessionId: 'session-feishu',
          updatedAt: 2
        }
      }
    })

    const store = new RemoteBindingStore(providerSettings as any)

    expect(store.getFeishuConfig()).toEqual(
      expect.objectContaining({
        appId: 'cli_a',
        appSecret: 'secret',
        verificationToken: 'verify',
        encryptKey: 'encrypt',
        enabled: true,
        pairedUserOpenIds: ['ou_1', 'ou_2'],
        lastFatalError: 'fatal',
        pairing: expect.objectContaining({
          code: '123456',
          expiresAt: 456,
          failedAttempts: 0
        })
      })
    )
    expect(store.getBinding('feishu:oc_x:root')).toEqual(
      expect.objectContaining({
        sessionId: 'session-feishu',
        updatedAt: 2
      })
    )
  })

  it('enables configured channels when legacy enabled flags are missing', () => {
    const providerSettings = createProviderSettings()
    providerSettings.set('remoteControl', {
      feishu: {
        appId: 'cli_a',
        appSecret: 'secret'
      },
      qqbot: {
        appId: 'qq-app',
        clientSecret: 'qq-secret'
      },
      weixinIlink: {
        accounts: [
          {
            accountId: 'account-1',
            ownerUserId: 'owner-1'
          }
        ]
      }
    })

    const store = new RemoteBindingStore(providerSettings as any)

    expect(store.getFeishuConfig().enabled).toBe(true)
    expect(store.getQQBotConfig().enabled).toBe(true)
    expect(store.getWeixinIlinkConfig().enabled).toBe(true)

    const rootProviderSettings = createProviderSettings()
    rootProviderSettings.set('remoteControl', {
      appId: 'legacy-app',
      appSecret: 'legacy-secret'
    })

    expect(new RemoteBindingStore(rootProviderSettings as any).getFeishuConfig().enabled).toBe(true)
  })

  it('removes authorized principals without touching other entries', () => {
    const providerSettings = createProviderSettings()
    providerSettings.set('remoteControl', {
      feishu: {
        appId: 'cli_a',
        appSecret: 'secret',
        verificationToken: 'verify',
        encryptKey: 'encrypt',
        enabled: true,
        defaultAgentId: 'deepchat',
        pairedUserOpenIds: ['ou_1', 'ou_2'],
        lastFatalError: null,
        pairing: {
          code: null,
          expiresAt: null,
          failedAttempts: 0
        },
        bindings: {}
      },
      qqbot: {
        appId: 'app-1',
        clientSecret: 'secret',
        enabled: true,
        defaultAgentId: 'deepchat',
        pairedUserIds: ['user_openid_1', 'user_openid_2'],
        pairedGroupIds: [],
        lastFatalError: null,
        pairing: {
          code: null,
          expiresAt: null,
          failedAttempts: 0
        },
        bindings: {}
      }
    })

    const store = new RemoteBindingStore(providerSettings as any)

    store.removeFeishuPairedUser('ou_2')
    store.removeQQBotPairedUser('user_openid_2')

    expect(store.getFeishuPairedUserOpenIds()).toEqual(['ou_1'])
    expect(store.getQQBotPairedUserIds()).toEqual(['user_openid_1'])
  })

  it('keeps valid bindings when another binding is malformed', () => {
    const providerSettings = createProviderSettings()
    providerSettings.set('remoteControl', {
      feishu: {
        appId: 'cli_a',
        appSecret: 'secret',
        bindings: {
          'feishu:oc_x:root': {
            sessionId: 'session-1',
            updatedAt: 1
          },
          'feishu:oc_y:root': {
            sessionId: 123
          }
        }
      }
    })

    const store = new RemoteBindingStore(providerSettings as any)

    expect(store.getBinding('feishu:oc_x:root')).toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        updatedAt: 1
      })
    )
    expect(store.getBinding('feishu:oc_y:root')).toBeNull()
  })

  it('keeps remote delivery state in memory and clears it after rebinding the endpoint', () => {
    const providerSettings = createProviderSettings()
    const store = new RemoteBindingStore(providerSettings as any)

    store.rememberRemoteDeliveryState('feishu:oc_x:root', {
      sourceMessageId: 'msg-1',
      segments: [
        {
          key: 'msg-1:0:process',
          kind: 'process',
          messageIds: [100],
          lastText: '💻 shell_command: "git status"'
        },
        {
          key: 'msg-1:1:answer',
          kind: 'answer',
          messageIds: [101],
          lastText: 'Draft answer'
        }
      ]
    })

    expect(store.getRemoteDeliveryState('feishu:oc_x:root')).toEqual({
      sourceMessageId: 'msg-1',
      segments: [
        {
          key: 'msg-1:0:process',
          kind: 'process',
          messageIds: [100],
          lastText: '💻 shell_command: "git status"'
        },
        {
          key: 'msg-1:1:answer',
          kind: 'answer',
          messageIds: [101],
          lastText: 'Draft answer'
        }
      ]
    })

    store.setBinding('feishu:oc_x:root', 'session-2')

    expect(store.getRemoteDeliveryState('feishu:oc_x:root')).toBeNull()
  })

  it('normalizes binding meta channel from the endpoint key', () => {
    const providerSettings = createProviderSettings()
    const store = new RemoteBindingStore(providerSettings as any)

    store.setBinding('feishu:oc_x:root', 'session-1', {
      channel: 'qqbot',
      kind: 'dm',
      chatId: 'oc_x',
      threadId: null
    })

    expect(store.getBinding('feishu:oc_x:root')).toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        meta: expect.objectContaining({
          channel: 'feishu'
        })
      })
    )

    store.clearBinding('feishu:oc_x:root')

    expect(store.getBinding('feishu:oc_x:root')).toBeNull()
  })

  it('expires a pairing code after too many failures and resets failures for a new code', () => {
    const providerSettings = createProviderSettings()
    const store = new RemoteBindingStore(providerSettings as any)

    const pairing = store.createPairCode('qqbot')

    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect(store.recordPairCodeFailure('qqbot', 5)).toEqual({
        attempts: attempt,
        exhausted: false
      })
    }

    expect(store.getQQBotPairingState()).toEqual(
      expect.objectContaining({
        code: pairing.code,
        failedAttempts: 4
      })
    )

    expect(store.recordPairCodeFailure('qqbot', 5)).toEqual({
      attempts: 5,
      exhausted: true
    })
    expect(store.getQQBotPairingState()).toEqual({
      code: null,
      expiresAt: null,
      failedAttempts: 0
    })

    store.createPairCode('qqbot')

    expect(store.getQQBotPairingState().failedAttempts).toBe(0)
  })

  it('updates the channel default agent id by endpoint prefix', () => {
    const providerSettings = createProviderSettings()
    const store = new RemoteBindingStore(providerSettings as any)

    store.setChannelDefaultAgentId('feishu:oc_x:root', 'codex')
    expect(store.getFeishuDefaultAgentId()).toBe('codex')

    store.setChannelDefaultAgentId('qqbot:c2c:abc', 'codex')
    expect(store.getQQBotDefaultAgentId()).toBe('codex')

    store.setChannelDefaultAgentId('weixin-ilink:acct:user', 'codex')
    expect(store.getWeixinIlinkDefaultAgentId()).toBe('codex')
  })
})
