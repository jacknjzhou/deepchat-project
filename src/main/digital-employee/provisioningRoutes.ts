import { digitalEmployeeProvisionRoute } from '@shared/contracts/routes'
import { createRouteMap, type DeepchatRouteMap } from '@/routes/routeRegistry'
import type { EmployeeProvisioner } from './provisioning'

/**
 * Preparation route: registers the employee's remote tools and installs its
 * skills before the renderer builds a conversation.
 *
 * The renderer calls this and then reads the MCP tool list; the order matters,
 * because the tool allowlist is the complement of what that list returns. If
 * registration happened in the background, the first conversation of a session
 * would run without any `staffdeck_*` tool and there is no retry afterwards.
 *
 * Reporting is flattened on purpose: the renderer needs three booleans and a
 * count, not the registrar's internal reason codes.
 */

export interface DigitalEmployeeProvisioningRoutesDeps {
  provisioner: EmployeeProvisioner
}

export function createDigitalEmployeeProvisioningRoutes(
  deps: DigitalEmployeeProvisioningRoutesDeps
): DeepchatRouteMap {
  return createRouteMap([
    [
      digitalEmployeeProvisionRoute.name,
      async (rawInput) => {
        const input = digitalEmployeeProvisionRoute.input.parse(rawInput)
        // `provisionById` never rejects; the route is a thin projection.
        const outcome = await deps.provisioner.provisionById(input.employeeId)

        return digitalEmployeeProvisionRoute.output.parse({
          employeeId: outcome.employeeId,
          skipped: outcome.skipped,
          toolsReady: outcome.mcp?.registered === true && outcome.mcp.started === true,
          installedSkills: outcome.skills?.installed ?? 0,
          failedSkills: outcome.skills?.failedSkills ?? [],
          skillNames: outcome.skillNames,
          failures: outcome.failures
        })
      }
    ]
  ])
}
