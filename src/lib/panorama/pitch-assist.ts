// Auto-assist: propose a pitch boundary from Spiideo tracklet OCCUPANCY.
//
// Spiideo doesn't expose its operator-marked pitch mask to our account (the
// calibration-session resource 403s for ROLE_USER, and it isn't inline in the
// fetchable mesh). But we already publish per-game tracklets (player positions
// in pan/tilt), and where players go over a whole match approximates the pitch.
// So the assist proposes the 4 corners of the occupancy's bounding rectangle;
// the admin drags them out to the painted lines and confirms. It is a STARTING
// POINT, never ground truth — players undershoot the true corners and never
// reach the run-off, so the proposal is systematically INSET; that's expected
// and the admin corrects it.
//
// Frame coupling: tracklet pan/tilt are directions in the mesh convention, so
// they must be interpreted through a mesh of the SAME calibration epoch. A
// stale-epoch tracklets artifact yields an offset proposal (still draggable,
// but flag it). Midline is NOT proposed — players cross it freely, so occupancy
// carries no midline signal; that stays manual.

import { CORNER_MARK_NAMES, type PitchMark } from './pitch-marks'
import { panTiltToRay, rayToUv, type MeshGeometry } from './pitch-solver'

export interface PitchProposal {
  marks: PitchMark[]
  /** Number of tracklet samples that fed the occupancy fit. */
  sampleCount: number
  /** How many corners projected inside mesh coverage (4 = all). */
  cornersOnMesh: number
  note: string
}

// A proposal needs enough spatial evidence to be worth showing. Below this the
// occupancy is too sparse to bound a pitch — return null, admin marks manually.
const MIN_SAMPLES = 200

export interface Pt {
  x: number
  y: number
}

/** Central-quantile trim per axis to drop stray fragments before the hull. */
function robustSubset(pts: Pt[], qLo = 0.01, qHi = 0.99): Pt[] {
  if (pts.length < 3) return pts
  const xs = pts.map((p) => p.x).sort((a, b) => a - b)
  const ys = pts.map((p) => p.y).sort((a, b) => a - b)
  const q = (arr: number[], f: number) =>
    arr[Math.min(arr.length - 1, Math.max(0, Math.floor(f * arr.length)))]
  const xLo = q(xs, qLo)
  const xHi = q(xs, qHi)
  const yLo = q(ys, qLo)
  const yHi = q(ys, qHi)
  return pts.filter((p) => p.x >= xLo && p.x <= xHi && p.y >= yLo && p.y <= yHi)
}

/** Andrew's monotone-chain convex hull (CCW, no repeated endpoint). */
export function convexHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x))
  if (p.length < 3) return p
  const cross = (o: Pt, a: Pt, b: Pt) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Pt[] = []
  for (const pt of p) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0
    )
      lower.pop()
    lower.push(pt)
  }
  const upper: Pt[] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i]
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0
    )
      upper.pop()
    upper.push(pt)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/** Minimum-area enclosing rectangle via rotating calipers over hull edges.
 *  Returns its 4 corners CCW. */
export function minAreaRect(hull: Pt[]): Pt[] {
  if (hull.length < 3) {
    // degenerate: axis-aligned box
    const xs = hull.map((p) => p.x)
    const ys = hull.map((p) => p.y)
    const x0 = Math.min(...xs)
    const x1 = Math.max(...xs)
    const y0 = Math.min(...ys)
    const y1 = Math.max(...ys)
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ]
  }
  let best: { area: number; corners: Pt[] } | null = null
  const n = hull.length
  for (let i = 0; i < n; i++) {
    const a = hull[i]
    const b = hull[(i + 1) % n]
    const ex = b.x - a.x
    const ey = b.y - a.y
    const len = Math.hypot(ex, ey)
    if (len < 1e-12) continue
    const ux = ex / len
    const uy = ey / len // edge direction
    // project all hull points onto (u, u⊥)
    let minP = Infinity
    let maxP = -Infinity
    let minQ = Infinity
    let maxQ = -Infinity
    for (const p of hull) {
      const dx = p.x - a.x
      const dy = p.y - a.y
      const proj = dx * ux + dy * uy
      const perp = -dx * uy + dy * ux
      if (proj < minP) minP = proj
      if (proj > maxP) maxP = proj
      if (perp < minQ) minQ = perp
      if (perp > maxQ) maxQ = perp
    }
    const area = (maxP - minP) * (maxQ - minQ)
    if (best === null || area < best.area) {
      const corner = (pp: number, qq: number): Pt => ({
        x: a.x + ux * pp - uy * qq,
        y: a.y + uy * pp + ux * qq,
      })
      best = {
        area,
        corners: [
          corner(minP, minQ),
          corner(maxP, minQ),
          corner(maxP, maxQ),
          corner(minP, maxQ),
        ],
      }
    }
  }
  return best!.corners
}

/**
 * Label 4 rectangle corners as nw/ne/se/sw under the pitch convention (origin
 * nw, +x along the LONGER axis toward ne, +y toward sw). Occupancy alone can't
 * fix absolute orientation, so this is deterministic-but-best-effort — the
 * admin verifies/rotates. Long edge = length; nw = the length-axis end nearer
 * the top of the frame (smaller pan proxy), winding to keep sw across the width.
 */
function labelCorners(rect: Pt[]): Record<string, Pt> {
  // rect is CCW; edges 0-1 and 1-2 are the two side lengths
  const e01 = Math.hypot(rect[1].x - rect[0].x, rect[1].y - rect[0].y)
  const e12 = Math.hypot(rect[2].x - rect[1].x, rect[2].y - rect[1].y)
  // rotate so index 0-1 is the LONG (length) edge
  const r = e01 >= e12 ? rect : [rect[1], rect[2], rect[3], rect[0]]
  // r[0]-r[1] length edge, r[1]-r[2] width edge. Choose nw as the length-edge
  // endpoint with the smaller x (left in pan), keeping consistent winding.
  const flip = r[0].x > r[1].x
  const nw = flip ? r[1] : r[0]
  const ne = flip ? r[0] : r[1]
  const se = flip ? r[3] : r[2]
  const sw = flip ? r[2] : r[3]
  return { corner_nw: nw, corner_ne: ne, corner_se: se, corner_sw: sw }
}

/**
 * Propose pitch corner marks from a tracklets artifact. Aggregates every
 * tracklet sample into a pan/tilt occupancy cloud, fits a robust bounding
 * rectangle, and projects its corners back to raw-frame pixels through the
 * mesh. Returns null when there's too little occupancy or no corner lands on
 * the mesh. Midline is never proposed.
 */
export function proposePitchMarksFromTracklets(
  tracklets: { objects: { pan: number[]; tilt: number[] }[] },
  mesh: MeshGeometry,
  frameWidth: number,
  frameHeight: number
): PitchProposal | null {
  const pts: Pt[] = []
  for (const obj of tracklets.objects) {
    const n = obj.pan.length
    for (let i = 0; i < n; i++) {
      const pan = obj.pan[i]
      const tilt = obj.tilt[i]
      if (Number.isFinite(pan) && Number.isFinite(tilt))
        pts.push({ x: pan, y: tilt })
    }
  }
  if (pts.length < MIN_SAMPLES) return null

  const trimmed = robustSubset(pts)
  const hull = convexHull(trimmed.length >= 3 ? trimmed : pts)
  if (hull.length < 3) return null
  const rect = minAreaRect(hull)
  const labeled = labelCorners(rect)

  const marks: PitchMark[] = []
  let cornersOnMesh = 0
  for (const name of CORNER_MARK_NAMES) {
    const c = labeled[name]
    const uv = rayToUv(mesh, panTiltToRay(c.x, c.y), frameWidth, frameHeight)
    if (!uv) continue
    cornersOnMesh++
    marks.push({ name, uv })
  }
  if (cornersOnMesh < 4) return null

  return {
    marks,
    sampleCount: pts.length,
    cornersOnMesh,
    note: 'Proposed from player occupancy — inset from the true lines; drag each corner out to the painted boundary and add the midline.',
  }
}
