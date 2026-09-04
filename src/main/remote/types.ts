import { z } from 'zod'
import type { QuestionOption } from '@shared/types/agent-interface'
import type {
  FeishuBrand,
  FeishuPairingSnapshot,
  FeishuRemoteSettings,
  FeishuRemoteStatus,
  QQBotPairingSnapshot,
  QQBotRemoteBindingSummary,
  QQBotRemoteSettings,
  QQBotRemoteStatus,
  RemoteBindingKind,
  RemoteBindingSummary,
  RemoteChannel,
  RemoteRuntimeState,
  WeixinIlinkAccountSummary,
  WeixinIlinkRemoteSettings
} from '@shared/types/remote'

export const REMOTE_CONTROL_SETTING_KEY = 'remoteControl'
export const TELEGRAM_PAIR_CODE_TTL_MS = 10 * 60 * 1000
export const FEISHU_PAIR_CODE_TTL_MS = TELEGRAM_PAIR_CODE_TTL_MS
export const QQBOT_PAIR_CODE_TTL_MS = TELEGRAM_PAIR_CODE_TTL_MS
export const REMOTE_PAIR_CODE_MAX_FAILURES = 5
export const FEISHU_INBOUND_DEDUP_TTL_MS = 30 * 60 * 1000
export const FEISHU_INBOUND_DEDUP_LIMIT = 2048
export const FEISHU_CONVERSATION_POLL_TIMEOUT_MS = 5 * 60 * 1000
export const FEISHU_OUTBOUND_TEXT_LIMIT = 8_000
export const TELEGRAM_STREAM_POLL_INTERVAL_MS = 450
export const TELEGRAM_RECENT_SESSION_LIMIT = 10
export const TELEGRAM_REMOTE_DEFAULT_AGENT_ID = 'deepchat'
export const FEISHU_REMOTE_DEFAULT_AGENT_ID = TELEGRAM_REMOTE_DEFAULT_AGENT_ID
export const QQBOT_REMOTE_DEFAULT_AGENT_ID = TELEGRAM_REMOTE_DEFAULT_AGENT_ID
export const WEIXIN_ILINK_REMOTE_DEFAULT_AGENT_ID = TELEGRAM_REMOTE_DEFAULT_AGENT_ID
export const FEISHU_REMOTE_REACTION_EMOJI = 'THINKING'
export const QQBOT_GROUP_AND_C2C_INTENT = 1 << 25

export const FEISHU_REMOTE_COMMANDS = [
  {
    command: 'start',
    description: 'Show remote control status'
  },
  {
    command: 'help',
    description: 'Show available commands'
  },
  {
    command: 'pair',
    description: 'Authorize this Feishu account'
  },
  {
    command: 'new',
    description: 'Start a new session'
  },
  {
    command: 'sessions',
    description: 'List recent sessions'
  },
  {
    command: 'use',
    description: 'Bind a listed session'
  },
  {
    command: 'stop',
    description: 'Stop the active generation'
  },
  {
    command: 'open',
    description: 'Open the current session on desktop'
  },
  {
    command: 'pending',
    description: 'Show the current pending interaction'
  },
  {
    command: 'model',
    description: 'View or switch the current model'
  },
  {
    command: 'agent',
    description: 'View or switch the current agent'
  },
  {
    command: 'status',
    description: 'Show runtime and session status'
  }
] as const

export const QQBOT_REMOTE_COMMANDS = [
  {
    command: 'start',
    description: 'Show remote control status'
  },
  {
    command: 'help',
    description: 'Show available commands'
  },
  {
    command: 'pair',
    description: 'Authorize this QQ account'
  },
  {
    command: 'new',
    description: 'Start a new session'
  },
  {
    command: 'sessions',
    description: 'List recent sessions'
  },
  {
    command: 'use',
    description: 'Bind a listed session'
  },
  {
    command: 'stop',
    description: 'Stop the active generation'
  },
  {
    command: 'open',
    description: 'Open the current session on desktop'
  },
  {
    command: 'pending',
    description: 'Show the current pending interaction'
  },
  {
    command: 'model',
    description: 'View or switch the current model'
  },
  {
    command: 'agent',
    description: 'View or switch the current agent'
  },
  {
    command: 'status',
    description: 'Show runtime and session status'
  }
] as const

export interface RemoteEndpointBindingMeta {
  channel: RemoteChannel
  kind: RemoteBindingKind
  chatId: string
  threadId: string | null
}

export type RemoteEndpointBinding = {
  sessionId: string
  updatedAt: number
  meta?: RemoteEndpointBindingMeta
}

export type TelegramPairingState = {
  code: string | null
  expiresAt: number | null
  failedAttempts: number
}

export type FeishuPairingState = TelegramPairingState
export type QQBotPairingState = TelegramPairingState

export type TelegramCommandPayload = {
  name: string
  args: string
}

export interface FeishuRemoteRuntimeConfig {
  brand: FeishuBrand
  appId: string
  appSecret: string
  verificationToken: string
  encryptKey: string
  enabled: boolean
  enableStreamingCards: boolean
  defaultAgentId: string
  defaultWorkdir: string
  pairedUserOpenIds: string[]
  lastFatalError: string | null
  pairing: FeishuPairingState
  bindings: Record<string, RemoteEndpointBinding>
}

export interface QQBotRemoteRuntimeConfig {
  appId: string
  clientSecret: string
  enabled: boolean
  defaultAgentId: string
  defaultWorkdir: string
  pairedUserIds: string[]
  pairedGroupIds: string[]
  lastFatalError: string | null
  pairing: QQBotPairingState
  bindings: Record<string, RemoteEndpointBinding>
}

export interface WeixinIlinkAccountRuntimeConfig {
  accountId: string
  ownerUserId: string
  baseUrl: string
  botToken: string
  enabled: boolean
  syncCursor: string
  lastFatalError: string | null
  bindings: Record<string, RemoteEndpointBinding>
}

export interface WeixinIlinkRemoteRuntimeConfig {
  enabled: boolean
  defaultAgentId: string
  defaultWorkdir: string
  accounts: WeixinIlinkAccountRuntimeConfig[]
}

export interface RemoteControlConfig {
  feishu: FeishuRemoteRuntimeConfig
  qqbot: QQBotRemoteRuntimeConfig
  weixinIlink: WeixinIlinkRemoteRuntimeConfig
}

export interface FeishuRawMention {
  key: string
  id?: {
    open_id?: string
  }
  name?: string
}

export interface FeishuInboundMessage {
  kind: 'message'
  eventId: string
  chatId: string
  threadId: string | null
  messageId: string
  chatType: 'p2p' | 'group'
  senderOpenId: string | null
  text: string
  command: TelegramCommandPayload | null
  mentionedBot: boolean
  mentions: FeishuRawMention[]
  attachments: RemoteInputAttachment[]
  allAttachmentsFailed?: boolean
}

export interface QQBotInboundMessage {
  kind: 'message'
  eventId: string
  chatId: string
  chatType: 'c2c' | 'group'
  messageId: string
  messageSeq: number
  senderUserId: string | null
  senderUserName: string
  text: string
  command: TelegramCommandPayload | null
  mentionedBot: boolean
  attachments: RemoteInputAttachment[]
}

export interface RemoteInputAttachment {
  id?: string
  filename: string
  mediaType?: string
  size?: number | null
  url?: string
  data?: string
  fileId?: string
  resourceKey?: string
  resourceType?: 'image' | 'file'
  encryptedMedia?: RemoteInputEncryptedMedia
  failedDownload?: boolean
  errorMessage?: string
}

export interface RemoteInputEncryptedMedia {
  encryptedQueryParam?: string
  aesKey?: string
  aesKeyEncoding?: 'auto' | 'hex'
  fullUrl?: string
  cdnBaseUrl?: string
}

export interface WeixinIlinkInboundMessage {
  kind: 'message'
  accountId: string
  userId: string
  text: string
  messageId: string
  contextToken: string | null
  command: TelegramCommandPayload | null
  createdAt: number | null
  attachments: RemoteInputAttachment[]
}

export interface RemotePermissionCommandInfo {
  command: string
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  suggestion: string
  signature?: string
  baseCommand?: string
}

export interface RemotePendingInteractionPermission {
  permissionType: 'read' | 'write' | 'all' | 'command'
  description: string
  toolName?: string
  serverName?: string
  providerId?: string
  requestId?: string
  rememberable?: boolean
  command?: string
  commandSignature?: string
  shellProfile?: import('@shared/commandShell').CommandShellProfile
  paths?: string[]
  commandInfo?: RemotePermissionCommandInfo
}

export interface RemotePendingInteractionQuestion {
  header?: string
  question: string
  options: QuestionOption[]
  custom: boolean
  multiple: boolean
}

export interface RemotePendingInteraction {
  type: 'permission' | 'question'
  messageId: string
  toolCallId: string
  toolName: string
  toolArgs: string
  serverName?: string
  serverIcons?: string
  serverDescription?: string
  permission?: RemotePendingInteractionPermission
  question?: RemotePendingInteractionQuestion
}

export interface RemoteRenderableBlock {
  key: string
  kind: 'reasoning' | 'toolCall' | 'toolResult' | 'search' | 'imageNotice' | 'answer' | 'error'
  text: string
  truncated: boolean
  sourceMessageId: string
  asset?: RemoteGeneratedImageAsset
}

export interface RemoteDeliverySegment {
  key: string
  kind: 'process' | 'answer' | 'terminal'
  text: string
  sourceMessageId: string
}

export interface RemoteGeneratedImageAsset {
  key: string
  path: string
  mimeType: string
  filename: string
  sourceMessageId: string
}

export interface TelegramModelOption {
  modelId: string
  modelName: string
}

export interface TelegramModelProviderOption {
  providerId: string
  providerName: string
  models: TelegramModelOption[]
}

export interface TelegramAgentOption {
  agentId: string
  agentName: string
  agentType: 'deepchat' | 'acp'
  source?: 'builtin' | 'manual' | 'registry'
}

export interface FeishuCardConfig {
  enable_forward?: boolean
  update_multi?: boolean
  wide_screen_mode?: boolean
}

export interface FeishuInteractiveCardPayload {
  config?: FeishuCardConfig
  header?: Record<string, unknown>
  elements?: Array<Record<string, unknown>>
  i18n_elements?: Record<string, Array<Record<string, unknown>>>
  card_link?: Record<string, unknown>
}

export type FeishuOutboundAction =
  | {
      type: 'sendText'
      text: string
    }
  | {
      type: 'sendCard'
      card: FeishuInteractiveCardPayload
      fallbackText: string
    }

const FEISHU_ENDPOINT_KEY_REGEX = /^feishu:([^:]+):([^:]+)$/
const QQBOT_ENDPOINT_KEY_REGEX = /^qqbot:(c2c|group):([^:]+)$/
const WEIXIN_ILINK_ENDPOINT_KEY_REGEX = /^weixin-ilink:([^:]+):([^:]+)$/

export interface FeishuRuntimeStatusSnapshot {
  state: RemoteRuntimeState
  lastError: string | null
  botUser: FeishuRemoteStatus['botUser']
}

export interface QQBotRuntimeStatusSnapshot {
  state: RemoteRuntimeState
  lastError: string | null
  botUser: QQBotRemoteStatus['botUser']
}

export interface WeixinIlinkRuntimeStatusSnapshot {
  state: RemoteRuntimeState
  lastError: string | null
  botUser: {
    accountId: string
    ownerUserId: string
    baseUrl: string
  } | null
}

export interface FeishuTransportTarget {
  chatId: string
  threadId: string | null
  replyToMessageId?: string | null
}

export interface QQBotTransportTarget {
  chatType: 'c2c' | 'group'
  openId: string
  msgId: string
}

export interface WeixinIlinkTransportTarget {
  userId: string
  contextToken?: string
}

export const createDefaultRemoteControlConfig = (): RemoteControlConfig => ({
  feishu: {
    brand: 'feishu',
    appId: '',
    appSecret: '',
    verificationToken: '',
    encryptKey: '',
    enabled: false,
    enableStreamingCards: false,
    defaultAgentId: FEISHU_REMOTE_DEFAULT_AGENT_ID,
    defaultWorkdir: '',
    pairedUserOpenIds: [],
    lastFatalError: null,
    pairing: {
      code: null,
      expiresAt: null,
      failedAttempts: 0
    },
    bindings: {}
  },
  qqbot: {
    appId: '',
    clientSecret: '',
    enabled: false,
    defaultAgentId: QQBOT_REMOTE_DEFAULT_AGENT_ID,
    defaultWorkdir: '',
    pairedUserIds: [],
    pairedGroupIds: [],
    lastFatalError: null,
    pairing: {
      code: null,
      expiresAt: null,
      failedAttempts: 0
    },
    bindings: {}
  },
  weixinIlink: {
    enabled: false,
    defaultAgentId: WEIXIN_ILINK_REMOTE_DEFAULT_AGENT_ID,
    defaultWorkdir: '',
    accounts: []
  }
})

const RemoteEndpointBindingMetaSchema = z.object({
  channel: z.enum(['feishu', 'qqbot', 'weixin-ilink']).optional(),
  kind: z.enum(['dm', 'group', 'topic']).optional(),
  chatId: z.string().optional(),
  threadId: z.string().nullable().optional()
})

const RemoteEndpointBindingSchema = z.object({
  sessionId: z.string().min(1),
  updatedAt: z.number().int().nonnegative().optional(),
  meta: RemoteEndpointBindingMetaSchema.optional()
})

const PairingStateSchema = z.object({
  code: z.string().nullable().optional(),
  expiresAt: z.number().int().nonnegative().nullable().optional(),
  failedAttempts: z.number().int().nonnegative().optional()
})

const FeishuRemoteRuntimeConfigSchema = z.object({
  brand: z.enum(['feishu', 'lark']).optional(),
  appId: z.string().optional(),
  appSecret: z.string().optional(),
  verificationToken: z.string().optional(),
  encryptKey: z.string().optional(),
  enabled: z.boolean().optional(),
  enableStreamingCards: z.boolean().optional(),
  defaultAgentId: z.string().optional(),
  defaultWorkdir: z.string().optional(),
  pairedUserOpenIds: z.array(z.string()).optional(),
  lastFatalError: z.string().nullable().optional(),
  pairing: PairingStateSchema.optional(),
  bindings: z.record(z.string(), z.unknown()).optional()
})

const QQBotRemoteRuntimeConfigSchema = z.object({
  appId: z.string().optional(),
  clientSecret: z.string().optional(),
  enabled: z.boolean().optional(),
  defaultAgentId: z.string().optional(),
  defaultWorkdir: z.string().optional(),
  pairedUserIds: z.array(z.union([z.string(), z.number()])).optional(),
  pairedGroupIds: z.array(z.union([z.string(), z.number()])).optional(),
  lastFatalError: z.string().nullable().optional(),
  pairing: PairingStateSchema.optional(),
  bindings: z.record(z.string(), z.unknown()).optional()
})

const WeixinIlinkAccountRuntimeConfigSchema = z.object({
  accountId: z.string().optional(),
  ownerUserId: z.string().optional(),
  baseUrl: z.string().optional(),
  botToken: z.string().optional(),
  enabled: z.boolean().optional(),
  syncCursor: z.string().optional(),
  lastFatalError: z.string().nullable().optional(),
  bindings: z.record(z.string(), z.unknown()).optional()
})

const WeixinIlinkRemoteRuntimeConfigSchema = z.object({
  enabled: z.boolean().optional(),
  defaultAgentId: z.string().optional(),
  defaultWorkdir: z.string().optional(),
  accounts: z.array(WeixinIlinkAccountRuntimeConfigSchema).optional()
})

const RemoteControlConfigSchema = z.object({
  feishu: FeishuRemoteRuntimeConfigSchema.optional(),
  qqbot: QQBotRemoteRuntimeConfigSchema.optional(),
  weixinIlink: WeixinIlinkRemoteRuntimeConfigSchema.optional()
})

type LegacyFeishuRemoteConfig = z.infer<typeof FeishuRemoteRuntimeConfigSchema>
type LegacyQQBotRemoteConfig = z.infer<typeof QQBotRemoteRuntimeConfigSchema>
type LegacyWeixinIlinkRemoteConfig = z.infer<typeof WeixinIlinkRemoteRuntimeConfigSchema>

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const hasAnyOwn = (value: Record<string, unknown>, keys: string[]): boolean =>
  keys.some((key) => hasOwn(value, key))

const hasBindingPrefix = (value: Record<string, unknown>, prefix: string): boolean => {
  const bindings = value.bindings
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
    return false
  }

  return Object.keys(bindings as Record<string, unknown>).some((key) => key.startsWith(prefix))
}

const extractLegacyFeishuConfig = (input: unknown): LegacyFeishuRemoteConfig | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null
  }

  const record = input as Record<string, unknown>
  if (
    !hasAnyOwn(record, [
      'appId',
      'appSecret',
      'verificationToken',
      'encryptKey',
      'enableStreamingCards',
      'pairedUserOpenIds',
      'lastFatalError'
    ]) &&
    !hasBindingPrefix(record, 'feishu:')
  ) {
    return null
  }

  const parsed = FeishuRemoteRuntimeConfigSchema.safeParse(record)
  return parsed.success ? parsed.data : null
}

const extractLegacyQQBotConfig = (input: unknown): LegacyQQBotRemoteConfig | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null
  }

  const record = input as Record<string, unknown>
  if (
    !hasAnyOwn(record, ['appId', 'clientSecret', 'pairedUserIds', 'lastFatalError']) &&
    !hasBindingPrefix(record, 'qqbot:')
  ) {
    return null
  }

  const parsed = QQBotRemoteRuntimeConfigSchema.safeParse(record)
  return parsed.success ? parsed.data : null
}

const extractLegacyWeixinIlinkConfig = (input: unknown): LegacyWeixinIlinkRemoteConfig | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null
  }

  const record = input as Record<string, unknown>
  if (
    !hasAnyOwn(record, ['accounts', 'defaultAgentId', 'defaultWorkdir', 'enabled']) &&
    !hasBindingPrefix(record, 'weixin-ilink:')
  ) {
    return null
  }

  const parsed = WeixinIlinkRemoteRuntimeConfigSchema.safeParse(record)
  return parsed.success ? parsed.data : null
}

const normalizeStringList = (input: Array<string | number> | undefined): string[] =>
  Array.from(
    new Set((input ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))
  ).sort((left, right) => left.localeCompare(right))

export const normalizeFeishuOpenIds = (input: Array<string | number> | undefined): string[] =>
  normalizeStringList(input)

export const normalizeQQBotUserIds = (input: Array<string | number> | undefined): string[] =>
  normalizeStringList(input)

export const normalizeQQBotGroupIds = (input: Array<string | number> | undefined): string[] =>
  normalizeStringList(input)

export const normalizeWeixinIlinkAccounts = (
  input: Array<Partial<WeixinIlinkAccountSummary>> | undefined
): WeixinIlinkAccountSummary[] => {
  const accounts = new Map<string, WeixinIlinkAccountSummary>()
  for (const entry of input ?? []) {
    const accountId = String(entry.accountId ?? '').trim()
    const ownerUserId = String(entry.ownerUserId ?? '').trim()
    const baseUrl = String(entry.baseUrl ?? '').trim() || 'https://ilinkai.weixin.qq.com'
    if (!accountId || !ownerUserId) {
      continue
    }

    accounts.set(accountId, {
      accountId,
      ownerUserId,
      baseUrl,
      enabled: entry.enabled !== false
    })
  }

  return [...accounts.values()].sort((left, right) => left.accountId.localeCompare(right.accountId))
}

type LooseWeixinIlinkRuntimeAccountInput = {
  accountId?: unknown
  ownerUserId?: unknown
  baseUrl?: unknown
  botToken?: unknown
  enabled?: boolean
  syncCursor?: unknown
  lastFatalError?: unknown
  bindings?: Record<string, unknown>
}

const normalizeWeixinIlinkRuntimeAccounts = (
  input: LooseWeixinIlinkRuntimeAccountInput[] | undefined
): WeixinIlinkAccountRuntimeConfig[] => {
  const accounts = new Map<string, WeixinIlinkAccountRuntimeConfig>()
  for (const entry of input ?? []) {
    const accountId = String(entry.accountId ?? '').trim()
    const ownerUserId = String(entry.ownerUserId ?? '').trim()
    if (!accountId || !ownerUserId) {
      continue
    }

    accounts.set(accountId, {
      accountId,
      ownerUserId,
      baseUrl: String(entry.baseUrl ?? '').trim() || 'https://ilinkai.weixin.qq.com',
      botToken: String(entry.botToken ?? '').trim(),
      enabled: entry.enabled !== false,
      syncCursor: String(entry.syncCursor ?? '').trim(),
      lastFatalError:
        entry.lastFatalError === null || entry.lastFatalError === undefined
          ? null
          : String(entry.lastFatalError).trim() || null,
      bindings: normalizeBindings(entry.bindings, 'weixin-ilink')
    })
  }

  return [...accounts.values()].sort((left, right) => left.accountId.localeCompare(right.accountId))
}

const normalizeBindingMeta = (
  endpointKey: string,
  meta: unknown,
  fallbackChannel: RemoteChannel
): RemoteEndpointBindingMeta | undefined => {
  const parsed = RemoteEndpointBindingMetaSchema.safeParse(meta)
  if (parsed.success && parsed.data.channel && parsed.data.kind && parsed.data.chatId) {
    return {
      channel: parsed.data.channel,
      kind: parsed.data.kind,
      chatId: parsed.data.chatId,
      threadId: parsed.data.threadId ?? null
    }
  }

  if (fallbackChannel === 'qqbot') {
    return deriveQQBotBindingMeta(endpointKey) ?? undefined
  }

  if (fallbackChannel === 'weixin-ilink') {
    return deriveWeixinIlinkBindingMeta(endpointKey) ?? undefined
  }

  return deriveFeishuBindingMeta(endpointKey) ?? undefined
}

const normalizeBindings = (
  rawBindings: Record<string, unknown> | undefined,
  channel: RemoteChannel
): Record<string, RemoteEndpointBinding> => {
  const bindings: Record<string, RemoteEndpointBinding> = {}
  for (const [endpointKey, binding] of Object.entries(rawBindings ?? {})) {
    const parsedBinding = RemoteEndpointBindingSchema.safeParse(binding)
    if (!parsedBinding.success) {
      continue
    }

    const normalizedSessionId = parsedBinding.data.sessionId.trim()
    if (!normalizedSessionId) {
      continue
    }

    bindings[endpointKey] = {
      sessionId: normalizedSessionId,
      updatedAt: parsedBinding.data.updatedAt ?? Date.now(),
      meta: normalizeBindingMeta(endpointKey, parsedBinding.data.meta, channel)
    }
  }
  return bindings
}

const resolveRemoteEnabled = (enabled: boolean | undefined, configured: boolean): boolean =>
  typeof enabled === 'boolean' ? enabled : configured

export const normalizeRemoteControlConfig = (input: unknown): RemoteControlConfig => {
  const defaults = createDefaultRemoteControlConfig()
  const parsed = RemoteControlConfigSchema.safeParse(input)
  if (!parsed.success) {
    return defaults
  }

  const feishu = parsed.data.feishu ?? extractLegacyFeishuConfig(input) ?? {}
  const qqbot = parsed.data.qqbot ?? extractLegacyQQBotConfig(input) ?? {}
  const weixinIlink = parsed.data.weixinIlink ?? extractLegacyWeixinIlinkConfig(input) ?? {}
  const weixinIlinkAccounts = normalizeWeixinIlinkRuntimeAccounts(weixinIlink.accounts)

  return {
    feishu: {
      brand: feishu.brand === 'lark' ? 'lark' : 'feishu',
      appId: feishu.appId?.trim() || '',
      appSecret: feishu.appSecret?.trim() || '',
      verificationToken: feishu.verificationToken?.trim() || '',
      encryptKey: feishu.encryptKey?.trim() || '',
      enabled: resolveRemoteEnabled(
        feishu.enabled,
        Boolean(feishu.appId?.trim() && feishu.appSecret?.trim())
      ),
      enableStreamingCards: Boolean(feishu.enableStreamingCards),
      defaultAgentId: feishu.defaultAgentId?.trim() || defaults.feishu.defaultAgentId,
      defaultWorkdir: feishu.defaultWorkdir?.trim() || '',
      pairedUserOpenIds: normalizeFeishuOpenIds(feishu.pairedUserOpenIds),
      lastFatalError: feishu.lastFatalError?.trim() || null,
      pairing: {
        code: feishu.pairing?.code?.trim() || null,
        expiresAt: typeof feishu.pairing?.expiresAt === 'number' ? feishu.pairing.expiresAt : null,
        failedAttempts:
          typeof feishu.pairing?.failedAttempts === 'number' && feishu.pairing.failedAttempts >= 0
            ? Math.trunc(feishu.pairing.failedAttempts)
            : 0
      },
      bindings: normalizeBindings(feishu.bindings, 'feishu')
    },
    qqbot: {
      appId: qqbot.appId?.trim() || '',
      clientSecret: qqbot.clientSecret?.trim() || '',
      enabled: resolveRemoteEnabled(
        qqbot.enabled,
        Boolean(qqbot.appId?.trim() && qqbot.clientSecret?.trim())
      ),
      defaultAgentId: qqbot.defaultAgentId?.trim() || defaults.qqbot.defaultAgentId,
      defaultWorkdir: qqbot.defaultWorkdir?.trim() || '',
      pairedUserIds: normalizeQQBotUserIds(qqbot.pairedUserIds),
      pairedGroupIds: normalizeQQBotGroupIds(qqbot.pairedGroupIds),
      lastFatalError: qqbot.lastFatalError?.trim() || null,
      pairing: {
        code: qqbot.pairing?.code?.trim() || null,
        expiresAt: typeof qqbot.pairing?.expiresAt === 'number' ? qqbot.pairing.expiresAt : null,
        failedAttempts:
          typeof qqbot.pairing?.failedAttempts === 'number' && qqbot.pairing.failedAttempts >= 0
            ? Math.trunc(qqbot.pairing.failedAttempts)
            : 0
      },
      bindings: normalizeBindings(qqbot.bindings, 'qqbot')
    },
    weixinIlink: {
      enabled: resolveRemoteEnabled(weixinIlink.enabled, weixinIlinkAccounts.length > 0),
      defaultAgentId: weixinIlink.defaultAgentId?.trim() || defaults.weixinIlink.defaultAgentId,
      defaultWorkdir: weixinIlink.defaultWorkdir?.trim() || '',
      accounts: weixinIlinkAccounts
    }
  }
}

export const buildFeishuEndpointKey = (chatId: string, threadId?: string | null): string =>
  `feishu:${chatId}:${threadId?.trim() || 'root'}`

export const parseFeishuEndpointKey = (
  endpointKey: string
): Pick<RemoteBindingSummary, 'chatId' | 'threadId'> | null => {
  const match = FEISHU_ENDPOINT_KEY_REGEX.exec(endpointKey.trim())
  if (!match) {
    return null
  }

  return {
    chatId: match[1],
    threadId: match[2] === 'root' ? null : match[2]
  }
}

export const buildFeishuBindingMeta = (params: {
  chatId: string
  threadId?: string | null
  chatType: 'p2p' | 'group'
}): RemoteEndpointBindingMeta => ({
  channel: 'feishu',
  kind: params.chatType === 'p2p' ? 'dm' : params.threadId ? 'topic' : 'group',
  chatId: params.chatId.trim(),
  threadId: params.threadId?.trim() || null
})

export const deriveFeishuBindingMeta = (endpointKey: string): RemoteEndpointBindingMeta | null => {
  const endpoint = parseFeishuEndpointKey(endpointKey)
  if (!endpoint) {
    return null
  }

  return {
    channel: 'feishu',
    kind: endpoint.threadId ? 'topic' : 'group',
    chatId: endpoint.chatId,
    threadId: endpoint.threadId
  }
}

export const buildQQBotEndpointKey = (chatType: 'c2c' | 'group', chatId: string): string =>
  `qqbot:${chatType}:${chatId.trim()}`

export const parseQQBotEndpointKey = (
  endpointKey: string
): (Pick<QQBotRemoteBindingSummary, 'chatId'> & { chatType: 'c2c' | 'group' }) | null => {
  const match = QQBOT_ENDPOINT_KEY_REGEX.exec(endpointKey.trim())
  if (!match) {
    return null
  }

  return {
    chatType: match[1] === 'group' ? 'group' : 'c2c',
    chatId: match[2]
  }
}

export const buildQQBotBindingMeta = (params: {
  chatId: string
  chatType: 'c2c' | 'group'
}): RemoteEndpointBindingMeta => ({
  channel: 'qqbot',
  kind: params.chatType === 'group' ? 'group' : 'dm',
  chatId: params.chatId.trim(),
  threadId: null
})

export const deriveQQBotBindingMeta = (endpointKey: string): RemoteEndpointBindingMeta | null => {
  const endpoint = parseQQBotEndpointKey(endpointKey)
  if (!endpoint) {
    return null
  }

  return buildQQBotBindingMeta(endpoint)
}

export const buildWeixinIlinkEndpointKey = (accountId: string, userId: string): string =>
  `weixin-ilink:${accountId.trim()}:${userId.trim()}`

export const parseWeixinIlinkEndpointKey = (
  endpointKey: string
): { accountId: string; userId: string } | null => {
  const match = WEIXIN_ILINK_ENDPOINT_KEY_REGEX.exec(endpointKey.trim())
  if (!match) {
    return null
  }

  return {
    accountId: match[1],
    userId: match[2]
  }
}

export const buildWeixinIlinkBindingMeta = (params: {
  userId: string
}): RemoteEndpointBindingMeta => ({
  channel: 'weixin-ilink',
  kind: 'dm',
  chatId: params.userId.trim(),
  threadId: null
})

export const deriveWeixinIlinkBindingMeta = (
  endpointKey: string
): RemoteEndpointBindingMeta | null => {
  const endpoint = parseWeixinIlinkEndpointKey(endpointKey)
  if (!endpoint) {
    return null
  }

  return buildWeixinIlinkBindingMeta({
    userId: endpoint.userId
  })
}

export const buildBindingSummary = (
  endpointKey: string,
  binding: RemoteEndpointBinding
): RemoteBindingSummary | null => {
  const meta =
    binding.meta ??
    deriveFeishuBindingMeta(endpointKey) ??
    deriveQQBotBindingMeta(endpointKey) ??
    deriveWeixinIlinkBindingMeta(endpointKey)

  if (!meta) {
    return null
  }

  return {
    channel: meta.channel,
    endpointKey,
    sessionId: binding.sessionId,
    chatId: meta.chatId,
    threadId: meta.threadId,
    kind: meta.kind,
    updatedAt: binding.updatedAt
  }
}

export const createPairCode = (ttlMs: number = TELEGRAM_PAIR_CODE_TTL_MS): TelegramPairingState => {
  return {
    code: `${Math.floor(100000 + Math.random() * 900000)}`,
    failedAttempts: 0,
    expiresAt: Date.now() + ttlMs
  }
}

export const normalizeFeishuSettingsInput = (
  input: FeishuRemoteSettings
): FeishuRemoteSettings => ({
  brand: input.brand === 'lark' ? 'lark' : 'feishu',
  appId: input.appId?.trim() ?? '',
  appSecret: input.appSecret?.trim() ?? '',
  verificationToken: input.verificationToken?.trim() ?? '',
  encryptKey: input.encryptKey?.trim() ?? '',
  remoteEnabled: Boolean(input.remoteEnabled),
  enableStreamingCards: Boolean(input.enableStreamingCards),
  defaultAgentId: input.defaultAgentId?.trim() || FEISHU_REMOTE_DEFAULT_AGENT_ID,
  defaultWorkdir: input.defaultWorkdir?.trim() ?? '',
  pairedUserOpenIds: normalizeFeishuOpenIds(input.pairedUserOpenIds)
})

export const normalizeQQBotSettingsInput = (input: QQBotRemoteSettings): QQBotRemoteSettings => ({
  appId: input.appId?.trim() ?? '',
  clientSecret: input.clientSecret?.trim() ?? '',
  remoteEnabled: Boolean(input.remoteEnabled),
  defaultAgentId: input.defaultAgentId?.trim() || QQBOT_REMOTE_DEFAULT_AGENT_ID,
  defaultWorkdir: input.defaultWorkdir?.trim() ?? '',
  pairedUserIds: normalizeQQBotUserIds(input.pairedUserIds)
})

export const normalizeWeixinIlinkSettingsInput = (
  input: WeixinIlinkRemoteSettings
): WeixinIlinkRemoteSettings => ({
  remoteEnabled: Boolean(input.remoteEnabled),
  defaultAgentId: input.defaultAgentId?.trim() || WEIXIN_ILINK_REMOTE_DEFAULT_AGENT_ID,
  defaultWorkdir: input.defaultWorkdir?.trim() ?? '',
  accounts: normalizeWeixinIlinkAccounts(input.accounts)
})

export const buildFeishuPairingSnapshot = (
  settings: FeishuRemoteRuntimeConfig
): FeishuPairingSnapshot => ({
  pairCode: settings.pairing.code,
  pairCodeExpiresAt: settings.pairing.expiresAt,
  pairedUserOpenIds: [...settings.pairedUserOpenIds]
})

export const buildQQBotPairingSnapshot = (
  settings: QQBotRemoteRuntimeConfig
): QQBotPairingSnapshot => ({
  pairCode: settings.pairing.code,
  pairCodeExpiresAt: settings.pairing.expiresAt,
  pairedUserIds: [...settings.pairedUserIds],
  pairedGroupIds: [...settings.pairedGroupIds]
})
