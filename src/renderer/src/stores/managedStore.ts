import { defineStore } from 'pinia'
import { ref } from 'vue'
import { createManagedClient } from '@api/ManagedClient'
import type { ManagedConfigStatus } from '@shared/contracts/routes'

export const useManagedStore = defineStore('managed', () => {
  const managed = ref(false)
  const providerIds = ref<string[]>([])
  const documentsLocked = ref(false)
  const username = ref('')
  const endpoint = ref('')
  const loading = ref(false)

  const client = createManagedClient()

  // 失败时保留上一次可用状态且不重抛，调用方（设置页 onMounted）不必再包 catch
  async function run(label: string, task: () => Promise<ManagedConfigStatus>): Promise<void> {
    loading.value = true
    try {
      const status = await task()
      managed.value = status.managed
      providerIds.value = status.providerIds
      documentsLocked.value = status.documentsLocked
      username.value = status.username
      endpoint.value = status.endpoint
    } catch (error) {
      console.error(`[managed] Failed to ${label}:`, error)
    } finally {
      loading.value = false
    }
  }

  /** 页面初始化：读取主进程已缓存的托管状态快照 */
  function load(): Promise<void> {
    return run('load managed status', () => client.getStatus())
  }

  /** 主动刷新：让主进程重新拉取企业配置，并用返回的最新状态更新 */
  function refreshConfig(): Promise<void> {
    return run('refresh managed config', () => client.refresh())
  }

  function isManagedProvider(providerId: string) {
    return providerIds.value.includes(providerId)
  }

  return {
    managed,
    providerIds,
    documentsLocked,
    username,
    endpoint,
    loading,
    load,
    refreshConfig,
    isManagedProvider
  }
})
