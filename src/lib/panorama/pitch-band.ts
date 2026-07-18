// Solve-quality verdict band — THE shared implementation. The result screen,
// the venue card, AND the pitch-calibration PUT (which refuses to activate a
// red solve) all call this one function; keeping them in lockstep is a
// product guarantee (the card must never contradict the verdict the admin
// saw, and the server must never activate what the screen calls red).
// The batch tracklets job mirrors these boundaries in Python
// (infrastructure/batch/player-tracklets/build_track.py,
// calibration_unusable_reason) — change them together.

import { CORNER_MARK_NAMES, type PitchMark } from './pitch-marks'

/**
 * Verdict band for a solve's max reprojection error, RELATIVE to the pitch's
 * on-screen size (max pairwise corner distance in raw-frame px). Absolute
 * thresholds mislead: 32px is huge on a pitch spanning 300px and ~1% on one
 * spanning 3000px — and venue meshes carry residual lens distortion that no
 * homography can absorb, so a well-marked pitch on an imperfect fit lands
 * around 0.5–1.5%. That reads "usable", never "your marks are wrong".
 */
export function solveErrorBand(
  errPx: number,
  marks: PitchMark[]
): 'good' | 'ok' | 'bad' {
  if (!Number.isFinite(errPx)) return 'bad'
  const corners = marks.filter((m) =>
    (CORNER_MARK_NAMES as readonly string[]).includes(m.name)
  )
  let diag = 0
  for (let i = 0; i < corners.length; i++) {
    for (let j = i + 1; j < corners.length; j++) {
      diag = Math.max(
        diag,
        Math.hypot(
          corners[i].uv[0] - corners[j].uv[0],
          corners[i].uv[1] - corners[j].uv[1]
        )
      )
    }
  }
  if (diag <= 0) return errPx < 15 ? 'good' : errPx < 45 ? 'ok' : 'bad'
  const rel = errPx / diag
  return rel < 0.005 ? 'good' : rel < 0.015 ? 'ok' : 'bad'
}
