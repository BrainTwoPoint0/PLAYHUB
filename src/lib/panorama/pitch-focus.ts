// Half-pitch watch framing: derive the player's pan sub-window for a
// recording's pitch_focus from the scene's CURRENT active calibration
// (resolved at watch time — never snapshotted onto the recording).
//
// The window is the pan range spanned by the focused half's boundary marks:
// its two corners plus both midline endpoints, unprojected through the mesh
// (uvToRay) into the canonical panorama frame (forward = +Z, right = +X,
// pan = atan2(x, z) — the same convention the player derives its limits in).
// Any missing/unprojectable mark → null (degrade to full framing; a broken
// window must never block the watch page).

import type { PitchFocus, PitchMark } from '@/lib/panorama/pitch-marks'
import { uvToRay, type MeshGeometry } from '@/lib/panorama/pitch-solver'

const DEG = Math.PI / 180

/** Breathing room past the half's corner rays (radians). */
const PAN_MARGIN_RAD = 2 * DEG

export interface PanWindow {
  minRad: number
  maxRad: number
}

const HALF_MARKS: Record<'left_half' | 'right_half', string[]> = {
  // Pitch-plane convention (pitch-marks.ts): x runs nw→ne along the length,
  // left_half = x < L/2. Both halves include the midline endpoints.
  left_half: ['corner_nw', 'corner_sw', 'midline_n', 'midline_s'],
  right_half: ['corner_ne', 'corner_se', 'midline_n', 'midline_s'],
}

export function panWindowForFocus(
  mesh: MeshGeometry,
  marks: PitchMark[],
  frameWidth: number,
  frameHeight: number,
  focus: PitchFocus
): PanWindow | null {
  if (focus === 'full') return null
  const names = HALF_MARKS[focus]
  const byName = new Map(marks.map((m) => [m.name, m]))
  let min = Infinity
  let max = -Infinity
  for (const name of names) {
    const mark = byName.get(name as PitchMark['name'])
    if (!mark) return null
    const r = uvToRay(mesh, mark.uv[0], mark.uv[1], frameWidth, frameHeight)
    if (!r) return null
    const [x, , z] = r.ray
    if (z <= 0) {
      // |pan| ≥ 90° — geometrically possible at wide venues where the mast
      // overhangs the touchline. The atan2 min/max below would wrap, so we
      // degrade to full framing — but LOUDLY: this failure is otherwise
      // indistinguishable from "no calibration", and if it's real at a venue
      // the fix is a pan-unwrap around the window midpoint, not this guard.
      console.warn(
        `panWindowForFocus: mark ${name} has |pan| >= 90° (z=${z.toFixed(4)}) — degrading to full framing`
      )
      return null
    }
    const pan = Math.atan2(x, z)
    if (!Number.isFinite(pan)) return null
    if (pan < min) min = pan
    if (pan > max) max = pan
  }
  if (!(max > min)) return null
  // a half spanning more than ~170° means the marks are garbage
  if (max - min > 170 * DEG) return null
  return { minRad: min - PAN_MARGIN_RAD, maxRad: max + PAN_MARGIN_RAD }
}
