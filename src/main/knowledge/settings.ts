import type { SettingsStore } from '@/config/settingsStore'
import type { McpSettings } from '@/mcp/settings'
import type { BuiltinKnowledgeConfig } from '@shared/types/knowledge'

/**
 * 知识库配置的持久化门面：包装 SettingsStore 的 `knowledgeConfigs` 键。
 *
 * 读路径附带一次历史迁移：早期版本把内置知识库的嵌入配置存在环境变量
 * 风格的 MCP 设置里，首次读取时搬到独立键下并回写，之后走零成本快路径。
 * 写路径由 routes.ts 的配置设置路由调用。
 */
export class KnowledgeSettings {
  constructor(
    private readonly settings: SettingsStore,
    private readonly mcpSettings: McpSettings
  ) {}

  /**
   * 读取全部知识库配置；键不存在时返回空数组（首次使用的正常状态，
   * 不是错误）。若触发过迁移则顺带把迁移结果写回存储。
   */
  getKnowledgeConfigs(): BuiltinKnowledgeConfig[] {
    const configs = this.settings.get<BuiltinKnowledgeConfig[]>('knowledgeConfigs') || []
    const migrated = this.mcpSettings.migrateBuiltinKnowledgeConfigsFromEnv(configs)
    // 迁移产生了新值才回写：避免每次读取都做无意义的磁盘写。
    if (migrated !== configs) this.settings.set('knowledgeConfigs', migrated)
    return migrated
  }

  /**
   * 整体覆写配置列表。持久化后由调用方（routes 层）负责驱动
   * KnowledgeService 做增量同步，这里只管存储。
   */
  setKnowledgeConfigs(configs: BuiltinKnowledgeConfig[]): void {
    this.settings.set('knowledgeConfigs', configs)
  }
}
