import { describe, it, expect } from 'vitest'
import { diffKeyframes, TIME_EPS, X_EPS } from '../keyframe-diff'
import type { CropKeyframe } from '../types'

const kf = (
  time: number,
  x: number,
  source: CropKeyframe['source'] = 'ai_ball',
  confidence = 0.9
): CropKeyframe => ({ time, x, source, confidence })

describe('diffKeyframes', () => {
  it('reports no change for identical lists', () => {
    const a = [kf(0, 100), kf(1, 200), kf(2, 300)]
    const d = diffKeyframes(a, [...a])
    expect(d.counts).toMatchObject({ added: 0, deleted: 0, moved: 0, unchanged: 3 })
    expect(d.maxAbsDx).toBe(0)
  })

  it('detects a deleted keyframe (the AI put the crop somewhere wrong)', () => {
    const before = [kf(0, 100), kf(1, 200), kf(2, 300)]
    const after = [kf(0, 100), kf(2, 300)]
    const d = diffKeyframes(before, after)
    expect(d.counts.deleted).toBe(1)
    expect(d.deleted[0]).toMatchObject({ time: 1, x: 200 })
    expect(d.counts.added).toBe(0)
  })

  it('detects an added keyframe (the human says it belongs here)', () => {
    const before = [kf(0, 100), kf(2, 300)]
    const after = [kf(0, 100), kf(1, 555, 'user', 1), kf(2, 300)]
    const d = diffKeyframes(before, after)
    expect(d.counts.added).toBe(1)
    expect(d.added[0]).toMatchObject({ time: 1, x: 555, source: 'user' })
    expect(d.counts.deleted).toBe(0)
  })

  it('detects a moved keyframe and records the signed dx', () => {
    const before = [kf(0, 100), kf(1, 200)]
    const after = [kf(0, 100), kf(1, 260)]
    const d = diffKeyframes(before, after)
    expect(d.counts.moved).toBe(1)
    expect(d.moved[0]).toMatchObject({ time: 1, xBefore: 200, xAfter: 260, dx: 60 })
    expect(d.maxAbsDx).toBe(60)
    expect(d.counts.added).toBe(0)
    expect(d.counts.deleted).toBe(0)
  })

  it('treats sub-epsilon x jitter as unchanged, not moved', () => {
    const before = [kf(1, 200)]
    const after = [kf(1, 200 + X_EPS - 1)]
    expect(diffKeyframes(before, after).counts).toMatchObject({ moved: 0, unchanged: 1 })
  })

  it('pairs keyframes whose time drifted within TIME_EPS (editor nudges on drag)', () => {
    const before = [kf(1.0, 200)]
    const after = [kf(1.0 + TIME_EPS / 2, 200)]
    const d = diffKeyframes(before, after)
    expect(d.counts).toMatchObject({ added: 0, deleted: 0, unchanged: 1 })
  })

  it('treats a beyond-epsilon time shift as delete + add, not a move', () => {
    const before = [kf(1.0, 200)]
    const after = [kf(1.0 + TIME_EPS * 4, 200)]
    const d = diffKeyframes(before, after)
    expect(d.counts).toMatchObject({ added: 1, deleted: 1, moved: 0 })
  })

  it('summarises which pipeline sources the human deleted (the diagnosis)', () => {
    const before = [kf(0, 10, 'ai_ball'), kf(1, 20, 'ai_cluster'), kf(2, 30, 'ai_cluster')]
    const d = diffKeyframes(before, [kf(0, 10, 'ai_ball')])
    expect(d.deletedSourceMix).toEqual({ ai_cluster: 2 })
  })

  it('handles empty before (nothing detected) and empty after (all removed)', () => {
    expect(diffKeyframes([], [kf(0, 1)]).counts).toMatchObject({ added: 1, deleted: 0 })
    expect(diffKeyframes([kf(0, 1)], []).counts).toMatchObject({ added: 0, deleted: 1 })
    expect(diffKeyframes([], []).counts).toMatchObject({ added: 0, deleted: 0, unchanged: 0 })
  })

  it('is order-insensitive (sorts unsorted input rather than mis-pairing)', () => {
    const before = [kf(2, 300), kf(0, 100), kf(1, 200)]
    const after = [kf(1, 200), kf(2, 300), kf(0, 100)]
    expect(diffKeyframes(before, after).counts).toMatchObject({ added: 0, deleted: 0, moved: 0 })
  })

  it('does not pair one before-frame with two after-frames (greedy, one-to-one)', () => {
    const before = [kf(1.0, 200)]
    const after = [kf(1.0, 200), kf(1.0 + TIME_EPS / 3, 800)]
    const d = diffKeyframes(before, after)
    expect(d.counts).toMatchObject({ unchanged: 1, added: 1, deleted: 0 })
  })

  it('ignores non-finite input defensively rather than emitting NaN', () => {
    const d = diffKeyframes([kf(NaN, 1), kf(0, 100)], [kf(0, 100)])
    expect(Number.isFinite(d.maxAbsDx)).toBe(true)
    expect(d.counts.before).toBe(1) // the NaN frame is dropped, not counted
  })
})
