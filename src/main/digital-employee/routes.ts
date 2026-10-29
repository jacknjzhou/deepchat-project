import { digitalEmployeeGetRoute, digitalEmployeeListRoute } from '@shared/contracts/routes'
import { createRouteMap, type DeepchatRouteMap } from '@/routes/routeRegistry'
import type { DigitalEmployeeProviderHolder } from './providerFactory'

/**
 * 数字员工的基础读取路由：员工列表与单个员工详情。
 *
 * 数据一律经 `providerHolder` 现取——provider 可能在运行期于 http 与 mock
 * 之间热切换，路由层不缓存任何名单。列表响应额外携带 `degraded` 与 `source`，
 * renderer 据此展示「演示数据」降级提示。
 */

/**
 * 组装两条读取路由。
 * get 未命中时不报错，返回 `{ employee: null }`，由前端决定如何呈现。
 */
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
