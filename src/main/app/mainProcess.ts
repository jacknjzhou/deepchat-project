/**
 * 主进程启动序列。
 *
 * 从 appMain 的 whenReady 回调进入，按硬顺序完成：
 * splash 窗口 → 设置存储/密钥/隐私/代理等基础设置 → 主数据库初始化
 * （含损坏恢复，进度推送到 splash）→ 配置存储迁移（json → SQLite）→
 * 自定义协议注册 → 交给 composition.createMainProcessControl 装配全部
 * 服务 → 关闭 splash。
 *
 * 失败路径：任何一步抛错都关闭 splash，然后按装配进度回收——
 * 已拿到 control 走 stopForCleanup()（完整拆卸），否则只关数据库，
 * 最后向上抛给 appMain 弹错误框并退出。
 */
import { electronApp } from '@electron-toolkit/utils'
import { app } from 'electron'
import { createSettingsStore } from '@/config/settingsStore'
import { SecretStore } from '@/config/secretStore'
import { DatabaseSecurityService } from './databaseSecurity'
import { proxyConfig } from '@/platform/proxy'
import type { StartupWorkloadCoordinator } from '@/app/startupWorkloadCoordinator'
import { createMainProcessControl, type MainProcessControl } from './composition'
import { initializeMainDatabaseWithRecovery } from './databaseStartup'
import { registerProtocols } from './protocols'
import { McpAppSandboxRegistry } from '@/mcp/apps/sandboxRegistry'
import { SplashWindow } from './splashWindow'
import { PrivacySettings } from './privacy'
import { ProxySettings } from '@/platform/proxySettings'
import { McpSettings } from '@/mcp/settings'
import { AcpCatalogSettings } from '@/agent/acp/catalog/settings'
import { SettingsDatabase } from '@/settings/data/database'
import { migrateConfigStorage } from '@/config/migration'
import { ProviderDatabase } from '@/provider/data/database'
import { McpDatabase } from '@/mcp/data/database'
import { AgentDatabase } from '@/agent/data/database'
import { mainLogger, setMainLoggingEnabled } from '@/logging'

export type { MainProcessControl } from './composition'

/**
 * 执行完整启动序列并返回主进程控制句柄。
 *
 * 参数 requestUpdateInstall 由 appMain 注入：composition 内的更新模块
 * 需要在退出-安装时借用 appMain 的关停状态机，这里只做透传。
 */
export async function startMainProcess(
  startupWorkloadCoordinator: StartupWorkloadCoordinator,
  startupRunId: string,
  requestUpdateInstall: (installAction: () => void) => Promise<void>
): Promise<MainProcessControl> {
  const splashWindow = new SplashWindow()
  let mainProcess: MainProcessControl | undefined
  let database: Awaited<ReturnType<typeof initializeMainDatabaseWithRecovery>> | undefined

  await splashWindow.create()

  try {
    electronApp.setAppUserModelId('com.wefonk.deepchat')
    const settingsStore = createSettingsStore()
    setMainLoggingEnabled(settingsStore.get<boolean>('loggingEnabled') ?? false)
    const secretStore = new SecretStore(settingsStore)
    const privacySettings = new PrivacySettings(settingsStore)
    const proxySettings = new ProxySettings(settingsStore)
    const mcpSettings = new McpSettings()
    const mcpAppSandboxRegistry = new McpAppSandboxRegistry()
    const acpCatalogSettings = new AcpCatalogSettings({ mcpSettings })
    const databaseSecurityService = new DatabaseSecurityService()
    const securityStatus = databaseSecurityService.getStatus()
    // 数据库加密开启时 splash 需要显示解锁进度；skipDelay 让解锁期不插入
    // 人为的最小展示时长（用户已经在等待真实工作了）。
    splashWindow.showDatabaseUnlockProgress(
      {
        active: securityStatus.enabled,
        safeStorageAvailable: securityStatus.safeStorageAvailable
      },
      { skipDelay: securityStatus.enabled }
    )
    database = await initializeMainDatabaseWithRecovery({
      security: databaseSecurityService,
      splash: splashWindow,
      observe: (observation) => {
        const context = {
          ...(observation.durationMs === undefined ? {} : { durationMs: observation.durationMs }),
          repairAttempted: observation.repairAttempted,
          schemaDiagnosis: observation.schemaDiagnosis,
          repairableIssueCount: observation.repairableIssueCount,
          manualIssueCount: observation.manualIssueCount
        }
        if (observation.outcome === 'failed') {
          mainLogger.emit('database.initialization.terminal', {
            ...context,
            outcome: 'failed',
            error: observation.error
          })
        } else {
          mainLogger.emit('database.initialization.terminal', {
            ...context,
            outcome: 'completed'
          })
        }
      }
    })
    splashWindow.showDatabaseUnlockProgress({
      active: false,
      safeStorageAvailable: databaseSecurityService.getStatus().safeStorageAvailable
    })
    const settingsDatabase = new SettingsDatabase(database)
    const providerDatabase = new ProviderDatabase(database)
    const mcpDatabase = new McpDatabase(database)
    const agentDatabase = new AgentDatabase(database)
    // 一次性配置迁移：把旧 json 存量导入各 SQLite 库并返回版本对比结果；
    // 迁移先于 attach/connect，保证后续读写看到的是已导入的数据。
    const configMigration = migrateConfigStorage({
      database: settingsDatabase,
      providerDatabase,
      mcpDatabase,
      agentDatabase,
      settings: settingsStore,
      mcpSettings: mcpSettings.getMigrationSnapshot(),
      acpCatalog: acpCatalogSettings.getMigrationSnapshot(),
      userDataPath: app.getPath('userData')
    })
    settingsStore.attachDatabase(settingsDatabase)
    mcpSettings.connectDatabase(mcpDatabase)
    acpCatalogSettings.connectDatabase(agentDatabase)
    if (configMigration.appVersionChanged) {
      mcpSettings.onUpgrade(configMigration.previousAppVersion)
    }
    proxyConfig.initFromConfig(proxySettings.getMode(), proxySettings.getCustomUrl())
    await registerProtocols(mcpAppSandboxRegistry)

    // 装配全部主进程服务；bindControl 在装配早期回填引用，使后续错误路径
    // 也能通过 mainProcess 变量触发完整拆卸。
    mainProcess = await createMainProcessControl({
      previousAppVersion: configMigration.previousAppVersion,
      settingsStore,
      secretStore,
      privacySettings,
      proxySettings,
      mcpSettings,
      mcpAppSandboxRegistry,
      acpCatalogSettings,
      database,
      settingsDatabase,
      providerDatabase,
      agentDatabase,
      databaseSecurityService,
      startupWorkloadCoordinator,
      startupRunId,
      requestUpdateInstall,
      onWindowCreated: (isMainWindow) => splashWindow.handleWindowCreated(isMainWindow),
      splash: splashWindow,
      bindControl: (control) => {
        mainProcess = control
      }
    })

    await splashWindow.close()
    return mainProcess
  } catch (error) {
    await splashWindow.close()
    if (mainProcess) {
      await mainProcess.stopForCleanup()
    } else {
      database?.close()
    }
    throw error
  }
}
