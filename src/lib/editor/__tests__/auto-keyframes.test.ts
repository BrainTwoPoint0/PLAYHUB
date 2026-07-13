import { describe, it, expect } from 'vitest'
import { autoKeyframesFromDetection } from '../auto-keyframes'
import { detectionsToCropKeyframes } from '../types'
import { simplifyCropKeyframes } from '../simplify'
import type { DetectionPosition } from '../types'

// A synthetic-but-plausible detection track: ball pans left→right with a few
// tracked/cluster fills and one 'none' dropout, at 25fps sampling.
function makePositions(): DetectionPosition[] {
  const out: DetectionPosition[] = []
  for (let i = 0; i < 250; i++) {
    const time = i / 25
    // Pan right, then reverse at i=150 (a real attack-and-clear shape) so the
    // simplifier keeps interior keyframes.
    const x = i < 150 ? 200 + 10 * i : 1700 - 12 * (i - 150)
    const source =
      i % 40 === 0
        ? 'none'
        : i % 7 === 0
          ? 'tracked'
          : i % 11 === 0
            ? 'cluster'
            : 'ball'
    out.push({
      time,
      x: source === 'none' ? -1 : x,
      y: 540,
      w: 14,
      h: 14,
      conf: source === 'ball' ? 0.62 : 0.35,
      source,
    })
  }
  return out
}

describe('autoKeyframesFromDetection', () => {
  const positions = makePositions()
  const sceneChanges = [4.2, 7.8]

  it('produces EXACTLY the editor composition (parity contract)', () => {
    // The editor previously inlined detectionsToCropKeyframes + simplify;
    // the headless job must never drift from it.
    const expected = simplifyCropKeyframes(
      detectionsToCropKeyframes({
        positions,
        scene_changes: sceneChanges,
        all_candidates: [],
      }),
      sceneChanges
    )
    const { keyframes } = autoKeyframesFromDetection({
      positions,
      scene_changes: sceneChanges,
    })
    expect(keyframes).toEqual(expected)
    expect(keyframes.length).toBeGreaterThanOrEqual(2)
  })

  it('passes scene changes through and defaults empty inputs', () => {
    const res = autoKeyframesFromDetection({})
    expect(res.keyframes).toEqual([])
    expect(res.sceneChanges).toEqual([])
    expect(res.quality.n_positions).toBe(0)
    expect(res.quality.ball_fraction).toBe(0)
    expect(res.quality.mean_conf).toBe(0)
  })

  it('derives quality signals from the detection, deterministically', () => {
    const { quality } = autoKeyframesFromDetection({
      positions,
      scene_changes: sceneChanges,
      modal_app_version: '2026.06.30.1',
    })
    expect(quality.n_positions).toBe(250)
    expect(quality.n_ball).toBe(
      positions.filter((p) => p.source === 'ball').length
    )
    expect(quality.ball_fraction).toBeCloseTo(quality.n_ball / 250)
    expect(quality.duration_seconds).toBeCloseTo(249 / 25)
    expect(quality.mean_conf).toBeGreaterThan(0.3)
    expect(quality.modal_app_version).toBe('2026.06.30.1')
    // Determinism: same input, same output.
    expect(
      autoKeyframesFromDetection({ positions, scene_changes: sceneChanges })
        .quality.mean_conf
    ).toBe(quality.mean_conf)
  })
})
