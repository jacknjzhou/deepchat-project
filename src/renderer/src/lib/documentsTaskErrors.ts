type Translate = (key: string, params?: Record<string, string>) => string

const PROVIDER_REF_PATTERN = /^\[documents\.(providerMissing|providerDisabled):([^|\]]*)\|/
const MODEL_REF_PATTERN = /^\[documents\.modelMissing:([^|\]]*)\|([^|\]]*)\]/

/**
 * 把主进程任务错误里的稳定前缀码映射为本地化文案；
 * 未命中前缀返回 null，调用方回退显示原始错误串。
 */
export function formatDocumentsTaskError(raw: string, t: Translate): string | null {
  if (raw.startsWith('[documents.modelRequired]')) {
    return t('documents.errors.modelRequired')
  }
  const providerMatch = raw.match(PROVIDER_REF_PATTERN)
  if (providerMatch) {
    return t('documents.errors.modelProviderMissing', { provider: providerMatch[2] })
  }
  const modelMatch = raw.match(MODEL_REF_PATTERN)
  if (modelMatch) {
    return t('documents.errors.modelMissing', { model: modelMatch[2] })
  }
  return null
}
