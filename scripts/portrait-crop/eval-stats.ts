/**
 * Pure statistics helpers for the eval harness — kept in their own module so
 * they're unit-testable without importing eval.ts (which runs a main() on import).
 */

export const BOOTSTRAP_ITERS = 2000

/**
 * Percentile bootstrap CI for the MEAN of a per-clip metric (resamples clips
 * with replacement). Returns {mean, lo, hi, n} at the given confidence level.
 * `rng` is injectable so tests are deterministic. With <2 values the interval
 * collapses to the point estimate — a single clip cannot support a CI, which is
 * exactly why the old single-holdout eval could not be trusted.
 */
export function bootstrapMeanCI(
  values: number[],
  level = 0.95,
  iters = BOOTSTRAP_ITERS,
  rng: () => number = Math.random
): { mean: number; lo: number; hi: number; n: number } {
  const n = values.length
  const mean = n ? values.reduce((s, x) => s + x, 0) / n : 0
  if (n < 2) return { mean, lo: mean, hi: mean, n }
  const means: number[] = []
  for (let b = 0; b < iters; b++) {
    let s = 0
    for (let i = 0; i < n; i++) s += values[Math.min(n - 1, (rng() * n) | 0)]
    means.push(s / n)
  }
  means.sort((a, b) => a - b)
  const loIdx = Math.floor(((1 - level) / 2) * iters)
  const hiIdx = Math.min(
    iters - 1,
    Math.ceil((1 - (1 - level) / 2) * iters) - 1
  )
  return { mean, lo: means[loIdx], hi: means[hiIdx], n }
}

/**
 * BLOCK bootstrap: resample GROUPS (e.g. matches) with replacement, not clips.
 * Clips from the same match share lighting/ball/pitch → they're correlated, so
 * bootstrapping clips as independent understates the interval (false confidence).
 * We resample whole match-blocks and take the mean over the resampled clips.
 * The mean is the plain per-item mean (unchanged); only the CI widens correctly.
 */
export function bootstrapGroupedMeanCI(
  items: { value: number; group: string }[],
  level = 0.95,
  iters = BOOTSTRAP_ITERS,
  rng: () => number = Math.random
): { mean: number; lo: number; hi: number; n: number; groups: number } {
  const n = items.length
  const mean = n ? items.reduce((s, it) => s + it.value, 0) / n : 0
  const byGroup = new Map<string, number[]>()
  for (const it of items) {
    const arr = byGroup.get(it.group)
    if (arr) arr.push(it.value)
    else byGroup.set(it.group, [it.value])
  }
  const groups = [...byGroup.values()]
  const G = groups.length
  if (G < 2) return { mean, lo: mean, hi: mean, n, groups: G }
  const means: number[] = []
  for (let b = 0; b < iters; b++) {
    let s = 0
    let c = 0
    for (let g = 0; g < G; g++) {
      const grp = groups[Math.min(G - 1, (rng() * G) | 0)]
      for (const v of grp) {
        s += v
        c++
      }
    }
    means.push(c ? s / c : 0)
  }
  means.sort((a, b) => a - b)
  const loIdx = Math.floor(((1 - level) / 2) * iters)
  const hiIdx = Math.min(
    iters - 1,
    Math.ceil((1 - (1 - level) / 2) * iters) - 1
  )
  return { mean, lo: means[loIdx], hi: means[hiIdx], n, groups: G }
}
