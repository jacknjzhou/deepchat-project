import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { RemoteChannelDescriptor, FeishuRemoteStatus } from '@shared/types/remote'
import type { PluginListItem } from '@shared/types/plugin'
import type { OcrRuntimeStatus } from '@shared/contracts/routes/ocr.routes'
import { usePluginCatalogStore } from '@/stores/pluginCatalog'

vi.mock('pinia', async () => vi.importActual<typeof import('pinia')>('pinia'))

const plugin = (enabled = false): PluginListItem => ({
  id: 'com.deepchat.plugins.test',
  name: 'Test plugin',
  version: '1.0.0',
  publisher: 'DeepChat',
  installed: true,
  enabled,
  trusted: true,
  trustState: 'trusted',
  official: true,
  capabilities: []
})

const feishuDescriptor: RemoteChannelDescriptor = {
  id: 'feishu',
  titleKey: 'settings.remote.feishu.title',
  descriptionKey: 'settings.remote.feishu.description',
  supportsCronDelivery: true
}

const feishuStatus = (enabled = false): FeishuRemoteStatus => ({
  channel: 'feishu',
  enabled,
  state: enabled ? 'running' : 'disabled',
  bindingCount: 0,
  pairedUserCount: 0,
  lastError: null,
  botUser: null
})

const ocrStatus: OcrRuntimeStatus = {
  platform: 'darwin',
  arch: 'arm64',
  availability: {
    status: 'available',
    lightOcrVersion: '0.5.5',
    bundleId: 'ppocrv6-small-native-20260719.1'
  },
  process: null,
  cache: null
}

describe('pluginCatalogStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('shares successful plugin and remote snapshots across consumers', () => {
    const store = usePluginCatalogStore()

    store.replacePlugins([plugin()], store.capturePluginRefresh())
    store.replaceRemoteSnapshot(
      [feishuDescriptor],
      [feishuStatus()],
      store.captureRemoteRefresh()
    )
    store.replaceOcrStatus(ocrStatus, store.beginOcrRefresh())

    const secondConsumer = usePluginCatalogStore()
    expect(secondConsumer.getPlugin('com.deepchat.plugins.test')?.enabled).toBe(false)
    expect(secondConsumer.remoteChannels).toEqual([feishuDescriptor])
    expect(secondConsumer.remoteStatuses.feishu?.state).toBe('disabled')
    expect(secondConsumer.ocrStatus).toEqual(ocrStatus)
    expect(secondConsumer.ocrStatusHasError).toBe(false)
  })

  it('keeps an optimistic plugin update when an older refresh completes', () => {
    const store = usePluginCatalogStore()
    store.replacePlugins([plugin()], store.capturePluginRefresh())
    const staleRefresh = store.capturePluginRefresh()

    const previous = store.beginPluginEnabledMutation('com.deepchat.plugins.test', true)

    expect(store.getPlugin('com.deepchat.plugins.test')?.enabled).toBe(true)
    expect(store.replacePlugins([plugin()], staleRefresh)).toBe(false)
    expect(store.getPlugin('com.deepchat.plugins.test')?.enabled).toBe(true)

    store.rollbackPluginMutation(previous)
    expect(store.getPlugin('com.deepchat.plugins.test')?.enabled).toBe(false)
  })

  it('keeps an optimistic remote update when a refresh spans the mutation', () => {
    const store = usePluginCatalogStore()
    store.replaceRemoteSnapshot(
      [feishuDescriptor],
      [feishuStatus()],
      store.captureRemoteRefresh()
    )
    const staleRefresh = store.captureRemoteRefresh()

    store.beginRemoteEnabledMutation('feishu', true)
    const refreshDuringMutation = store.captureRemoteRefresh()

    expect(store.remoteStatuses.feishu).toMatchObject({ enabled: true, state: 'starting' })
    expect(
      store.replaceRemoteSnapshot([feishuDescriptor], [feishuStatus()], staleRefresh)
    ).toBe(false)

    store.commitRemoteMutation(feishuStatus(true))

    expect(
      store.replaceRemoteSnapshot([feishuDescriptor], [feishuStatus()], refreshDuringMutation)
    ).toBe(false)
    expect(store.remoteStatuses.feishu).toMatchObject({ enabled: true, state: 'running' })
  })

  it('keeps only the latest OCR refresh result and clears stale errors after recovery', () => {
    const store = usePluginCatalogStore()
    const staleRefresh = store.beginOcrRefresh()
    const currentRefresh = store.beginOcrRefresh()

    expect(store.replaceOcrStatus(ocrStatus, staleRefresh)).toBe(false)
    expect(store.markOcrStatusRefreshFailed(currentRefresh)).toBe(true)
    expect(store.ocrStatus).toBeNull()
    expect(store.ocrStatusHasError).toBe(true)

    const recoveryRefresh = store.beginOcrRefresh()
    expect(store.replaceOcrStatus(ocrStatus, recoveryRefresh)).toBe(true)
    expect(store.ocrStatus).toEqual(ocrStatus)
    expect(store.ocrStatusHasError).toBe(false)
  })
})
