import type { CropKeyframe } from './types'

/**
 * Remove keyframes whose index falls within [lo, hi] inclusive (order-agnostic).
 * Pure — used by the editor's batch range-delete (clear a stretch of bad keyframes,
 * e.g. where the AI crop followed a distractor, in one action).
 */
export function removeKeyframeRange(
  keyframes: CropKeyframe[],
  lo: number,
  hi: number
): CropKeyframe[] {
  const a = Math.min(lo, hi)
  const b = Math.max(lo, hi)
  return keyframes.filter((_, i) => i < a || i > b)
}
