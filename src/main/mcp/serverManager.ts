import logger from '@shared/logger'
import type { MCPServerConfig } from '@shared/types/mcp'
import {
  McpClient,
  McpConnectionCancelledError,
  type McpClientRuntime,
  type McpConnectResult
} from './mcpClient'
import axios from 'axios'
import { proxyConfig } from '@/platform/proxy'
import type { DeepchatEventPublisher } from '@shared/contracts/events'
import type { SemanticNotificationPublisher } from '@/notifications'
import type { McpOAuthManager } from './mcpOAuthManager'
import type { InMemoryServerFactory } from './inMemoryServers/builder'
import type { PrivacySettingsPort } from '@/app/privacy'
import type { McpSettings } from './settings'

const NPM_REGISTRY_LIST = [
  'https://registry.npmmirror.com/',
  'https://registry.npmjs.org/',
  'https://r.cnpmjs.org/'
]

type StartServerOptions = {
  onBackgroundConnected?: () => void
  configOverride?: Partial<MCPServerConfig>
  waitForConnection?: boolean
}

const STOP_DRAIN_MS = 250

/**
 * server 实例的编排层：维护「名称 → McpClient」注册表，并串行化每个
 * server 的启停（starting/stopping 去重 + startEpoch 代际号防过期启动）。
 * 职责包括：npm/uv 镜像测速与缓存、启动结果的同步/后台（软超时）两条
 * 收尾路径、连接失败的通知与 OAuth 处理。
 * 不理解工具语义；工具注册表在 ToolManager，配置持久化在 McpSettings。
 */
export class ServerManager {
  private clients: Map<string, McpClient> = new Map()
  private readonly starting = new Map<string, Promise<McpConnectResult>>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly startEpoch = new Map<string, number>()
  private serverLastErrors: Map<string, string> = new Map()
  private readonly mcpSettings: McpSettings
  private npmRegistry: string | null = null
  private uvRegistry: string | null = null
  private mcpOAuthManager?: McpOAuthManager
  private readonly inMemoryServerFactory: InMemoryServerFactory
  private readonly clientRuntime: McpClientRuntime
  private readonly onRegistryChanged: () => void
  private readonly privacy: PrivacySettingsPort

  constructor(
    mcpSettings: McpSettings,
    privacy: PrivacySettingsPort,
    inMemoryServerFactory: InMemoryServerFactory,
    clientRuntime: McpClientRuntime,
    onRegistryChanged: () => void,
    private readonly semanticNotifications: SemanticNotificationPublisher,
    private readonly publishEvent: DeepchatEventPublisher,
    mcpOAuthManager?: McpOAuthManager
  ) {
    this.mcpSettings = mcpSettings
    this.privacy = privacy
    this.inMemoryServerFactory = inMemoryServerFactory
    this.clientRuntime = clientRuntime
    this.onRegistryChanged = onRegistryChanged
    this.mcpOAuthManager = mcpOAuthManager
    this.loadRegistryFromCache()
  }

  private isPrivacyModeEnabled(): boolean {
    return this.privacy.isEnabled()
  }

  private isPluginOwnedServerConfig(config?: Partial<MCPServerConfig> | null): boolean {
    return Boolean(config?.ownerPluginId || config?.source === 'plugin')
  }

  getServerLastError(serverName: string): string | undefined {
    return this.serverLastErrors.get(serverName)
  }

  setServerLastError(serverName: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error || 'Unknown error')
    this.serverLastErrors.set(serverName, message)
  }

  clearServerLastError(serverName: string): void {
    this.serverLastErrors.delete(serverName)
  }

  /**
   * 从持久化缓存恢复生效的 npm registry（自定义 > 缓存），并按镜像联动
   * uv/pip 源。构造与用户改设置时调用，保证后续启动的子进程拿到正确源。
   */
  loadRegistryFromCache(): void {
    const effectiveRegistry = this.mcpSettings.getEffectiveNpmRegistry()
    if (effectiveRegistry) {
      this.npmRegistry = effectiveRegistry
      if (effectiveRegistry === 'https://registry.npmmirror.com/') {
        this.uvRegistry = 'http://mirrors.aliyun.com/pypi/simple'
      } else {
        this.uvRegistry = null
      }
      logger.info(`[NPM Registry] Loaded effective registry: ${effectiveRegistry}`)
    } else {
      this.npmRegistry = null
      this.uvRegistry = null
      logger.info('[NPM Registry] No effective registry, will use default or detect')
    }
  }

  // Test npm registry speed and return best choice
  /**
   * 选出最优 npm registry：自定义 registry 优先，其次有效缓存；
   * 都没有时对候选镜像并发测速（带代理与 10s 超时），取延迟最低者并
   * 写回缓存。全部失败时退回第一个候选，保证始终有可用源。
   */
  async testNpmRegistrySpeed(useCache: boolean = true): Promise<string> {
    const customRegistry = this.mcpSettings.getCustomNpmRegistry()
    if (customRegistry) {
      this.npmRegistry = customRegistry
      if (customRegistry === 'https://registry.npmmirror.com/') {
        this.uvRegistry = 'http://mirrors.aliyun.com/pypi/simple'
      } else {
        this.uvRegistry = null
      }
      logger.info(`[NPM Registry] Using custom registry: ${customRegistry}`)
      return customRegistry
    }
    if (useCache && this.mcpSettings.isNpmRegistryCacheValid()) {
      const cache = this.mcpSettings.getNpmRegistryCache()
      if (cache) {
        this.npmRegistry = cache.registry
        if (cache.registry === 'https://registry.npmmirror.com/') {
          this.uvRegistry = 'http://mirrors.aliyun.com/pypi/simple'
        } else {
          this.uvRegistry = null
        }
        logger.info(`[NPM Registry] Using cached registry: ${cache.registry}`)
        return cache.registry
      }
    }

    logger.info('[NPM Registry] Testing registry speed...')
    const timeout = 10000
    const testPackage = 'tiny-runtime-injector'

    // Get proxy configuration
    const proxyUrl = proxyConfig.getProxyUrl()
    const proxyOptions = (() => {
      if (!proxyUrl) return {}
      const u = new URL(proxyUrl)
      const host = u.hostname
      const port = u.port ? parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : 80
      const auth = u.username ? { username: u.username, password: u.password ?? '' } : undefined
      return { proxy: { host, port, ...(auth ? { auth } : {}) } }
    })()

    const results = await Promise.all(
      NPM_REGISTRY_LIST.map(async (registry) => {
        const start = Date.now()
        let success = false
        let isTimeout = false
        let time = 0

        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeout)
        try {
          const response = await axios.get(`${registry}${testPackage}`, {
            ...proxyOptions,
            signal: controller.signal
          })
          success = response.status >= 200 && response.status < 300
        } catch (error) {
          isTimeout =
            (error instanceof Error &&
              (error.name === 'AbortError' || error.name === 'CanceledError')) ||
            Date.now() - start >= timeout
        } finally {
          clearTimeout(timeoutId)
          time = Date.now() - start
        }

        return {
          registry,
          success,
          time,
          isTimeout
        }
      })
    )

    // Filter successful requests and sort by response time
    const successfulResults = results
      .filter((result) => result.success)
      .sort((a, b) => a.time - b.time)
    logger.info('[NPM Registry] Test results:', successfulResults)
    let bestRegistry: string
    if (successfulResults.length === 0) {
      logger.info('[NPM Registry] All tests failed, using default registry')
      bestRegistry = NPM_REGISTRY_LIST[0]
    } else {
      bestRegistry = successfulResults[0].registry
      logger.info(`[NPM Registry] Best registry: ${bestRegistry} (${successfulResults[0].time}ms)`)
    }
    this.npmRegistry = bestRegistry
    if (bestRegistry === 'https://registry.npmmirror.com/') {
      this.uvRegistry = 'http://mirrors.aliyun.com/pypi/simple'
    } else {
      this.uvRegistry = null
    }

    this.mcpSettings.setNpmRegistryCache({
      registry: bestRegistry,
      lastChecked: Date.now(),
      isAutoDetect: true
    })
    return bestRegistry
  }

  // Get npm registry
  getNpmRegistry(): string | null {
    return this.npmRegistry
  }

  async refreshNpmRegistry(): Promise<string> {
    logger.info('[NPM Registry] Manual refresh triggered')
    return await this.testNpmRegistrySpeed(false) // Don't use cache
  }

  async updateNpmRegistryInBackground(): Promise<void> {
    try {
      if (this.isPrivacyModeEnabled()) {
        logger.info('[NPM Registry] Privacy mode enabled, skipping background update')
        return
      }

      // Check if update is needed
      if (this.mcpSettings.isNpmRegistryCacheValid()) {
        logger.info('[NPM Registry] Cache is still valid, skipping background update')
        return
      }
      logger.info('[NPM Registry] Starting background registry update')
      await this.testNpmRegistrySpeed(false)
      logger.info('[NPM Registry] Background registry update completed')
    } catch (error) {
      console.error('[NPM Registry] Background update failed:', error)
    }
  }

  // Get uv registry
  getUvRegistry(): string | null {
    return this.uvRegistry
  }

  // Get running clients
  async getRunningClients(): Promise<McpClient[]> {
    const clients: McpClient[] = []
    for (const [name, client] of this.clients.entries()) {
      if (this.isServerRunning(name)) {
        clients.push(client)
      }
    }
    return clients
  }

  async getActiveClients(): Promise<McpClient[]> {
    return Array.from(this.clients.values()).filter((client) => client.isActive())
  }

  /**
   * 启动指定 server，去重与代际控制的核心入口：
   * - 先等已进行中的 stop 完成（避免停止中又启动的竞态）；
   * - 已有同配置的启动任务则直接共享其结果（configOverride 的启动不共享，
   *   因为它针对的是一次性覆盖配置）；
   * - waitForConnection 且共享到 soft-timeout-released 时，再等一次确定性
   *   连接，满足调用方「必须知道结果」的预期。
   */
  async startServer(name: string, options: StartServerOptions = {}): Promise<McpConnectResult> {
    const pendingStop = this.stopping.get(name)
    if (pendingStop) await pendingStop

    const inflight = this.starting.get(name)
    if (inflight && !options.configOverride) {
      const result = await inflight
      const stopAfter = this.stopping.get(name)
      if (stopAfter) {
        await stopAfter
      } else if (options.waitForConnection && result === 'soft-timeout-released') {
        const client = this.clients.get(name)
        if (client) {
          return client.connect({ phase: 'startup', waitForConnection: true })
        }
      } else {
        return result
      }
    }
    const epoch = this.startEpoch.get(name) ?? 0
    const task = this.connectServer(name, options, epoch)
    if (!options.configOverride) {
      this.starting.set(name, task)
    }
    try {
      return await task
    } finally {
      if (this.starting.get(name) === task) {
        this.starting.delete(name)
      }
    }
  }

  /**
   * 代际号不匹配即视为过期启动：stop 已在此期间发生，启动结果作废，
   * 客户端按 stopped 处理（必要的话顺手 disconnect 清理）。防止「停止-
   * 启动」交叠时旧启动任务把刚停止的 server 又拉起来。
   */
  private isStaleStart(name: string, epoch: number): boolean {
    return (this.startEpoch.get(name) ?? 0) !== epoch
  }

  /**
   * 启动的实际执行体（无去重，由 startServer 保证）：
   * 1. 已在运行 → 记恢复通知后直接返回 connected；
   * 2. 已有活跃但未连上的 client 且无配置覆盖 → 复用该 client 继续握手；
   * 3. 否则读持久化配置（合并 configOverride），断开旧 client 后新建。
   * 失败路径：记录 lastError、交给 OAuth 管理器判定是否为认证问题
   * （认证问题走引导流程不发通知），非认证失败且非插件 server 才发
   * 连接失败语义通知。finally 中统一刷新注册表。
   */
  private async connectServer(
    name: string,
    options: StartServerOptions,
    epoch: number
  ): Promise<McpConnectResult> {
    const existingClient = this.clients.get(name)
    if (existingClient?.isServerRunning()) {
      if (this.isStaleStart(name, epoch)) {
        return 'stopped'
      }
      console.info(`MCP server ${name} is already running`)
      this.recoverConnectionNotification(name)
      return 'connected'
    }

    let client = existingClient
    let serverConfig: MCPServerConfig
    if (existingClient?.isActive() && !options.configOverride) {
      console.info(`MCP server ${name} is starting...`)
      serverConfig = (existingClient.serverConfig ?? {}) as unknown as MCPServerConfig
    } else {
      const servers = await this.mcpSettings.getMcpServers()
      const persistedServerConfig = servers[name]
      if (!persistedServerConfig) {
        throw new Error(`MCP server ${name} not found`)
      }
      if (this.isStaleStart(name, epoch)) {
        return 'stopped'
      }
      // Runtime adapters own every field they override. In particular, replacing env preserves the
      // minimal child-process boundary instead of merging stale persisted variables back into it.
      serverConfig = options.configOverride
        ? {
            ...persistedServerConfig,
            ...options.configOverride
          }
        : persistedServerConfig

      if (existingClient) {
        await existingClient.disconnect()
        if (this.clients.get(name) === existingClient) {
          this.clients.delete(name)
        }
      }
      client = undefined
    }

    try {
      if (!client) {
        console.info(`Starting MCP server ${name}...`)
        const npmRegistry = serverConfig.customNpmRegistry || this.npmRegistry
        client = new McpClient(
          name,
          serverConfig as unknown as Record<string, unknown>,
          npmRegistry,
          this.uvRegistry,
          this.mcpOAuthManager,
          this.inMemoryServerFactory,
          this.clientRuntime,
          this.onRegistryChanged,
          this.publishEvent
        )
        this.clients.set(name, client)
      }
      if (this.isStaleStart(name, epoch)) {
        await client.disconnect()
        if (this.clients.get(name) === client) {
          this.clients.delete(name)
        }
        return 'stopped'
      }

      this.clearServerLastError(name)
      const connectTask = client.connect({
        phase: 'startup',
        waitForConnection: options.waitForConnection
      })
      const connectionCompletion = client.getConnectionCompletion()
      const connectResult = await connectTask
      this.handleStartupConnectResult(
        name,
        client,
        serverConfig,
        connectResult,
        connectionCompletion,
        options
      )
      if (connectResult === 'connected') {
        this.clearServerLastError(name)
        this.recoverConnectionNotification(name)
      }
      return connectResult
    } catch (error) {
      if (client?.getLifecycleStatus?.() === 'stopped' && !client.isActive()) {
        console.info(`MCP server ${name} startup was cancelled; ignoring stopped client`)
        if (this.clients.get(name) === client) {
          this.clients.delete(name)
        }
        return 'stopped'
      }

      console.error(`Failed to start MCP server ${name}:`, error)

      // Retain the inactive client so diagnostics can report the terminal lifecycle until the
      // user restarts or stops it. A later start replaces this client through the normal path.
      this.setServerLastError(name, error)
      const authHandled =
        this.mcpOAuthManager?.handleConnectionError(name, serverConfig, error) ?? false

      if (!authHandled && !this.isPluginOwnedServerConfig(serverConfig)) {
        this.notifyConnectionFailure(name)
      }

      throw error
    } finally {
      this.onRegistryChanged()
    }
  }

  /**
   * 软超时放行后的后台收尾：监听未完成的握手，最终连上则清错误、发恢复
   * 通知并回调 onBackgroundConnected（补发 started 事件）；最终失败且该
   * client 仍是当前实例时，走与同步失败相同的错误处置。client 已被替换
   * 则静默丢弃——新旧实例不能互相代答。
   */
  private handleStartupConnectResult(
    name: string,
    client: McpClient,
    serverConfig: MCPServerConfig,
    connectResult: McpConnectResult,
    connectionCompletion: Promise<void> | null,
    options: { onBackgroundConnected?: () => void } = {}
  ): void {
    if (connectResult !== 'soft-timeout-released') {
      return
    }

    if (!connectionCompletion) {
      return
    }

    connectionCompletion
      .then(() => {
        if (this.clients.get(name) !== client) return
        this.clearServerLastError(name)
        this.recoverConnectionNotification(name)
        options.onBackgroundConnected?.()
        this.onRegistryChanged()
      })
      .catch((error) => {
        if (error instanceof McpConnectionCancelledError) {
          return
        }

        if (this.clients.get(name) !== client) {
          return
        }

        this.setServerLastError(name, error)
        const authHandled =
          this.mcpOAuthManager?.handleConnectionError(name, serverConfig, error) ?? false

        if (!authHandled && !this.isPluginOwnedServerConfig(serverConfig)) {
          this.notifyConnectionFailure(name)
        }

        this.onRegistryChanged()
      })
  }

  private notifyConnectionFailure(serverName: string): void {
    this.semanticNotifications.occur({
      code: 'mcp.connectionFailed',
      serverName
    })
  }

  private recoverConnectionNotification(serverName: string): void {
    this.semanticNotifications.recover({
      code: 'mcp.connectionFailed',
      serverName
    })
  }

  /**
   * 停止指定 server（去重：并发调用共享同一次停止）。实际逻辑见
   * stopServerOnce。
   */
  async stopServer(name: string): Promise<void> {
    const existing = this.stopping.get(name)
    if (existing) return existing

    const task = this.stopServerOnce(name)
    this.stopping.set(name, task)
    try {
      await task
    } finally {
      if (this.stopping.get(name) === task) {
        this.stopping.delete(name)
      }
    }
  }

  /**
   * 停止的实际执行体：
   * 1. 递增 startEpoch，令正在进行的启动全部作废；
   * 2. disconnect 现有 client 并从注册表移除；
   * 3. 对进行中的启动任务短暂等待（STOP_DRAIN_MS），让它在 epoch 失效后
   *    自行退出并清理自己创建的 client；
   * 4. 若期间又冒出新 client（启动竞态残留），一并断开。
   */
  private async stopServerOnce(name: string): Promise<void> {
    this.startEpoch.set(name, (this.startEpoch.get(name) ?? 0) + 1)
    const live = this.clients.get(name)
    if (live) {
      try {
        await live.disconnect()
      } catch (error) {
        console.error(`Failed to stop MCP server ${name}:`, error)
        throw error
      }
      if (this.clients.get(name) === live) {
        this.clients.delete(name)
      }
      this.clearServerLastError(name)
      this.recoverConnectionNotification(name)
      console.info(`MCP server ${name} has been stopped`)
      this.onRegistryChanged()
    }

    const inflight = this.starting.get(name)
    if (this.starting.get(name) === inflight) {
      this.starting.delete(name)
    }
    if (inflight) {
      await Promise.race([
        inflight.catch(() => {}),
        new Promise<void>((resolve) => {
          setTimeout(resolve, STOP_DRAIN_MS)
        })
      ])
    }

    const leftover = this.clients.get(name)
    if (leftover && leftover !== live) {
      try {
        await leftover.disconnect()
      } catch (error) {
        console.error(`Failed to stop MCP server ${name}:`, error)
        throw error
      }
      if (this.clients.get(name) === leftover) {
        this.clients.delete(name)
      }
      this.clearServerLastError(name)
      this.recoverConnectionNotification(name)
      this.onRegistryChanged()
      return
    }
    if (!live) {
      this.recoverConnectionNotification(name)
    }
  }

  isServerRunning(name: string): boolean {
    const client = this.clients.get(name)
    if (!client) {
      return false
    }
    return client.isServerRunning()
  }

  isServerActive(name: string): boolean {
    return (
      this.starting.has(name) ||
      this.stopping.has(name) ||
      (this.clients.get(name)?.isActive() ?? false)
    )
  }

  /**
   * Get client instance
   */
  getClient(name: string): McpClient | undefined {
    return this.clients.get(name)
  }
}
