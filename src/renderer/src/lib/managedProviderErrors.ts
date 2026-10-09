type Translate = (key: string, params?: Record<string, string>) => string

// 不锚定行首：调用链通常传入经 IPC 包装后的错误串
// （如 "Error: Error invoking remote method 'deepchat:route:invoke': Error: [managed.providerLocked:...]"），
// 因此需在整个字符串中查找该标记。
const PROVIDER_LOCKED_PATTERN = /\[managed\.providerLocked:([^\]\n]+)\]/

/**
 * 把主进程托管 provider 守卫错误里的稳定前缀码映射为本地化文案；
 * 未命中前缀返回 null，调用方回退显示原始错误串。
 */
export function formatManagedProviderError(raw: string, t: Translate): string | null {
  if (PROVIDER_LOCKED_PATTERN.test(raw)) {
    return t('settings.managed.providerLocked')
  }
  return null
}
