import { defineStore } from 'pinia'
import { ref } from 'vue'
import { createManagedClient } from '@api/ManagedClient'

export const useManagedStore = defineStore('managed', () => {
  const managed = ref(false)
  const providerIds = ref<string[]>([])
  const documentsLocked = ref(false)
  const username = ref('')
  const endpoint = ref('')
  const loading = ref(false)

  const client = createManagedClient()

  async function refresh() {
    loading.value = true
    try {
      const status = await client.getStatus()
      managed.value = status.managed
      providerIds.value = status.providerIds
      documentsLocked.value = status.documentsLocked
      username.value = status.username
      endpoint.value = status.endpoint
    } finally {
      loading.value = false
    }
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
    refresh,
    isManagedProvider
  }
})
