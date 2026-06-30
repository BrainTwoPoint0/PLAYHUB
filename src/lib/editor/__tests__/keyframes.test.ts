import { describe, it, expect } from 'vitest'
import { removeKeyframeRange } from '../keyframes'
import type { CropKeyframe } from '../types'

const kf = (time: number, x: number): CropKeyframe => ({
  time,
  x,
  source: 'ai_ball',
  confidence: 0.8,
})

describe('removeKeyframeRange', () => {
  const kfs = [kf(0, 100), kf(1, 200), kf(2, 300), kf(3, 400), kf(4, 500)]

  it('removes the inclusive index range, keeps the rest', () => {
    const r = removeKeyframeRange(kfs, 1, 3)
    expect(r.map((k) => k.time)).toEqual([0, 4])
  })

  it('is order-agnostic (hi, lo)', () => {
    expect(removeKeyframeRange(kfs, 3, 1)).toEqual(
      removeKeyframeRange(kfs, 1, 3)
    )
  })

  it('removes a single index when lo === hi', () => {
    expect(removeKeyframeRange(kfs, 2, 2).map((k) => k.time)).toEqual([
      0, 1, 3, 4,
    ])
  })

  it('is pure (does not mutate input)', () => {
    const copy = [...kfs]
    removeKeyframeRange(kfs, 0, 4)
    expect(kfs).toEqual(copy)
  })
})
