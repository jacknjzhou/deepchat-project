/**
 * MCP 子系统的数据库入口：持有共享连接并提供设置表实例。settingsTable
 * 每次访问都新建轻量包装（无独立状态），连接生命周期由外部 provider 管理。
 */

import type { DatabaseConnectionProvider } from '@/data/databaseConnection'
import { McpSettingsTable } from './settingsTable'

export class McpDatabase {
  constructor(private readonly connection: DatabaseConnectionProvider) {}

  get settingsTable(): McpSettingsTable {
    return new McpSettingsTable(this.connection.getDatabase())
  }
}
