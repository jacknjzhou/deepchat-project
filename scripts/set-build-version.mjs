import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

/**
 * Optionally override package.json version at build time.
 *
 * Usage:
 *   BUILD_VERSION=1.2.3 pnpm run build
 *
 * If BUILD_VERSION is unset, this script is a no-op.
 */

const buildVersion = process.env.BUILD_VERSION

if (!buildVersion) {
  console.log('[set-build-version] BUILD_VERSION not set, skipping version override.')
  process.exit(0)
}

const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[-\w.]+)?(?:\+[-\w.]+)?$/

if (!SEMVER_REGEX.test(buildVersion)) {
  console.error(`[set-build-version] Invalid semver version: ${buildVersion}`)
  process.exit(1)
}

const packageJsonPath = resolve(process.cwd(), 'package.json')
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))

if (packageJson.version === buildVersion) {
  console.log(`[set-build-version] Version already set to ${buildVersion}.`)
  process.exit(0)
}

packageJson.version = buildVersion
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)

console.log(`[set-build-version] Updated package.json version to ${buildVersion}.`)
