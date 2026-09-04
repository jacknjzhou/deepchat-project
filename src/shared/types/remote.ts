export type RemoteChannelId = 'feishu' | 'qqbot' | 'weixin-ilink'
export type RemoteChannel = RemoteChannelId
export type PairableRemoteChannel = Extract<RemoteChannelId, 'feishu' | 'qqbot'>
export type RemoteBindingKind = 'dm' | 'group' | 'topic'
export type FeishuBrand = 'feishu' | 'lark'
export type RemoteRuntimeState =
  | 'disabled'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'backoff'
  | 'error'

export interface RemoteChannelDescriptor {
  id: RemoteChannelId
  titleKey: string
  descriptionKey: string
  supportsCronDelivery: boolean
}

export interface RemoteBindingSummary {
  channel: RemoteChannel
  endpointKey: string
  sessionId: string
  chatId: string
  threadId: string | null
  kind: RemoteBindingKind
  updatedAt: number
}

export interface FeishuRemoteBindingSummary extends RemoteBindingSummary {
  channel: 'feishu'
}

export interface QQBotRemoteBindingSummary extends RemoteBindingSummary {
  channel: 'qqbot'
}

export interface FeishuPairingSnapshot {
  pairCode: string | null
  pairCodeExpiresAt: number | null
  pairedUserOpenIds: string[]
}

export interface FeishuAuthSession {
  sessionKey: string
  authUrl: string | null
  redirectUri: string
  expiresAt: number
  message?: string
  messageKey?: string
}

export interface FeishuAuthResult {
  authorized: boolean
  openId: string | null
  unionId?: string
  name?: string
  message?: string
  messageKey?: string
}

export interface FeishuAuthStartInput {
  brand?: FeishuBrand
  appId?: string
  appSecret?: string
  redirectUri?: string
}

export interface FeishuAuthWaitInput {
  sessionKey: string
  timeoutMs?: number
}

export interface FeishuInstallSession {
  sessionKey: string
  installUrl: string
  userCode: string
  expiresAt: number
  intervalMs: number
  message?: string
  messageKey?: string
}

export interface FeishuInstallResult {
  installed: boolean
  brand: FeishuBrand | null
  appId: string | null
  openId?: string
  message?: string
  messageKey?: string
}

export interface FeishuInstallStartInput {
  brand?: FeishuBrand
}

export interface FeishuInstallWaitInput {
  sessionKey: string
  timeoutMs?: number
}

export interface QQBotPairingSnapshot {
  pairCode: string | null
  pairCodeExpiresAt: number | null
  pairedUserIds: string[]
  pairedGroupIds: string[]
}

export type RemotePairingSnapshot =
  | FeishuPairingSnapshot
  | QQBotPairingSnapshot

export interface WeixinIlinkAccountSummary {
  accountId: string
  ownerUserId: string
  baseUrl: string
  enabled: boolean
}

export interface FeishuRemoteSettings {
  brand: FeishuBrand
  appId: string
  appSecret: string
  verificationToken: string
  encryptKey: string
  remoteEnabled: boolean
  enableStreamingCards: boolean
  defaultAgentId: string
  defaultWorkdir: string
  pairedUserOpenIds: string[]
}

export interface QQBotRemoteSettings {
  appId: string
  clientSecret: string
  remoteEnabled: boolean
  defaultAgentId: string
  defaultWorkdir: string
  pairedUserIds: string[]
}

export interface WeixinIlinkRemoteSettings {
  remoteEnabled: boolean
  defaultAgentId: string
  defaultWorkdir: string
  accounts: WeixinIlinkAccountSummary[]
}

export type RemoteChannelSettings =
  | FeishuRemoteSettings
  | QQBotRemoteSettings
  | WeixinIlinkRemoteSettings

export type ChannelSettingsMap = {
  feishu: FeishuRemoteSettings
  qqbot: QQBotRemoteSettings
  'weixin-ilink': WeixinIlinkRemoteSettings
}

export interface FeishuRemoteStatus {
  channel: 'feishu'
  enabled: boolean
  state: RemoteRuntimeState
  bindingCount: number
  pairedUserCount: number
  lastError: string | null
  botUser: {
    openId: string
    name?: string
  } | null
}

export interface QQBotRemoteStatus {
  channel: 'qqbot'
  enabled: boolean
  state: RemoteRuntimeState
  bindingCount: number
  pairedUserCount: number
  lastError: string | null
  botUser: {
    id: string
    username?: string
  } | null
}

export interface WeixinIlinkAccountStatus extends WeixinIlinkAccountSummary {
  state: RemoteRuntimeState
  connected: boolean
  bindingCount: number
  lastError: string | null
}

export interface WeixinIlinkRemoteStatus {
  channel: 'weixin-ilink'
  enabled: boolean
  state: RemoteRuntimeState
  bindingCount: number
  accountCount: number
  connectedAccountCount: number
  lastError: string | null
  accounts: WeixinIlinkAccountStatus[]
}

export type RemoteChannelStatus =
  | FeishuRemoteStatus
  | QQBotRemoteStatus
  | WeixinIlinkRemoteStatus

export interface WeixinIlinkLoginSession {
  sessionKey: string
  loginUrl: string | null
  message?: string
  messageKey?: string
}

export interface WeixinIlinkLoginResult {
  connected: boolean
  account: WeixinIlinkAccountSummary | null
  message?: string
  messageKey?: string
}

export interface RemoteServicePort {
  listRemoteChannels(): Promise<RemoteChannelDescriptor[]>

  getChannelSettings<T extends RemoteChannel>(channel: T): Promise<ChannelSettingsMap[T]>

  saveChannelSettings<T extends RemoteChannel>(
    channel: T,
    input: ChannelSettingsMap[T]
  ): Promise<ChannelSettingsMap[T]>

  getChannelStatus(channel: 'feishu'): Promise<FeishuRemoteStatus>
  getChannelStatus(channel: 'qqbot'): Promise<QQBotRemoteStatus>
  getChannelStatus(channel: 'weixin-ilink'): Promise<WeixinIlinkRemoteStatus>
  getChannelStatus(channel: RemoteChannel): Promise<RemoteChannelStatus>

  getChannelBindings(channel: RemoteChannel): Promise<RemoteBindingSummary[]>
  removeChannelBinding(channel: RemoteChannel, endpointKey: string): Promise<void>
  removeChannelPrincipal(channel: PairableRemoteChannel, principalId: string): Promise<void>

  getChannelPairingSnapshot(channel: 'feishu'): Promise<FeishuPairingSnapshot>
  getChannelPairingSnapshot(channel: 'qqbot'): Promise<QQBotPairingSnapshot>
  getChannelPairingSnapshot(channel: PairableRemoteChannel): Promise<RemotePairingSnapshot>

  createChannelPairCode(
    channel: PairableRemoteChannel
  ): Promise<{ code: string; expiresAt: number }>
  clearChannelPairCode(channel: PairableRemoteChannel): Promise<void>
  clearChannelBindings(channel: RemoteChannel): Promise<number>

  startFeishuAuth(input?: FeishuAuthStartInput): Promise<FeishuAuthSession>
  waitForFeishuAuth(input: FeishuAuthWaitInput): Promise<FeishuAuthResult>
  cancelFeishuAuth(sessionKey: string): Promise<void>
  startFeishuInstall(input?: FeishuInstallStartInput): Promise<FeishuInstallSession>
  waitForFeishuInstall(input: FeishuInstallWaitInput): Promise<FeishuInstallResult>
  cancelFeishuInstall(sessionKey: string): Promise<void>

  getWeixinIlinkSettings(): Promise<WeixinIlinkRemoteSettings>
  saveWeixinIlinkSettings(input: WeixinIlinkRemoteSettings): Promise<WeixinIlinkRemoteSettings>
  getWeixinIlinkStatus(): Promise<WeixinIlinkRemoteStatus>
  startWeixinIlinkLogin(input?: { force?: boolean }): Promise<WeixinIlinkLoginSession>
  waitForWeixinIlinkLogin(input: {
    sessionKey: string
    timeoutMs?: number
  }): Promise<WeixinIlinkLoginResult>
  removeWeixinIlinkAccount(accountId: string): Promise<void>
  restartWeixinIlinkAccount(accountId: string): Promise<void>
}
