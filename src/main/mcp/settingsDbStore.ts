/**
 * MCP 设置的 SQLite 存储适配器：实现 StoreLike 接口，把键值读写桥接到
 * McpSettingsTable。'mcpServers' 是特殊键——不存于通用键值表，而是映射
 * 到专用的 mcp_servers 表（按行存储每个 server 配置）；其余键走
 * mcp_settings 键值表。上层 McpSettings 通过该适配器即可透明切换
 * 文件存储与数据库存储两种后端。
 */

import type { MCPServerConfig } from '@shared/types/mcp'
import type { McpSettingsTable } from './data/settingsTable'
import type { StoreLike } from '@/config/storeLike'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export class McpDbStore implements StoreLike<Record<string, unknown>> {
  constructor(private readonly getSettingsTable: () => McpSettingsTable) {}

  private get settingsTable(): McpSettingsTable {
    return this.getSettingsTable()
  }

  get store(): Record<string, unknown> {
    return {
      ...this.settingsTable.listMcpSettings(),
      mcpServers: this.settingsTable.listMcpServers()
    }
  }

  get<TValue = unknown>(key: string, defaultValue?: TValue): TValue | undefined {
    if (key === 'mcpServers') {
      const servers = this.settingsTable.listMcpServers()
      return (Object.keys(servers).length > 0 ? servers : defaultValue) as TValue | undefined
    }
    const value = this.settingsTable.getMcpSetting<TValue>(key)
    return value === undefined ? defaultValue : value
  }

  set(keyOrValues: string | Record<string, unknown>, value?: unknown): void {
    if (typeof keyOrValues !== 'string') {
      for (const [key, nextValue] of Object.entries(keyOrValues)) this.set(key, nextValue)
      return
    }
    if (keyOrValues === 'mcpServers' && isRecord(value)) {
      this.settingsTable.replaceMcpServers(value as Record<string, MCPServerConfig>)
      return
    }
    this.settingsTable.setMcpSetting(keyOrValues, value)
  }

  delete(key: string): void {
    if (key === 'mcpServers') {
      this.settingsTable.replaceMcpServers({})
      return
    }
    this.settingsTable.deleteMcpSetting(key)
  }

  has(key: string): boolean {
    return key === 'mcpServers'
      ? Object.keys(this.settingsTable.listMcpServers()).length > 0
      : this.settingsTable.getMcpSetting(key) !== undefined
  }
}
