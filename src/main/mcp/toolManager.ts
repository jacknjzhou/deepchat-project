/**
 * MCP 工具注册表与调用代理（ToolManager）。
 *
 * 职责：从所有运行中的 server（及插件提供的工具目录）发现工具，构建
 * 「模型可见工具名 → 实际调用目标」的映射并缓存；按访问上下文过滤工具；
 * 代理工具调用——包括参数校验、目标一致性核验、插件策略检查与派发。
 *
 * 工具名规则：同名工具冲突时，冲突双方都被重命名为 `${serverName}_${tool}`，
 * 描述加 server 前缀；调用时始终用 server 侧的原始名。工具名最终必须匹配
 * /^[a-zA-Z0-9_-]+$/，否则该工具被丢弃。注册表缓存是整体失效式的：任何
 * server 状态变化都会 invalidateRegistry，下次枚举全量重建。
 */

import logger from '@shared/logger'
import {
  TOOL_EXECUTION,
  type MCPContentItem,
  type MCPTextContent,
  type MCPServerConfig,
  type MCPToolCall,
  type MCPToolDefinition,
  type McpToolDefinitionsSnapshot,
  type MCPToolResponse,
  type McpExpectedToolTarget,
  type Resource,
  type Tool,
  type ToolDispatchCommit,
  type ToolOutcomeProjectionRegistrar,
  type ToolCallResult
} from '@shared/types/mcp'
import type { AgentSettingsPort } from '@/agent/settings'
import { ServerManager } from './serverManager'
import { McpClient } from './mcpClient'
import { jsonrepair } from 'jsonrepair'
import { getExplicitlyDeniedPluginTools, resolvePluginToolPolicy } from '@/plugin/toolPolicyStore'
import type { DeepchatEventPublisher } from '@shared/contracts/events'
import type { SemanticNotificationPublisher } from '@/notifications'
import { awaitWithAbort } from '@/lib/awaitWithAbort'
import type { McpSettings } from './settings'
import { CUA_PLUGIN_ID } from '@shared/types/plugin'
import {
  appendCuaResultProjections,
  normalizeCuaToolArguments,
  validateCuaSnapshotTargetArguments
} from '@/plugin/cuaToolAdapter'
import type {
  PluginOwnedToolCatalogRegistration,
  PluginRuntimeStartReason
} from '@/plugin/runtimeSupervisor'
import { createPersistedMcpToolResult, getToolVisibility } from './resultProjection'
import { resolveCachedImageDataUrl as resolveCachedImageDataUrlFromDisk } from '@/platform/imageCache'
import { findJsonValueDifference, type JsonValueDifference } from './schemaValidation'
import { types as nodeTypes } from 'node:util'
import { McpPreDispatchError, type McpPreDispatchErrorCode } from './errors'

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, key), seen)
  }
  return Object.freeze(value)
}

/*
 * 各环节的资源上限：参数展开体积、缓存快照的条数/字节/节点数、缓存图片
 * 引用数量等。工具入参来自模型且可能包含指向本地缓存的 imgcache:// 引用，
 * 展开后体积可能暴涨，必须限界后再交给 server。
 */
const PLUGIN_RUNTIME_DIAGNOSTIC_TIMEOUT_MS = 30_000
const TOOL_CATALOG_VALIDATION_TIMEOUT_MS = 30_000
const MAX_SCHEMA_DIFFERENCE_PATH_LENGTH = 512
const MAX_CACHED_IMAGE_ARGUMENT_REFERENCES = 8
const MAX_MCP_EXECUTION_ARGUMENT_BYTES = 32 * 1024 * 1024
const MAX_CACHED_TOOL_SNAPSHOT_DEFINITIONS = 1_024
const MAX_CACHED_TOOL_SNAPSHOT_DEFINITION_BYTES = 256 * 1_024
const MAX_CACHED_TOOL_SNAPSHOT_TOTAL_BYTES = 4 * 1_024 * 1_024
const MAX_CACHED_TOOL_SNAPSHOT_DEFINITION_NODES = 100_000
const MAX_CACHED_TOOL_SNAPSHOT_TOTAL_NODES = 500_000
const MAX_CACHED_TOOL_SNAPSHOT_DEPTH = 64
const MAX_CACHED_TOOL_SNAPSHOT_SOURCES = 1_024
const MAX_CACHED_TOOL_SNAPSHOT_SOURCE_NAME_BYTES = 1_024
const CACHED_IMAGE_REFERENCE_PATTERN = /^imgcache:\/\/\S+$/i
const CACHED_IMAGE_PREFIX_LENGTH = 'imgcache://'.length

const SCHEMA_DIFFERENCE_REASONS: Record<JsonValueDifference['kind'], string> = {
  type: 'type differs',
  value: 'value differs',
  'array-length': 'array length differs',
  'missing-key': 'missing from live schema',
  'unexpected-key': 'not present in packaged schema'
}

const formatSchemaDifference = (difference: JsonValueDifference): string => {
  const path =
    difference.path.length <= MAX_SCHEMA_DIFFERENCE_PATH_LENGTH
      ? difference.path
      : `${difference.path.slice(0, MAX_SCHEMA_DIFFERENCE_PATH_LENGTH - 3)}...`
  return `${JSON.stringify(path)} (${SCHEMA_DIFFERENCE_REASONS[difference.kind]})`
}

/**
 * 工具可见范围的过滤上下文（与 McpService 侧的同名结构对应）。
 * includeRegularServers=false 表示只看插件工具；expectedServerNames 用于
 * 快照比对时声明「应当成功」的 server 集合。
 */
type McpToolAccessContext = {
  enabledTools?: string[]
  enabledServerIds?: string[]
  agentId?: string
  conversationId?: string
  includeRegularServers?: boolean
  expectedServerNames?: string[]
}

export type ComputerUsePreviewCall = {
  conversationId: string
  runId: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  source: {
    serverName: string
    ownerPluginId?: string
  }
}

export type ComputerUsePreviewObserver = {
  shouldCaptureAfterClick?(call: ComputerUsePreviewCall): boolean
  started(call: ComputerUsePreviewCall): void
  completed(call: ComputerUsePreviewCall, result: MCPToolResponse): void
  failed(call: ComputerUsePreviewCall, error: unknown): void
}

type ActiveToolDefinitionsRefresh = {
  completion: Promise<void>
  settle: () => void
}

type CachedImageDataUrlResolver = (source: string, signal?: AbortSignal) => Promise<string>

type CachedImageResolutionContext = {
  dataUrls: Map<string, Promise<string>>
  referenceCount: number
  expandedBytes: number
}

/**
 * 插件运行时的所有权接口：由 PluginRuntimeSupervisor 提供实现。
 * 没有插件体系时用 NO_PLUGIN_OWNERSHIP 兜底，保证 ToolManager 可独立工作。
 */
type PluginMcpOwnershipPort = {
  ownsServer(serverName: string): boolean
  isServerAvailable(serverName: string): boolean
  getOwnerPluginId(serverName: string): string | undefined
  getAvailableToolCatalogs(): PluginOwnedToolCatalogRegistration[]
  getAvailableToolServerNames(): string[]
  ensureRunning(serverName: string, reason: PluginRuntimeStartReason): Promise<void>
}

const NO_PLUGIN_OWNERSHIP: PluginMcpOwnershipPort = {
  ownsServer: () => false,
  isServerAvailable: () => false,
  getOwnerPluginId: () => undefined,
  getAvailableToolCatalogs: () => [],
  getAvailableToolServerNames: () => [],
  ensureRunning: async (serverName) => {
    throw new Error(`Plugin runtime server "${serverName}" is not registered`)
  }
}

/** 一个工具来源：live server 客户端，或插件注册的静态工具目录。 */
type ToolSource = {
  serverName: string
  displayName: string
  icon: string
  tools: readonly Tool[]
  client?: McpClient
  catalogBacked: boolean
}

/**
 * 最终工具名 → 调用目标的映射项。originalName 保留 server 侧原始名
 * （冲突重命名后两者不同），catalogTool 是插件目录提供的打包定义。
 */
type ToolTarget = {
  serverName: string
  originalName: string
  client?: McpClient
  catalogBacked: boolean
  catalogTool?: Tool
  definition: MCPToolDefinition
}

type CatalogValidationState = {
  readonly liveTools: ReadonlyMap<string, Tool>
  readonly verifiedToolNames: Set<string>
}

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
    conversationId: input?.conversationId?.trim() || undefined,
    includeRegularServers: input?.includeRegularServers,
    expectedServerNames: normalizeStringList(input?.expectedServerNames)
  }
}

/**
 * 对缓存快照做结构与体积限界校验（遍历式）：条数、单条/总体字节、节点数、
 * 深度、循环引用、代理对象、非纯 JSON 值都拒绝。快照会被深拷贝并冻结后
 * 跨进程暴露，这里保证其可安全序列化且不会撑爆内存。
 */
function assertBoundedCachedToolSnapshot(definitions: readonly MCPToolDefinition[]): void {
  if (definitions.length > MAX_CACHED_TOOL_SNAPSHOT_DEFINITIONS) {
    throw new Error('Cached Tool definition snapshot exceeds its definition limit.')
  }

  let totalBytes = 0
  let totalNodes = 0
  for (const definition of definitions) {
    const ancestors = new Set<object>()
    const stack: Array<
      | { readonly kind: 'enter'; readonly value: unknown; readonly depth: number }
      | { readonly kind: 'exit'; readonly value: object }
    > = [{ kind: 'enter', value: definition, depth: 0 }]
    let definitionBytes = 0
    let definitionNodes = 0
    const addBytes = (bytes: number): void => {
      definitionBytes += bytes
      totalBytes += bytes
      if (
        definitionBytes > MAX_CACHED_TOOL_SNAPSHOT_DEFINITION_BYTES ||
        totalBytes > MAX_CACHED_TOOL_SNAPSHOT_TOTAL_BYTES
      ) {
        throw new Error('Cached Tool definition snapshot exceeds its byte limit.')
      }
    }

    while (stack.length > 0) {
      const item = stack.pop()
      if (!item) break
      if (item.kind === 'exit') {
        ancestors.delete(item.value)
        continue
      }
      definitionNodes += 1
      totalNodes += 1
      if (
        definitionNodes > MAX_CACHED_TOOL_SNAPSHOT_DEFINITION_NODES ||
        totalNodes > MAX_CACHED_TOOL_SNAPSHOT_TOTAL_NODES ||
        item.depth > MAX_CACHED_TOOL_SNAPSHOT_DEPTH
      ) {
        throw new Error('Cached Tool definition snapshot exceeds its structural limit.')
      }

      if (item.value === null) {
        addBytes(4)
        continue
      }
      if (typeof item.value === 'boolean') {
        addBytes(item.value ? 4 : 5)
        continue
      }
      if (typeof item.value === 'number') {
        if (!Number.isFinite(item.value)) {
          throw new Error('Cached Tool definition snapshot contains a non-JSON value.')
        }
        addBytes(Buffer.byteLength(JSON.stringify(item.value), 'utf8'))
        continue
      }
      if (typeof item.value === 'string') {
        if (Buffer.byteLength(item.value, 'utf8') > MAX_CACHED_TOOL_SNAPSHOT_DEFINITION_BYTES) {
          throw new Error('Cached Tool definition snapshot exceeds its byte limit.')
        }
        addBytes(Buffer.byteLength(JSON.stringify(item.value), 'utf8'))
        continue
      }
      if (!item.value || typeof item.value !== 'object') {
        throw new Error('Cached Tool definition snapshot contains a non-JSON value.')
      }
      if (ancestors.has(item.value) || nodeTypes.isProxy(item.value)) {
        throw new Error('Cached Tool definition snapshot contains an unsafe object graph.')
      }
      if (Object.getOwnPropertySymbols(item.value).length > 0) {
        throw new Error('Cached Tool definition snapshot contains a symbol property.')
      }

      ancestors.add(item.value)
      stack.push({ kind: 'exit', value: item.value })
      if (Array.isArray(item.value)) {
        const keys = Object.getOwnPropertyNames(item.value).filter((key) => key !== 'length')
        if (keys.length !== item.value.length) {
          throw new Error('Cached Tool definition snapshot contains an invalid array.')
        }
        addBytes(2 + Math.max(0, item.value.length - 1))
        for (let index = item.value.length - 1; index >= 0; index -= 1) {
          const descriptor = Object.getOwnPropertyDescriptor(item.value, String(index))
          if (!descriptor?.enumerable || !('value' in descriptor)) {
            throw new Error('Cached Tool definition snapshot contains an unsafe property.')
          }
          stack.push({ kind: 'enter', value: descriptor.value, depth: item.depth + 1 })
        }
        continue
      }

      const prototype = Object.getPrototypeOf(item.value)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('Cached Tool definition snapshot contains a non-JSON object.')
      }
      const keys = Object.getOwnPropertyNames(item.value)
      let includedProperties = 0
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]
        const descriptor = Object.getOwnPropertyDescriptor(item.value, key)
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new Error('Cached Tool definition snapshot contains an unsafe property.')
        }
        if (descriptor.value === undefined) continue
        addBytes(
          Buffer.byteLength(JSON.stringify(key), 'utf8') + 1 + (includedProperties > 0 ? 1 : 0)
        )
        includedProperties += 1
        stack.push({ kind: 'enter', value: descriptor.value, depth: item.depth + 1 })
      }
      addBytes(2)
    }
  }
}

function assertBoundedCachedToolSnapshotSources(serverNames: readonly string[]): void {
  if (serverNames.length > MAX_CACHED_TOOL_SNAPSHOT_SOURCES) {
    throw new Error('Cached Tool definition snapshot exceeds its source limit.')
  }
  for (const serverName of serverNames) {
    if (Buffer.byteLength(serverName, 'utf8') > MAX_CACHED_TOOL_SNAPSHOT_SOURCE_NAME_BYTES) {
      throw new Error('Cached Tool definition snapshot exceeds its source-name limit.')
    }
  }
}

/**
 * 工具注册表。核心状态是三类缓存：工具定义列表、成功/失败的 server 集合
 * （用于快照完整性判定）与工具名→目标映射。缓存为 null 表示需要重建；
 * 重建由 activeToolDefinitionsRefresh 去重，并发调用共享同一次全量枚举，
 * 枚举期间注册表失效（generation 变化）则丢弃结果重来。
 */
export class ToolManager {
  private readonly agentSettings: Pick<AgentSettingsPort, 'getAcpAgents' | 'getAgentMcpSelections'>
  private readonly mcpSettings: McpSettings
  private serverManager: ServerManager
  private cachedToolDefinitions: MCPToolDefinition[] | null = null
  private cachedToolDefinitionFailedServerNames: ReadonlySet<string> | null = null
  private cachedToolDefinitionSuccessfulServerNames: ReadonlySet<string> | null = null
  private toolNameToTargetMap: Map<string, ToolTarget> | null = null
  private catalogValidationPromises = new WeakMap<McpClient, Promise<CatalogValidationState>>()
  private toolDefinitionsCacheGeneration = 0
  private activeToolDefinitionsRefresh: ActiveToolDefinitionsRefresh | null = null

  constructor(
    agentSettings: Pick<AgentSettingsPort, 'getAcpAgents' | 'getAgentMcpSelections'>,
    mcpSettings: McpSettings,
    serverManager: ServerManager,
    private readonly semanticNotifications: SemanticNotificationPublisher,
    private readonly publishEvent: DeepchatEventPublisher,
    private readonly pluginOwnership: PluginMcpOwnershipPort = NO_PLUGIN_OWNERSHIP,
    private readonly computerUsePreviewObserver?: ComputerUsePreviewObserver,
    private readonly resolveCachedImageDataUrl: CachedImageDataUrlResolver = resolveCachedImageDataUrlFromDisk
  ) {
    this.agentSettings = agentSettings
    this.mcpSettings = mcpSettings
    this.serverManager = serverManager
  }

  /**
   * 整体作废注册表缓存：generation 自增会让进行中的枚举结果被丢弃，
   * 同时放行所有等待该轮枚举的调用方（settle），让它们进入下一轮重建。
   * server 启停、配置变化、插件注册变化都应触发这里。
   */
  public invalidateRegistry(): void {
    console.info('MCP client list updated, clearing tool definitions cache and target map.')
    this.toolDefinitionsCacheGeneration += 1
    this.activeToolDefinitionsRefresh?.settle()
    this.activeToolDefinitionsRefresh = null
    this.cachedToolDefinitions = null
    this.cachedToolDefinitionFailedServerNames = null
    this.cachedToolDefinitionSuccessfulServerNames = null
    this.toolNameToTargetMap = null
    this.catalogValidationPromises = new WeakMap()
  }

  /**
   * 输出当前缓存的工具快照（同步、不触发重建）：深拷贝冻结后附带完整性
   * 信息——期望存在但既不在成功也不在失败集合里的 server 视为失败
   * （说明尚未发现完成）。未初始化时返回 uninitialized 状态。
   */
  public snapshotCachedToolDefinitions(
    access?: string[] | McpToolAccessContext
  ): McpToolDefinitionsSnapshot {
    if (
      this.cachedToolDefinitions === null ||
      this.cachedToolDefinitionFailedServerNames === null ||
      this.cachedToolDefinitionSuccessfulServerNames === null ||
      this.toolNameToTargetMap === null
    ) {
      return Object.freeze({ state: 'uninitialized' })
    }
    const context = normalizeToolAccessContext(access)
    const selectedDefinitions = this.filterToolDefinitionsByContext(
      this.cachedToolDefinitions,
      context
    )
    assertBoundedCachedToolSnapshot(selectedDefinitions)
    const tools = selectedDefinitions.map((definition) => deepFreeze(structuredClone(definition)))
    const hasExplicitExpectedServerNames = context.expectedServerNames !== undefined
    const expectedServerNames = Array.from(
      new Set([
        ...(context.expectedServerNames ?? []),
        ...this.pluginOwnership.getAvailableToolServerNames()
      ])
    )
    assertBoundedCachedToolSnapshotSources(expectedServerNames)
    const expectedServerNameSet = new Set(expectedServerNames)
    const failedServerNames = new Set(
      [...this.cachedToolDefinitionFailedServerNames].filter((serverName) =>
        hasExplicitExpectedServerNames
          ? expectedServerNameSet.has(serverName)
          : this.isServerAllowedByContext(serverName, context)
      )
    )
    for (const serverName of expectedServerNames) {
      if (
        !this.cachedToolDefinitionSuccessfulServerNames.has(serverName) &&
        !this.cachedToolDefinitionFailedServerNames.has(serverName)
      ) {
        failedServerNames.add(serverName)
      }
    }
    const failedSourceCount = failedServerNames.size
    return Object.freeze({
      state: 'ready',
      tools: Object.freeze(tools),
      complete: failedSourceCount === 0,
      failedSourceCount
    })
  }

  private isPluginOwnedClient(client: McpClient): boolean {
    return this.pluginOwnership.ownsServer(client.serverName)
  }

  private isCuaComputerUseServer(client: McpClient): boolean {
    return (
      this.pluginOwnership.isServerAvailable(client.serverName) &&
      this.pluginOwnership.getOwnerPluginId(client.serverName) === CUA_PLUGIN_ID
    )
  }

  public async getRunningClients(): Promise<McpClient[]> {
    return this.serverManager.getRunningClients()
  }

  public async checkPluginRuntimePermissions(serverName: string): Promise<unknown> {
    if (!this.pluginOwnership.ownsServer(serverName)) {
      throw new Error(`MCP server "${serverName}" is not owned by a plugin runtime`)
    }
    if (!this.pluginOwnership.isServerAvailable(serverName)) {
      throw new Error(`Plugin runtime server "${serverName}" is not available`)
    }

    await this.pluginOwnership.ensureRunning(serverName, 'runtime-test')
    if (!this.pluginOwnership.isServerAvailable(serverName)) {
      throw new Error(`Plugin runtime server "${serverName}" is no longer available`)
    }
    const client = this.serverManager.getClient(serverName)
    if (!client) {
      throw new Error(`Plugin runtime server "${serverName}" has no running client`)
    }
    const signal = AbortSignal.timeout(PLUGIN_RUNTIME_DIAGNOSTIC_TIMEOUT_MS)
    const catalogTool = this.getCatalogTool(serverName, 'check_permissions')
    await this.verifyCatalogTool(client, catalogTool, signal)
    const result = await client.callTool('check_permissions', { prompt: false }, { signal })
    if (result.isError) {
      const detail = result.content
        ?.filter((item): item is MCPTextContent => item.type === 'text')
        .map((item) => item.text)
        .filter(Boolean)
        .join('; ')
      throw new Error(detail || `Plugin runtime server "${serverName}" permission check failed`)
    }
    return result
  }

  // Get all tool definitions
  /**
   * 获取全部工具定义（带缓存与并发去重）。
   *
   * 流程：命中缓存直接按上下文过滤返回；否则进入一轮全量重建——
   * 1. loadToolSources 收集各 server 与插件目录的工具；
   * 2. 按工具名扫冲突，冲突者双方记入重命名集合；
   * 3. 生成最终定义（重命名、参数缺省描述、执行策略固定为 write——
   *    server 自报的 execution 注解不可信）并填充目标映射；
   * 4. 若期间注册表失效（generation 变化）则丢弃重来，否则写入缓存。
   * 并发调用共享同一轮重建；signal 中止会让等待方立即抛出。
   */
  public async getAllToolDefinitions(
    access?: string[] | McpToolAccessContext,
    options?: { signal?: AbortSignal }
  ): Promise<MCPToolDefinition[]> {
    options?.signal?.throwIfAborted()
    const context = normalizeToolAccessContext(access)
    if (this.cachedToolDefinitions !== null) {
      return this.filterToolDefinitionsByContext(this.cachedToolDefinitions, context)
    }

    const activeRefresh = this.activeToolDefinitionsRefresh
    if (activeRefresh) {
      await awaitWithAbort(activeRefresh.completion, options?.signal)
      return await this.getAllToolDefinitions(access, options)
    }

    let resolveRefresh = () => {}
    const refreshCompletion = new Promise<void>((resolve) => {
      resolveRefresh = resolve
    })
    const refresh: ActiveToolDefinitionsRefresh = {
      completion: refreshCompletion,
      settle: () => resolveRefresh()
    }
    this.activeToolDefinitionsRefresh = refresh

    try {
      const refreshGeneration = this.toolDefinitionsCacheGeneration
      console.info('Fetching/refreshing tool definitions and target map...')
      const clients = await awaitWithAbort(this.serverManager.getRunningClients(), options?.signal)
      const loadedSources = await this.loadToolSources(clients ?? [], options?.signal)
      const sources = loadedSources.sources
      const serverConfigs = await awaitWithAbort(this.mcpSettings.getMcpServers(), options?.signal)
      const results: MCPToolDefinition[] = []
      const nextToolNameToTargetMap = new Map<string, ToolTarget>()

      if (sources.length === 0) {
        console.warn('No live MCP tools or on-demand plugin tool catalogs found.')
      }

      const toolNameToServerMap: Map<string, string> = new Map()
      const toolsToRename: Map<string, Set<string>> = new Map()

      for (const source of sources) {
        const currentServerRenames = toolsToRename.get(source.serverName) ?? new Set<string>()
        for (const tool of source.tools) {
          if (!getToolVisibility(tool).includes('model')) {
            continue
          }
          const originalServerName = toolNameToServerMap.get(tool.name)
          if (originalServerName && originalServerName !== source.serverName) {
            console.warn(
              `Conflict detected for tool '${tool.name}' between server '${originalServerName}' and '${source.serverName}'. Marking for rename.`
            )
            const originalServerRenames = toolsToRename.get(originalServerName) ?? new Set()
            originalServerRenames.add(tool.name)
            toolsToRename.set(originalServerName, originalServerRenames)
            currentServerRenames.add(tool.name)
          } else if (!originalServerName) {
            toolNameToServerMap.set(tool.name, source.serverName)
          }
        }
        if (currentServerRenames.size > 0) {
          toolsToRename.set(source.serverName, currentServerRenames)
        }
      }

      for (const source of sources) {
        const renamesForThisServer = toolsToRename.get(source.serverName) ?? new Set()
        for (const tool of source.tools) {
          if (!getToolVisibility(tool).includes('model')) {
            continue
          }
          let finalName = tool.name
          let finalDescription = tool.description ?? ''
          const originalName = tool.name

          if (renamesForThisServer.has(originalName)) {
            finalName = `${source.serverName}_${originalName}`
            finalDescription = `[${source.serverName}] ${tool.description ?? ''}`
          }

          const namePattern = /^[a-zA-Z0-9_-]+$/
          if (!namePattern.test(finalName)) {
            console.error(
              `Generated tool name '${finalName}' is invalid. Skipping tool '${originalName}' from server '${source.serverName}'. Please ensure the tool name matches the allowed pattern: /^[a-zA-Z0-9_-]+$/`
            )
            continue
          }

          const properties = isRecord(tool.inputSchema.properties)
            ? tool.inputSchema.properties
            : {}
          const toolProperties = Object.fromEntries(
            Object.entries(properties).map(([key, value]) => [
              key,
              isRecord(value) && !value.description
                ? { ...value, description: `Params of ${key}` }
                : value
            ])
          )

          const serverConfig = serverConfigs[source.serverName]
          const definition: MCPToolDefinition = {
            // Server annotations are untrusted hints and must not weaken local execution policy.
            execution: TOOL_EXECUTION.write,
            type: 'function',
            function: {
              name: finalName,
              description: finalDescription,
              parameters: {
                type: 'object',
                properties: toolProperties,
                required: Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : []
              }
            },
            server: {
              name: source.serverName,
              icons: source.icon,
              description: source.displayName,
              id: serverConfig?.serverId,
              configGeneration: serverConfig?.configGeneration,
              bindingHash: serverConfig?.bindingHash
            },
            raw: {
              name: tool.name,
              title: tool.title,
              description: tool.description,
              icons: tool.icons,
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
              annotations: tool.annotations,
              _meta: tool._meta,
              execution: tool.execution
            }
          }
          results.push(definition)

          nextToolNameToTargetMap.set(finalName, {
            serverName: source.serverName,
            originalName,
            client: source.client,
            catalogBacked: source.catalogBacked,
            catalogTool: tool,
            definition: deepFreeze(structuredClone({ ...definition, source: 'mcp' as const }))
          })
        }
      }

      // Cache results and return
      options?.signal?.throwIfAborted()
      if (refreshGeneration !== this.toolDefinitionsCacheGeneration) {
        if (this.activeToolDefinitionsRefresh === refresh) {
          this.activeToolDefinitionsRefresh = null
        }
        return await this.getAllToolDefinitions(access, options)
      }
      this.cachedToolDefinitions = results
      this.cachedToolDefinitionFailedServerNames = new Set(loadedSources.failedServerNames)
      this.cachedToolDefinitionSuccessfulServerNames = new Set(
        sources.map((source) => source.serverName)
      )
      this.toolNameToTargetMap = nextToolNameToTargetMap
      console.info(`Cached ${results.length} final tool definitions and populated target map.`)

      return this.filterToolDefinitionsByContext(this.cachedToolDefinitions, context)
    } finally {
      refresh.settle()
      if (this.activeToolDefinitionsRefresh === refresh) {
        this.activeToolDefinitionsRefresh = null
      }
    }
  }

  /**
   * 从两类来源收集工具：
   * - live clients：逐个 listTools，成功则清 lastError 并解除 toolListFailed
   *   通知；失败则记入 failedServerNames（单 server 失败不拖垮整体）。
   *   不可用的插件 server 与已被目录覆盖的 server 跳过，避免重复。
   * - 插件工具目录：直接采用插件注册的静态 catalog（catalogBacked=true），
   *   调用前会用 verifyCatalogTool 与 live server 核对一致性。
   */
  private async loadToolSources(
    clients: McpClient[],
    signal?: AbortSignal
  ): Promise<{ sources: ToolSource[]; failedServerNames: ReadonlySet<string> }> {
    const catalogRegistrations = this.pluginOwnership.getAvailableToolCatalogs()
    const catalogServerNames = new Set(
      catalogRegistrations.map((registration) => registration.serverName)
    )
    const sources: ToolSource[] = []
    const failedServerNames = new Set<string>()

    for (const client of clients) {
      if (
        (this.pluginOwnership.ownsServer(client.serverName) &&
          !this.pluginOwnership.isServerAvailable(client.serverName)) ||
        catalogServerNames.has(client.serverName)
      ) {
        continue
      }

      try {
        const tools = await awaitWithAbort(client.listTools({ signal }), signal)
        this.serverManager.clearServerLastError(client.serverName)
        if (!this.isPluginOwnedClient(client)) {
          this.recoverToolListNotification(client.serverName)
        }
        if (!tools) {
          continue
        }
        sources.push({
          serverName: client.serverName,
          displayName: client.serverConfig.descriptions as string,
          icon: client.serverConfig.icons as string,
          tools: this.filterExplicitlyDeniedTools(client.serverName, tools),
          client,
          catalogBacked: false
        })
      } catch (error) {
        if (signal?.aborted) {
          throw error
        }
        failedServerNames.add(client.serverName)
        this.handleToolListError(client, error)
      }
    }

    for (const registration of catalogRegistrations) {
      sources.push({
        serverName: registration.serverName,
        displayName: registration.displayName,
        icon: 'plugin',
        tools: this.filterExplicitlyDeniedTools(
          registration.serverName,
          registration.toolCatalog.tools
        ),
        catalogBacked: true
      })
    }
    return { sources, failedServerNames }
  }

  private filterExplicitlyDeniedTools(serverName: string, tools: readonly Tool[]): readonly Tool[] {
    const deniedTools = new Set(getExplicitlyDeniedPluginTools(serverName))
    return deniedTools.size === 0 ? tools : tools.filter((tool) => !deniedTools.has(tool.name))
  }

  private handleToolListError(client: McpClient, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const serverName = client.serverName || 'Unknown server'
    console.error(`Failed to get tool list from server '${serverName}':`, errorMessage)
    this.serverManager.setServerLastError(serverName, errorMessage)
    if (this.isPluginOwnedClient(client)) {
      return
    }

    this.semanticNotifications.occur({
      code: 'mcp.toolListFailed',
      serverName
    })
  }

  private recoverToolListNotification(serverName: string): void {
    this.semanticNotifications.recover({
      code: 'mcp.toolListFailed',
      serverName
    })
  }

  /**
   * 派发前的访问控制判定：按 finalName 与原始名双重匹配 enabledTools，
   * server 维度交由 isServerAllowedByContext。
   */
  private filterToolDefinitionsByContext(
    toolDefinitions: MCPToolDefinition[],
    context: McpToolAccessContext
  ): MCPToolDefinition[] {
    if (
      !context.enabledTools &&
      !context.enabledServerIds &&
      context.includeRegularServers !== false
    ) {
      return toolDefinitions
    }

    return toolDefinitions.filter((toolDef) => {
      const finalName = toolDef.function.name
      const target = this.toolNameToTargetMap?.get(finalName)
      const originalName = target?.originalName || finalName
      if (
        context.enabledTools &&
        !context.enabledTools.includes(finalName) &&
        !context.enabledTools.includes(originalName)
      ) {
        return false
      }
      return this.isServerAllowedByContext(toolDef.server.name, context)
    })
  }

  private isServerAllowedByContext(serverName: string, context: McpToolAccessContext): boolean {
    // Official plugin runtimes are app-global capabilities; per-agent MCP selections only govern
    // user-configured servers.
    if (this.pluginOwnership.isServerAvailable(serverName)) {
      return true
    }
    if (context.includeRegularServers === false) {
      return false
    }
    return !context.enabledServerIds || context.enabledServerIds.includes(serverName)
  }

  /**
   * 核对「授权时看到的工具目标」与「当前实际目标」是否一致：工具名、
   * server、原始名、serverId/configGeneration/bindingHash 任一变化都返回
   * 差异描述（null 表示一致）。用于会话授权后工具环境被用户改动的防护。
   */
  private describeExpectedTargetMismatch(
    finalName: string,
    target: ToolTarget | undefined,
    expected: McpExpectedToolTarget | undefined,
    config?: MCPServerConfig | null
  ): string | null {
    if (!expected) {
      return null
    }
    if (expected.finalName !== finalName) {
      return 'the authorized tool name no longer matches the requested tool'
    }
    if (
      !target ||
      target.serverName !== expected.serverName ||
      target.originalName !== expected.originalName
    ) {
      return 'the authorized MCP tool now resolves to a different target'
    }
    if (config === null) {
      return 'the authorized MCP server configuration is no longer available'
    }
    if (
      config &&
      (config.serverId !== expected.serverId ||
        config.configGeneration !== expected.configGeneration ||
        config.bindingHash !== expected.bindingHash)
    ) {
      return 'the authorized MCP server binding changed before dispatch'
    }
    return null
  }

  private createTargetChangedResponse(
    toolCallId: string,
    reason: string,
    throwError = false
  ): MCPToolResponse {
    return this.createPreDispatchErrorResponse(
      toolCallId,
      'target_changed',
      `Error: MCP tool execution was cancelled because ${reason}. Refresh tools and retry.`,
      throwError
    )
  }

  private createPreDispatchErrorResponse(
    toolCallId: string,
    code: McpPreDispatchErrorCode,
    content: string,
    throwError = false
  ): MCPToolResponse {
    if (throwError) throw new McpPreDispatchError(content, code)
    return {
      toolCallId,
      content,
      isError: true
    }
  }

  /**
   * 工具调用的完整流水线。派发前依次过闸：
   * 目标映射存在 → expectedTarget 一致性 → ACP agent 的 MCP 白名单 →
   * server 配置存在且绑定一致 → server 级访问控制 → 插件工具策略 →
   * 参数解析与展开（imgcache 引用解析、CUA 参数规范化）→ 最终一致性复核
   * （配置可能在准备参数期间被改）。
   * 全部通过后 commitDispatch 标记派发边界，再以原始工具名调用目标 client。
   * 派发失败不抛错而返回 isError 响应对象（除非 throwPreDispatchErrors）；
   * signal 中止在派发提交后不再作废已执行的结果。
   */
  async callTool(
    toolCall: MCPToolCall,
    access?: Pick<McpToolAccessContext, 'agentId' | 'enabledServerIds'> & {
      signal?: AbortSignal
      runId?: string
      expectedTarget?: McpExpectedToolTarget
      assertCurrentToolDefinition?: (definition: MCPToolDefinition) => void
      throwPreDispatchErrors?: boolean
      commitDispatch?: ToolDispatchCommit
      registerOutcomeProjection?: ToolOutcomeProjectionRegistrar
    }
  ): Promise<MCPToolResponse> {
    let previewCall: ComputerUsePreviewCall | null = null
    let previewStarted = false
    let previewTerminalNotified = false
    let dispatchBoundaryFailed = false
    let dispatchCommitted = false
    try {
      access?.signal?.throwIfAborted()
      const finalName = toolCall.function.name
      const argsString = toolCall.function.arguments

      logger.info(`[ToolManager] Calling tool:`, {
        requestedName: finalName,
        originalName: finalName,
        serverName: toolCall.server?.name || 'unknown'
      })

      // Ensure definitions and map are loaded/cached
      await awaitWithAbort(
        this.getAllToolDefinitions(undefined, { signal: access?.signal }),
        access?.signal
      )
      access?.signal?.throwIfAborted()

      if (!this.toolNameToTargetMap) {
        console.error('Tool target map is not available.')
        return this.createPreDispatchErrorResponse(
          toolCall.id,
          'runtime_unavailable',
          'Error: Internal error - tool information not available.',
          access?.throwPreDispatchErrors
        )
      }

      const targetInfo = this.toolNameToTargetMap.get(finalName)

      if (!targetInfo) {
        console.error(`Tool '${finalName}' not found in the target map.`)
        return this.createPreDispatchErrorResponse(
          toolCall.id,
          'target_unavailable',
          `Error: Tool '${finalName}' not found or server not running.`,
          access?.throwPreDispatchErrors
        )
      }

      const { originalName, serverName: toolServerName } = targetInfo
      const targetMismatch = this.describeExpectedTargetMismatch(
        finalName,
        targetInfo,
        access?.expectedTarget
      )
      if (targetMismatch) {
        return this.createTargetChangedResponse(
          toolCall.id,
          targetMismatch,
          access?.throwPreDispatchErrors
        )
      }
      const accessContext = normalizeToolAccessContext({
        agentId: access?.agentId,
        enabledServerIds: access?.enabledServerIds,
        conversationId: toolCall.conversationId
      })
      const hintedProviderId = toolCall.providerId?.trim()
      const shouldCheckAcpAccess = Boolean(toolCall.conversationId) && hintedProviderId === 'acp'

      // Session execution passes agent identity with the tool access context.
      if (shouldCheckAcpAccess) {
        const agentId = accessContext.agentId
        if (!agentId) {
          return this.createPreDispatchErrorResponse(
            toolCall.id,
            'tool_not_allowed',
            'ACP agent context is required for MCP access control.',
            access?.throwPreDispatchErrors
          )
        }

        try {
          const acpAgents = await awaitWithAbort(this.agentSettings.getAcpAgents(), access?.signal)
          if (acpAgents.some((item) => item.id === agentId)) {
            const selections = await awaitWithAbort(
              this.agentSettings.getAgentMcpSelections(agentId),
              access?.signal
            )
            if (!selections?.length || !selections.includes(toolServerName)) {
              return this.createPreDispatchErrorResponse(
                toolCall.id,
                'tool_not_allowed',
                `MCP server '${toolServerName}' is not allowed for ACP agent '${agentId}'. Configure MCP access in ACP settings.`,
                access?.throwPreDispatchErrors
              )
            }
          }
        } catch (error) {
          if (access?.signal?.aborted || isAbortError(error)) throw error
          console.warn('[ToolManager] Failed to check ACP agent MCP access control:', error)
        }
      }
      access?.signal?.throwIfAborted()

      // Log the call details including original name
      console.info('[MCP] ToolManager calling tool', {
        requestedName: finalName,
        originalName: originalName,
        serverName: toolServerName
      })

      // Parse arguments
      let args: Record<string, unknown> = {}
      if (argsString.trim()) {
        try {
          const parsed = JSON.parse(argsString)
          if (!isRecord(parsed)) {
            throw new Error('MCP tool arguments must be a JSON object')
          }
          args = parsed
        } catch (error: unknown) {
          console.warn(
            'Error parsing tool call arguments with JSON.parse, trying jsonrepair:',
            error instanceof Error ? error.message : String(error)
          )
          try {
            const repaired = JSON.parse(jsonrepair(argsString))
            if (!isRecord(repaired)) {
              throw new Error('MCP tool arguments must be a JSON object')
            }
            args = repaired
          } catch (repairError: unknown) {
            console.error('Error parsing MCP tool arguments even after jsonrepair:', repairError)
            return this.createPreDispatchErrorResponse(
              toolCall.id,
              'invalid_request',
              'Error: MCP tool arguments must be a valid JSON object.',
              access?.throwPreDispatchErrors
            )
          }
        }
      }

      // Get server configuration
      const servers = await awaitWithAbort(this.mcpSettings.getMcpServers(), access?.signal)
      access?.signal?.throwIfAborted()
      const serverConfig = servers[toolServerName]
      if (!serverConfig) {
        console.error(`Configuration for server '${toolServerName}' not found.`)
        return this.createPreDispatchErrorResponse(
          toolCall.id,
          'target_unavailable',
          `Error: Configuration missing for server '${toolServerName}'.`,
          access?.throwPreDispatchErrors
        )
      }
      const bindingMismatch = this.describeExpectedTargetMismatch(
        finalName,
        targetInfo,
        access?.expectedTarget,
        serverConfig
      )
      if (bindingMismatch) {
        return this.createTargetChangedResponse(
          toolCall.id,
          bindingMismatch,
          access?.throwPreDispatchErrors
        )
      }
      if (!this.isServerAllowedByContext(toolServerName, accessContext)) {
        return this.createPreDispatchErrorResponse(
          toolCall.id,
          'tool_not_allowed',
          `MCP server '${toolServerName}' is not allowed for Office Agent '${accessContext.agentId ?? 'unknown'}'. Configure MCP access in Office Agent settings.`,
          access?.throwPreDispatchErrors
        )
      }
      const pluginPolicy = resolvePluginToolPolicy(toolServerName, originalName)
      if (
        pluginPolicy.managed &&
        pluginPolicy.decision !== 'allow' &&
        pluginPolicy.decision !== 'ask'
      ) {
        return this.createPreDispatchErrorResponse(
          toolCall.id,
          'tool_not_allowed',
          pluginPolicy.decision === 'deny'
            ? `Tool '${originalName}' on server '${toolServerName}' is blocked by plugin policy.`
            : `Tool '${originalName}' on server '${toolServerName}' is not declared by its closed plugin policy.`,
          access?.throwPreDispatchErrors
        )
      }
      const targetClient = await this.resolveToolClient(targetInfo, access?.signal)
      access?.signal?.throwIfAborted()
      const preparedArgs = await this.prepareToolArguments(
        targetClient,
        originalName,
        args,
        access?.signal
      )
      access?.signal?.throwIfAborted()
      if (!preparedArgs.ok) {
        return this.createPreDispatchErrorResponse(
          toolCall.id,
          'invalid_request',
          `Error: ${preparedArgs.error}`,
          access?.throwPreDispatchErrors
        )
      }

      const currentServers = await awaitWithAbort(this.mcpSettings.getMcpServers(), access?.signal)
      access?.signal?.throwIfAborted()
      const currentTarget = this.toolNameToTargetMap?.get(finalName)
      const currentConfig = currentServers[toolServerName]
      const finalMismatch = this.describeExpectedTargetMismatch(
        finalName,
        currentTarget,
        access?.expectedTarget,
        currentConfig ?? null
      )
      if (
        finalMismatch ||
        !currentTarget ||
        !currentConfig ||
        (access?.expectedTarget && this.serverManager.getClient(toolServerName) !== targetClient)
      ) {
        return this.createTargetChangedResponse(
          toolCall.id,
          finalMismatch || 'the active MCP client changed before dispatch',
          access?.throwPreDispatchErrors
        )
      }

      previewCall =
        originalName === 'get_window_state'
          ? this.createComputerUsePreviewCall({
              client: targetClient,
              toolCall,
              toolName: originalName,
              args: preparedArgs.args,
              runId: access?.runId
            })
          : null
      const ownerPluginId = this.pluginOwnership.ownsServer(toolServerName)
        ? this.pluginOwnership.getOwnerPluginId(toolServerName)
        : undefined
      access?.signal?.throwIfAborted()
      try {
        access?.assertCurrentToolDefinition?.(currentTarget.definition)
        access?.commitDispatch?.({
          toolName: finalName,
          toolSource: 'mcp',
          normalizedArguments: preparedArgs.args,
          target: {
            serverName: toolServerName,
            originalName,
            ...(ownerPluginId ? { ownerPluginId } : {})
          }
        })
        dispatchCommitted = access?.commitDispatch !== undefined
      } catch (error) {
        dispatchBoundaryFailed = true
        throw error
      }
      if (previewCall) {
        this.notifyComputerUsePreview('started', previewCall)
        previewStarted = true
      }

      // Call the tool on the target client using the ORIGINAL name
      const result = access?.signal
        ? await targetClient.callTool(originalName, preparedArgs.args, {
            signal: access.signal,
            toolDefinition: currentTarget.catalogTool
          })
        : await targetClient.callTool(originalName, preparedArgs.args, {
            toolDefinition: currentTarget.catalogTool
          })
      const formattedResponse = this.formatToolResponse(toolCall.id, result)
      const mcpResult = currentTarget.catalogTool
        ? createPersistedMcpToolResult({
            tool: currentTarget.catalogTool,
            config: currentConfig,
            serverName: toolServerName,
            result
          })
        : undefined
      const response: MCPToolResponse = {
        ...formattedResponse,
        content:
          ownerPluginId === CUA_PLUGIN_ID
            ? appendCuaResultProjections(
                formattedResponse.content,
                originalName,
                result.structuredContent,
                result.isError === true
              )
            : formattedResponse.content,
        ...(ownerPluginId ? { ownerPluginId } : {}),
        ...(mcpResult ? { mcpResult } : {})
      }

      const projectOutcome = () => {
        if (previewCall) {
          this.notifyComputerUsePreview('completed', previewCall, response)
          previewTerminalNotified = true
        }

        this.publishEvent('mcp.toolCall.result', {
          functionName: toolCall.function.name,
          content: response.content,
          version: Date.now()
        })

        this.scheduleComputerUsePreviewAfterClick({
          client: targetClient,
          toolCall,
          toolName: originalName,
          args: preparedArgs.args,
          runId: access?.runId,
          response,
          signal: access?.signal
        })
      }
      if (dispatchCommitted && access?.registerOutcomeProjection) {
        access.registerOutcomeProjection(projectOutcome)
      } else {
        projectOutcome()
      }

      return response
    } catch (error: unknown) {
      if (previewCall && previewStarted && !previewTerminalNotified) {
        const projectFailure = () => {
          this.notifyComputerUsePreview('failed', previewCall!, error)
          previewTerminalNotified = true
        }
        if (dispatchCommitted && access?.registerOutcomeProjection) {
          access.registerOutcomeProjection(projectFailure)
        } else {
          projectFailure()
        }
      }
      if (isAbortError(error) || (access?.signal?.aborted && !dispatchCommitted)) {
        throw error
      }
      if (dispatchBoundaryFailed) {
        throw error
      }
      if (error instanceof McpPreDispatchError) {
        if (access?.throwPreDispatchErrors) throw error
      } else if (access?.throwPreDispatchErrors && !dispatchCommitted) {
        throw new McpPreDispatchError(
          'MCP runtime became unavailable before target dispatch.',
          'runtime_unavailable'
        )
      }

      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('Unhandled error during tool call:', error)
      return {
        toolCallId: toolCall.id,
        content: `Error: Failed to execute tool '${toolCall.function.name}': ${errorMessage}`,
        isError: true
      }
    }
  }

  /**
   * 解析调用目标对应的 client：插件 server 先确保运行时已拉起；目录型
   * 工具（catalogBacked）还需先通过打包定义与 live 定义的一致性核验。
   */
  private async resolveToolClient(target: ToolTarget, signal?: AbortSignal): Promise<McpClient> {
    let client = target.client
    if (this.pluginOwnership.ownsServer(target.serverName)) {
      await awaitWithAbort(this.pluginOwnership.ensureRunning(target.serverName, 'tool'), signal)
      signal?.throwIfAborted()
      if (!this.pluginOwnership.isServerAvailable(target.serverName)) {
        throw new Error(`Plugin runtime server "${target.serverName}" is no longer available`)
      }
      client = this.serverManager.getClient(target.serverName)
    }
    if (!client) {
      throw new Error(`MCP server "${target.serverName}" has no running client`)
    }

    if (target.catalogBacked) {
      if (!target.catalogTool) {
        throw new Error(
          `Catalog-backed MCP tool "${target.originalName}" has no packaged definition`
        )
      }
      await this.verifyCatalogTool(client, target.catalogTool, signal)
    }
    return client
  }

  /**
   * 核验目录型工具：按 client 去重共享一次 live listTools（30s 超时），
   * 工具缺失或 inputSchema 与打包目录不一致即抛 definition_changed——
   * 插件目录声明与 server 实际行为必须一致才允许执行，防止打包定义
   * 掩盖 server 侧的参数漂移。
   */
  private async verifyCatalogTool(
    client: McpClient,
    catalogTool: Tool,
    signal?: AbortSignal
  ): Promise<void> {
    let validationPromise = this.catalogValidationPromises.get(client)
    if (!validationPromise) {
      const validationSignal = AbortSignal.timeout(TOOL_CATALOG_VALIDATION_TIMEOUT_MS)
      validationPromise = client
        .listTools({ signal: validationSignal })
        .then((liveTools) => {
          this.serverManager.clearServerLastError(client.serverName)
          const tools = new Map<string, Tool>()
          for (const liveTool of liveTools ?? []) {
            if (tools.has(liveTool.name)) {
              throw new Error(
                `Live MCP server "${client.serverName}" returned duplicate tool "${liveTool.name}"`
              )
            }
            tools.set(liveTool.name, liveTool)
          }
          return {
            liveTools: tools,
            verifiedToolNames: new Set<string>()
          }
        })
        .catch((error) => {
          this.serverManager.setServerLastError(client.serverName, error)
          throw error
        })
      this.catalogValidationPromises.set(client, validationPromise)
      void validationPromise.catch(() => {
        if (this.catalogValidationPromises.get(client) === validationPromise) {
          this.catalogValidationPromises.delete(client)
        }
      })
    }

    const validation = await awaitWithAbort(validationPromise, signal)
    signal?.throwIfAborted()
    if (validation.verifiedToolNames.has(catalogTool.name)) {
      return
    }

    const liveTool = validation.liveTools.get(catalogTool.name)
    if (!liveTool) {
      const errorMessage = `Live MCP tool "${catalogTool.name}" is missing from catalog-backed server "${client.serverName}"`
      this.serverManager.setServerLastError(client.serverName, errorMessage)
      throw new McpPreDispatchError(errorMessage, 'definition_changed')
    }
    const difference = findJsonValueDifference(catalogTool.inputSchema, liveTool.inputSchema)
    if (difference) {
      const errorMessage = `Live MCP tool "${catalogTool.name}" schema differs from the packaged catalog for server "${client.serverName}" at ${formatSchemaDifference(difference)}`
      this.serverManager.setServerLastError(client.serverName, errorMessage)
      throw new McpPreDispatchError(errorMessage, 'definition_changed')
    }
    validation.verifiedToolNames.add(catalogTool.name)
  }

  private getCatalogTool(serverName: string, toolName: string): Tool {
    const tool = this.pluginOwnership
      .getAvailableToolCatalogs()
      .find((registration) => registration.serverName === serverName)
      ?.toolCatalog.tools.find((candidate) => candidate.name === toolName)
    if (!tool) {
      throw new Error(
        `Plugin runtime server "${serverName}" has no packaged catalog entry for "${toolName}"`
      )
    }
    return tool
  }

  private createComputerUsePreviewCall(input: {
    client: McpClient
    toolCall: MCPToolCall
    toolName: string
    args: Record<string, unknown>
    runId?: string
  }): ComputerUsePreviewCall | null {
    const conversationId = input.toolCall.conversationId?.trim()
    const runId = input.runId?.trim()
    if (!conversationId || !runId || !this.isCuaComputerUseServer(input.client)) {
      return null
    }

    const ownerPluginId = this.pluginOwnership.getOwnerPluginId(input.client.serverName)
    return {
      conversationId,
      runId,
      toolCallId: input.toolCall.id,
      toolName: input.toolName,
      args: { ...input.args },
      source: {
        serverName: input.client.serverName,
        ...(ownerPluginId ? { ownerPluginId } : {})
      }
    }
  }

  private scheduleComputerUsePreviewAfterClick(input: {
    client: McpClient
    toolCall: MCPToolCall
    toolName: string
    args: Record<string, unknown>
    runId?: string
    response: MCPToolResponse
    signal?: AbortSignal
  }): void {
    if (
      input.toolName !== 'click' ||
      input.response.isError === true ||
      resolvePluginToolPolicy(input.client.serverName, 'get_window_state').decision !== 'allow' ||
      !this.computerUsePreviewObserver?.shouldCaptureAfterClick
    ) {
      return
    }

    const clickCall = this.createComputerUsePreviewCall(input)
    const pid = this.readPositiveIntegerArg(input.args.pid)
    const windowId = this.readPositiveIntegerArg(input.args.window_id)
    if (!clickCall || pid == null || windowId == null) {
      return
    }

    let shouldCapture = false
    try {
      shouldCapture = this.computerUsePreviewObserver.shouldCaptureAfterClick(clickCall)
    } catch (error) {
      logger.warn('[ToolManager] Computer Use preview eligibility check failed', {
        toolCallId: clickCall.toolCallId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    if (!shouldCapture) {
      return
    }

    const snapshotCall: ComputerUsePreviewCall = {
      ...clickCall,
      toolCallId: `${clickCall.toolCallId}:pip-snapshot`,
      toolName: 'get_window_state',
      args: {
        pid,
        window_id: windowId
      }
    }
    void this.captureComputerUsePreviewSnapshot(input.client, snapshotCall, input.signal)
  }

  private async captureComputerUsePreviewSnapshot(
    client: McpClient,
    call: ComputerUsePreviewCall,
    signal?: AbortSignal
  ): Promise<void> {
    let started = false
    try {
      signal?.throwIfAborted()
      this.notifyComputerUsePreview('started', call)
      started = true
      if (!this.pluginOwnership.isServerAvailable(client.serverName)) {
        throw new Error(`Plugin runtime server "${client.serverName}" is no longer available`)
      }
      await this.verifyCatalogTool(
        client,
        this.getCatalogTool(client.serverName, 'get_window_state'),
        signal
      )
      const result = signal
        ? await client.callTool('get_window_state', call.args, { signal })
        : await client.callTool('get_window_state', call.args)
      signal?.throwIfAborted()
      this.notifyComputerUsePreview(
        'completed',
        call,
        this.formatToolResponse(call.toolCallId, result)
      )
    } catch (error) {
      if (started) {
        this.notifyComputerUsePreview('failed', call, error)
      }
    }
  }

  /**
   * 把 client 返回的原始结果整理为 MCPToolResponse：字符串原样、数组逐项
   * 归一为内容项（未知对象 JSON 化为文本），并透传 _meta 与 structuredContent。
   */
  private formatToolResponse(toolCallId: string, result: ToolCallResult): MCPToolResponse {
    let formattedContent: string | MCPContentItem[] = ''
    if (typeof result.content === 'string') {
      formattedContent = result.content
    } else if (Array.isArray(result.content)) {
      formattedContent = result.content.map((item): MCPContentItem => {
        if (typeof item === 'string') {
          return { type: 'text', text: item } as MCPTextContent
        }
        if (item && typeof item === 'object' && ('type' in item || 'text' in item)) {
          const contentItem = item as { type?: unknown; text?: unknown }
          if (
            contentItem.type === 'text' ||
            contentItem.type === 'image' ||
            contentItem.type === 'resource' ||
            contentItem.type === 'resource_link' ||
            contentItem.type === 'audio'
          ) {
            return item as MCPContentItem
          }
          if (contentItem.type && contentItem.text) {
            return { type: 'text', text: String(contentItem.text) } as MCPTextContent
          }
        }
        return { type: 'text', text: JSON.stringify(item) } as MCPTextContent
      })
    } else if (result.content) {
      formattedContent = JSON.stringify(result.content)
    }

    return {
      toolCallId,
      content: formattedContent,
      isError: result.isError,
      ...(result._meta ? { _meta: result._meta } : {}),
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {})
    }
  }

  private readPositiveIntegerArg(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
  }

  private notifyComputerUsePreview(
    phase: 'started' | 'completed' | 'failed',
    call: ComputerUsePreviewCall,
    value?: MCPToolResponse | unknown
  ): void {
    const observer = this.computerUsePreviewObserver
    if (!observer) {
      return
    }
    try {
      if (phase === 'started') {
        observer.started(call)
      } else if (phase === 'completed') {
        observer.completed(call, value as MCPToolResponse)
      } else {
        observer.failed(call, value)
      }
    } catch (error) {
      logger.warn('[ToolManager] Computer Use preview observer failed', {
        phase,
        toolCallId: call.toolCallId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * 派发前的参数准备：先把参数里的 imgcache:// 引用解析为实际 dataUrl
   * （引用数与展开体积受限），再对 CUA（computer-use）工具做平台化
   * 规范化与快照目标校验。失败返回 ok:false 而非抛错，由调用方转成
   * invalid_request 响应。
   */
  private async prepareToolArguments(
    client: McpClient,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ ok: true; args: Record<string, unknown> } | { ok: false; error: string }> {
    let resolvedArgs: Record<string, unknown>
    try {
      const context: CachedImageResolutionContext = {
        dataUrls: new Map(),
        referenceCount: 0,
        expandedBytes: 0
      }
      resolvedArgs = (await this.resolveCachedImageArguments(args, signal, context)) as Record<
        string,
        unknown
      >
      if (Buffer.byteLength(JSON.stringify(resolvedArgs)) > MAX_MCP_EXECUTION_ARGUMENT_BYTES) {
        throw new Error('Expanded MCP tool arguments exceed the 32 MiB limit')
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error
      return {
        ok: false,
        error: `Unable to resolve cached image reference: ${error instanceof Error ? error.message : String(error)}`
      }
    }

    if (!this.isCuaComputerUseServer(client)) {
      return { ok: true, args: resolvedArgs }
    }

    const normalizedArgs = normalizeCuaToolArguments(toolName, resolvedArgs)
    const validationError = validateCuaSnapshotTargetArguments(toolName, normalizedArgs)
    if (validationError) {
      return { ok: false, error: validationError }
    }
    if (toolName !== 'launch_app' || process.platform !== 'win32') {
      return { ok: true, args: normalizedArgs }
    }

    return await this.prepareCuaWindowsLaunchArgs(client, normalizedArgs, signal)
  }

  /**
   * 递归解析参数中的 imgcache:// 引用为缓存 dataUrl。同一引用只解析一次
   * （context.dataUrls 去重），引用数量与总体积超限即抛错。
   */
  private async resolveCachedImageArguments(
    value: unknown,
    signal: AbortSignal | undefined,
    context: CachedImageResolutionContext
  ): Promise<unknown> {
    signal?.throwIfAborted()
    if (typeof value === 'string') {
      const reference = value.trim()
      if (!CACHED_IMAGE_REFERENCE_PATTERN.test(reference)) {
        return value
      }
      context.referenceCount += 1
      if (context.referenceCount > MAX_CACHED_IMAGE_ARGUMENT_REFERENCES) {
        throw new Error('MCP tool arguments contain more than 8 cached image references')
      }
      const normalizedReference =
        reference.slice(0, CACHED_IMAGE_PREFIX_LENGTH).toLowerCase() +
        reference.slice(CACHED_IMAGE_PREFIX_LENGTH)
      let dataUrl = context.dataUrls.get(normalizedReference)
      if (!dataUrl) {
        dataUrl = this.resolveCachedImageDataUrl(reference, signal)
        context.dataUrls.set(normalizedReference, dataUrl)
      }
      const resolved = await dataUrl
      context.expandedBytes += Buffer.byteLength(resolved)
      if (context.expandedBytes > MAX_MCP_EXECUTION_ARGUMENT_BYTES) {
        throw new Error('Expanded cached images exceed the 32 MiB limit')
      }
      return resolved
    }
    if (Array.isArray(value)) {
      const resolved: unknown[] = []
      for (const item of value) {
        resolved.push(await this.resolveCachedImageArguments(item, signal, context))
      }
      return resolved
    }
    if (isRecord(value)) {
      const resolved: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        resolved[key] = await this.resolveCachedImageArguments(item, signal, context)
      }
      return resolved
    }
    return value
  }

  /**
   * Windows 上 launch_app 目标的兼容处理：macOS 风格的 bundle_id 若形如
   * 路径则改写为 path 参数；既非路径也无其他可启动目标时，先调 list_apps
   * 预检目标是否存在于 Windows 应用列表，防止把 bundle id 直接交给
   * Windows 侧导致启动失败。
   */
  private async prepareCuaWindowsLaunchArgs(
    client: McpClient,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ ok: true; args: Record<string, unknown> } | { ok: false; error: string }> {
    const normalizedArgs = { ...args }
    const bundleId = this.readStringArg(normalizedArgs.bundle_id)
    const name = this.readStringArg(normalizedArgs.name)

    if (bundleId && !bundleId.includes('!') && this.isWindowsPathLike(bundleId)) {
      delete normalizedArgs.bundle_id
      if (
        !this.readStringArg(normalizedArgs.path) &&
        !this.readStringArg(normalizedArgs.launch_path)
      ) {
        normalizedArgs.path = bundleId
      }
      return { ok: true, args: normalizedArgs }
    }

    if (
      this.readStringArg(normalizedArgs.path) ||
      this.readStringArg(normalizedArgs.launch_path) ||
      this.readStringArg(normalizedArgs.aumid) ||
      (bundleId && bundleId.includes('!')) ||
      this.hasUrlLaunchTargets(normalizedArgs)
    ) {
      return { ok: true, args: normalizedArgs }
    }

    const target = bundleId || name
    if (!target) {
      return { ok: true, args: normalizedArgs }
    }

    const apps = await this.listCuaWindowsApps(client, signal)
    if (!apps) {
      return {
        ok: false,
        error:
          'Unable to validate the Windows app target before launching. Call list_apps first, then retry with a Windows name, path, launch_path, or aumid.'
      }
    }

    if (!this.matchesCuaWindowsApp(apps, target)) {
      return {
        ok: false,
        error: `Windows app target '${target}' was not found. Call list_apps first and use a Windows app name, path, launch_path, or aumid. Do not use macOS bundle ids on Windows.`
      }
    }

    return { ok: true, args: normalizedArgs }
  }

  private readStringArg(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }

  private isWindowsPathLike(value: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || /[\\/]/.test(value)
  }

  private hasUrlLaunchTargets(args: Record<string, unknown>): boolean {
    return Array.isArray(args.urls) && args.urls.some((item) => this.readStringArg(item))
  }

  private async listCuaWindowsApps(
    client: McpClient,
    signal?: AbortSignal
  ): Promise<Array<Record<string, unknown>> | null> {
    try {
      const result = (
        signal
          ? await client.callTool('list_apps', {}, { signal })
          : await client.callTool('list_apps', {})
      ) as {
        structuredContent?: unknown
        content?: unknown
      }
      signal?.throwIfAborted()
      const structured = result.structuredContent
      if (
        structured &&
        typeof structured === 'object' &&
        Array.isArray((structured as { apps?: unknown }).apps)
      ) {
        return (structured as { apps: Array<Record<string, unknown>> }).apps
      }

      const parsed = this.parseToolResultJsonObject(result.content)
      if (parsed && Array.isArray(parsed.apps)) {
        return parsed.apps as Array<Record<string, unknown>>
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error
      console.warn('[MCP] Failed to preflight CUA Windows launch target:', error)
    }
    return null
  }

  private parseToolResultJsonObject(content: unknown): Record<string, unknown> | null {
    const text = Array.isArray(content)
      ? content
          .map((item) =>
            item && typeof item === 'object' && 'text' in item
              ? String((item as { text?: unknown }).text ?? '')
              : ''
          )
          .join('\n')
      : typeof content === 'string'
        ? content
        : ''
    if (!text.trim()) {
      return null
    }
    try {
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  private matchesCuaWindowsApp(apps: Array<Record<string, unknown>>, target: string): boolean {
    const normalizedTarget = this.normalizeWindowsAppIdentifier(target)
    return apps.some((app) => {
      const candidates = [app.name, app.bundle_id, app.launch_path, app.path, app.aumid].flatMap(
        (value) => this.windowsAppIdentifierCandidates(value)
      )
      return candidates.some(
        (candidate) =>
          candidate === normalizedTarget ||
          candidate.includes(normalizedTarget) ||
          normalizedTarget.includes(candidate)
      )
    })
  }

  private windowsAppIdentifierCandidates(value: unknown): string[] {
    const raw = this.readStringArg(value)
    if (!raw) {
      return []
    }
    const normalized = this.normalizeWindowsAppIdentifier(raw)
    const basename = raw.split(/[\\/]/).pop()
    return basename && basename !== raw
      ? [normalized, this.normalizeWindowsAppIdentifier(basename)]
      : [normalized]
  }

  private normalizeWindowsAppIdentifier(value: string): string {
    return value.trim().replace(/^"|"$/g, '').toLowerCase()
  }

  // 根据客户端名称获取提示模板内容
  async getPromptByClient(
    clientName: string,
    promptName: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    try {
      const clients = await this.getRunningClients()

      // 查找指定的客户端
      const client = clients.find((c) => c.serverName === clientName)
      if (!client) {
        throw new Error(`MCP client not found: ${clientName}`)
      }

      if (typeof client.getPrompt !== 'function') {
        throw new Error(`MCP client ${clientName} does not support getting prompt templates`)
      }

      return await client.getPrompt(promptName, params)
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('Failed to get prompt template:', errorMessage)
      throw new Error(`Failed to get prompt template: ${errorMessage}`)
    }
  }

  // 根据客户端名称读取资源内容
  async readResourceByClient(clientName: string, resourceUri: string): Promise<Resource> {
    try {
      const clients = await this.getRunningClients()

      // 查找指定的客户端
      const client = clients.find((c) => c.serverName === clientName)
      if (!client) {
        throw new Error(`MCP client not found: ${clientName}`)
      }

      if (typeof client.readResource !== 'function') {
        throw new Error(`MCP client ${clientName} does not support reading resources`)
      }

      return await client.readResource(resourceUri)
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('Failed to read resource:', errorMessage)
      throw new Error(`Failed to read resource: ${errorMessage}`)
    }
  }
}
