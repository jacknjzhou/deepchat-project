import {
  digitalEmployeeGetRoute,
  digitalEmployeeListRoute
} from '@shared/contracts/routes'
import { createRouteMap, type DeepchatRouteMap } from '@/routes/routeRegistry'
import type { DigitalEmployeeProvider } from './provider'

export function createDigitalEmployeeRoutes(provider: DigitalEmployeeProvider): DeepchatRouteMap {
  return createRouteMap([
    [
      digitalEmployeeListRoute.name,
      async () => {
        const employees = await provider.list()
        return digitalEmployeeListRoute.output.parse({
          employees,
          fetchedAt: new Date().toISOString()
        })
      }
    ],
    [
      digitalEmployeeGetRoute.name,
      async (rawInput) => {
        const input = digitalEmployeeGetRoute.input.parse(rawInput)
        const employees = await provider.list()
        const employee = employees.find((item) => item.id === input.id) ?? null
        return digitalEmployeeGetRoute.output.parse({ employee })
      }
    ]
  ])
}
