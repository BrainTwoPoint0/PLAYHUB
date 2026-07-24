/**
 * Keyframe diff — the training/QA signal from a human correcting a portrait draft.
 *
 * Label semantics: a draft marked "good enough" is UNEDITED by definition. The moment
 * an admin edits anything, that itself says the auto-detection was not good enough; this
 * diff says *how* it failed — which keyframes they deleted (the crop was wrong there),
 * which they added (it belongs here), and how far they dragged it.
 *
 * Computed SERVER-SIDE so it cannot be forged and the algorithm is versioned in one place.
 * Pure and dependency-free, matching auto-keyframes.ts (the Batch container imports that
 * via a relative esbuild path, so no framework imports may creep in here either).
 */
import type { CropKeyframe } from './types'

/**
 * Pairing tolerance. One frame at 25fps is 0.04s and the editor nudges keyframe times on
 * drag, so a pair inside this window is the *same* keyframe moved, not a delete+add.
 */
export const TIME_EPS = 0.05
/** Sub-pixel-ish x jitter (0.2% of the 1920 source) is not a human "move". */
export const X_EPS = 4

export interface KeyframeMove {
  time: number
  xBefore: number
  xAfter: number
  dx: number
}

export interface KeyframeDiff {
  added: CropKeyframe[]
  deleted: CropKeyframe[]
  moved: KeyframeMove[]
  /** How many deleted frames came from each pipeline source — the diagnosis:
   *  ai_cluster-heavy = holds are wrong, ai_tracked-heavy = bridges, ai_ball = wrong-ball. */
  deletedSourceMix: Partial<Record<CropKeyframe['source'], number>>
  counts: {
    before: number
    after: number
    added: number
    deleted: number
    moved: number
    unchanged: number
  }
  maxAbsDx: number
  meanAbsDx: number
}

function clean(
  list: readonly CropKeyframe[] | null | undefined
): CropKeyframe[] {
  if (!Array.isArray(list)) return []
  return list
    .filter((k) => k && Number.isFinite(k.time) && Number.isFinite(k.x))
    .slice()
    .sort((a, b) => a.time - b.time)
}

/**
 * Greedy nearest-time one-to-one pairing over both lists sorted by time. Unpaired
 * before-frames are deletions, unpaired after-frames are additions, paired frames are
 * `moved` when |dx| > X_EPS and `unchanged` otherwise.
 */
export function diffKeyframes(
  beforeInput: readonly CropKeyframe[] | null | undefined,
  afterInput: readonly CropKeyframe[] | null | undefined
): KeyframeDiff {
  const before = clean(beforeInput)
  const after = clean(afterInput)

  const added: CropKeyframe[] = []
  const deleted: CropKeyframe[] = []
  const moved: KeyframeMove[] = []
  let unchanged = 0
  let sumAbsDx = 0
  let maxAbsDx = 0

  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    const b = before[i]
    const a = after[j]
    const dt = a.time - b.time
    if (Math.abs(dt) <= TIME_EPS) {
      const dx = a.x - b.x
      if (Math.abs(dx) > X_EPS) {
        moved.push({ time: b.time, xBefore: b.x, xAfter: a.x, dx })
        sumAbsDx += Math.abs(dx)
        if (Math.abs(dx) > maxAbsDx) maxAbsDx = Math.abs(dx)
      } else {
        unchanged++
      }
      i++
      j++
    } else if (dt < 0) {
      // an after-frame with no before-partner in range: the human added it
      added.push(a)
      j++
    } else {
      // a before-frame the human left behind: deleted
      deleted.push(b)
      i++
    }
  }
  for (; i < before.length; i++) deleted.push(before[i])
  for (; j < after.length; j++) added.push(after[j])

  const deletedSourceMix: Partial<Record<CropKeyframe['source'], number>> = {}
  for (const d of deleted) {
    if (!d.source) continue
    deletedSourceMix[d.source] = (deletedSourceMix[d.source] ?? 0) + 1
  }

  return {
    added,
    deleted,
    moved,
    deletedSourceMix,
    counts: {
      before: before.length,
      after: after.length,
      added: added.length,
      deleted: deleted.length,
      moved: moved.length,
      unchanged,
    },
    maxAbsDx,
    meanAbsDx: moved.length ? sumAbsDx / moved.length : 0,
  }
}
