import type { ModelTarget } from './documentExtractor'

export interface VisionTargetCandidates {
  explicitVision: ModelTarget | null
  agentVision: ModelTarget | null
  textTarget: ModelTarget | null
  isVisionCapable: (target: ModelTarget) => Promise<boolean>
}

/**
 * Resolve the vision model for document extraction, most explicit first.
 * When no dedicated vision model is configured, accept the default text
 * model if it advertises vision capability, so images go to the multimodal
 * model instead of falling back to local OCR.
 */
export async function pickVisionTarget(
  candidates: VisionTargetCandidates
): Promise<ModelTarget | null> {
  if (candidates.explicitVision) return candidates.explicitVision
  if (candidates.agentVision) return candidates.agentVision
  if (candidates.textTarget && (await candidates.isVisionCapable(candidates.textTarget))) {
    return candidates.textTarget
  }
  return null
}
