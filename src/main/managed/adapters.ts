import type { LLM_PROVIDER } from '@shared/types/provider'
import type { DeepChatAgentConfig } from '@shared/types/agent-interface'
import type { ProviderSettings } from '@/provider/settings'
import type { AgentSettings } from '@/agent/settings'
import type { ManagedProviderWriter } from './apply'
import type { ManagedAgentSettingsWriter } from './applyAgentModels'

/** 把 ProviderSettings 适配成 ManagedProviderWriter（upsert 语义） */
export function createManagedProviderWriter(settings: ProviderSettings): ManagedProviderWriter {
  return {
    async setProvider(id, patch) {
      const existing = settings.getProviderById(id)
      if (existing) settings.updateProviderAtomic(id, patch as unknown as Partial<LLM_PROVIDER>)
      else settings.addProviderAtomic(patch as unknown as LLM_PROVIDER)
    },
    removeProvider(id) {
      settings.removeProviderAtomic(id)
    }
  }
}

/** 把 AgentSettings 适配成 ManagedAgentSettingsWriter（扁平 patch → { config } 包装） */
export function createManagedAgentSettingsWriter(
  settings: AgentSettings
): ManagedAgentSettingsWriter {
  return {
    getDeepChatAgentConfig: async (agentId) =>
      ((await settings.getDeepChatAgentConfig(agentId)) ?? null) as Record<string, unknown> | null,
    updateDeepChatAgent: async (agentId, patch) =>
      settings.updateDeepChatAgent(agentId, { config: patch as unknown as DeepChatAgentConfig })
  }
}
