import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

import {
  hasMidline,
  inFocusHalf,
  markWorldPoint,
  validateMarks,
  type PitchMark,
} from '../pitch-marks'
import {
  MarkUnprojectableError,
  parseMeshGeometry,
  solvePitchHomography,
  uvToRay,
  type MeshGeometry,
} from '../pitch-solver'

const FW = 3840
const FH = 2160

// ── real-mesh fixture (the shipped Nazwa/kuwait mesh in public/) ─────────────
const MESH_DIR = path.join(process.cwd(), 'public', 'vp-mesh-kuwait')

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(buf.byteLength)
  new Uint8Array(out).set(buf)
  return out
}

function loadKuwaitMesh(): MeshGeometry {
  const scene = JSON.parse(
    readFileSync(path.join(MESH_DIR, 'scene.json'), 'utf8')
  )
  return parseMeshGeometry(
    scene,
    toArrayBuffer(readFileSync(path.join(MESH_DIR, 'vertices.bin'))),
    toArrayBuffer(readFileSync(path.join(MESH_DIR, 'indices.bin')))
  )
}

// ── synthetic single-projection mesh with a known uv↔ray relation ────────────
// Build a grid whose world rays come from a simple overhead pinhole looking at
// a ground plane: ray direction for uv is known in closed form, so a
// homography solved from marks must reproject exactly.
function syntheticMesh(): MeshGeometry {
  // world rays: camera at height 10 over origin, looking straight down -y;
  // ground point (X, Z) → direction (X, -10, Z) (pitch plane y = -10 · scale).
  // Choose textureToWorld = identity by inverting the player transform: with
  // R_scene = MOUNT_S⁻¹ the product transpose(R_scene · MOUNT_S) = I, so a
  // vertex's world ray is literally (f0, f1, 1). We emulate that by supplying
  // rotation R such that R · MOUNT_S = I.
  const MOUNT_S = [
    [0, -0.218849, 0.975731],
    [-1.000013, 0, 0],
    [0, -0.975762, -0.218884],
  ]
  // invert MOUNT_S numerically (3x3)
  const m = MOUNT_S
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

  // 11x11 grid over uv [0.1, 0.9]²; (f0, f1) = a known linear map of uv so the
  // uv→ray relation is a homography by construction.
  const N = 11
  const verts: number[] = []
  const indices: number[] = []
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const u = 0.1 + (0.8 * c) / (N - 1)
      const v = 0.1 + (0.8 * r) / (N - 1)
      const f0 = (u - 0.5) * 2 // in [-0.8, 0.8]
      const f1 = (v - 0.5) * 1.2
      verts.push(f0, f1, u, v, 1)
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

describe('parseMeshGeometry: ragged blocks + world composition (independent GT)', () => {
  // Two projections with DIFFERENT world transforms and a RAGGED first block
  // (n_indices % 3 !== 0, the converted-Spiideo mesh class). Ground truth is
  // written literally — not derived from the functions under test — so a
  // dropped transpose, swapped multiplication order, contiguous-triple
  // assumption, or corrupted triProjection all fail here.
  const MOUNT_S = [
    [0, -0.218849, 0.975731],
    [-1.000013, 0, 0],
    [0, -0.975762, -0.218884],
  ]
  const inv3 = (m: number[][]): number[][] => {
    const det =
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    return [
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
  }
  const mul3 = (a: number[][], b: number[][]): number[][] =>
    a.map((row, i) =>
      [0, 1, 2].map(
        (j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]
      )
    )
  const t3 = (a: number[][]): number[][] =>
    [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[j][i]))

  // desired textureToWorld per projection (LITERAL ground truth)
  const twA = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]
  const twB = [
    [0, 0, 1],
    [0, 1, 0],
    [-1, 0, 0],
  ] // 90° about y: (x,y,z) → (z,y,−x)
  // scene rotation satisfying transpose(R·S) = tw  ⇒  R = twᵀ·S⁻¹
  const rotFor = (tw: number[][]) => mul3(t3(tw), inv3(MOUNT_S)).flat()

  // one quad (2 triangles) per projection; vertex f = simple function of uv
  const quad = (u0: number, v0: number) => {
    const verts: number[] = []
    for (const [du, dv] of [
      [0, 0],
      [0.2, 0],
      [0, 0.2],
      [0.2, 0.2],
    ]) {
      const u = u0 + du
      const v = v0 + dv
      verts.push(u, v, u, v, 1) // f0 = u, f1 = v
    }
    return verts
  }
  const verts = new Float32Array([...quad(0.1, 0.1), ...quad(0.6, 0.6)])
  // block A: 6 real indices + 2 RAGGED junk trailing entries (declared in
  // n_indices); block B follows at absolute offset 8
  const indices = new Uint32Array([0, 2, 1, 1, 2, 3, 0, 0, 4, 6, 5, 5, 6, 7])
  const scene = {
    projections: [
      { n_vertices: 4, n_indices: 8, camera: { rotation: rotFor(twA) } },
      { n_vertices: 4, n_indices: 6, camera: { rotation: rotFor(twB) } },
    ],
  }
  const mesh = parseMeshGeometry(scene, verts.buffer, indices.buffer)

  it('drops the ragged remainder and keeps block boundaries', () => {
    expect(Array.from(mesh.triProjection)).toEqual([0, 0, 1, 1])
    expect(Array.from(mesh.triStart)).toEqual([0, 3, 8, 11])
  })

  it('maps uv through each projection to the LITERAL expected world ray', () => {
    const a = uvToRay(mesh, 0.2 * FW, 0.2 * FH, FW, FH)
    expect(a).not.toBeNull()
    // twA = I: ray ∝ (0.2, 0.2, 1)
    const na = Math.hypot(0.2, 0.2, 1)
    expect(a!.ray[0]).toBeCloseTo(0.2 / na, 5)
    expect(a!.ray[1]).toBeCloseTo(0.2 / na, 5)
    expect(a!.ray[2]).toBeCloseTo(1 / na, 5)

    const b = uvToRay(mesh, 0.7 * FW, 0.7 * FH, FW, FH)
    expect(b).not.toBeNull()
    // twB: (0.7, 0.7, 1) → (1, 0.7, −0.7)
    const nb = Math.hypot(1, 0.7, 0.7)
    expect(b!.ray[0]).toBeCloseTo(1 / nb, 5)
    expect(b!.ray[1]).toBeCloseTo(0.7 / nb, 5)
    expect(b!.ray[2]).toBeCloseTo(-0.7 / nb, 5)
  })
})

describe('validateMarks', () => {
  const corners = [
    { name: 'corner_nw', uv: [100, 200] },
    { name: 'corner_ne', uv: [3000, 210] },
    { name: 'corner_se', uv: [3100, 1800] },
    { name: 'corner_sw', uv: [120, 1700] },
  ]

  it('accepts the 4 corners', () => {
    const res = validateMarks(corners, FW, FH)
    expect('marks' in res && res.marks).toHaveLength(4)
  })

  it('accepts corners + full midline', () => {
    const res = validateMarks(
      [
        ...corners,
        { name: 'midline_n', uv: [1500, 205] },
        { name: 'midline_s', uv: [1550, 1750] },
      ],
      FW,
      FH
    )
    expect('marks' in res).toBe(true)
  })

  it.each([
    [[], 'missing_corners'],
    [corners.slice(0, 3), 'missing_corners'],
    [
      [...corners, { name: 'midline_n', uv: [1500, 205] }],
      'incomplete_midline',
    ],
    [[...corners, corners[0]], 'duplicate_name'],
    [
      [...corners.slice(1), { name: 'centre_spot', uv: [1, 1] }],
      'unknown_name',
    ],
    [
      [...corners.slice(1), { name: 'corner_nw', uv: [-5, 10] }],
      'out_of_frame',
    ],
    [[...corners.slice(1), { name: 'corner_nw', uv: [NaN, 10] }], 'bad_mark'],
    ['nope', 'not_array'],
  ] as const)('rejects invalid payloads (%#)', (payload, code) => {
    const res = validateMarks(payload as unknown, FW, FH)
    expect('error' in res && res.error.code).toBe(code)
  })

  it('midline helpers', () => {
    const dims = { lengthM: 60, widthM: 40 }
    expect(markWorldPoint('corner_se', dims)).toEqual([60, 40])
    expect(markWorldPoint('midline_s', dims)).toEqual([30, 40])
    expect(inFocusHalf(10, 'left_half', dims)).toBe(true)
    expect(inFocusHalf(40, 'left_half', dims)).toBe(false)
    expect(inFocusHalf(40, 'right_half', dims)).toBe(true)
    expect(inFocusHalf(40, 'full', dims)).toBe(true)
    expect(
      hasMidline([
        { name: 'midline_n', uv: [0, 0] },
        { name: 'midline_s', uv: [0, 0] },
      ] as PitchMark[])
    ).toBe(true)
    expect(hasMidline([{ name: 'midline_n', uv: [0, 0] }] as PitchMark[])).toBe(
      false
    )
  })
})

// public/vp-mesh-kuwait is gitignored (generated locally by generate_mesh.py);
// skip the real-mesh suite when absent — the synthetic suites below carry the
// mutant-killing coverage regardless.
const HAS_KUWAIT_MESH = existsSync(path.join(MESH_DIR, 'scene.json'))

describe.skipIf(!HAS_KUWAIT_MESH)('uvToRay on the real kuwait mesh', () => {
  const mesh = HAS_KUWAIT_MESH
    ? loadKuwaitMesh()
    : (undefined as unknown as MeshGeometry)

  it('reproduces referenced vertices own rays (self-consistency)', () => {
    // sample referenced vertices spread across the index buffer
    const step = Math.max(1, Math.floor(mesh.triProjection.length / 50))
    let checked = 0
    for (let t = 0; t < mesh.triProjection.length && checked < 40; t += step) {
      const vi = mesh.indices[mesh.triStart[Math.floor(t)]] * 5
      const u = mesh.verts[vi + 2]
      const v = mesh.verts[vi + 3]
      const pi = mesh.triProjection[Math.floor(t)]
      const tw = mesh.textureToWorld[pi]
      const f0 = mesh.verts[vi]
      const f1 = mesh.verts[vi + 1]
      const ex = tw[0][0] * f0 + tw[0][1] * f1 + tw[0][2]
      const ey = tw[1][0] * f0 + tw[1][1] * f1 + tw[1][2]
      const ez = tw[2][0] * f0 + tw[2][1] * f1 + tw[2][2]
      const en = Math.hypot(ex, ey, ez)

      const hit = uvToRay(mesh, u * FW, v * FH, FW, FH)
      if (!hit) continue // vertex uv can sit on the coverage boundary
      const dot = (hit.ray[0] * ex + hit.ray[1] * ey + hit.ray[2] * ez) / en
      // world rays are continuous across projections, so even when the point
      // resolves in an overlapping strip the direction must agree
      expect(Math.acos(Math.min(1, Math.abs(dot)))).toBeLessThan(0.002)
      expect(hit.pxPerRadian).toBeGreaterThan(0)
      checked++
    }
    expect(checked).toBeGreaterThan(20)
  })

  it('returns null outside mesh coverage (synthetic bounds)', () => {
    // the kuwait mesh covers the whole frame (θ≤100° + ±2% overshoot), so the
    // out-of-coverage contract is asserted on the synthetic mesh, whose uv
    // domain is [0.1, 0.9]² by construction
    const synth = syntheticMesh()
    expect(uvToRay(synth, 0.05 * FW, 0.5 * FH, FW, FH)).toBeNull()
    expect(uvToRay(synth, 0.5 * FW, 0.5 * FH, FW, FH)).not.toBeNull()
  })
})

describe('solvePitchHomography', () => {
  const mesh = syntheticMesh()
  const dims = { lengthM: 60, widthM: 40 }

  // ground-truth plane→uv correspondence for the synthetic mesh: pick a known
  // homography G mapping pitch (X, Y) to (f0, f1) and invert the vertex maps
  // f0 = (u - 0.5) * 2, f1 = (v - 0.5) * 1.2 to place the marks in uv px.
  const G = [
    [0.012, 0.003, -0.45],
    [0.001, 0.018, -0.35],
    [0.0002, 0.0001, 1],
  ]
  function markAt(name: PitchMark['name']): PitchMark {
    const [X, Y] = markWorldPoint(name, dims)
    const w = G[2][0] * X + G[2][1] * Y + G[2][2]
    const f0 = (G[0][0] * X + G[0][1] * Y + G[0][2]) / w
    const f1 = (G[1][0] * X + G[1][1] * Y + G[1][2]) / w
    const u = f0 / 2 + 0.5
    const v = f1 / 1.2 + 0.5
    return { name, uv: [u * FW, v * FH] }
  }
  const marks: PitchMark[] = [
    markAt('corner_nw'),
    markAt('corner_ne'),
    markAt('corner_se'),
    markAt('corner_sw'),
    markAt('midline_n'),
    markAt('midline_s'),
  ]

  it('recovers an exact-fit homography from clean marks', () => {
    const solve = solvePitchHomography(mesh, marks, dims, FW, FH)
    expect(solve.solverVersion).toBeGreaterThan(0)
    for (const err of Object.values(solve.perMarkErrorRad)) {
      expect(err).toBeLessThan(1e-5)
    }
    expect(solve.reprojectionErrorPx).toBeLessThan(0.5)
    expect(solve.fieldPolygonRayn).toHaveLength(4)
  })

  it('emits fieldPolygonRayn in canonical nw/ne/se/sw order regardless of submission order', () => {
    const shuffled = [
      marks[2],
      marks[0],
      marks[3],
      marks[1],
      marks[4],
      marks[5],
    ]
    const a = solvePitchHomography(mesh, marks, dims, FW, FH)
    const b = solvePitchHomography(mesh, shuffled, dims, FW, FH)
    expect(b.fieldPolygonRayn).toEqual(a.fieldPolygonRayn)
    // canonical order = nw, ne, se, sw: nw is the origin so its rayn must
    // equal the unprojected corner_nw ray, not whatever came first
    const nwHit = uvToRay(mesh, marks[0].uv[0], marks[0].uv[1], FW, FH)!
    expect(a.fieldPolygonRayn[0]![0]).toBeCloseTo(
      nwHit.ray[0] / nwHit.ray[2],
      4
    )
  })

  it('reports a real error when a mark is displaced', () => {
    const bad = marks.map((m) =>
      m.name === 'corner_se'
        ? { ...m, uv: [m.uv[0] + 60, m.uv[1] + 40] as [number, number] }
        : m
    )
    const solve = solvePitchHomography(mesh, bad, dims, FW, FH)
    expect(solve.reprojectionErrorPx).toBeGreaterThan(5)
  })

  it('throws MarkUnprojectableError outside coverage', () => {
    const off = marks.map((m, i) =>
      i === 0 ? { ...m, uv: [1, 1] as [number, number] } : m
    )
    expect(() => solvePitchHomography(mesh, off, dims, FW, FH)).toThrow(
      MarkUnprojectableError
    )
  })
})
