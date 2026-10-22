import {
  digitalEmployeeGetRoute,
  digitalEmployeeListRoute
} from '@shared/contracts/routes'
import { createRouteMap, type DeepchatRouteMap } from '@/routes/routeRegistry'
import type { DigitalEmployeeProviderHolder } from './providerFactory'

export function createDigitalEmployeeRoutes(
  providerHolder: DigitalEmployeeProviderHolder
): DeepchatRouteMap {
  return createRouteMap([
    [
      digitalEmployeeListRoute.name,
      async () => {
        // 每次请求读取 holder，配置热替换后立即可见，且旧实例缓存随之丢弃。
        const provider = providerHolder.current()
        const employees = await provider.list()
        return digitalEmployeeListRoute.output.parse({
          employees,
          fetchedAt: new Date().toISOString(),
          degraded: provider.degraded === true,
          source: provider.source ?? 'mock'
        })
      }
    ],
    [
      digitalEmployeeGetRoute.name,
      async (rawInput) => {
        const input = digitalEmployeeGetRoute.input.parse(rawInput)
        const employees = await providerHolder.current().list()
        const employee = employees.find((item) => item.id === input.id) ?? null
        return digitalEmployeeGetRoute.output.parse({ employee })
      }
    ]
  ])
}
