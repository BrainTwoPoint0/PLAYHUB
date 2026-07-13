import { describe, it, expect } from 'vitest'
import { bootstrapMeanCI, bootstrapGroupedMeanCI } from '../eval-stats'

// Deterministic LCG so bootstrap resampling is reproducible in tests.
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (1664525 * s + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe('bootstrapMeanCI', () => {
  it('collapses to the point estimate with <2 values (a single clip cannot support a CI)', () => {
    expect(bootstrapMeanCI([])).toEqual({ mean: 0, lo: 0, hi: 0, n: 0 })
    const one = bootstrapMeanCI([0.42])
    expect(one).toEqual({ mean: 0.42, lo: 0.42, hi: 0.42, n: 1 })
  })

  it('gives a zero-width interval when all values are identical', () => {
    const r = bootstrapMeanCI([0.3, 0.3, 0.3, 0.3], 0.95, 500, lcg(1))
    expect(r.mean).toBeCloseTo(0.3, 10)
    expect(r.lo).toBeCloseTo(0.3, 10)
    expect(r.hi).toBeCloseTo(0.3, 10)
    expect(r.n).toBe(4)
  })

  it('brackets the sample mean and stays within the value range', () => {
    const vals = [0.0, 0.1, 0.2, 0.3, 0.9]
    const r = bootstrapMeanCI(vals, 0.95, 3000, lcg(12345))
    expect(r.mean).toBeCloseTo(0.3, 10) // (0+0.1+0.2+0.3+0.9)/5
    expect(r.lo).toBeLessThanOrEqual(r.mean)
    expect(r.hi).toBeGreaterThanOrEqual(r.mean)
    expect(r.lo).toBeGreaterThanOrEqual(Math.min(...vals))
    expect(r.hi).toBeLessThanOrEqual(Math.max(...vals))
    // With this spread the interval must be non-trivial (not collapsed).
    expect(r.hi - r.lo).toBeGreaterThan(0.05)
  })

  it('is reproducible for a fixed rng seed and narrows a wider interval at lower confidence', () => {
    const vals = [0.0, 0.1, 0.2, 0.3, 0.9]
    const a = bootstrapMeanCI(vals, 0.95, 3000, lcg(7))
    const b = bootstrapMeanCI(vals, 0.95, 3000, lcg(7))
    expect(a).toEqual(b) // deterministic under a fixed seed
    const wide = bootstrapMeanCI(vals, 0.95, 3000, lcg(7))
    const narrow = bootstrapMeanCI(vals, 0.5, 3000, lcg(7))
    expect(narrow.hi - narrow.lo).toBeLessThanOrEqual(wide.hi - wide.lo)
  })
})

describe('bootstrapGroupedMeanCI (match-block)', () => {
  it('reports the plain item mean and the group count', () => {
    const items = [
      { value: 0.2, group: 'm1' },
      { value: 0.4, group: 'm1' },
      { value: 0.6, group: 'm2' },
    ]
    const r = bootstrapGroupedMeanCI(items, 0.95, 2000, lcg(3))
    expect(r.mean).toBeCloseTo((0.2 + 0.4 + 0.6) / 3, 10)
    expect(r.n).toBe(3)
    expect(r.groups).toBe(2)
  })

  it('collapses to a point with <2 groups (one match cannot support a CI)', () => {
    const r = bootstrapGroupedMeanCI(
      [
        { value: 0.3, group: 'm1' },
        { value: 0.5, group: 'm1' },
      ],
      0.95,
      2000,
      lcg(1)
    )
    expect(r.groups).toBe(1)
    expect(r.lo).toBe(r.mean)
    expect(r.hi).toBe(r.mean)
  })

  it('gives a WIDER interval than naive per-item bootstrap when items cluster by group (the whole point)', () => {
    // Two matches, tightly clustered within each, far apart between: correlated.
    const items = [
      { value: 0.1, group: 'a' },
      { value: 0.12, group: 'a' },
      { value: 0.11, group: 'a' },
      { value: 0.9, group: 'b' },
      { value: 0.88, group: 'b' },
      { value: 0.92, group: 'b' },
    ]
    const grouped = bootstrapGroupedMeanCI(items, 0.95, 4000, lcg(9))
    const naive = bootstrapMeanCI(
      items.map((i) => i.value),
      0.95,
      4000,
      lcg(9)
    )
    // Block bootstrap must NOT be falsely confident: its interval is wider.
    expect(grouped.hi - grouped.lo).toBeGreaterThan(naive.hi - naive.lo)
  })
})
