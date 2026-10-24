import {
  HttpDigitalEmployeeProvider,
  ResilientDigitalEmployeeProvider,
  type DigitalEmployeeProvider
} from './provider'

export interface DigitalEmployeeConnectionConfig {
  enabled: boolean
  baseUrl: string
  apiKey: string
  externalUserId: string
}

/**
 * 配置不完整或未启用时返回 fallback（Mock）；完整时返回带降级能力的远端 Provider。
 * 配置只从持久化设置读入，factory 内不读 env / renderer 全局。
 *
 * `externalUserId` 仍参与这里的完整性判断，但**不传给 Provider**：它是执行期
 * 身份（远端 run 与回流的 body 字段），列表请求用不到。判它是为了在配置页
 * 就拦住不完整的一组值，而不是让第一次对话才发现建不了远端会话。
 */
export function createDigitalEmployeeProvider(
  config: DigitalEmployeeConnectionConfig,
  fallback: DigitalEmployeeProvider
): DigitalEmployeeProvider {
  if (!config.enabled || !config.baseUrl || !config.apiKey || !config.externalUserId) {
    return fallback
  }
  return new ResilientDigitalEmployeeProvider(
    new HttpDigitalEmployeeProvider({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey
    }),
    fallback
  )
}

export interface DigitalEmployeeProviderHolder {
  current(): DigitalEmployeeProvider
  replace(next: DigitalEmployeeProvider): void
}

/**
 * 稳定代理：routes 每次请求都从 holder 取当前 Provider，
 * 因此 replace 换实例即可自然丢弃旧实例的 ETag / 响应缓存。
 */
export function createDigitalEmployeeProviderHolder(
  initial: DigitalEmployeeProvider
): DigitalEmployeeProviderHolder {
  let provider = initial
  return {
    current: () => provider,
    replace: (next) => {
      provider = next
    }
  }
}
