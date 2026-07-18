import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

import {
  convexHull,
  minAreaRect,
  proposePitchMarksFromTracklets,
  type Pt,
} from '../pitch-assist'
import { CORNER_MARK_NAMES } from '../pitch-marks'
import {
  panTiltToRay,
  parseMeshGeometry,
  rayToUv,
  uvToRay,
  type MeshGeometry,
} from '../pitch-solver'

const FW = 3840
const FH = 2160
const MESH_DIR = path.join(process.cwd(), 'public', 'vp-mesh-kuwait')
const HAS_MESH = existsSync(path.join(MESH_DIR, 'scene.json'))

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(buf.byteLength)
  new Uint8Array(out).set(buf)
  return out
}
function loadMesh(): MeshGeometry {
  const scene = JSON.parse(
    readFileSync(path.join(MESH_DIR, 'scene.json'), 'utf8')
  )
  return parseMeshGeometry(
    scene,
    toArrayBuffer(readFileSync(path.join(MESH_DIR, 'vertices.bin'))),
    toArrayBuffer(readFileSync(path.join(MESH_DIR, 'indices.bin')))
  )
}

describe('convexHull + minAreaRect geometry', () => {
  it('bounds a rotated filled rectangle with ~minimal area', () => {
    // a 40x20 rectangle rotated 30°, densely filled + a few interior fliers
    const ang = (30 * Math.PI) / 180
    const cos = Math.cos(ang)
    const sin = Math.sin(ang)
    const pts: Pt[] = []
    for (let a = 0; a <= 40; a += 1) {
      for (let b = 0; b <= 20; b += 1) {
        pts.push({ x: a * cos - b * sin + 5, y: a * sin + b * cos - 3 })
      }
    }
    const hull = convexHull(pts)
    const rect = minAreaRect(hull)
    expect(rect).toHaveLength(4)
    // side lengths should be ~40 and ~20 (order may swap)
    const sides = [0, 1, 2, 3].map((i) =>
      Math.hypot(
        rect[(i + 1) % 4].x - rect[i].x,
        rect[(i + 1) % 4].y - rect[i].y
      )
    )
    const sorted = [...sides].sort((a, b) => a - b)
    expect(sorted[0]).toBeCloseTo(20, 0)
    expect(sorted[3]).toBeCloseTo(40, 0)
    // enclosing area within 5% of the true 40*20 = 800
    const area = sorted[0] * sorted[3]
    expect(area).toBeGreaterThan(800 * 0.98)
    expect(area).toBeLessThan(800 * 1.05)
  })
})

describe('proposePitchMarksFromTracklets', () => {
  it('returns null below the minimum sample count', () => {
    const sparse = {
      objects: [{ pan: [0, 1, 2], tilt: [-20, -21, -22] }],
    }
    expect(
      proposePitchMarksFromTracklets(sparse, {} as MeshGeometry, FW, FH)
    ).toBeNull()
  })

  it('returns null when rosterN says the population is a stadium bowl', () => {
    // HCT: crowd/track/staff in the occupancy → rect fits the bowl, not the
    // pitch (measured 320-1535px corner error vs admin marks). rosterN 56.
    const pan: number[] = []
    const tilt: number[] = []
    for (let i = 0; i < 500; i++) {
      pan.push(-50 + (i % 100))
      tilt.push(-10 - (i % 25))
    }
    const bowl = { objects: [{ pan, tilt }], rosterN: 56 }
    expect(
      proposePitchMarksFromTracklets(bowl, {} as MeshGeometry, FW, FH)
    ).toBeNull()
  })

  it.skipIf(!HAS_MESH)(
    'players-only rosterN and absent rosterN both keep the proposal',
    () => {
      const mesh = loadMesh()
      const pan: number[] = []
      const tilt: number[] = []
      for (let p = -55; p <= 55; p += 2) {
        for (let ti = -12; ti >= -34; ti -= 2) {
          pan.push(p)
          tilt.push(ti)
        }
      }
      for (const rosterN of [15, undefined]) {
        const prop = proposePitchMarksFromTracklets(
          { objects: [{ pan, tilt }], rosterN },
          mesh,
          FW,
          FH
        )
        expect(prop).not.toBeNull()
        expect(prop!.marks).toHaveLength(4)
      }
    }
  )

  it.skipIf(!HAS_MESH)(
    'proposes 4 on-mesh corners bounding a pan/tilt occupancy cloud',
    () => {
      const mesh = loadMesh()
      // synth occupancy: a grid of pan/tilt inside the Nazwa window (pan ±60,
      // tilt −10..−35), which all project onto the mesh
      const pan: number[] = []
      const tilt: number[] = []
      for (let p = -55; p <= 55; p += 2) {
        for (let ti = -12; ti >= -34; ti -= 2) {
          pan.push(p)
          tilt.push(ti)
        }
      }
      const tracklets = { objects: [{ pan, tilt }] }
      const prop = proposePitchMarksFromTracklets(tracklets, mesh, FW, FH)
      expect(prop).not.toBeNull()
      expect(prop!.marks).toHaveLength(4)
      expect(prop!.cornersOnMesh).toBe(4)
      expect(new Set(prop!.marks.map((m) => m.name))).toEqual(
        new Set(CORNER_MARK_NAMES)
      )
      // every proposed uv must be inside the frame and land on the mesh
      for (const m of prop!.marks) {
        expect(m.uv[0]).toBeGreaterThanOrEqual(0)
        expect(m.uv[0]).toBeLessThanOrEqual(FW)
        expect(uvToRay(mesh, m.uv[0], m.uv[1], FW, FH)).not.toBeNull()
      }
      // the proposed corners must span most of the pan range (a real bounding
      // box, not a collapsed point): reproject two corners and check pan spread
      const rays = prop!.marks.map(
        (m) => uvToRay(mesh, m.uv[0], m.uv[1], FW, FH)!.ray
      )
      const pans = rays.map((r) => (Math.atan2(r[0], r[2]) * 180) / Math.PI)
      expect(Math.max(...pans) - Math.min(...pans)).toBeGreaterThan(60)
    }
  )

  it.skipIf(!HAS_MESH)(
    'rayToUv is the exact inverse of uvToRay on coverage',
    () => {
      const mesh = loadMesh()
      let checked = 0
      for (let x = 500; x < FW; x += 700) {
        for (let y = 500; y < FH; y += 500) {
          const r = uvToRay(mesh, x, y, FW, FH)
          if (!r) continue
          const uv = rayToUv(mesh, r.ray, FW, FH)
          if (!uv) continue
          expect(Math.hypot(uv[0] - x, uv[1] - y)).toBeLessThan(2)
          checked++
        }
      }
      expect(checked).toBeGreaterThan(10)
    }
  )

  it('panTiltToRay matches the mesh convention (pan 0 tilt 0 → forward +z)', () => {
    const [x, y, z] = panTiltToRay(0, 0)
    expect(x).toBeCloseTo(0, 6)
    expect(y).toBeCloseTo(0, 6)
    expect(z).toBeCloseTo(1, 6)
    // +pan swings toward +x, +tilt dips toward −y (down)
    expect(panTiltToRay(30, 0)[0]).toBeGreaterThan(0)
    expect(panTiltToRay(0, 30)[1]).toBeLessThan(0)
  })
})
