import { describe, expect, it } from 'vitest'

import { panWindowForFocus } from '../pitch-focus'
import type { PitchMark } from '../pitch-marks'
import { parseMeshGeometry, uvToRay, type MeshGeometry } from '../pitch-solver'

const FW = 3840
const FH = 2160
const DEG = Math.PI / 180

// Synthetic single-projection mesh with a KNOWN uv↔ray relation (same recipe
// as pitch-calibration.test.ts): rotation = MOUNT_S⁻¹ makes textureToWorld
// the identity, so a vertex's world ray is literally (f0, f1, 1) with
// f0 = (u−0.5)·2, f1 = (v−0.5)·1.2 over uv ∈ [0.1, 0.9]². Hence for a mark
// at normalized u: pan = atan2(f0, 1) = atan(2(u−0.5)) — closed form.
function syntheticMesh(): MeshGeometry {
  const m = [
    [0, -0.218849, 0.975731],
    [-1.000013, 0, 0],
    [0, -0.975762, -0.218884],
  ]
  const det =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  const inv = [
    [
      (m[1][1] * m[2][2] - m[1][2] * m[2][1]) / det,
      (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / det,
      (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / det,
    ],
    [
      (m[1][2] * m[2][0] - m[1][0] * m[2][2]) / det,
      (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / det,
      (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / det,
    ],
    [
      (m[1][0] * m[2][1] - m[1][1] * m[2][0]) / det,
      (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / det,
      (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / det,
    ],
  ]
  const N = 11
  const verts: number[] = []
  const indices: number[] = []
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const u = 0.1 + (0.8 * c) / (N - 1)
      const v = 0.1 + (0.8 * r) / (N - 1)
      verts.push((u - 0.5) * 2, (v - 0.5) * 1.2, u, v, 1)
    }
  }
  for (let r = 0; r < N - 1; r++) {
    for (let c = 0; c < N - 1; c++) {
      const a = r * N + c
      indices.push(a, a + N, a + 1, a + 1, a + N, a + N + 1)
    }
  }
  const scene = {
    projections: [
      {
        n_vertices: N * N,
        n_indices: indices.length,
        camera: { rotation: inv.flat() },
      },
    ],
  }
  return parseMeshGeometry(
    scene,
    new Float32Array(verts).buffer,
    new Uint32Array(indices).buffer
  )
}

const at = (name: PitchMark['name'], u: number, v: number): PitchMark => ({
  name,
  uv: [u * FW, v * FH],
})

// Pitch laid out left-to-right in the frame: nw/sw on the left, ne/se on the
// right, midline centred. All well inside the mesh's uv [0.1, 0.9] coverage.
const MARKS: PitchMark[] = [
  at('corner_nw', 0.15, 0.3),
  at('corner_sw', 0.15, 0.7),
  at('corner_ne', 0.85, 0.3),
  at('corner_se', 0.85, 0.7),
  at('midline_n', 0.5, 0.3),
  at('midline_s', 0.5, 0.7),
]

const panAt = (u: number) => Math.atan(2 * (u - 0.5))
const MARGIN = 2 * DEG

describe('panWindowForFocus', () => {
  const mesh = syntheticMesh()

  it('sanity: the synthetic uv→ray closed form holds', () => {
    const r = uvToRay(mesh, 0.15 * FW, 0.3 * FH, FW, FH)!
    expect(Math.atan2(r.ray[0], r.ray[2])).toBeCloseTo(panAt(0.15), 6)
  })

  it('left_half spans left corners → midline (+margin)', () => {
    const w = panWindowForFocus(mesh, MARKS, FW, FH, 'left_half')!
    expect(w.minRad).toBeCloseTo(panAt(0.15) - MARGIN, 6)
    expect(w.maxRad).toBeCloseTo(panAt(0.5) + MARGIN, 6)
  })

  it('right_half spans midline → right corners (+margin)', () => {
    const w = panWindowForFocus(mesh, MARKS, FW, FH, 'right_half')!
    expect(w.minRad).toBeCloseTo(panAt(0.5) - MARGIN, 6)
    expect(w.maxRad).toBeCloseTo(panAt(0.85) + MARGIN, 6)
  })

  it('the two halves share the midline boundary', () => {
    const l = panWindowForFocus(mesh, MARKS, FW, FH, 'left_half')!
    const r = panWindowForFocus(mesh, MARKS, FW, FH, 'right_half')!
    expect(l.maxRad - MARGIN).toBeCloseTo(r.minRad + MARGIN, 6)
  })

  it('focus=full returns null', () => {
    expect(panWindowForFocus(mesh, MARKS, FW, FH, 'full')).toBeNull()
  })

  it('missing midline → null', () => {
    const noMid = MARKS.filter((m) => !m.name.startsWith('midline'))
    expect(panWindowForFocus(mesh, noMid, FW, FH, 'left_half')).toBeNull()
  })

  it('missing half corner → null', () => {
    const noNw = MARKS.filter((m) => m.name !== 'corner_nw')
    expect(panWindowForFocus(mesh, noNw, FW, FH, 'left_half')).toBeNull()
    // the other half is unaffected
    expect(panWindowForFocus(mesh, noNw, FW, FH, 'right_half')).not.toBeNull()
  })

  it('a mark off mesh coverage → null (uvToRay miss)', () => {
    const off = MARKS.map((m) =>
      m.name === 'corner_nw' ? at('corner_nw', 0.01, 0.01) : m
    )
    expect(panWindowForFocus(mesh, off, FW, FH, 'left_half')).toBeNull()
  })

  it('degenerate window (all marks at one point) → null', () => {
    const collapsed = MARKS.map(
      (m) => ({ ...m, uv: [0.5 * FW, 0.5 * FH] }) as PitchMark
    )
    expect(panWindowForFocus(mesh, collapsed, FW, FH, 'left_half')).toBeNull()
  })
})
