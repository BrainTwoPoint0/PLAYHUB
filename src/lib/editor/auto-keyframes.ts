// The shared "detection → publishable crop keyframes" composition. The editor
// and the headless portrait-render Batch job MUST produce identical keyframes
// from the same detection JSON — this module is the single implementation
// (the Batch container imports it via esbuild relative path, the
// monthly-invoicing precedent). Keep it pure and dependency-free.

import {
  detectionsToCropKeyframes,
  type CropKeyframe,
  type DetectionPosition,
} from './types'
import { simplifyCropKeyframes } from './simplify'

export interface DetectionInput {
  positions?: DetectionPosition[]
  scene_changes?: number[]
  modal_app_version?: string | null
  modal_inference_ms?: number | null
  codec_fingerprint?: Record<string, unknown> | null
}

/**
 * Quality signals recorded on every system-generated render — the future
 * auto-publish gate (today they only sort/inform the review queue). Derived
 * purely from the detection output, so a re-render never changes them unless
 * the detection itself is refreshed.
 */
export interface DetectionQuality {
  n_positions: number
  n_ball: number // real ball detections (vs tracked/cluster fill)
  ball_fraction: number // n_ball / n_positions (0 when no positions)
  mean_conf: number
  duration_seconds: number
  keyframe_count: number
  modal_app_version: string | null
}

export interface AutoKeyframesResult {
  keyframes: CropKeyframe[]
  sceneChanges: number[]
  quality: DetectionQuality
}

export function autoKeyframesFromDetection(
  detection: DetectionInput
): AutoKeyframesResult {
  const positions = detection.positions ?? []
  const sceneChanges = detection.scene_changes ?? []
  const cropKfs = detectionsToCropKeyframes({
    positions,
    scene_changes: sceneChanges,
    all_candidates: [],
  })
  const keyframes = simplifyCropKeyframes(cropKfs, sceneChanges)

  const ball = positions.filter((p) => p.source === 'ball')
  const conf = positions.filter((p) => p.source !== 'none' && p.x >= 0)
  return {
    keyframes,
    sceneChanges,
    quality: {
      n_positions: positions.length,
      n_ball: ball.length,
      ball_fraction: positions.length ? ball.length / positions.length : 0,
      mean_conf: conf.length
        ? conf.reduce((a, p) => a + (p.conf ?? 0), 0) / conf.length
        : 0,
      duration_seconds: positions.length
        ? Math.max(...positions.map((p) => p.time))
        : 0,
      keyframe_count: keyframes.length,
      modal_app_version: detection.modal_app_version ?? null,
    },
  }
}
