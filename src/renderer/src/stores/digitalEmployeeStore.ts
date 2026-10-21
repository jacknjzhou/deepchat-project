import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createConfigClient } from '../../api/ConfigClient'
import { createDigitalEmployeeClient } from '../../api/DigitalEmployeeClient'
import type { ConfigEntryKey, DigitalEmployee } from '@shared/contracts/routes'

const FAVORITES_KEY = 'digitalEmployee.favorites'
const SESSION_BINDINGS_KEY = 'digitalEmployee.sessionBindings'

export const useDigitalEmployeeStore = defineStore('digitalEmployee', () => {
  const client = createDigitalEmployeeClient()
  const configClient = createConfigClient()

  const employees = ref<DigitalEmployee[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const selectedDigitalEmployeeId = ref<string | null>(null)
  const favorites = ref<string[]>([])
  const sessionBindings = ref<Record<string, string>>({})

  const enabledEmployees = computed(() => employees.value.filter((employee) => employee.enabled))
  const selectedDigitalEmployee = computed(
    () => employees.value.find((employee) => employee.id === selectedDigitalEmployeeId.value) ?? null
  )

  const readStringArraySetting = async (key: ConfigEntryKey): Promise<string[]> => {
    try {
      const value = await configClient.getSetting(key)
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
    } catch {
      return []
    }
  }

  const readBindingsSetting = async (): Promise<Record<string, string>> => {
    try {
      const value = await configClient.getSetting(SESSION_BINDINGS_KEY)
      if (value === null || value === undefined || typeof value !== 'object') return {}
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    } catch {
      return {}
    }
  }

  async function fetchEmployees(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const result = await client.list()
      employees.value = result.employees
    } catch (e) {
      error.value = `Failed to load digital employees: ${e}`
    } finally {
      loading.value = false
    }
  }

  async function loadPersistedState(): Promise<void> {
    favorites.value = await readStringArraySetting(FAVORITES_KEY)
    sessionBindings.value = await readBindingsSetting()
  }

  function setSelectedDigitalEmployee(id: string | null): void {
    selectedDigitalEmployeeId.value = id
  }

  async function toggleFavorite(id: string): Promise<void> {
    favorites.value = favorites.value.includes(id)
      ? favorites.value.filter((item) => item !== id)
      : [...favorites.value, id]
    await configClient.setSetting(FAVORITES_KEY, [...favorites.value])
  }

  async function bindSession(sessionId: string, employeeId: string): Promise<void> {
    sessionBindings.value = { ...sessionBindings.value, [sessionId]: employeeId }
    await configClient.setSetting(SESSION_BINDINGS_KEY, { ...sessionBindings.value })
  }

  function employeeForSession(sessionId: string): DigitalEmployee | null {
    const employeeId = sessionBindings.value[sessionId]
    if (!employeeId) return null
    return employees.value.find((employee) => employee.id === employeeId) ?? null
  }

  async function loadInitialData(): Promise<void> {
    await Promise.all([fetchEmployees(), loadPersistedState()])
  }

  return {
    employees,
    loading,
    error,
    selectedDigitalEmployeeId,
    favorites,
    sessionBindings,
    enabledEmployees,
    selectedDigitalEmployee,
    fetchEmployees,
    loadInitialData,
    setSelectedDigitalEmployee,
    toggleFavorite,
    bindSession,
    employeeForSession
  }
})
