export type ManagedEndpointSource = 'env' | 'builtin' | 'none'

export interface ManagedEndpointInfo {
  endpoint: string
  source: ManagedEndpointSource
}

/**
 * 解析托管配置端点：运行时环境变量优先，其次构建期注入的默认值（MAIN_VITE_*）。
 * 空串 / 纯空格视为未设置；返回值已 trim。
 */
export function resolveManagedEndpointInfo(
  runtimeEndpoint: string | undefined,
  builtinEndpoint: string | undefined
): ManagedEndpointInfo {
  const fromEnv = runtimeEndpoint?.trim() ?? ''
  if (fromEnv) return { endpoint: fromEnv, source: 'env' }
  const fromBuiltin = builtinEndpoint?.trim() ?? ''
  if (fromBuiltin) return { endpoint: fromBuiltin, source: 'builtin' }
  return { endpoint: '', source: 'none' }
}
