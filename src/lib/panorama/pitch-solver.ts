// Advisory pitch-calibration solver: marks (raw-frame px) → world rays through
// the scene MESH, then a pitch-metric → ray homography (normalized DLT) with a
// reprojection-error estimate the marking UI shows the admin at save time.
//
// The mesh — not the per-venue fisheye fit — is the geometry ground truth: it
// is exactly what the player renders through and what the player-tracklets
// batch job builds its uv↔rayn lookups from, and for converted-Spiideo venues
// (HCT) there is no fisheye fit at all. Consumers RECOMPUTE from the stored
// marks through their own mesh copy; everything derived here is advisory and
// tagged with SOLVER_VERSION.
//
// Mesh format (see generate_mesh.py + VirtualPanoramaPlayer.tsx): vertex =
// [f0, f1, u, v, alpha]; world ray = transpose(R_scene · MOUNT_S) · (f0, f1, 1);
// (u, v) = raw-frame pixel / frame size (y down, no flip). Only triangle-
// referenced vertices are meaningful — culled vertices remain in vertices.bin
// with garbage values (2026-07-12 invariant).

import type { PitchDims, PitchMark } from './pitch-marks'
import { CORNER_MARK_NAMES, markWorldPoint } from './pitch-marks'

export const SOLVER_VERSION = 1

/** Sensor-mount convention matrix — frozen physical constant. Twin of MOUNT_S
 *  in VirtualPanoramaPlayer.tsx and generate_mesh.py; never edit one alone. */
const MOUNT_S = [
  [0, -0.218849, 0.975731],
  [-1.000013, 0, 0],
  [0, -0.975762, -0.218884],
]

interface SceneProjection {
  n_vertices: number
  n_indices: number
  camera: { rotation: number[] }
}

export interface MeshGeometry {
  /** Flat [f0, f1, u, v, alpha] per vertex, all projections concatenated. */
  verts: Float32Array
  /** Global triangle indices into verts. */
  indices: Uint32Array
  /** Per-triangle ABSOLUTE offset into indices of the triple's first index.
   *  Triangles are triples WITHIN each projection's n_indices block — Spiideo's
   *  own captured meshes can have n_indices % 3 !== 0, and assuming globally
   *  contiguous triples would misalign every triangle after a ragged block. */
  triStart: Uint32Array
  /** Per-triangle projection index (world transform lookup). */
  triProjection: Uint16Array
  /** Per-projection textureToWorld = transpose(R_scene · MOUNT_S), row-major. */
  textureToWorld: number[][][]
}

function mat3Mul(a: number[][], b: number[][]): number[][] {
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]
  return out
}

function transpose(a: number[][]): number[][] {
  return [
    [a[0][0], a[1][0], a[2][0]],
    [a[0][1], a[1][1], a[2][1]],
    [a[0][2], a[1][2], a[2][2]],
  ]
}

/** Parse scene.json + vertices.bin + indices.bin into a queryable geometry. */
export function parseMeshGeometry(
  sceneJson: { projections: SceneProjection[] },
  verticesBin: ArrayBuffer,
  indicesBin: ArrayBuffer
): MeshGeometry {
  const verts = new Float32Array(verticesBin)
  const indices = new Uint32Array(indicesBin)
  if (verts.length % 5 !== 0) {
    throw new Error(`vertices.bin length ${verts.length} not divisible by 5`)
  }
  const projections = sceneJson.projections
  if (!Array.isArray(projections) || projections.length === 0) {
    throw new Error('scene.json has no projections')
  }
  const textureToWorld = projections.map((p) => {
    const r = p.camera.rotation
    if (!Array.isArray(r) || r.length !== 9) {
      throw new Error(
        'projection camera.rotation must be a 3x3 row-major array'
      )
    }
    const R = [r.slice(0, 3), r.slice(3, 6), r.slice(6, 9)]
    return transpose(mat3Mul(R, MOUNT_S))
  })
  // Triangles are triples WITHIN each projection's n_indices block (the player
  // slices per-projection blocks the same way): a ragged block must drop its
  // trailing remainder, never bleed into the next projection's indices.
  const starts: number[] = []
  const projOf: number[] = []
  let base = 0
  projections.forEach((p, pi) => {
    const span = Math.floor(p.n_indices / 3)
    for (let t = 0; t < span; t++) {
      const s = base + t * 3
      if (s + 2 >= indices.length) break
      starts.push(s)
      projOf.push(pi)
    }
    base += p.n_indices
  })
  return {
    verts,
    indices,
    triStart: new Uint32Array(starts),
    triProjection: new Uint16Array(projOf),
    textureToWorld,
  }
}

/**
 * Map a raw-frame pixel to a world ray by locating the mesh triangle whose
 * texture-UV footprint contains it and barycentrically interpolating (f0, f1).
 * Returns null when the pixel is outside mesh coverage (un-unprojectable —
 * callers must surface this to the operator, not guess).
 *
 * Also returns pxPerRadian: the local uv-px-per-ray-angle scale from the
 * containing triangle, used to express angular reprojection error in pixels.
 */
export function uvToRay(
  mesh: MeshGeometry,
  xPx: number,
  yPx: number,
  frameWidth: number,
  frameHeight: number
): { ray: [number, number, number]; pxPerRadian: number } | null {
  const u = xPx / frameWidth
  const v = yPx / frameHeight
  const { verts, indices, triStart, triProjection, textureToWorld } = mesh
  const nTri = triProjection.length
  for (let t = 0; t < nTri; t++) {
    const s = triStart[t]
    const ia = indices[s] * 5
    const ib = indices[s + 1] * 5
    const ic = indices[s + 2] * 5
    const ua = verts[ia + 2]
    const va = verts[ia + 3]
    const ub = verts[ib + 2]
    const vb = verts[ib + 3]
    const uc = verts[ic + 2]
    const vc = verts[ic + 3]
    // cheap reject before barycentric
    if (
      (u < ua && u < ub && u < uc) ||
      (u > ua && u > ub && u > uc) ||
      (v < va && v < vb && v < vc) ||
      (v > va && v > vb && v > vc)
    ) {
      continue
    }
    const d = (vb - vc) * (ua - uc) + (uc - ub) * (va - vc)
    if (Math.abs(d) < 1e-12) continue
    const w0 = ((vb - vc) * (u - uc) + (uc - ub) * (v - vc)) / d
    const w1 = ((vc - va) * (u - uc) + (ua - uc) * (v - vc)) / d
    const w2 = 1 - w0 - w1
    const eps = -1e-6
    if (w0 < eps || w1 < eps || w2 < eps) continue

    const f0 = w0 * verts[ia] + w1 * verts[ib] + w2 * verts[ic]
    const f1 = w0 * verts[ia + 1] + w1 * verts[ib + 1] + w2 * verts[ic + 1]
    const tw = textureToWorld[triProjection[t]]
    const rx = tw[0][0] * f0 + tw[0][1] * f1 + tw[0][2]
    const ry = tw[1][0] * f0 + tw[1][1] * f1 + tw[1][2]
    const rz = tw[2][0] * f0 + tw[2][1] * f1 + tw[2][2]
    const n = Math.hypot(rx, ry, rz)
    if (!(n > 0)) continue

    // local scale: uv-px extent of the triangle vs its angular extent
    const rayAt = (i: number): [number, number, number] => {
      const g0 = verts[i]
      const g1 = verts[i + 1]
      const x = tw[0][0] * g0 + tw[0][1] * g1 + tw[0][2]
      const y = tw[1][0] * g0 + tw[1][1] * g1 + tw[1][2]
      const z = tw[2][0] * g0 + tw[2][1] * g1 + tw[2][2]
      const nn = Math.hypot(x, y, z)
      return [x / nn, y / nn, z / nn]
    }
    const ra = rayAt(ia)
    const rb = rayAt(ib)
    const rc = rayAt(ic)
    const edgeScale = (
      r1: [number, number, number],
      r2: [number, number, number],
      u1: number,
      v1: number,
      u2: number,
      v2: number
    ): number => {
      const ang = Math.acos(
        Math.min(1, Math.abs(r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2]))
      )
      const px = Math.hypot((u1 - u2) * frameWidth, (v1 - v2) * frameHeight)
      return ang > 1e-9 ? px / ang : 0
    }
    // max over two edges so one uv-degenerate edge can't zero the scale (which
    // would report 0 px error to the operator as false reassurance)
    const pxPerRadian = Math.max(
      edgeScale(ra, rb, ua, va, ub, vb),
      edgeScale(ra, rc, ua, va, uc, vc)
    )

    return { ray: [rx / n, ry / n, rz / n], pxPerRadian }
  }
  return null
}

/**
 * Inverse of uvToRay: map a world-ray DIRECTION back to a raw-frame pixel by
 * finding the mesh triangle whose ray cone contains it and interpolating uv.
 * Used to seed a calibration proposal from tracklet directions (which are
 * pan/tilt in the mesh convention) into the mark's raw-pixel space. Returns
 * null when the direction falls outside mesh coverage. dir need not be unit.
 *
 * Barycentric weights w satisfy [r0 r1 r2]·w ∝ dir (rays as the cone basis);
 * a direction is inside the triangle's cone iff all weights are >= 0.
 */
export function rayToUv(
  mesh: MeshGeometry,
  dir: [number, number, number],
  frameWidth: number,
  frameHeight: number
): [number, number] | null {
  const { verts, indices, triStart, triProjection, textureToWorld } = mesh
  const nTri = triProjection.length
  const worldRay = (i: number, tw: number[][]): [number, number, number] => {
    const g0 = verts[i]
    const g1 = verts[i + 1]
    return [
      tw[0][0] * g0 + tw[0][1] * g1 + tw[0][2],
      tw[1][0] * g0 + tw[1][1] * g1 + tw[1][2],
      tw[2][0] * g0 + tw[2][1] * g1 + tw[2][2],
    ]
  }
  const eps = -1e-6
  for (let t = 0; t < nTri; t++) {
    const s = triStart[t]
    const ia = indices[s] * 5
    const ib = indices[s + 1] * 5
    const ic = indices[s + 2] * 5
    const tw = textureToWorld[triProjection[t]]
    const r0 = worldRay(ia, tw)
    const r1 = worldRay(ib, tw)
    const r2 = worldRay(ic, tw)
    // solve [r0 r1 r2] w = dir via Cramer's rule
    const det =
      r0[0] * (r1[1] * r2[2] - r1[2] * r2[1]) -
      r1[0] * (r0[1] * r2[2] - r0[2] * r2[1]) +
      r2[0] * (r0[1] * r1[2] - r0[2] * r1[1])
    if (Math.abs(det) < 1e-12) continue
    const w0 =
      (dir[0] * (r1[1] * r2[2] - r1[2] * r2[1]) -
        r1[0] * (dir[1] * r2[2] - dir[2] * r2[1]) +
        r2[0] * (dir[1] * r1[2] - dir[2] * r1[1])) /
      det
    const w1 =
      (r0[0] * (dir[1] * r2[2] - dir[2] * r2[1]) -
        dir[0] * (r0[1] * r2[2] - r0[2] * r2[1]) +
        r2[0] * (r0[1] * dir[2] - r0[2] * dir[1])) /
      det
    const w2 =
      (r0[0] * (r1[1] * dir[2] - r1[2] * dir[1]) -
        r1[0] * (r0[1] * dir[2] - r0[2] * dir[1]) +
        dir[0] * (r0[1] * r1[2] - r0[2] * r1[1])) /
      det
    // inside the cone (same side of origin: all weights share the sign of the
    // component of dir along the cone) — reject the antipodal solution
    if (w0 < eps || w1 < eps || w2 < eps) continue
    const sum = w0 + w1 + w2
    if (!(sum > 0)) continue
    const u =
      (w0 * verts[ia + 2] + w1 * verts[ib + 2] + w2 * verts[ic + 2]) / sum
    const v =
      (w0 * verts[ia + 3] + w1 * verts[ib + 3] + w2 * verts[ic + 3]) / sum
    return [u * frameWidth, v * frameHeight]
  }
  return null
}

/** World-ray direction for a (pan, tilt) in the dewarp convention (degrees).
 *  Twin of generate_mesh.py ray(): (cos t sin p, −sin t, cos t cos p). */
export function panTiltToRay(
  panDeg: number,
  tiltDeg: number
): [number, number, number] {
  const p = (panDeg * Math.PI) / 180
  const t = (tiltDeg * Math.PI) / 180
  const ct = Math.cos(t)
  return [ct * Math.sin(p), -Math.sin(t), ct * Math.cos(p)]
}

export interface PitchSolve {
  solverVersion: number
  /** Row-major 3x3: (X, Y, 1) pitch metres → world-ray direction (up to scale). */
  homography: number[][]
  /** Per-mark angular reprojection error, radians. */
  perMarkErrorRad: Record<string, number>
  /** Per-mark error in raw-frame pixels (local mesh px-per-radian scale) —
   *  the operator-facing currency; the headline below is the max of these. */
  perMarkErrorPx: Record<string, number>
  /** Max per-mark error expressed in raw-frame pixels via the local mesh scale. */
  reprojectionErrorPx: number
  /** Corner rays as rayn = (x/z, y/z), null when a corner has z <= 0. */
  fieldPolygonRayn: ([number, number] | null)[]
}

export class MarkUnprojectableError extends Error {
  constructor(public markName: string) {
    super(`mark ${markName} is outside mesh coverage`)
  }
}

/**
 * Normalized DLT homography from pitch-metric plane points to world-ray
 * directions, plus reprojection stats. Rays are treated as points on the
 * sphere via the cross-product DLT constraint (no z > 0 requirement).
 */
export function solvePitchHomography(
  mesh: MeshGeometry,
  marks: PitchMark[],
  dims: PitchDims,
  frameWidth: number,
  frameHeight: number
): PitchSolve {
  const rays: [number, number, number][] = []
  const world: [number, number][] = []
  const scales: number[] = []
  for (const m of marks) {
    const hit = uvToRay(mesh, m.uv[0], m.uv[1], frameWidth, frameHeight)
    if (!hit) throw new MarkUnprojectableError(m.name)
    rays.push(hit.ray)
    world.push(markWorldPoint(m.name, dims))
    scales.push(hit.pxPerRadian)
  }
  if (rays.length < 4) {
    throw new Error('need at least 4 marks to solve')
  }

  // Hartley normalization of the world points
  const cx = world.reduce((s, p) => s + p[0], 0) / world.length
  const cy = world.reduce((s, p) => s + p[1], 0) / world.length
  const meanDist =
    world.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) /
    world.length
  const s = meanDist > 0 ? Math.SQRT2 / meanDist : 1
  const norm = (p: [number, number]): [number, number] => [
    (p[0] - cx) * s,
    (p[1] - cy) * s,
  ]

  // DLT: for each correspondence, ray × H·(X, Y, 1) = 0 → 3 rows (rank 2)
  const A: number[][] = []
  for (let i = 0; i < rays.length; i++) {
    const [X, Y] = norm(world[i])
    const [rx, ry, rz] = rays[i]
    const p = [X, Y, 1]
    // rows of [r]_x ⊗ p
    A.push([
      0,
      0,
      0,
      -rz * p[0],
      -rz * p[1],
      -rz * p[2],
      ry * p[0],
      ry * p[1],
      ry * p[2],
    ])
    A.push([
      rz * p[0],
      rz * p[1],
      rz * p[2],
      0,
      0,
      0,
      -rx * p[0],
      -rx * p[1],
      -rx * p[2],
    ])
    A.push([
      -ry * p[0],
      -ry * p[1],
      -ry * p[2],
      rx * p[0],
      rx * p[1],
      rx * p[2],
      0,
      0,
      0,
    ])
  }
  const h = smallestSingularVector(A)
  // denormalize: H = Hn · T where T is the normalization transform
  const Hn = [h.slice(0, 3), h.slice(3, 6), h.slice(6, 9)]
  const T = [
    [s, 0, -s * cx],
    [0, s, -s * cy],
    [0, 0, 1],
  ]
  const H = mat3Mul(Hn, T)

  const perMarkErrorRad: Record<string, number> = {}
  const perMarkErrorPx: Record<string, number> = {}
  let maxPx = 0
  const cornerRaynByName = new Map<string, [number, number] | null>()
  marks.forEach((m, i) => {
    const [X, Y] = world[i]
    const px = H[0][0] * X + H[0][1] * Y + H[0][2]
    const py = H[1][0] * X + H[1][1] * Y + H[1][2]
    const pz = H[2][0] * X + H[2][1] * Y + H[2][2]
    const n = Math.hypot(px, py, pz)
    const [rx, ry, rz] = rays[i]
    const dot = Math.abs((px * rx + py * ry + pz * rz) / (n || 1))
    const err = Math.acos(Math.min(1, dot))
    perMarkErrorRad[m.name] = err
    perMarkErrorPx[m.name] = err * scales[i]
    maxPx = Math.max(maxPx, err * scales[i])
    if (m.name.startsWith('corner')) {
      cornerRaynByName.set(m.name, rz > 1e-9 ? [rx / rz, ry / rz] : null)
    }
  })

  return {
    solverVersion: SOLVER_VERSION,
    homography: H,
    perMarkErrorRad,
    perMarkErrorPx,
    reprojectionErrorPx: maxPx,
    // CANONICAL order (nw, ne, se, sw — a simple quad), independent of the
    // order the client submitted marks in: a submission-ordered polygon can be
    // a self-intersecting bowtie, and the artifact doesn't label vertices.
    fieldPolygonRayn: CORNER_MARK_NAMES.map(
      (name) => cornerRaynByName.get(name) ?? null
    ),
  }
}

/** Smallest-singular-vector of A (9 columns): eigenvector of AᵀA's smallest
 *  eigenvalue via cyclic Jacobi rotations (deterministic for 9x9 symmetric). */
function smallestSingularVector(A: number[][]): number[] {
  const n = 9
  const M: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (const row of A) {
    for (let i = 0; i < n; i++) {
      if (row[i] === 0) continue
      for (let j = 0; j < n; j++) M[i][j] += row[i] * row[j]
    }
  }
  const V: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  )
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) off += M[p][q] * M[p][q]
    }
    if (off < 1e-24) break
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(M[p][q]) < 1e-30) continue
        const theta = (M[q][q] - M[p][p]) / (2 * M[p][q])
        const t =
          Math.sign(theta || 1) /
          (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const mkp = M[k][p]
          const mkq = M[k][q]
          M[k][p] = c * mkp - s * mkq
          M[k][q] = s * mkp + c * mkq
        }
        for (let k = 0; k < n; k++) {
          const mpk = M[p][k]
          const mqk = M[q][k]
          M[p][k] = c * mpk - s * mqk
          M[q][k] = s * mpk + c * mqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p]
          const vkq = V[k][q]
          V[k][p] = c * vkp - s * vkq
          V[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  let best = 0
  for (let i = 1; i < n; i++) {
    if (M[i][i] < M[best][best]) best = i
  }
  return V.map((row) => row[best])
}
