import type { DeepchatBridge } from '@shared/contracts/bridge'
import {
  ocrClearCacheRoute,
  ocrGetRuntimeStatusRoute,
  ocrWarmupRoute
} from '@shared/contracts/routes'
import { getDeepchatBridge } from './core'

export function createOcrClient(bridge: DeepchatBridge = getDeepchatBridge()) {
  async function getRuntimeStatus() {
    return await bridge.invoke(ocrGetRuntimeStatusRoute.name, {})
  }

  async function clearCache() {
    return await bridge.invoke(ocrClearCacheRoute.name, {})
  }

  async function warmup() {
    return await bridge.invoke(ocrWarmupRoute.name, {})
  }

  return { getRuntimeStatus, clearCache, warmup }
}

export type OcrClient = ReturnType<typeof createOcrClient>
