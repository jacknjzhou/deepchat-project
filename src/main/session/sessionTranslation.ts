import { resolveAssistantModelSelection } from '@/agent/shared/assistantModelSelection'
import type { AgentSettingsPort } from '@/agent/settings'
import type { AgentManager } from '@/agent/manager/agentManager'
import type { ProviderRuntimePort } from '@shared/types/provider'

/** 把 BCP 47 locale 映射为提示词用的英文语言名；中文区分简繁，未知回退英文。 */
export function resolveTranslationLanguage(locale?: string): string {
  const normalized = locale?.trim().toLowerCase() || ''
  if (normalized.startsWith('zh-cn') || normalized.startsWith('zh-hans')) {
    return 'Simplified Chinese'
  }
  if (
    normalized.startsWith('zh-tw') ||
    normalized.startsWith('zh-hk') ||
    normalized.startsWith('zh-hant')
  ) {
    return 'Traditional Chinese'
  }
  const languages: Array<[string, string]> = [
    ['ja', 'Japanese'],
    ['ko', 'Korean'],
    ['fr', 'French'],
    ['de', 'German'],
    ['es', 'Spanish'],
    ['pt', 'Portuguese'],
    ['ru', 'Russian'],
    ['it', 'Italian'],
    ['tr', 'Turkish'],
    ['pl', 'Polish'],
    ['da', 'Danish'],
    ['fa', 'Persian'],
    ['he', 'Hebrew'],
    ['en', 'English']
  ]
  return languages.find(([prefix]) => normalized.startsWith(prefix))?.[1] ?? 'English'
}

/**
 * 会话内翻译功能（SessionTranslation）：把选中文本经 LLM 翻译成用户界面语言。
 * 模型选择沿用助手模型解析链（Agent 配置 → 全局默认），无可用模型直接报错；
 * temperature 压低到 0.2、输出上限 1024——翻译要的是忠实与克制，不是发挥。
 */
export class SessionTranslation {
  constructor(
    private readonly dependencies: {
      agentManager: Pick<AgentManager, 'resolveBackend'>
      agentSettings: Pick<AgentSettingsPort, 'getDefaultModel' | 'resolveDeepChatAgentConfig'>
      providerRuntime: Pick<ProviderRuntimePort, 'generateCompletion'>
    }
  ) {}

  /** 翻译入口：空文本直接返回空串，不发起任何模型调用。 */
  async translate(text: string, locale?: string, agentId?: string): Promise<string> {
    const input = text?.trim()
    if (!input) return ''

    const defaultModel = this.dependencies.agentSettings.getDefaultModel()
    const selection = await resolveAssistantModelSelection(
      this.dependencies,
      agentId ?? 'deepchat',
      defaultModel?.providerId || '',
      defaultModel?.modelId || ''
    )
    if (!selection.providerId || !selection.modelId) {
      throw new Error('No provider or model configured. Please set a default model in settings.')
    }

    const translated = await this.dependencies.providerRuntime.generateCompletion(
      selection.providerId,
      [
        {
          role: 'system',
          content: `You are a translation assistant. Translate the user input into ${resolveTranslationLanguage(locale)}. Return only the translated text with no explanations.`
        },
        { role: 'user', content: input }
      ],
      selection.modelId,
      0.2,
      1024
    )
    return translated.trim()
  }
}
