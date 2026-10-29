/**
 * MCP 服务主入口（McpService）。
 *
 * 职责：作为 MCP 子系统的门面，串联三类角色 ——
 * - ServerManager：负责单个 server 的进程/连接生命周期与启动结果；
 * - ToolManager：维护工具注册表（含 staffdeck/ 前缀重命名）并代理调用；
 * - McpOAuthManager：server 凭据与 OAuth 状态。
 *
 * 对外实现 McpServicePort，被 IPC 层与 agent 运行时消费。插件拥有的
 * MCP server（ownerPluginId / source === 'plugin'）走 PluginRuntimeSupervisor
 * 的专属通道，普通 MCP 设置接口对它们一律拒绝，避免两条所有权路径互相覆盖。
 */

import type { ProviderSettingsPort } from '@/provider/settings'
import logger from '@shared/logger'
import { performance } from 'node:perf_hooks'
import type { Prompt } from '@shared/types/prompt'
import {
  type McpElicitationDecision,
  type McpElicitationRequestPayload,
  type McpAppDescriptor,
  type McpClient,
  type McpCredentialBinding,
  type McpCredentialInput,
  type McpCredentialKind,
  type McpCredentialStatus,
  type McpEnterpriseIdentityProfile,
  type McpEnterpriseIdentityStatus,
  type McpExpectedToolTarget,
  type McpSamplingDecision,
  type McpSamplingRequestPayload,
  type MCPServerConfig,
  type McpAddServerResult,
  type McpServerAuthStatus,
  type McpServerDiagnostics,
  type McpServicePort,
  type McpAppHostPort,
  type MCPContentItem,
  type MCPToolCall,
  type MCPToolDefinition,
  type MCPToolResponse,
  type ToolDispatchCommit,
  type ToolOutcomeProjectionRegistrar,
  type PromptListEntry,
  type Resource,
  type ResourceListEntry
} from '@shared/types/mcp'
import type { ToolCallImagePreview } from '@shared/types/core/mcp'
import type { ProviderRuntimePort } from '@shared/types/provider'
import { ServerManager } from './serverManager'
import type { McpClient as RuntimeMcpClient } from './mcpClient'
import { ToolManager, type ComputerUsePreviewObserver } from './toolManager'
import { McpRouterManager } from './mcprouterManager'
import {
  AUTH_EXTENSION_CLIENT_CREDENTIALS,
  MCP_CLIENT_CREDENTIALS_DRAFT_REVISION,
  McpOAuthManager
} from './mcpOAuthManager'
import { prepareToolCallImageContent } from '@/lib/toolCallImagePreviews'
import type { InMemoryServerFactory } from './inMemoryServers/builder'
import type { PromptSettings } from '@/agent/promptSettings'
import type { PrivacySettingsPort } from '@/app/privacy'
import type { AgentSettingsPort } from '@/agent/settings'
import { PluginRuntimeSupervisor } from '@/plugin/runtimeSupervisor'
import type { DeepchatEventPublisher } from '@shared/contracts/events'
import type { SemanticNotificationPublisher } from '@/notifications'
import { McpSettings } from './settings'
import type { PermissionMode } from '@shared/types/agent-interface'
import type { ToolPermissionBroker } from '@/tool/permission'
import type { McpAppSandboxRegistry } from './apps/sandboxRegistry'
import { McpAppHost } from './apps/appHost'
import { hasMcpIdentityBearingChange } from './serverIdentity'
import type { CacheImageOptions } from '@/platform/imageCache'
import { awaitWithAbort } from '@/lib/awaitWithAbort'

/**
 * 一次工具调用/枚举的可见范围约束。`enabledTools` 按工具名、
 * `enabledServerIds` 按 server 名做白名单过滤；两者都不传表示不限制。
 * agentId / conversationId 仅作标识透传，不参与过滤。
 */
type McpToolAccessContext = {
  enabledTools?: string[]
  enabledServerIds?: string[]
  agentId?: string
  conversationId?: string
}

/** 关停单个 stdio server 的最长等待，超时后强制终止进程树。 */
const MCP_SHUTDOWN_SERVER_TIMEOUT_MS = 10_000
/** 应用关停时并发停止 server 的数量；过高会让日志与进程回收互相踩踏。 */
const MCP_SHUTDOWN_CONCURRENCY = 4
/** sampling/elicitation 待决请求上限，防止恶意 server 把主进程内存打爆。 */
const MCP_MAX_PENDING_INTERACTIONS = 64

const normalizeStringList = (items?: string[]): string[] | undefined => {
  if (!Array.isArray(items)) {
    return undefined
  }
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)))
}

const normalizeToolAccessContext = (
  input?: string[] | McpToolAccessContext
): McpToolAccessContext => {
  if (Array.isArray(input)) {
    return { enabledTools: normalizeStringList(input) }
  }
  return {
    enabledTools: normalizeStringList(input?.enabledTools),
    enabledServerIds: normalizeStringList(input?.enabledServerIds),
    agentId: input?.agentId?.trim() || undefined,
    conversationId: input?.conversationId?.trim() || undefined
  }
}

export class McpService implements McpServicePort {
  public readonly appHost: McpAppHostPort | null
  private serverManager: ServerManager
  private toolManager: ToolManager
  private mcpOAuthManager: McpOAuthManager
  private providerSettings: Pick<ProviderSettingsPort, 'getProviderModels' | 'getCustomModels'>
  private readonly promptSettings: Pick<PromptSettings, 'getCustomPrompts'>
  private readonly mcpSettings: McpSettings
  private readonly privacy: PrivacySettingsPort
  private isInitialized: boolean = false
  // McpRouter
  private mcprouter?: McpRouterManager
  private cacheImage?: (data: string, options?: CacheImageOptions) => Promise<string>
  private readonly onRegistryChanged: () => void
  private shutdownPromise: Promise<void> | null = null
  private addMcpServerTail: Promise<void> = Promise.resolve()
  private readonly pluginRuntimeSupervisor: PluginRuntimeSupervisor
  private readonly mcpAppSandboxRegistry?: McpAppSandboxRegistry
  private pendingSamplingRequests = new Map<
    string,
    { resolve: (decision: McpSamplingDecision) => void; reject: (error: Error) => void }
  >()
  private pendingElicitationRequests = new Map<
    string,
    { resolve: (decision: McpElicitationDecision) => void; reject: (error: Error) => void }
  >()

  private emitServerStarted(serverName: string): void {
    this.publishEvent('mcp.server.started', {
      serverName,
      version: Date.now()
    })
  }

  private emitServerStopped(serverName: string): void {
    this.publishEvent('mcp.server.stopped', {
      serverName,
      version: Date.now()
    })
  }

  /**
   * 后台启动一个 server，不等待连接：连接成功（含软超时后台连上）时记
   * 日志并发 started 事件，失败只记错误。初始化阶段的所有启动都走这里，
   * 保证启动失败不会阻塞主流程。
   */
  private startServerInBackground(
    serverName: string,
    successMessage: string,
    failureMessage: string
  ): void {
    void this.serverManager
      .startServer(serverName, {
        onBackgroundConnected: () => {
          logger.info(successMessage)
          this.emitServerStarted(serverName)
        }
      })
      .then((connectResult) => {
        if (connectResult === 'connected') {
          logger.info(successMessage)
          this.emitServerStarted(serverName)
        } else if (connectResult === 'soft-timeout-released') {
          logger.info(`[MCP] Server ${serverName} startup released after soft timeout`)
        }
      })
      .catch((error) => {
        console.error(failureMessage, error)
      })
  }

  constructor(
    providerSettings: Pick<ProviderSettingsPort, 'getProviderModels' | 'getCustomModels'>,
    agentSettings: Pick<AgentSettingsPort, 'getAcpAgents' | 'getAgentMcpSelections'>,
    promptSettings: Pick<PromptSettings, 'getCustomPrompts'>,
    mcpSettings: McpSettings,
    privacy: PrivacySettingsPort,
    inMemoryServerFactory: InMemoryServerFactory,
    providerRuntime: Pick<ProviderRuntimePort, 'generateCompletionStandalone'>,
    onRegistryChanged: () => void,
    semanticNotifications: SemanticNotificationPublisher,
    private readonly publishEvent: DeepchatEventPublisher,
    cacheImage?: (data: string, options?: CacheImageOptions) => Promise<string>,
    pluginRuntimeSupervisor?: PluginRuntimeSupervisor,
    computerUsePreviewObserver?: ComputerUsePreviewObserver,
    mcpApps?: {
      registry: McpAppSandboxRegistry
      permissionBroker: ToolPermissionBroker
      getPermissionMode(conversationId: string): Promise<PermissionMode>
      validateSource(input: {
        descriptor: McpAppDescriptor
        conversationId: string
        messageId: string
        blockId: string
        toolInput: Record<string, unknown>
      }): boolean
      persistModelContext(
        messageId: string,
        blockId: string,
        descriptor: McpAppDescriptor,
        toolInput: Record<string, unknown>,
        context: {
          content?: MCPContentItem[]
          structuredContent?: Record<string, unknown>
          approvedHash: string
        }
      ): boolean
    },
    private readonly onInitializationFailed: () => void = () => undefined
  ) {
    logger.info('Initializing MCP service')

    this.providerSettings = providerSettings
    this.promptSettings = promptSettings
    this.mcpSettings = mcpSettings
    this.privacy = privacy
    this.cacheImage = cacheImage
    this.onRegistryChanged = onRegistryChanged
    this.pluginRuntimeSupervisor = pluginRuntimeSupervisor ?? new PluginRuntimeSupervisor()
    this.mcpAppSandboxRegistry = mcpApps?.registry
    this.mcpOAuthManager = new McpOAuthManager(
      undefined,
      this.publishEvent,
      (serverName) => this.restartServerAfterAuthentication(serverName),
      this.mcpSettings,
      (serverId) => {
        this.revokeMcpAppsByServer(serverId)
        this.handleRegistryChanged()
      }
    )
    this.serverManager = new ServerManager(
      this.mcpSettings,
      this.privacy,
      inMemoryServerFactory,
      {
        sampling: this,
        elicitation: this,
        completion: providerRuntime,
        config: this.providerSettings
      },
      () => this.handleRegistryChanged(),
      semanticNotifications,
      this.publishEvent,
      this.mcpOAuthManager
    )
    this.toolManager = new ToolManager(
      agentSettings,
      this.mcpSettings,
      this.serverManager,
      semanticNotifications,
      this.publishEvent,
      {
        ownsServer: (serverName) => this.pluginRuntimeSupervisor.ownsServer(serverName),
        isServerAvailable: (serverName) =>
          this.pluginRuntimeSupervisor.isServerAvailable(serverName),
        getOwnerPluginId: (serverName) => this.pluginRuntimeSupervisor.getOwnerPluginId(serverName),
        getAvailableToolCatalogs: () => this.pluginRuntimeSupervisor.getAvailableToolCatalogs(),
        getAvailableToolServerNames: () =>
          this.pluginRuntimeSupervisor.getAvailableToolServerNames(),
        ensureRunning: (serverName, reason) =>
          this.pluginRuntimeSupervisor.ensureRunning(serverName, reason)
      },
      computerUsePreviewObserver
    )
    this.appHost = mcpApps
      ? new McpAppHost({
          settings: this.mcpSettings,
          serverManager: this.serverManager,
          permissionBroker: mcpApps.permissionBroker,
          registry: mcpApps.registry,
          ensureServerRunning: async (serverName) => {
            if (this.pluginRuntimeSupervisor.ownsServer(serverName)) {
              await this.pluginRuntimeSupervisor.ensureRunning(serverName, 'external')
              return
            }
            await this.serverManager.startServer(serverName, { waitForConnection: true })
          },
          getPermissionMode: mcpApps.getPermissionMode,
          validateSource: mcpApps.validateSource,
          persistModelContext: mcpApps.persistModelContext
        })
      : null
    this.pluginRuntimeSupervisor.attachProcessPort({
      isReady: () => this.isReady(),
      isRunning: (serverName) => this.serverManager.isServerRunning(serverName),
      isActive: (serverName) => this.serverManager.isServerActive(serverName),
      start: (serverName, configOverride) =>
        this.startServerDirect(serverName, configOverride, true),
      stop: (serverName, mode) =>
        mode === 'shutdown'
          ? this.stopPluginServerDuringShutdownDirect(serverName)
          : this.stopServerDirect(serverName)
    })
    this.pluginRuntimeSupervisor.subscribeRegistryChanged(() => this.handleRegistryChanged())
    // init mcprouter manager
    try {
      this.mcprouter = new McpRouterManager(this.mcpSettings)
    } catch (e) {
      console.warn('[MCP] McpRouterManager init failed:', e)
    }
  }

  handleConfigChanged(): void {
    this.handleRegistryChanged()
  }

  revokeMcpAppsByServer(serverId: string): void {
    this.mcpAppSandboxRegistry?.revokeByServer(serverId)
  }

  /**
   * 注册表变化（配置增删改、插件注册等）后的统一失效入口：
   * 工具注册表缓存作废 + 通知 renderer 刷新。所有状态写入路径都应汇到这里。
   */
  private handleRegistryChanged(): void {
    this.toolManager.invalidateRegistry()
    this.onRegistryChanged()
  }

  private isPrivacyModeEnabled(): boolean {
    return this.privacy.isEnabled()
  }

  private isPluginOwnedServerConfig(config?: Partial<MCPServerConfig> | null): boolean {
    return Boolean(config?.ownerPluginId || config?.source === 'plugin')
  }

  private async isPluginOwnedServerName(serverName: string): Promise<boolean> {
    if (this.pluginRuntimeSupervisor.ownsServer(serverName)) {
      return true
    }
    const servers = await this.mcpSettings.getMcpServers()
    return this.isPluginOwnedServerConfig(servers[serverName])
  }

  private isServerAllowedByContext(serverName: string, context: McpToolAccessContext): boolean {
    if (this.pluginRuntimeSupervisor.isServerAvailable(serverName)) {
      return true
    }

    return !context.enabledServerIds || context.enabledServerIds.includes(serverName)
  }

  /**
   * 应用启动时的初始化编排，只执行一次：
   * 1. 读取配置；2. 探测 npm registry（隐私模式下跳过网络探测）；
   * 3. 后台启动内置 custom-prompts server 与所有已启用的普通 server
   *    （不等待连接完成，避免拖慢启动）；4. 延迟刷新 registry 并补启漏掉的 server。
   * 即使中途抛错也会把 isInitialized 置真，防止系统卡死在未初始化状态。
   */
  async initialize() {
    if (this.isInitialized) {
      return
    }

    try {
      // Load configuration
      const [servers, enabledServers, mcpEnabled] = await Promise.all([
        this.mcpSettings.getMcpServers(),
        this.mcpSettings.getEnabledMcpServers(),
        this.mcpSettings.getMcpEnabled()
      ])

      // Initialize npm registry (prefer cache if available)
      if (this.isPrivacyModeEnabled()) {
        logger.info('[MCP] Privacy mode enabled, skipping automatic npm registry detection')
      } else {
        logger.info('[MCP] Initializing npm registry...')
        try {
          await this.serverManager.testNpmRegistrySpeed(true)
          logger.info(`[MCP] npm registry initialized: ${this.serverManager.getNpmRegistry()}`)
        } catch (error) {
          console.error('[MCP] npm registry initialization failed:', error)
        }
      }

      // Check and start deepchat-inmemory/custom-prompts-server
      const customPromptsServerName = 'deepchat-inmemory/custom-prompts-server'
      const startingServers = new Set<string>()
      if (mcpEnabled && servers[customPromptsServerName]) {
        logger.info(`[MCP] Attempting to start custom prompts server: ${customPromptsServerName}`)
        startingServers.add(customPromptsServerName)
        this.startServerInBackground(
          customPromptsServerName,
          `[MCP] Custom prompts server ${customPromptsServerName} started successfully`,
          `[MCP] Failed to start custom prompts server ${customPromptsServerName}:`
        )
      }

      if (enabledServers.length > 0) {
        for (const serverName of enabledServers) {
          const serverConfig = servers[serverName]
          if (
            serverConfig &&
            !startingServers.has(serverName) &&
            mcpEnabled &&
            !this.isPluginOwnedServerConfig(serverConfig) &&
            !this.pluginRuntimeSupervisor.ownsServer(serverName)
          ) {
            logger.info(`[MCP] Attempting to start enabled server: ${serverName}`)
            startingServers.add(serverName)
            this.startServerInBackground(
              serverName,
              `[MCP] Enabled server ${serverName} started successfully`,
              `[MCP] Failed to start enabled server ${serverName}:`
            )
          }
        }
      }

      // Mark initialization complete
      this.isInitialized = true
      logger.info('[MCP] Initialization completed')

      this.scheduleBackgroundRegistryUpdate()
      void this.retryUnstartedEnabledServers().catch((error) => {
        console.error('[MCP] Failed to retry unstarted enabled servers:', error)
      })
    } catch (error) {
      console.error('[MCP] Initialization failed:', error)
      // Mark as complete even if initialization fails to avoid system stuck in uninitialized state
      this.isInitialized = true
      try {
        this.onInitializationFailed()
      } catch {
        // Diagnostics must not alter MCP initialization compatibility.
      }
    }
  }

  /**
   * 关停全部 MCP 客户端。用 shutdownPromise 保证幂等：并发调用共享同一次
   * 关停过程，完成后清空句柄，允许极端情况下的再次关停。
   */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise
    }

    this.shutdownPromise = this.shutdownRunningClients()
    try {
      await this.shutdownPromise
    } finally {
      this.shutdownPromise = null
    }
  }

  /**
   * 关停的实际执行体：先拒绝还在等待的 sampling/elicitation 请求（server
   * 已不可用，继续等待只会挂死调用方），再停插件运行时，最后以有限并发
   * （MCP_SHUTDOWN_CONCURRENCY）停掉其余活跃客户端。
   */
  private async shutdownRunningClients(): Promise<void> {
    for (const requestId of this.pendingSamplingRequests.keys()) {
      await this.cancelSamplingRequest(requestId, 'MCP service is shutting down')
    }
    for (const requestId of this.pendingElicitationRequests.keys()) {
      await this.cancelElicitationRequest(requestId, 'MCP service is shutting down')
    }

    try {
      await this.pluginRuntimeSupervisor.shutdown()
    } catch (error) {
      console.error('[MCP] Failed to stop plugin-owned runtimes during shutdown:', error)
    }

    const activeClients = (await this.serverManager.getActiveClients()).filter(
      (client) => !this.pluginRuntimeSupervisor.ownsServer(client.serverName)
    )
    let nextIndex = 0

    const stopNext = async (): Promise<void> => {
      while (nextIndex < activeClients.length) {
        const client = activeClients[nextIndex++]
        await this.stopServerDuringShutdown(client)
      }
    }

    const workers = Array.from(
      { length: Math.min(MCP_SHUTDOWN_CONCURRENCY, activeClients.length) },
      () => stopNext()
    )
    await Promise.all(workers)
  }

  async stopServerDuringShutdownByName(serverName: string): Promise<void> {
    if (this.pluginRuntimeSupervisor.ownsServer(serverName)) {
      await this.pluginRuntimeSupervisor.requestExternalStop(serverName)
      return
    }
    const client = this.serverManager.getClient(serverName)
    if (!client) {
      return
    }

    await this.stopServerDuringShutdown(client)
  }

  private async stopPluginServerDuringShutdownDirect(serverName: string): Promise<void> {
    const client = this.serverManager.getClient(serverName)
    if (!client) {
      return
    }
    await this.stopServerDuringShutdown(client, true)
  }

/**
 * 应用关停时的停止路径：与用户手动 stopServer 不同，这里必须保证最终退出，
 * 因此超时后强制终止 stdio 进程树而不是无限等待。
 * `failOnIncompleteStop` 仅用于插件运行时 server：插件回收失败要向上抛错，
 * 普通 server 停不掉则只记日志、继续关停其余 server。
 */
  private async stopServerDuringShutdown(
    client: RuntimeMcpClient,
    failOnIncompleteStop = false
  ): Promise<void> {
    const startedAt = performance.now()
    let timeoutId: NodeJS.Timeout | null = null
    let timedOut = false

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true
        reject(new Error(`MCP server ${client.serverName} stop timed out`))
      }, MCP_SHUTDOWN_SERVER_TIMEOUT_MS)
    })

    try {
      await Promise.race([this.stopServerDirect(client.serverName), timeoutPromise])
      console.info(
        `[MCP] Stopped server ${client.serverName} during shutdown durationMs=${(performance.now() - startedAt).toFixed(1)}`
      )
    } catch (error) {
      if (timedOut) {
        const forceTerminated = await client.forceTerminateStdioProcessTree(
          `shutdown stop timed out after ${MCP_SHUTDOWN_SERVER_TIMEOUT_MS}ms`
        )
        console.warn('[MCP] Server stop timed out during shutdown; continuing shutdown:', {
          serverName: client.serverName,
          timeoutMs: MCP_SHUTDOWN_SERVER_TIMEOUT_MS,
          durationMs: Number((performance.now() - startedAt).toFixed(1)),
          forceTerminatedStdioProcess: forceTerminated,
          note: forceTerminated
            ? 'stdio process tree force termination was attempted; the underlying stop promise may still finish later'
            : 'no stdio process tree was available to force terminate; underlying stop may still be pending'
        })
        if (failOnIncompleteStop && !forceTerminated) {
          throw new Error(
            `Plugin runtime server ${client.serverName} could not be terminated during shutdown`
          )
        }
        return
      }

      console.error(`[MCP] Failed to stop server ${client.serverName} during shutdown:`, error)
      if (failOnIncompleteStop) {
        throw error
      }
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  }

  /**
   * OAuth 完成或凭据更新后重启 server，使新凭据立即生效。
   * 插件运行时管理的 server 走 supervisor 重启；配置里标记为插件所有但
   * 插件已注册的（isPluginOwnedServerName 为 true 但 ownsServer 为 false，
   * 即插件已禁用）拒绝重启，未启用的 server 也不启动。
   * 失败只记日志——认证回调不应因重启失败而对用户报错。
   */
  private async restartServerAfterAuthentication(serverName: string): Promise<void> {
    try {
      if (await this.pluginRuntimeSupervisor.restartIfRunning(serverName, 'authentication')) {
        return
      }
      const servers = await this.mcpSettings.getMcpServers()
      const serverConfig = servers[serverName]
      if (this.isPluginOwnedServerConfig(serverConfig)) {
        console.warn(
          `[MCP] Refusing to restart unregistered plugin-owned server ${serverName} after authentication`
        )
        return
      }
      if (!serverConfig?.enabled) {
        return
      }

      const connectResult = await this.serverManager.startServer(serverName, {
        onBackgroundConnected: () => this.emitServerStarted(serverName)
      })
      if (connectResult === 'connected') {
        this.emitServerStarted(serverName)
      }
    } catch (error) {
      console.error(`[MCP] Failed to restart authenticated server ${serverName}:`, error)
    }
  }

  // =============== McpRouter marketplace APIs ===============
  async listMcpRouterServers(
    page: number,
    limit: number
  ): Promise<{
    servers: Array<{
      uuid: string
      created_at: string
      updated_at: string
      name: string
      author_name: string
      title: string
      description: string
      content?: string
      server_key: string
      config_name?: string
      server_url?: string
    }>
  }> {
    if (!this.mcprouter) throw new Error('McpRouterManager not available')
    const data = await this.mcprouter.listServers(page, limit)
    return { servers: data && data.servers ? data.servers : [] }
  }

  async installMcpRouterServer(serverKey: string): Promise<boolean> {
    if (!this.mcprouter) throw new Error('McpRouterManager not available')
    return this.mcprouter.installServer(serverKey)
  }

  async getMcpRouterApiKey(): Promise<string> {
    return this.mcpSettings.getRouterApiKey()
  }

  async setMcpRouterApiKey(key: string): Promise<void> {
    const normalizedApiKey = key.trim()
    await this.synchronizeMcpRouterServersAuth(normalizedApiKey)
  }

  async isServerInstalled(source: string, sourceId: string): Promise<boolean> {
    const servers = await this.mcpSettings.getMcpServers()
    for (const config of Object.values(servers)) {
      if (config.source === source && config.sourceId === sourceId) {
        return true
      }
    }
    return false
  }

  async listInstalledServerIds(source: string, sourceIds: string[]): Promise<string[]> {
    const requestedIds = new Set(sourceIds)
    if (requestedIds.size === 0) return []

    const installedIds = new Set<string>()
    const servers = await this.mcpSettings.getMcpServers()
    for (const config of Object.values(servers)) {
      if (config.source === source && config.sourceId && requestedIds.has(config.sourceId)) {
        installedIds.add(config.sourceId)
      }
    }
    return [...installedIds]
  }

  /**
   * 用户更新 router API key 后，把所有 mcprouter 来源 server 的 Authorization
   * 头同步为 `Bearer <newKey>`。旧 key 失效意味着凭据作废：先撤销关联的
   * MCP App 授权，再一次性写回 key 与 server 列表（两值必须原子写入，
   * 否则可能出现「新 key 配旧头」的中间态），最后清空这些 server 的 OAuth 凭据。
   * 无实际变化时直接返回，避免无谓的写入与重连。
   */
  private async synchronizeMcpRouterServersAuth(normalizedApiKey: string): Promise<void> {
    const currentApiKey = this.mcpSettings.getRouterApiKey()
    const servers = await this.mcpSettings.getMcpServers()
    let updatedServerCount = 0
    const invalidatedServerIds = new Set<string>()

    for (const [serverName, config] of Object.entries(servers)) {
      if (config.source !== 'mcprouter') {
        continue
      }

      const updatedHeaders = { ...config.customHeaders }
      const authorizationHeaderNames = Object.keys(updatedHeaders).filter(
        (name) => name.toLowerCase() === 'authorization'
      )
      const expectedAuthorization = normalizedApiKey ? `Bearer ${normalizedApiKey}` : undefined
      const alreadySynchronized = expectedAuthorization
        ? authorizationHeaderNames.length === 1 &&
          authorizationHeaderNames[0] === 'Authorization' &&
          updatedHeaders.Authorization === expectedAuthorization
        : authorizationHeaderNames.length === 0

      if (alreadySynchronized) {
        continue
      }

      for (const name of authorizationHeaderNames) {
        delete updatedHeaders[name]
      }
      if (expectedAuthorization) {
        updatedHeaders.Authorization = expectedAuthorization
      }

      servers[serverName] = {
        ...config,
        customHeaders: updatedHeaders
      }
      if (config.serverId) {
        invalidatedServerIds.add(config.serverId)
      }
      updatedServerCount += 1
    }

    if (currentApiKey === normalizedApiKey && updatedServerCount === 0) {
      return
    }

    for (const serverId of invalidatedServerIds) {
      this.revokeMcpAppsByServer(serverId)
    }

    this.mcpSettings.setRouterApiKeyAndServers(
      normalizedApiKey,
      updatedServerCount > 0 ? servers : undefined
    )
    for (const serverId of invalidatedServerIds) {
      this.mcpOAuthManager.clearServerCredentials(serverId)
    }
    logger.info(`Synchronized Authorization for ${updatedServerCount} mcprouter servers`)
  }

  /**
   * 初始化完成 5 秒后后台复测 npm registry 速度并择优切换。
   * 延迟是为了避开启动高峰；隐私模式下两次都检查，防止延迟窗口内开关被打开。
   */
  private scheduleBackgroundRegistryUpdate(): void {
    if (this.isPrivacyModeEnabled()) {
      return
    }

    setTimeout(async () => {
      if (this.isPrivacyModeEnabled()) {
        return
      }

      try {
        await this.serverManager.updateNpmRegistryInBackground()
      } catch (error) {
        console.error('[MCP] Background registry update failed:', error)
      }
    }, 5000)
  }

  // Add method to get initialization status
  isReady(): boolean {
    return this.isInitialized
  }

  // Get MCP server configuration
  getMcpServers(): Promise<Record<string, MCPServerConfig>> {
    return this.mcpSettings.getMcpServers()
  }

  // Get all MCP servers
  /**
   * 枚举当前运行中的客户端及其工具/提示/资源，供 MCP 中心页展示。
   * MCP 总开关关闭时仅保留插件可用的 server；prompts/resources 逐一拉取，
   * 单个 server 失败不影响其余条目（该 server 只是缺 prompts/resources）。
   */
  async getMcpClients(): Promise<McpClient[]> {
    const enabled = await this.mcpSettings.getMcpEnabled()
    const clients = (await this.toolManager.getRunningClients()).filter(
      (client) => enabled || this.pluginRuntimeSupervisor.isServerAvailable(client.serverName)
    )
    const toolDefinitions = await this.toolManager.getAllToolDefinitions()
    const clientsList: McpClient[] = []
    for (const client of clients) {
      const results = toolDefinitions.filter(
        (definition) => definition.server.name === client.serverName
      )

      // Create client basic info object
      const clientObj: McpClient = {
        name: client.serverName,
        icon: client.serverConfig['icons'] as string,
        isRunning: client.isServerRunning(),
        tools: results
      }

      // Check and add prompts (if supported)
      if (typeof client.listPrompts === 'function') {
        try {
          const prompts = await client.listPrompts()
          if (prompts && prompts.length > 0) {
            clientObj.prompts = prompts.map((prompt) => ({
              id: prompt.name,
              name: prompt.name,
              content: prompt.description || '',
              description: prompt.description || '',
              arguments: prompt.arguments || [],
              client: {
                name: client.serverName,
                icon: client.serverConfig['icons'] as string
              }
            }))
          }
        } catch (error) {
          console.error(
            `[MCP] Failed to get prompt templates for client ${client.serverName}:`,
            error
          )
        }
      }

      // Check and add resources (if supported)
      if (typeof client.listResources === 'function') {
        try {
          const resources = await client.listResources()
          if (resources && resources.length > 0) {
            clientObj.resources = resources
          }
        } catch (error) {
          console.error(`[MCP] Failed to get resources for client ${client.serverName}:`, error)
        }
      }

      clientsList.push(clientObj)
    }
    return clientsList
  }

  getEnabledMcpServers(): Promise<string[]> {
    return this.mcpSettings.getEnabledMcpServers()
  }

  /**
   * 启停单个 server 的设置入口。插件所有的 server 归插件管理，这里直接
   * 抛错而非静默忽略——用户界面不应出现对这些 server 的无效操作。
   * 禁用时先撤销该 server 名下的 MCP App 授权，防止停用后 App 仍可调用。
   */
  async setMcpServerEnabled(serverName: string, enabled: boolean): Promise<void> {
    const servers = await this.mcpSettings.getMcpServers()
    const serverConfig = servers[serverName]
    if (this.pluginRuntimeSupervisor.ownsServer(serverName)) {
      throw new Error(
        `Plugin-owned MCP server "${serverName}" is controlled by its plugin, not MCP settings`
      )
    }
    if (this.isPluginOwnedServerConfig(serverConfig)) {
      throw new Error(
        `Plugin-owned MCP server "${serverName}" is not registered by an enabled plugin`
      )
    }

    if (!enabled && serverConfig?.serverId) {
      this.revokeMcpAppsByServer(serverConfig.serverId)
    }
    await this.mcpSettings.setMcpServerEnabled(serverName, enabled)
    if (
      !this.isPluginOwnedServerConfig(serverConfig) &&
      !(await this.mcpSettings.getMcpEnabled())
    ) {
      return
    }

    if (enabled) {
      await this.startServer(serverName)
      return
    }

    await this.stopServer(serverName)
  }

  // Add MCP server
  /**
   * 新增 server。通过 addMcpServerTail 把所有写入串成队列：并发 add 时
   * 逐个读-判重-写，否则两个同名请求可能同时通过判重造成双写。
   * 已存在时返回 { status: 'duplicate' } 而不抛错，由调用方决定提示方式。
   */
  async addMcpServer(serverName: string, config: MCPServerConfig): Promise<McpAddServerResult> {
    const result = this.addMcpServerTail.then(() => this.addMcpServerOnce(serverName, config))
    this.addMcpServerTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async addMcpServerOnce(
    serverName: string,
    config: MCPServerConfig
  ): Promise<McpAddServerResult> {
    if (this.pluginRuntimeSupervisor.ownsServer(serverName)) {
      throw new Error(`MCP server "${serverName}" is owned by an enabled plugin`)
    }
    const existingServers = await this.getMcpServers()
    if (existingServers[serverName]) {
      return { status: 'duplicate' }
    }
    await this.mcpSettings.addMcpServer(serverName, config)
    return { status: 'added' }
  }

  // Update MCP server configuration
  /**
   * 更新配置。若变更携带身份语义（serverIdentity 判定）或被禁用，先撤销
   * MCP App 授权；configGeneration 变化说明连接参数实质改变，凭据一并作废。
   * 正在运行的 server 停止后立即重启以套用新配置；重启失败时补发
   * SERVER_STOPPED 事件，让 UI 状态与真实运行状态保持一致。
   */
  async updateMcpServer(serverName: string, config: Partial<MCPServerConfig>): Promise<void> {
    const servers = await this.mcpSettings.getMcpServers()
    if (
      this.pluginRuntimeSupervisor.ownsServer(serverName) ||
      this.isPluginOwnedServerConfig(servers[serverName])
    ) {
      throw new Error(
        `Plugin-owned MCP server "${serverName}" cannot be edited through MCP settings`
      )
    }
    const wasRunning = this.serverManager.isServerRunning(serverName)
    const previousConfig = servers[serverName]
    if (
      previousConfig?.serverId &&
      (config.enabled === false ||
        hasMcpIdentityBearingChange(previousConfig, { ...previousConfig, ...config }))
    ) {
      this.revokeMcpAppsByServer(previousConfig.serverId)
    }
    await this.mcpSettings.updateMcpServer(serverName, config)
    const updatedConfig = (await this.mcpSettings.getMcpServers())[serverName]
    if (
      previousConfig?.serverId &&
      updatedConfig?.configGeneration !== previousConfig.configGeneration
    ) {
      this.mcpOAuthManager.clearServerCredentials(previousConfig.serverId)
    }

    // If server was previously running, restart it to apply new configuration
    if (wasRunning) {
      logger.info(`[MCP] Configuration updated, restarting server: ${serverName}`)
      try {
        await this.stopServer(serverName) // stopServer will emit SERVER_STOPPED event
        await this.startServer(serverName) // startServer will emit SERVER_STARTED event
        logger.info(`[MCP] Server ${serverName} restarted successfully`)
      } catch (error) {
        console.error(`[MCP] Failed to restart server ${serverName}:`, error)
        // Even if restart fails, ensure correct state by marking as not running
        this.emitServerStopped(serverName)
      }
    }
  }

  // Remove MCP server
  /**
   * 删除 server：撤销 App 授权 → 若在运行先停止 → 清 OAuth 凭据 → 从
   * 设置中移除。顺序保证不留孤儿进程与孤儿凭据。
   */
  async removeMcpServer(serverName: string): Promise<void> {
    const currentServers = await this.mcpSettings.getMcpServers()
    if (
      this.pluginRuntimeSupervisor.ownsServer(serverName) ||
      this.isPluginOwnedServerConfig(currentServers[serverName])
    ) {
      throw new Error(`Plugin-owned MCP server "${serverName}" must be removed by its plugin`)
    }
    const serverId = currentServers[serverName]?.serverId
    if (serverId) {
      this.revokeMcpAppsByServer(serverId)
    }
    // If server is running, stop it first
    if (await this.isServerRunning(serverName)) {
      await this.stopServer(serverName)
    }
    const servers = await this.mcpSettings.getMcpServers()
    const persistedServerId = servers[serverName]?.serverId
    if (persistedServerId) {
      this.mcpOAuthManager.clearServerCredentials(persistedServerId)
    }
    await this.mcpSettings.removeMcpServer(serverName)
  }

  /**
   * 补启「配置为启用但尚未运行」的普通 server。典型时机是工具链 PATH
   * 刷新后（如用户刚安装 node/uv，之前因缺运行环境启动失败）。
   * 已在启动/运行中、插件所有的 server 一律跳过。
   */
  async retryUnstartedEnabledServers(): Promise<void> {
    if (!this.isInitialized) return
    const [servers, enabledServers, mcpEnabled] = await Promise.all([
      this.mcpSettings.getMcpServers(),
      this.mcpSettings.getEnabledMcpServers(),
      this.mcpSettings.getMcpEnabled()
    ])
    if (!mcpEnabled) return
    for (const serverName of enabledServers) {
      const serverConfig = servers[serverName]
      if (
        !serverConfig ||
        this.serverManager.isServerActive(serverName) ||
        this.isPluginOwnedServerConfig(serverConfig) ||
        this.pluginRuntimeSupervisor.ownsServer(serverName)
      ) {
        continue
      }
      this.startServerInBackground(
        serverName,
        `[MCP] Enabled server ${serverName} started after toolchain PATH refresh`,
        `[MCP] Failed to retry enabled server ${serverName}:`
      )
    }
  }

  async isServerRunning(serverName: string): Promise<boolean> {
    return Promise.resolve(this.serverManager.isServerRunning(serverName))
  }

  async isServerActive(serverName: string): Promise<boolean> {
    return Promise.resolve(this.serverManager.isServerActive(serverName))
  }

  /**
   * 通用的启动入口，插件所有的 server 被拒绝（应由插件运行时启动）。
   * 实际工作交给 startServerDirect。
   */
  async startServer(serverName: string): Promise<void> {
    if (this.pluginRuntimeSupervisor.ownsServer(serverName)) {
      throw new Error(
        `Plugin-owned MCP server "${serverName}" cannot be started through the generic MCP route`
      )
    }
    if (await this.isPluginOwnedServerName(serverName)) {
      throw new Error(
        `Plugin-owned MCP server "${serverName}" is not registered by an enabled plugin`
      )
    }
    await this.startServerDirect(serverName)
  }

  /**
   * 启动的内部实现，供插件运行时等可信调用方复用。
   * waitForConnection=false 时采用后台连接语义：软超时后先返回、连接成功
   * 再发 started 事件（onBackgroundConnected）；waitForConnection=true 时
   * 阻塞到连接结果，进程中途退出则抛错——调用方（如 McpAppHost）需要
   * 确定性结论而非「可能稍后就好」。
   */
  private async startServerDirect(
    serverName: string,
    configOverride?: Partial<MCPServerConfig>,
    waitForConnection = false
  ): Promise<void> {
    const connectResult = await this.serverManager.startServer(serverName, {
      onBackgroundConnected: waitForConnection
        ? undefined
        : () => this.emitServerStarted(serverName),
      configOverride,
      waitForConnection
    })
    if (connectResult === 'connected') {
      this.emitServerStarted(serverName)
      return
    }
    if (connectResult === 'stopped' && waitForConnection) {
      throw new Error(`Plugin runtime server "${serverName}" stopped during startup`)
    }
  }

  /**
   * 通用停止入口，插件所有的 server 拒绝（与 startServer 对称）。
   */
  async stopServer(serverName: string): Promise<void> {
    if (this.pluginRuntimeSupervisor.ownsServer(serverName)) {
      throw new Error(
        `Plugin-owned MCP server "${serverName}" cannot be stopped through the generic MCP route`
      )
    }
    if (await this.isPluginOwnedServerName(serverName)) {
      throw new Error(
        `Plugin-owned MCP server "${serverName}" is not registered by an enabled plugin`
      )
    }
    await this.stopServerDirect(serverName)
  }

  private async stopServerDirect(serverName: string): Promise<void> {
    await this.serverManager.stopServer(serverName)
    this.emitServerStopped(serverName)
  }

  getServerLastError(serverName: string): string | undefined {
    return this.serverManager.getServerLastError(serverName)
  }

  async getMcpServerAuthStatus(serverId: string): Promise<McpServerAuthStatus> {
    const { name, config } = await this.requireServerById(serverId)
    return this.mcpOAuthManager.getStatus(name, config)
  }

  async startMcpServerAuth(serverId: string): Promise<McpServerAuthStatus> {
    const { name, config } = await this.requireServerById(serverId)
    return this.mcpOAuthManager.startAuth(name, config)
  }

  async completeMcpServerAuthFromCallbackUrl(
    serverId: string,
    callbackUrl: string
  ): Promise<McpServerAuthStatus> {
    const { name, config } = await this.requireServerById(serverId)
    return this.mcpOAuthManager.completeAuthFromCallbackUrl(name, config, callbackUrl)
  }

  async logoutMcpServerAuth(serverId: string): Promise<McpServerAuthStatus> {
    const { name, config } = await this.requireServerById(serverId)
    return this.mcpOAuthManager.logout(name, config)
  }

  async getMcpCredentialStatus(serverId: string): Promise<McpCredentialStatus[]> {
    const { config } = await this.requireServerById(serverId)
    return this.mcpOAuthManager.getCredentialStatuses(config)
  }

  async setMcpCredential(
    binding: McpCredentialBinding,
    credential: McpCredentialInput
  ): Promise<McpCredentialStatus> {
    const { name, config } = await this.requireCurrentCredentialBinding(binding)
    const expectedKind: McpCredentialKind =
      config.authorization?.mode === 'private_key_jwt'
        ? 'private_key'
        : config.authorization?.mode === 'cross_app_access'
          ? 'enterprise_resource_secret'
          : 'client_secret'
    if (credential.kind !== expectedKind) {
      throw new Error('MCP credential type does not match the selected authorization mode')
    }
    if (
      credential.kind === 'private_key' &&
      config.authorization?.keyAlgorithm !== credential.algorithm
    ) {
      throw new Error('MCP private key algorithm does not match the server configuration')
    }
    const status = this.mcpOAuthManager.setCredential(binding, credential)
    await this.restartServerAfterAuthentication(name)
    return status
  }

  async removeMcpCredential(
    binding: McpCredentialBinding,
    kind: McpCredentialKind
  ): Promise<McpCredentialStatus> {
    const { name } = await this.requireCurrentCredentialBinding(binding)
    const status = this.mcpOAuthManager.removeCredential(binding, kind)
    if (this.serverManager.isServerRunning(name)) {
      await this.stopServer(name)
    }
    return status
  }

  listMcpEnterpriseProfiles(): Promise<McpEnterpriseIdentityProfile[]> {
    return Promise.resolve(this.mcpOAuthManager.listEnterpriseProfiles())
  }

  saveMcpEnterpriseProfile(
    profile: McpEnterpriseIdentityProfile
  ): Promise<McpEnterpriseIdentityProfile> {
    return Promise.resolve(this.mcpOAuthManager.saveEnterpriseProfile(profile))
  }

  async removeMcpEnterpriseProfile(profileId: string): Promise<void> {
    const servers = await this.mcpSettings.getMcpServers()
    for (const [serverName, config] of Object.entries(servers)) {
      if (config.authorization?.identityProfileId !== profileId) {
        continue
      }
      if (config.serverId) {
        this.mcpOAuthManager.clearServerCredentials(config.serverId)
      }
      await this.updateMcpServer(serverName, {
        authorization: { mode: 'interactive' }
      })
    }
    this.mcpOAuthManager.removeEnterpriseProfile(profileId)
  }

  setMcpEnterpriseProfileClientSecret(
    profileId: string,
    secret: string
  ): Promise<McpEnterpriseIdentityStatus> {
    return Promise.resolve(this.mcpOAuthManager.setEnterpriseProfileClientSecret(profileId, secret))
  }

  getMcpEnterpriseProfileStatus(profileId: string): Promise<McpEnterpriseIdentityStatus> {
    return Promise.resolve(this.mcpOAuthManager.getEnterpriseProfileStatus(profileId))
  }

  startMcpEnterpriseProfileAuth(profileId: string): Promise<McpEnterpriseIdentityStatus> {
    return this.mcpOAuthManager.startEnterpriseProfileAuth(profileId)
  }

  completeMcpEnterpriseProfileAuthFromCallbackUrl(
    profileId: string,
    callbackUrl: string
  ): Promise<McpEnterpriseIdentityStatus> {
    return this.mcpOAuthManager.completeEnterpriseProfileAuthFromCallbackUrl(profileId, callbackUrl)
  }

  logoutMcpEnterpriseProfile(profileId: string): Promise<McpEnterpriseIdentityStatus> {
    return Promise.resolve(this.mcpOAuthManager.logoutEnterpriseProfile(profileId))
  }

  /**
   * 按 serverId（稳定标识）反查 server 配置。凭据/诊断类接口都以 serverId
   * 为参数，因为 serverName 可能被用户重命名。找不到抛错。
   */
  private async requireServerById(
    serverId: string
  ): Promise<{ name: string; config: MCPServerConfig }> {
    const servers = await this.mcpSettings.getMcpServers()
    const match = Object.entries(servers).find(([, config]) => config.serverId === serverId)
    if (!match) {
      throw new Error('MCP server identity was not found')
    }
    return { name: match[0], config: match[1] }
  }

  /**
   * 校验凭据绑定是否仍然指向当前配置：configGeneration / bindingHash /
   * endpoint 等任一不匹配即判定 stale 并抛错。防止把凭据写到已被用户
   * 改过 baseUrl 或重新生成过身份的 server 上。
   */
  private async requireCurrentCredentialBinding(
    binding: McpCredentialBinding
  ): Promise<{ name: string; config: MCPServerConfig }> {
    const match = await this.requireServerById(binding.serverId)
    const config = match.config
    if (
      config.configGeneration !== binding.configGeneration ||
      config.bindingHash !== binding.bindingHash ||
      config.baseUrl !== binding.endpoint ||
      config.authorization?.protectedResourceUrl !== binding.protectedResourceUrl ||
      config.authorization?.authorizationServerIssuer !== binding.authorizationServerIssuer ||
      config.authorization?.clientId !== binding.clientId
    ) {
      throw new Error('MCP credential binding is stale')
    }
    return match
  }

  /**
   * 汇总 server 诊断信息。运行中的 client 直接给出实时诊断；未运行时
   * 依据 lastError 构造降级视图（error/stopped），扩展列表来自静态配置
   * 推断——此路径拿不到运行时数据，调用方需理解其近似性。
   */
  async getServerDiagnostics(serverId: string): Promise<McpServerDiagnostics> {
    const { name: serverName, config } = await this.requireServerById(serverId)
    const auth = this.mcpOAuthManager.getStatus(serverName, config)
    const client = this.serverManager.getClient(serverName)
    const lastError = this.serverManager.getServerLastError(serverName)?.slice(0, 2048)
    if (client) {
      return {
        ...client.getDiagnostics(auth),
        ...(lastError ? { lastError } : {})
      }
    }

    let authorizationExtensions: string[] = []
    try {
      authorizationExtensions = this.mcpOAuthManager.getUsableAuthorizationExtensions(config)
    } catch {
      authorizationExtensions = []
    }
    return {
      serverId,
      serverName,
      owner: config.ownerPluginId ? 'plugin' : 'deepchat',
      transport: config.type,
      connectionState: lastError ? 'error' : 'stopped',
      lifecycleStatus: lastError ? 'failed' : 'stopped',
      ...(lastError ? { lastError } : {}),
      era: 'unknown',
      probe: { outcome: 'not-run' },
      extensions: [],
      clientExtensions: [
        { id: 'io.modelcontextprotocol/ui' },
        ...authorizationExtensions.map((id) => ({
          id,
          ...(id === AUTH_EXTENSION_CLIENT_CREDENTIALS
            ? { revision: MCP_CLIENT_CREDENTIALS_DRAFT_REVISION }
            : {})
        }))
      ],
      cacheState: 'unknown',
      subscriptions: [],
      auth: {
        state: auth.state,
        persistent: auth.persistent,
        mode: auth.mode
      },
      updatedAt: Date.now()
    }
  }

  /**
   * 列出全部工具定义（按 access context 过滤）。MCP 总开关关闭时，仅插件
   * 可用的 server 的工具保留，其余一律剔除。
   */
  async getAllToolDefinitions(
    enabledMcpTools?: string[] | McpToolAccessContext
  ): Promise<MCPToolDefinition[]> {
    const context = normalizeToolAccessContext(enabledMcpTools)
    const enabled = await this.mcpSettings.getMcpEnabled()
    const tools = await this.toolManager.getAllToolDefinitions(context)
    return tools.filter((tool) => {
      if (!enabled && !this.pluginRuntimeSupervisor.isServerAvailable(tool.server.name)) {
        return false
      }
      return this.isServerAllowedByContext(tool.server.name, context)
    })
  }

  /**
   * 输出「期望可用的 server 集合 + 当前缓存快照」，供上层做工具一致性
   * 比对（缓存里缺了哪个期望中的 server，说明其发现失败或尚未完成）。
   * 期望集合排除插件所有的 server——它们由 supervisor 侧负责。
   */
  async snapshotCachedToolDefinitions(
    enabledMcpTools?: string[] | McpToolAccessContext
  ): Promise<import('@shared/types/mcp').McpToolDefinitionsSnapshot> {
    const context = normalizeToolAccessContext(enabledMcpTools)
    const enabled = await this.mcpSettings.getMcpEnabled()
    const [configuredEnabledServerNames, serverConfigs] = enabled
      ? await Promise.all([
          this.mcpSettings.getEnabledMcpServers(),
          this.mcpSettings.getMcpServers()
        ])
      : [[], {}]
    const selectedServerNames = context.enabledServerIds ? new Set(context.enabledServerIds) : null
    const expectedServerNames = enabled
      ? configuredEnabledServerNames.filter(
          (serverName) =>
            (!selectedServerNames || selectedServerNames.has(serverName)) &&
            !this.isPluginOwnedServerConfig(serverConfigs[serverName]) &&
            !this.pluginRuntimeSupervisor.ownsServer(serverName)
        )
      : []
    return this.toolManager.snapshotCachedToolDefinitions({
      ...context,
      includeRegularServers: enabled,
      expectedServerNames
    })
  }

  /**
   * 获取所有客户端的提示模板，并附加客户端信息
   * @returns 所有提示模板列表，每个提示模板附带所属客户端信息
   */
  async getAllPrompts(): Promise<Array<PromptListEntry>> {
    const enabled = await this.mcpSettings.getMcpEnabled()
    const clients = (await this.toolManager.getRunningClients()).filter(
      (client) => enabled || this.pluginRuntimeSupervisor.isServerAvailable(client.serverName)
    )
    const promptsList: Array<Prompt & { client: { name: string; icon: string } }> = []

    for (const client of clients) {
      if (typeof client.listPrompts === 'function') {
        try {
          const prompts = await client.listPrompts()
          if (prompts && prompts.length > 0) {
            // Add client information to each prompt template
            const clientPrompts = prompts.map((prompt) => ({
              id: prompt.name,
              name: prompt.name,
              description: prompt.description || '',
              arguments: prompt.arguments || [],
              files: prompt.files || [], // Add files field
              client: {
                name: client.serverName,
                icon: client.serverConfig['icons'] as string
              }
            }))
            promptsList.push(...clientPrompts)
          }
        } catch (error) {
          console.error(
            `[MCP] Failed to get prompt templates for client ${client.serverName}:`,
            error
          )
        }
      }
    }

    return promptsList
  }

  /**
   * 获取所有客户端的资源列表，并附加客户端信息
   * @returns 所有资源列表，每个资源附带所属客户端信息
   */
  async getAllResources(): Promise<
    Array<ResourceListEntry & { client: { name: string; icon: string } }>
  > {
    const enabled = await this.mcpSettings.getMcpEnabled()
    const clients = (await this.toolManager.getRunningClients()).filter(
      (client) => enabled || this.pluginRuntimeSupervisor.isServerAvailable(client.serverName)
    )
    const resourcesList: Array<ResourceListEntry & { client: { name: string; icon: string } }> = []

    for (const client of clients) {
      if (typeof client.listResources === 'function') {
        try {
          const resources = await client.listResources()
          if (resources && resources.length > 0) {
            // Add client information to each resource
            const clientResources = resources.map((resource) => ({
              ...resource,
              client: {
                name: client.serverName,
                icon: client.serverConfig['icons'] as string
              }
            }))
            resourcesList.push(...clientResources)
          }
        } catch (error) {
          console.error(`[MCP] Failed to get resources for client ${client.serverName}:`, error)
        }
      }
    }

    return resourcesList
  }

  /**
   * 工具调用的统一入口：委托 ToolManager 派发，之后处理三件事——
   * 1. dispatch 未提交且 signal 已中止则抛 AbortError（提交后的中止不影响
   *    已执行的结果）；2. 图片内容经缓存转存，生成预览并替换原文（stdio/
   *    inmemory/插件 server 允许访问私网图片地址）；3. 把结构化内容折叠为
   *    模型可读的纯文本，错误结果加 `Error:` 前缀。
   * 返回值同时携带格式化文本（喂给模型）与 rawData（UI 展示用）。
   */
  async callTool(
    request: MCPToolCall,
    options?: {
      signal?: AbortSignal
      agentId?: string
      enabledServerIds?: string[]
      runId?: string
      expectedTarget?: McpExpectedToolTarget
      assertCurrentToolDefinition?: (definition: MCPToolDefinition) => void
      throwPreDispatchErrors?: boolean
      commitDispatch?: ToolDispatchCommit
      registerOutcomeProjection?: ToolOutcomeProjectionRegistrar
    }
  ): Promise<{ content: string; rawData: MCPToolResponse }> {
    let dispatchCommitted = false
    const toolCallResult = await this.toolManager.callTool(
      request,
      options?.commitDispatch
        ? {
            ...options,
            commitDispatch: (input) => {
              options.commitDispatch?.(input)
              dispatchCommitted = true
            }
          }
        : options
    )
    if (!dispatchCommitted) {
      options?.signal?.throwIfAborted()
    }
    let normalizedContent = toolCallResult.content
    let imagePreviews: ToolCallImagePreview[] = []

    if (!options?.signal?.aborted) {
      try {
        const serverName = request.server?.name
        const serverConfig = serverName
          ? (await awaitWithAbort(this.mcpSettings.getMcpServers(), options?.signal))[serverName]
          : undefined
        const allowPrivateNetwork =
          serverConfig?.type === 'stdio' ||
          serverConfig?.type === 'inmemory' ||
          Boolean(serverName && this.pluginRuntimeSupervisor.ownsServer(serverName))
        const cacheImage = this.cacheImage
        const preparedImages = await prepareToolCallImageContent({
          toolName: request.function.name,
          toolArgs: request.function.arguments,
          content: toolCallResult.content,
          cacheImage: cacheImage
            ? (data) =>
                cacheImage(data, {
                  signal: options?.signal,
                  allowPrivateNetwork
                })
            : undefined,
          signal: options?.signal
        })
        imagePreviews = preparedImages.imagePreviews
        normalizedContent = preparedImages.content
      } catch (error) {
        if (!dispatchCommitted || !options?.signal?.aborted) throw error
      }
    }

    // Format tool call results into strings that are easy for large models to parse
    let formattedContent = ''

    // Determine content type
    if (typeof normalizedContent === 'string') {
      // Content is already a string
      formattedContent = normalizedContent
    } else if (Array.isArray(normalizedContent)) {
      // Content is structured array, needs formatting
      const contentParts: string[] = []

      // Process each content item
      for (const item of normalizedContent) {
        if (item.type === 'text') {
          contentParts.push(item.text)
        } else if (item.type === 'image') {
          contentParts.push(`[Image: ${item.mimeType}]`)
        } else if (item.type === 'resource') {
          if ('text' in item.resource && item.resource.text) {
            contentParts.push(`[Resource: ${item.resource.uri}]\n${item.resource.text}`)
          } else if ('blob' in item.resource) {
            contentParts.push(`[Binary Resource: ${item.resource.uri}]`)
          } else {
            contentParts.push(`[Resource: ${item.resource.uri}]`)
          }
        } else {
          // Handle other unknown types
          contentParts.push(JSON.stringify(item))
        }
      }

      // Combine all content
      formattedContent = contentParts.join('\n\n')
    }

    // Add error marker (if any)
    if (toolCallResult.isError) {
      formattedContent = `Error: ${formattedContent}`
    }

    if (!dispatchCommitted) {
      options?.signal?.throwIfAborted()
    }

    return {
      content: formattedContent,
      rawData: {
        ...toolCallResult,
        content: normalizedContent,
        ...(imagePreviews.length > 0 ? { imagePreviews } : {})
      }
    }
  }

  async checkPluginRuntimePermissions(serverName: string): Promise<unknown> {
    return await this.toolManager.checkPluginRuntimePermissions(serverName)
  }

  /**
   * 处理 server 发起的 sampling 请求：登记后通过事件发布给 renderer，
   * 返回的 Promise 挂起等待用户/策略决策（submitSamplingDecision resolve，
   * cancelSamplingRequest reject）。等待期间连接层可以安全地不响应。
   */
  async handleSamplingRequest(request: McpSamplingRequestPayload): Promise<McpSamplingDecision> {
    if (!request || !request.requestId) {
      throw new Error('Invalid sampling request: missing requestId')
    }
    this.assertInteractionCapacity(request.requestId, 'sampling')

    return new Promise<McpSamplingDecision>((resolve, reject) => {
      try {
        this.pendingSamplingRequests.set(request.requestId, { resolve, reject })
        this.publishEvent('mcp.sampling.request', {
          request,
          version: Date.now()
        })
      } catch (error) {
        this.pendingSamplingRequests.delete(request.requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async submitSamplingDecision(decision: McpSamplingDecision): Promise<void> {
    if (!decision || !decision.requestId) {
      throw new Error('Invalid sampling decision: missing requestId')
    }

    const pending = this.pendingSamplingRequests.get(decision.requestId)
    if (!pending) {
      console.warn(
        `[MCP] Sampling request ${decision.requestId} not found when submitting decision`
      )
      return
    }

    this.pendingSamplingRequests.delete(decision.requestId)
    pending.resolve(decision)

    this.publishEvent('mcp.sampling.decision', {
      decision,
      version: Date.now()
    })
  }

  async cancelSamplingRequest(requestId: string, reason?: string): Promise<void> {
    if (!requestId) {
      return
    }

    const pending = this.pendingSamplingRequests.get(requestId)
    if (!pending) {
      return
    }

    this.pendingSamplingRequests.delete(requestId)
    pending.reject(new Error(reason ?? 'Sampling request cancelled'))

    this.publishEvent('mcp.sampling.cancelled', {
      requestId,
      reason: reason ?? 'cancelled',
      version: Date.now()
    })
  }

  async handleElicitationRequest(
    request: McpElicitationRequestPayload
  ): Promise<McpElicitationDecision> {
    if (!request?.requestId) {
      throw new Error('Invalid elicitation request: missing requestId')
    }
    this.assertInteractionCapacity(request.requestId, 'elicitation')

    return new Promise<McpElicitationDecision>((resolve, reject) => {
      this.pendingElicitationRequests.set(request.requestId, { resolve, reject })
      try {
        this.publishEvent('mcp.elicitation.request', {
          request,
          version: Date.now()
        })
      } catch (error) {
        this.pendingElicitationRequests.delete(request.requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async submitElicitationDecision(decision: McpElicitationDecision): Promise<void> {
    if (!decision?.requestId) {
      throw new Error('Invalid elicitation decision: missing requestId')
    }

    const pending = this.pendingElicitationRequests.get(decision.requestId)
    if (!pending) {
      console.warn(
        `[MCP] Elicitation request ${decision.requestId} not found when submitting decision`
      )
      return
    }

    this.pendingElicitationRequests.delete(decision.requestId)
    pending.resolve(decision)
    this.publishEvent('mcp.elicitation.decision', {
      decision,
      version: Date.now()
    })
  }

  async cancelElicitationRequest(requestId: string, reason?: string): Promise<void> {
    if (!requestId) {
      return
    }

    const pending = this.pendingElicitationRequests.get(requestId)
    if (!pending) {
      return
    }

    this.pendingElicitationRequests.delete(requestId)
    pending.reject(new Error(reason ?? 'Elicitation request cancelled'))
    this.publishEvent('mcp.elicitation.cancelled', {
      requestId,
      reason: reason ?? 'cancelled',
      version: Date.now()
    })
  }

  /**
   * sampling / elicitation 待决请求的公共护栏：requestId 不可重复登记，
   * 且总量不得超过 MCP_MAX_PENDING_INTERACTIONS，防止 server 无限发起
   * 交互请求耗尽主进程资源。
   */
  private assertInteractionCapacity(requestId: string, kind: 'sampling' | 'elicitation'): void {
    if (
      this.pendingSamplingRequests.has(requestId) ||
      this.pendingElicitationRequests.has(requestId)
    ) {
      throw new Error(`Duplicate MCP interaction request: ${requestId}`)
    }
    if (
      this.pendingSamplingRequests.size + this.pendingElicitationRequests.size >=
      MCP_MAX_PENDING_INTERACTIONS
    ) {
      throw new Error(`Too many pending MCP ${kind} requests`)
    }
  }

  // Get MCP enabled status
  async getMcpEnabled(): Promise<boolean> {
    return this.mcpSettings.getMcpEnabled()
  }

  // Set MCP enabled status
  /**
   * MCP 总开关。开启时逐个启动所有已启用的普通 server；关闭时停止全部
   * 非 server（插件所有的无论开关如何都保持其所有权路径处理）。
   * 单个 server 启停失败不中断整体流程，只记日志。
   */
  /**
   * MCP 总开关。开启时逐个启动所有已启用的普通 server；关闭时停止全部
   * 非插件所有的 server（插件 server 仍走其所有权路径处理）。
   * 单个 server 启停失败不中断整体流程，只记日志。
   */
  async setMcpEnabled(enabled: boolean): Promise<void> {
    await this.mcpSettings.setMcpEnabled(enabled)

    if (enabled) {
      const servers = await this.mcpSettings.getMcpServers()
      const enabledServers = await this.mcpSettings.getEnabledMcpServers()
      for (const serverName of enabledServers) {
        if (
          this.pluginRuntimeSupervisor.ownsServer(serverName) ||
          this.isPluginOwnedServerConfig(servers[serverName])
        ) {
          continue
        }
        try {
          await this.startServer(serverName)
        } catch (error) {
          console.error(`[MCP] Failed to start enabled server ${serverName}:`, error)
        }
      }
      return
    }

    const activeClients = await this.serverManager.getActiveClients()
    const servers = await this.mcpSettings.getMcpServers()
    for (const client of activeClients) {
      if (this.pluginRuntimeSupervisor.ownsServer(client.serverName)) {
        continue
      }
      try {
        if (this.isPluginOwnedServerConfig(servers[client.serverName])) {
          await this.stopServerDirect(client.serverName)
        } else {
          await this.stopServer(client.serverName)
        }
      } catch (error) {
        console.error(`[MCP] Failed to stop server ${client.serverName}:`, error)
      }
    }
  }

  /**
   * Get specified prompt template
   * @param prompt Prompt template object (containing client information)
   * @param params Prompt template parameters
   * @returns Prompt template content
   */
  async getPrompt(prompt: PromptListEntry, args?: Record<string, unknown>): Promise<unknown> {
    // Check if this is a custom prompt from deepchat/custom-prompts-server
    if (prompt.client.name === 'deepchat/custom-prompts-server') {
      logger.info(`[MCP] Getting custom prompt: ${prompt.name}`)
      try {
        const customPrompts = await this.promptSettings.getCustomPrompts()
        const foundPrompt = customPrompts.find((p) => p.name === prompt.name)

        if (foundPrompt) {
          // Return the prompt in the expected format
          return {
            name: foundPrompt.name,
            description: foundPrompt.description,
            content: foundPrompt.content || '',
            messages: foundPrompt.messages || [],
            arguments: foundPrompt.parameters || []
          }
        } else {
          throw new Error(`Custom prompt "${prompt.name}" not found`)
        }
      } catch (error) {
        console.error(`[MCP] Failed to get custom prompt "${prompt.name}":`, error)
        throw error
      }
    }

    // For MCP server prompts, check if MCP is enabled
    const enabled = await this.mcpSettings.getMcpEnabled()
    if (!enabled && !(await this.isPluginOwnedServerName(prompt.client.name))) {
      throw new Error('MCP functionality is disabled')
    }

    // Pass client information and prompt template name to toolManager
    return this.toolManager.getPromptByClient(prompt.client.name, prompt.name, args)
  }

  /**
   * Read specified resource
   * @param resource Resource object (containing client information)
   * @returns Resource content
   */
  async readResource(resource: ResourceListEntry): Promise<Resource> {
    const enabled = await this.mcpSettings.getMcpEnabled()
    if (!enabled && !(await this.isPluginOwnedServerName(resource.client.name))) {
      throw new Error('MCP functionality is disabled')
    }

    // Pass client information and resource URI to toolManager
    return this.toolManager.readResourceByClient(resource.client.name, resource.uri)
  }

  async getNpmRegistryStatus(): Promise<{
    currentRegistry: string | null
    isFromCache: boolean
    lastChecked?: number
    autoDetectEnabled: boolean
    customRegistry?: string
  }> {
    const cache = this.mcpSettings.getNpmRegistryCache()
    const autoDetectEnabled = this.mcpSettings.getAutoDetectNpmRegistry()
    const customRegistry = this.mcpSettings.getCustomNpmRegistry()
    const currentRegistry = this.serverManager.getNpmRegistry()

    let isFromCache = false
    if (customRegistry && currentRegistry === customRegistry) {
      isFromCache = false
    } else if (cache && this.mcpSettings.isNpmRegistryCacheValid()) {
      isFromCache = currentRegistry === cache.registry
    }

    return {
      currentRegistry,
      isFromCache,
      lastChecked: cache?.lastChecked,
      autoDetectEnabled,
      customRegistry
    }
  }

  async refreshNpmRegistry(): Promise<string> {
    return await this.serverManager.refreshNpmRegistry()
  }

  async setCustomNpmRegistry(registry: string | undefined): Promise<void> {
    this.mcpSettings.setCustomNpmRegistry(registry)
    if (registry) {
      logger.info(`[MCP] Setting custom NPM registry: ${registry}`)
    } else {
      logger.info('[MCP] Clearing custom NPM registry')
    }
    this.serverManager.loadRegistryFromCache()
  }

  async setAutoDetectNpmRegistry(enabled: boolean): Promise<void> {
    this.mcpSettings.setAutoDetectNpmRegistry(enabled)
    if (enabled) {
      this.serverManager.loadRegistryFromCache()
    }
  }

  async clearNpmRegistryCache(): Promise<void> {
    this.mcpSettings.clearNpmRegistryCache()
    logger.info('[MCP] NPM Registry cache cleared')
  }

  // Get npm registry (for ACP and other internal use)
  getNpmRegistry(): string | null {
    return this.serverManager.getNpmRegistry()
  }

  // Get uv registry (for ACP and other internal use)
  getUvRegistry(): string | null {
    return this.serverManager.getUvRegistry()
  }
}
