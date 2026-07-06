'use client'

/**
 * VirtualPanoramaPlayer — a faithful reconstruction of Spiideo's Perform
 * de-warp. It textures the raw 4K VirtualPanorama video (two side-by-side
 * distorted strips) onto Spiideo's own calibration mesh and views it with a
 * perspective camera at the mesh origin, giving a continuous, pannable,
 * de-warped panorama of the whole pitch.
 *
 * Mesh format (reverse-engineered, see docs): scene.json + vertices.bin +
 * indices.bin.
 *   - vertices.bin: float32 × 5 per vertex = [x, y, z, u, v] (position + UV).
 *   - indices.bin: uint32, global (both projections index one vertex array).
 *   - scene.json: min/max pan+tilt (radians) + zoom range; the two projections
 *     map to the left/right halves (u 0–0.5 / 0.5–1) of the video texture.
 * Camera looks toward +Z (the surface sits at z 0→1); pan = yaw, tilt = pitch.
 *
 * This is the RAW-feed path (real fisheye/panorama). For Spiideo's already-
 * de-warped "Play" render, use FlatZoomPlayer instead.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import Hls from 'hls.js'
import { Button } from '@braintwopoint0/playback-commons/ui'
import {
  Play,
  Pause,
  Maximize,
  Minus,
  Plus,
  Frame,
  Loader2,
  AlertTriangle,
  Move,
  Crosshair,
} from 'lucide-react'
import { cn } from '@braintwopoint0/playback-commons/utils'

interface SceneJson {
  minPan: number
  maxPan: number
  minTilt: number
  maxTilt: number
}

interface VirtualPanoramaPlayerProps {
  /** Raw VirtualPanorama video URL (HLS `.m3u8` or mp4) — the 2-strip 4K feed. */
  src: string
  /** Base URL holding scene.json + vertices.bin + indices.bin. */
  meshBaseUrl: string
  /**
   * Optional pre-produced auto-follow video (e.g. Spiideo's Play production).
   * When set, the "Auto" toggle switches to THIS smooth auto-directed feed
   * instead of running our motion-follow driver; dragging returns to the
   * pannable de-warp. Kept time-synced to the main feed.
   */
  autoSrc?: string
  posterUrl?: string | null
  className?: string
  /**
   * Texture-addressing controls (the 4K frame packs the two strips top/bottom
   * while the mesh's split coordinate is the 4th float — so by default we swap
   * the two UV components). flipV / flipTexY handle the remaining vertical
   * orientation ambiguity between the mesh's UV origin and three's texture.
   */
  uvSwap?: boolean
  flipV?: boolean
  flipTexY?: boolean
  /** Debug: texture the mesh with a UV grid instead of the video (isolates geometry from texture). */
  debug?: boolean
  /** Start muted playback automatically so the VideoTexture has live frames. */
  autoplay?: boolean
  /** Inspect: view the mesh from an EXTERNAL orbiting camera (drag orbits) to see its 3D shape. Forces the UV grid. */
  inspect?: boolean
  /** Which projection strip to render: 'both' (default), '0', or '1'. Isolates the two overlapping sensor meshes. */
  proj?: 'both' | '0' | '1'
  /** Treat the mesh as a flat 2D image-warp grid: orthographic camera, vertex (x,y) = output NDC. */
  ortho?: boolean
  /** Distortion-grid de-warp: regular output grid, (f0,f1) = source sample coords. Use with ortho + a single proj. */
  dewarp?: boolean
  /**
   * Seam calibration for the composed two-half panorama (measured per
   * calibration with veo-automations/pano-align.mjs — gradient NCC between the
   * two halves' renders):
   *  - seamOverlap: overlap width as a fraction of proj0's rendered width
   *  - seamScale: world magnification applied to proj1 so its angular
   *    resolution matches proj0 (the grids have different column counts)
   *  - seamShiftY: world-Y added to proj1 (negative = down)
   */
  seamOverlap?: number
  seamScale?: number
  seamShiftY?: number
  /** Roll/perspective residual: blend-strip x-shift = a + b·y at the seam edge (world units). */
  seamWarpA?: number
  seamWarpB?: number
  /**
   * SLAVE MODE (WatchPlayer): when set, this de-warp surface stops owning
   * transport and slaves its raw-VP <video> clock to the given MASTER video
   * (the flat production). Play/pause/seek/rate mirror the master; a drift guard
   * keeps them aligned. Pair with `hideChrome` so the shared PlayerControlBar
   * (bound to the master) is the only transport UI — the user is never locked out.
   */
  masterVideoRef?: React.RefObject<HTMLVideoElement | null>
  /** Hide this component's own transport chrome (scrubber/play/time/fullscreen + center play). Canvas, zoom%, hint, loading/error stay. */
  hideChrome?: boolean
  /** Imperative control handle for the pan/zoom/auto extras, so they can live in the shared control bar. Populated on mount. */
  apiRef?: React.MutableRefObject<DewarpSurfaceApi | null>
  /** Reports pan-state changes (auto-follow toggled by button OR by a drag; zoom %) up to the shared bar's extras. */
  onStateChange?: (s: { autoFollow: boolean; zoomPct: number }) => void
}

/** Imperative surface controls, surfaced so DewarpControls can drive them from the shared bar. */
export interface DewarpSurfaceApi {
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
  toggleAuto: () => void
}

const FOV_MIN = 12
const FOV_MAX = 100
/** Curved mode: widest fov whose vertical extent still fits inside the panorama's tilt range. */
const CURVED_FOV_MAX = 62
const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v))
const DEG = Math.PI / 180

const fmtTime = (s: number): string => {
  if (!Number.isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

/** Build a three geometry from Spiideo's [x,y,z,f3,f4] vertex + uint32 index bins. */
function buildMeshGeometry(
  vbuf: ArrayBuffer,
  ibuf: ArrayBuffer,
  opts: {
    uvSwap: boolean
    flipV: boolean
    indexStart?: number
    indexCount?: number
    // Distortion-grid mode: output is a regular grid (from col/row); the stored
    // (f0,f1) barrel positions are the SOURCE sample coords.
    dewarp?: boolean
    vStart?: number
    vCount?: number
    /**
     * Feather-blend ramp in LOCAL grid X (grid spans [-1,1]): vertex alpha goes
     * 0 → 1 (smoothstep) across [from,to]. Requires a material with
     * vertexColors + transparent. Used on the top half at the centre seam.
     */
    alphaRamp?: { from: number; to: number }
    /**
     * Local seam alignment warp (paired with alphaRamp): the two sensors have a
     * relative roll/perspective component, so the blend strip is shifted in X
     * by (a + b·y) at the seam edge, tapering to zero at the ramp end. Warps
     * ONLY the blend strip — the rest of the grid is untouched.
     */
    seamWarp?: { a: number; b: number }
    /**
     * Cylindrical panorama mapping. The composed panorama is an equi-angular
     * cylindrical image (scene.json's pan/tilt limits are its angular extents),
     * so instead of a flat wall the vertices are placed on a unit cylinder
     * around the camera: pan = worldX·panPerWorld, tilt = worldY·tiltPerWorld,
     * pos = [sin(pan), tan(tilt), cos(pan)]. Placement (offset/scale/shiftY)
     * is baked in world space BEFORE curving.
     */
    curve?: {
      xOffset: number
      scale: number
      shiftY: number
      panPerWorld: number
      tiltPerWorld: number
    }
  }
): THREE.BufferGeometry {
  const raw = new Float32Array(vbuf)

  if (opts.dewarp) {
    const vStart = opts.vStart ?? 0
    const vCount = opts.vCount ?? Math.floor(raw.length / 5) - vStart
    // Detect actual rows by source-x wraps (x jumps back to the left). Rows have
    // VARIABLE widths, so we can't assume a fixed nCols.
    const rows: { start: number; len: number }[] = []
    let rowStart = 0
    let prev = raw[vStart * 5]
    for (let j = 1; j < vCount; j++) {
      const x = raw[(vStart + j) * 5]
      if (x < prev - 1.0) {
        rows.push({ start: rowStart, len: j - rowStart })
        rowStart = j
      }
      prev = x
    }
    rows.push({ start: rowStart, len: vCount - rowStart })
    const nRows = rows.length
    // source-coord normalization (barrel positions → [0,1])
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity
    for (let j = 0; j < vCount; j++) {
      const x = raw[(vStart + j) * 5],
        y = raw[(vStart + j) * 5 + 1]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    const topStrip = vStart === 0
    const pos = new Float32Array(vCount * 3)
    const uv = new Float32Array(vCount * 2)
    const ramp = opts.alphaRamp
    const rgba = ramp ? new Float32Array(vCount * 4) : null
    for (let r = 0; r < nRows; r++) {
      const { start, len } = rows[r]
      for (let c = 0; c < len; c++) {
        const j = start + c
        const colFrac = c / Math.max(1, len - 1)
        const x = colFrac * 2 - 1 // native scale, centered: grid spans [-1,1]
        const y = 0.5625 - (r / Math.max(1, nRows - 1)) * 1.125
        let xOut = x
        if (ramp && opts.seamWarp) {
          const u = clamp((x - ramp.from) / (ramp.to - ramp.from), 0, 1)
          xOut = x + (1 - u) * (opts.seamWarp.a + opts.seamWarp.b * y)
        }
        if (opts.curve) {
          // bake placement in flat world space, then wrap onto the unit
          // cylinder around the camera (equi-angular panorama)
          const cv = opts.curve
          const xw = cv.xOffset + cv.scale * xOut
          const yw = cv.shiftY + cv.scale * y
          const pan = xw * cv.panPerWorld
          const tilt = yw * cv.tiltPerWorld
          // camera looks toward +z, where screen-right = world −x
          pos[j * 3] = -Math.sin(pan)
          pos[j * 3 + 1] = Math.tan(tilt)
          pos[j * 3 + 2] = Math.cos(pan)
        } else {
          pos[j * 3] = xOut
          pos[j * 3 + 1] = y
          pos[j * 3 + 2] = 0
        }
        const sx = raw[(vStart + j) * 5],
          sy = raw[(vStart + j) * 5 + 1]
        const u = (sx - minX) / (maxX - minX)
        let vBase = (sy - minY) / (maxY - minY)
        if (opts.flipV) vBase = 1 - vBase
        // 4K frame stacks two strips top/bottom → map into one strip half.
        uv[j * 2] = u
        uv[j * 2 + 1] = topStrip ? 0.5 + vBase * 0.5 : vBase * 0.5
        if (rgba && ramp) {
          const t = clamp((x - ramp.from) / (ramp.to - ramp.from), 0, 1)
          rgba[j * 4] = 1
          rgba[j * 4 + 1] = 1
          rgba[j * 4 + 2] = 1
          rgba[j * 4 + 3] = t * t * (3 - 2 * t) // smoothstep feather
        }
      }
    }
    // Triangulate between adjacent rows by column index (widths differ ≤2).
    const indices: number[] = []
    for (let r = 0; r < nRows - 1; r++) {
      const a = rows[r]
      const b = rows[r + 1]
      const m = Math.min(a.len, b.len)
      for (let c = 0; c < m - 1; c++) {
        const a0 = a.start + c,
          a1 = a.start + c + 1
        const b0 = b.start + c,
          b1 = b.start + c + 1
        indices.push(a0, b0, a1, a1, b0, b1)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    if (rgba) geo.setAttribute('color', new THREE.BufferAttribute(rgba, 4))
    geo.setIndex(indices)
    return geo
  }

  const n = Math.floor(raw.length / 5)
  const pos = new Float32Array(n * 3)
  const uv = new Float32Array(n * 2)
  for (let k = 0; k < n; k++) {
    pos[k * 3] = raw[k * 5]
    pos[k * 3 + 1] = raw[k * 5 + 1]
    pos[k * 3 + 2] = raw[k * 5 + 2]
    const f3 = raw[k * 5 + 3]
    const f4 = raw[k * 5 + 4]
    let u = opts.uvSwap ? f4 : f3
    let v = opts.uvSwap ? f3 : f4
    if (opts.flipV) v = 1 - v
    uv[k * 2] = u
    uv[k * 2 + 1] = v
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  const allIdx = new Uint32Array(ibuf)
  const idx =
    opts.indexCount != null
      ? allIdx.slice(
          opts.indexStart ?? 0,
          (opts.indexStart ?? 0) + opts.indexCount
        )
      : allIdx
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  return geo
}

// Defaults measured for the current calibration with pano-align.mjs (gradient
// NCC, cross-checked against the grids' column-count ratio and scene.json's
// pan limits — the mesh grids are equi-angular in pan).
const SEAM_OVERLAP_DEFAULT = 0.17
const SEAM_SCALE_DEFAULT = 1.1905
const SEAM_SHIFT_Y_DEFAULT = -0.0273
const SEAM_WARP_A_DEFAULT = -0.04
const SEAM_WARP_B_DEFAULT = 0.17

interface SceneProjection {
  n_vertices: number
  n_indices: number
  camera: { position: number[]; rotation: number[] }
}

/**
 * EXACT panorama, reproduced from Spiideo Perform's own de-warp shader
 * (reverse-engineered by hooking its WebGL context — see
 * veo-automations/spiideo-perform-gl-recon.mjs). Perform's mesh vertex is
 * [f0, f1, f2, f3, f4]:
 *   - (f0,f1) = a normalised image-plane coordinate (attribute `vertexPosition`)
 *   - (f2,f3) = the SOURCE texture UV into the 4K frame (attribute `vertexTexCoord0`)
 *   - f4      = a feather alpha (attribute `vertexAlpha`)
 * and its vertex shader is:
 *   homogeneousNormCoord = textureToWorld * vec3(vertexPosition, 1.0)
 *   gl_Position = projectionMatrix * homogeneousNormCoord.xyzz
 * i.e. (f0,f1,1) is rotated into a WORLD ray by a per-projection matrix, then
 * pinhole-projected (perspective divide by the ray's z). Both projections share
 * one world frame, so they align with ZERO fitting.
 *
 * `textureToWorld` is not in scene.json, but it is a fixed function of the
 * calibration rotation R: textureToWorld = R · S, where S is a global
 * sensor-mount convention matrix (a 12.66° tilt) recovered once from the
 * captured matrices — identical across projections and recordings. So the whole
 * thing is derived purely from scene.json + S; nothing is tuned per clip.
 *
 * We bake `position = textureToWorld · (f0,f1,1)` (the world ray) per vertex and
 * view it with a perspective camera at the origin; pan/tilt rotate the camera.
 */
const MOUNT_S = [
  [0, -0.218849, 0.975731],
  [-1.000013, 0, 0],
  [0, -0.975762, -0.218884],
] // R · S = textureToWorld (recovered from Perform's captured matrices)

interface PanoramaView {
  geometries: THREE.BufferGeometry[] // one per projection (≥1)
  forward: THREE.Vector3
  right: THREE.Vector3
  up: THREE.Vector3
  panMin: number
  panMax: number
  tiltMin: number
  tiltMax: number
  // Maps a point in the RAW video frame (u,v ∈ [0,1], v=0 top) to the panorama
  // angle that shows it — used by motion auto-follow to point the camera at the
  // action detected in the raw feed. null if that region isn't in the mesh.
  lookup: (u: number, v: number) => { pan: number; tilt: number } | null
}

function buildExactPanorama(
  vbuf: ArrayBuffer,
  ibuf: ArrayBuffer,
  sceneProjs: SceneProjection[]
): PanoramaView {
  const F = new Float32Array(vbuf)
  const I = new Uint32Array(ibuf)
  const nTotal = Math.floor(F.length / 5)

  // textureToWorld = R · S per projection (R = scene rotation, row-major).
  // Vertices are stored sequentially per projection, so the offset for each is
  // the cumulative sum of the preceding projections' n_vertices — supports any
  // number of projections (a 180° single lens splits into ≥2).
  let vOff = 0
  const projs = sceneProjs.map((p, pi) => {
    const R = p.camera.rotation
    const Rm = [
      [R[0], R[1], R[2]],
      [R[3], R[4], R[5]],
      [R[6], R[7], R[8]],
    ]
    const twRaw = Rm.map((row) =>
      [0, 1, 2].map(
        (c) =>
          row[0] * MOUNT_S[0][c] +
          row[1] * MOUNT_S[1][c] +
          row[2] * MOUNT_S[2][c]
      )
    )
    // Spiideo uploads textureToWorld via uniformMatrix3fv(transpose=false) → GL
    // reads it COLUMN-major, so the actual GL matrix is the transpose of R·S
    // (which is what we recovered as row-major). Using R·S directly de-warps
    // coherently but places the projections on swapped sides; the transpose is
    // the true matrix.
    const tw = [0, 1, 2].map((i) => [0, 1, 2].map((jj) => twRaw[jj][i]))
    const vStart = vOff
    const count = Math.max(0, Math.min(p.n_vertices, nTotal - vStart))
    vOff += p.n_vertices
    return { pi, vStart, count, tw }
  })

  // mean forward direction + raster-axis accumulators (so the camera's up/right
  // come from the mesh itself — no guessed world-up)
  const fwd = [0, 0, 0]
  const rrAcc = [0, 0, 0] // Σ pos·(col−½): world direction of increasing column
  const ruAcc = [0, 0, 0] // Σ pos·(row−½): world direction of increasing row
  // Raw-UV → (pan,tilt) grid for auto-follow: bin each vertex by its source UV
  // (f2,f3) and accumulate the panorama angle its world ray points at.
  const LG = 64
  const gPan = new Float64Array(LG * LG),
    gTilt = new Float64Array(LG * LG),
    gCnt = new Float64Array(LG * LG)
  const geometries = projs.map((P) => {
    const pos = new Float32Array(P.count * 3)
    const uv = new Float32Array(P.count * 2)
    const rgba = new Float32Array(P.count * 4)
    for (let j = P.vStart; j < P.vStart + P.count; j++) {
      const k = j - P.vStart
      const f0 = F[j * 5],
        f1 = F[j * 5 + 1]
      // world ray = textureToWorld · (f0, f1, 1)
      const x = P.tw[0][0] * f0 + P.tw[0][1] * f1 + P.tw[0][2]
      const y = P.tw[1][0] * f0 + P.tw[1][1] * f1 + P.tw[1][2]
      const z = P.tw[2][0] * f0 + P.tw[2][1] * f1 + P.tw[2][2]
      pos[k * 3] = x
      pos[k * 3 + 1] = y
      pos[k * 3 + 2] = z
      fwd[0] += x
      fwd[1] += y
      fwd[2] += z
      const colFrac = F[j * 5 + 2] - 0.5
      const rowFrac =
        (P.pi === 0 ? F[j * 5 + 3] * 2 : (F[j * 5 + 3] - 0.5) * 2) - 0.5
      rrAcc[0] += x * colFrac
      rrAcc[1] += y * colFrac
      rrAcc[2] += z * colFrac
      ruAcc[0] += x * rowFrac
      ruAcc[1] += y * rowFrac
      ruAcc[2] += z * rowFrac
      // source UV is (f2,f3) directly (already addresses the correct strip)
      const su = F[j * 5 + 2],
        sv = F[j * 5 + 3]
      uv[k * 2] = su
      uv[k * 2 + 1] = sv
      // bin this vertex's (raw-UV → panorama angle) into the auto-follow grid
      const gu = Math.min(LG - 1, Math.max(0, Math.floor(su * LG)))
      const gv = Math.min(LG - 1, Math.max(0, Math.floor(sv * LG)))
      const gi = gv * LG + gu
      const rlen = Math.hypot(x, y, z) || 1
      gPan[gi] += Math.atan2(x, z)
      gTilt[gi] += Math.asin(clamp(-y / rlen, -1, 1))
      gCnt[gi] += 1
      // Spiideo's baked feather alpha (f4)
      const a = F[j * 5 + 4]
      rgba[k * 4] = 1
      rgba[k * 4 + 1] = 1
      rgba[k * 4 + 2] = 1
      rgba[k * 4 + 3] = a
    }
    // Use the mesh's OWN complete per-projection indices (a full regular-grid
    // triangle LIST — 97446 = 2·149·109·3 for the 150×110 grid). The previous code
    // re-triangulated by detecting rows via an f2-wrap heuristic and paired rows
    // with m = min(len_a, len_b), which truncated the highest-index (right-most)
    // columns whenever a row split was missed — leaving a right-side black wedge.
    // File indices reference the GLOBAL vertex array and are stored sequentially
    // per projection, so slice this projection's block (cumulative n_indices
    // offset) and rebase to local (−vStart); drop any stray out-of-range triangle.
    let idxOff = 0
    for (let q = 0; q < P.pi; q++) idxOff += sceneProjs[q].n_indices
    const nIdx = sceneProjs[P.pi].n_indices
    const tris: number[] = []
    for (let t = 0; t + 2 < nIdx; t += 3) {
      const a0 = I[idxOff + t] - P.vStart
      const a1 = I[idxOff + t + 1] - P.vStart
      const a2 = I[idxOff + t + 2] - P.vStart
      if (
        a0 >= 0 &&
        a0 < P.count &&
        a1 >= 0 &&
        a1 < P.count &&
        a2 >= 0 &&
        a2 < P.count
      )
        tris.push(a0, a1, a2)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    geo.setAttribute('color', new THREE.BufferAttribute(rgba, 4))
    geo.setIndex(tris)
    return geo
  })
  // The panorama already lives in textureToWorld's CANONICAL frame: forward =
  // +Z, right = +X, up = +Y. Spiideo's captured projectionMatrix is axis-aligned
  // (row0 = (1,0,0,0), row3 = (0,0,1,0) → screen = world.xy / world.z), i.e. it
  // projects every ray down a fixed +Z axis — because textureToWorld = R·S has
  // already rotated both projections into one common frame. Deriving a basis from
  // the mesh raster (the old code) skews right/up and tilts the seam into a fold;
  // the two projections only stay coplanar under the canonical axes.
  // up = world -Y: Spiideo's projectionMatrix row1 is (0,-1.5425,0,0), i.e.
  // screen.y = -k·world.y/z, so world +Y maps to screen-DOWN → camera up = -Y.
  const forward = new THREE.Vector3(0, 0, 1)
  const right = new THREE.Vector3(1, 0, 0)
  const up = new THREE.Vector3(0, -1, 0)
  void fwd
  void rrAcc
  void ruAcc // raster accumulators no longer needed

  // angular extents of the panorama about (forward, right, up) → pan/tilt limits
  let panMin = Infinity,
    panMax = -Infinity,
    tiltMin = Infinity,
    tiltMax = -Infinity
  const d = new THREE.Vector3()
  for (const P of projs)
    for (let j = P.vStart; j < P.vStart + P.count; j += 5) {
      const f0 = F[j * 5],
        f1 = F[j * 5 + 1]
      d.set(
        P.tw[0][0] * f0 + P.tw[0][1] * f1 + P.tw[0][2],
        P.tw[1][0] * f0 + P.tw[1][1] * f1 + P.tw[1][2],
        P.tw[2][0] * f0 + P.tw[2][1] * f1 + P.tw[2][2]
      ).normalize()
      const yaw = Math.atan2(d.dot(right), d.dot(forward))
      const pitch = Math.asin(clamp(d.dot(up), -1, 1))
      if (yaw < panMin) panMin = yaw
      if (yaw > panMax) panMax = yaw
      if (pitch < tiltMin) tiltMin = pitch
      if (pitch > tiltMax) tiltMax = pitch
    }

  // average the auto-follow grid; lookup samples the nearest filled cell
  const gAvgPan = new Float32Array(LG * LG),
    gAvgTilt = new Float32Array(LG * LG)
  const gFilled = new Uint8Array(LG * LG)
  for (let i = 0; i < LG * LG; i++) {
    if (gCnt[i] > 0) {
      gAvgPan[i] = gPan[i] / gCnt[i]
      gAvgTilt[i] = gTilt[i] / gCnt[i]
      gFilled[i] = 1
    }
  }
  const lookup = (
    u: number,
    v: number
  ): { pan: number; tilt: number } | null => {
    const cu = Math.min(LG - 1, Math.max(0, Math.floor(u * LG)))
    const cv = Math.min(LG - 1, Math.max(0, Math.floor(v * LG)))
    for (let r = 0; r < LG; r++) {
      for (let dv = -r; dv <= r; dv++) {
        for (let du = -r; du <= r; du++) {
          if (r > 0 && Math.abs(du) !== r && Math.abs(dv) !== r) continue // ring only
          const nu = cu + du,
            nv = cv + dv
          if (nu < 0 || nu >= LG || nv < 0 || nv >= LG) continue
          const gi = nv * LG + nu
          if (gFilled[gi]) return { pan: gAvgPan[gi], tilt: gAvgTilt[gi] }
        }
      }
    }
    return null
  }
  return {
    geometries,
    forward,
    right,
    up,
    panMin,
    panMax,
    tiltMin,
    tiltMax,
    lookup,
  }
}

export function VirtualPanoramaPlayer({
  src,
  meshBaseUrl,
  autoSrc,
  posterUrl,
  className = '',
  uvSwap = true,
  flipV = false,
  flipTexY = false,
  debug = false,
  autoplay = false,
  inspect = false,
  proj = 'both',
  ortho = false,
  dewarp = false,
  seamOverlap = SEAM_OVERLAP_DEFAULT,
  seamScale = SEAM_SCALE_DEFAULT,
  seamShiftY = SEAM_SHIFT_Y_DEFAULT,
  seamWarpA = SEAM_WARP_A_DEFAULT,
  seamWarpB = SEAM_WARP_B_DEFAULT,
  masterVideoRef,
  hideChrome = false,
  apiRef,
  onStateChange,
}: VirtualPanoramaPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasHostRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const autoVideoRef = useRef<HTMLVideoElement>(null) // pre-produced auto-follow feed
  const hlsRef = useRef<Hls | null>(null)

  // live camera state (radians / degrees) in refs — no re-render per frame
  const viewRef = useRef({ pan: 0, tilt: 0, fov: 70 })
  const limitsRef = useRef<SceneJson>({
    minPan: -1.48,
    maxPan: 1.48,
    minTilt: -0.78,
    maxTilt: 0.34,
  })
  const panoRef = useRef<PanoramaView | null>(null)

  // curved mode = the product path: composed panorama + perspective camera
  const curved = proj === 'both'

  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [zoomPct, setZoomPct] = useState(100)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showHint, setShowHint] = useState(true)
  const [retry, setRetry] = useState(0)
  // motion auto-follow (the ▣ toggle): when on, a driver steers the camera at
  // the detected action instead of the user. Only meaningful in curved mode.
  const [autoFollow, setAutoFollow] = useState(false)
  const autoFollowRef = useRef(false)
  useEffect(() => {
    autoFollowRef.current = autoFollow
  }, [autoFollow])

  const dismissHint = useCallback(() => setShowHint(false), [])
  const syncZoom = useCallback(
    () =>
      setZoomPct(
        Math.round(
          ((curved ? CURVED_FOV_MAX : FOV_MAX) / viewRef.current.fov) * 100
        )
      ),
    [curved]
  )
  const reload = useCallback(() => {
    setError(null)
    setIsLoading(true)
    setRetry((r) => r + 1)
  }, [])

  const clampView = useCallback(
    (v: { pan: number; tilt: number; fov: number }) => {
      const l = limitsRef.current
      if (!curved) {
        return {
          pan: clamp(v.pan, l.minPan, l.maxPan),
          tilt: clamp(v.tilt, l.minTilt, l.maxTilt),
          fov: clamp(v.fov, FOV_MIN, FOV_MAX),
        }
      }
      // keep the whole frame on the panorama: shrink the pan/tilt range by half
      // the view's angular size (collapsing to the midpoint when it inverts)
      const fov = clamp(v.fov, FOV_MIN, CURVED_FOV_MAX)
      const vHalf = (fov / 2) * DEG
      const hHalf = Math.atan(Math.tan(vHalf) * (16 / 9))
      const panMid = (l.minPan + l.maxPan) / 2
      const tiltMid = (l.minTilt + l.maxTilt) / 2
      const panMin = Math.min(l.minPan + hHalf, panMid)
      const panMax = Math.max(l.maxPan - hHalf, panMid)
      const tiltMin = Math.min(l.minTilt + vHalf, tiltMid)
      const tiltMax = Math.max(l.maxTilt - vHalf, tiltMid)
      return {
        pan: clamp(v.pan, panMin, panMax),
        tilt: clamp(v.tilt, tiltMin, tiltMax),
        fov,
      }
    },
    [curved]
  )

  // --- HLS / <video> ---
  useEffect(() => {
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.playsInline = true
    video.preload = 'auto'
    // Mute for autoplay (permitted → live VideoTexture frames) AND in slave mode:
    // the master carries the audio, and an unmuted programmatic play() on the
    // slave gets blocked by autoplay policy → frozen texture + double audio.
    if (autoplay || masterVideoRef) video.muted = true
    videoRef.current = video

    const isHls = src.includes('.m3u8')
    if (isHls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true })
      hls.loadSource(src)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad()
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR)
          hls.recoverMediaError()
        else {
          hls.destroy()
          setIsLoading(false)
          setError('This recording could not be loaded.')
        }
      })
      hlsRef.current = hls
    } else {
      video.src = src
    }

    const onTime = () => setCurrentTime(video.currentTime)
    const onDur = () => setDuration(video.duration || 0)
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onError = () => {
      setIsLoading(false)
      setError('This recording could not be loaded.')
    }
    const onCanPlay = () => {
      if (autoplay) void video.play().catch(() => {})
    }
    video.addEventListener('loadedmetadata', onDur)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('error', onError)
    video.addEventListener('canplay', onCanPlay)
    return () => {
      video.removeEventListener('loadedmetadata', onDur)
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('error', onError)
      video.removeEventListener('canplay', onCanPlay)
      hlsRef.current?.destroy()
      hlsRef.current = null
      video.removeAttribute('src')
      video.load()
    }
  }, [src, retry, autoplay])

  // --- three.js: load mesh, build scene, render loop ---
  useEffect(() => {
    const host = canvasHostRef.current
    const video = videoRef.current
    if (!host || !video) return
    let disposed = false
    let raf = 0
    let renderer: THREE.WebGLRenderer | null = null
    let ro: ResizeObserver | null = null
    let onWheel: ((e: WheelEvent) => void) | null = null

    ;(async () => {
      try {
        const [scene_, vbuf, ibuf] = await Promise.all([
          fetch(`${meshBaseUrl}/scene.json`).then(
            (r) => r.json() as Promise<SceneJson>
          ),
          fetch(`${meshBaseUrl}/vertices.bin`).then((r) => r.arrayBuffer()),
          fetch(`${meshBaseUrl}/indices.bin`).then((r) => r.arrayBuffer()),
        ])
        if (disposed) return
        // Curved mode (the product path): Perform's exact de-warp — every mesh
        // vertex is a WORLD ray, viewed by a perspective camera at the origin;
        // pan/tilt rotate the viewer. Flat ortho remains for the single-
        // projection measurement/debug paths.
        // The composed two-projection panorama ALWAYS uses the exact de-warp
        // (buildExactPanorama). `dewarp`/`ortho` remain single-projection debug
        // paths only. (Previously curved required `dewarp` too, so a bare
        // `proj=both` fell through to the raw-mesh fallback and looked broken.)
        const curved = proj === 'both'
        const useOrtho = ortho && !curved
        if (!curved) {
          limitsRef.current = scene_
          viewRef.current = clampView(viewRef.current)
        }

        const scene = new THREE.Scene()
        const camera: THREE.PerspectiveCamera | THREE.OrthographicCamera =
          useOrtho
            ? new THREE.OrthographicCamera(-1, 1, 0.5625, -0.5625, -100, 100)
            : new THREE.PerspectiveCamera(
                viewRef.current.fov,
                16 / 9,
                0.01,
                100
              )

        let texture: THREE.Texture
        if (debug || inspect) {
          // UV grid: hue by U, brightness by V, with white gridlines. If this
          // de-warps into a smooth curved grid, the mesh+UVs are correct and
          // any remaining garbage is a video-texture problem.
          const c = document.createElement('canvas')
          c.width = 1024
          c.height = 512
          const g = c.getContext('2d')!
          for (let y = 0; y < 512; y += 16)
            for (let x = 0; x < 1024; x += 16) {
              g.fillStyle = `hsl(${(x / 1024) * 360}, 75%, ${(y / 512) * 55 + 20}%)`
              g.fillRect(x, y, 16, 16)
            }
          g.strokeStyle = '#ffffff'
          g.lineWidth = 2
          for (let x = 0; x <= 1024; x += 128) g.strokeRect(x, 0, 0.01, 512)
          for (let y = 0; y <= 512; y += 128) g.strokeRect(0, y, 1024, 0.01)
          texture = new THREE.CanvasTexture(c)
        } else {
          texture = new THREE.VideoTexture(video)
        }
        texture.colorSpace = THREE.SRGBColorSpace
        texture.flipY = flipTexY
        texture.minFilter = THREE.LinearFilter
        texture.magFilter = THREE.LinearFilter

        // Optionally render only one projection's index range (they are stored
        // sequentially: proj0 first, then proj1).
        const projs = (
          scene_ as unknown as {
            projections?: { n_indices: number; n_vertices: number }[]
          }
        ).projections
        let indexStart: number | undefined
        let indexCount: number | undefined
        let vStart: number | undefined
        let vCount: number | undefined
        if (projs && projs.length >= 2) {
          const which = proj === '1' ? 1 : 0
          if (proj !== 'both') {
            indexStart = which === 0 ? 0 : projs[0].n_indices
            indexCount = projs[which].n_indices
          }
          // dewarp always uses a single projection's vertex grid
          vStart = which === 0 ? 0 : projs[0].n_vertices
          vCount = projs[which].n_vertices
        }
        // For the de-warp both-halves panorama, build one grid per projection
        // and compose them at NATIVE scale using the measured seam calibration:
        // no cropping/stretching — proj1 (left) is scaled to proj0's angular
        // resolution and the two are overlapped by the measured amount, with
        // proj0 feather-blended over proj1 across the overlap.
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          side: THREE.DoubleSide,
        })
        const geometries: THREE.BufferGeometry[] = []
        const materials: THREE.Material[] = [material]
        const meshes: THREE.Mesh[] = []
        if (curved && projs && projs.length >= 1) {
          // Exact reproduction of Perform's de-warp shader (see buildExactPanorama).
          const view = buildExactPanorama(
            vbuf,
            ibuf,
            projs as unknown as SceneProjection[]
          )
          panoRef.current = view
          // pan/tilt limits from the panorama's real angular extents
          limitsRef.current = {
            minPan: view.panMin,
            maxPan: view.panMax,
            minTilt: view.tiltMin,
            maxTilt: view.tiltMax,
          }
          // open at a flat broadcast-style zoom (a wide fov fisheyes the edges)
          viewRef.current = clampView({ pan: 0, tilt: 0, fov: 46 })
          syncZoom()
          // Compose N projections: the LAST is the opaque base, the rest are
          // drawn on top with Spiideo's baked feather alpha across each overlap.
          // For the common 2-projection mesh this is exactly proj1-base +
          // proj0-blended; a single 180° lens is split into ≥2 projections (you
          // can't rectilinearly de-warp 180° in one), so the same path covers
          // 3+ with no per-count special-casing.
          const gs = view.geometries
          const base = new THREE.Mesh(gs[gs.length - 1], material)
          geometries.push(gs[gs.length - 1])
          meshes.push(base)
          const blend = new THREE.MeshBasicMaterial({
            map: texture,
            side: THREE.DoubleSide,
            transparent: true,
            depthWrite: false,
            depthTest: false, // coincident surfaces at the seams
            vertexColors: true,
          })
          if (gs.length > 1) materials.push(blend)
          for (let gi = gs.length - 2; gi >= 0; gi--) {
            const m = new THREE.Mesh(gs[gi], blend)
            m.renderOrder = gs.length - 1 - gi
            geometries.push(gs[gi])
            meshes.push(m)
          }
        } else {
          const g = buildMeshGeometry(vbuf, ibuf, {
            uvSwap,
            flipV,
            indexStart,
            indexCount,
            dewarp,
            vStart,
            vCount,
          })
          geometries.push(g)
          meshes.push(new THREE.Mesh(g, material))
        }
        for (const m of meshes) scene.add(m)
        if (inspect) scene.add(new THREE.AxesHelper(2)) // X=red Y=green Z=blue

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
        renderer.setClearColor(0x05_09_07, 1)
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        host.appendChild(renderer.domElement)
        Object.assign(renderer.domElement.style, {
          width: '100%',
          height: '100%',
          display: 'block',
          touchAction: 'none',
        })

        onWheel = (e: WheelEvent) => {
          e.preventDefault()
          viewRef.current = clampView({
            ...viewRef.current,
            fov: viewRef.current.fov / Math.exp(-e.deltaY * 0.0015),
          })
          syncZoom()
          dismissHint()
        }
        host.addEventListener('wheel', onWheel, { passive: false })

        const target = new THREE.Vector3()
        const camRight = new THREE.Vector3()
        const resize = () => {
          const w = host.clientWidth || 1
          const h = host.clientHeight || 1
          renderer!.setSize(w, h, false)
          if (camera instanceof THREE.PerspectiveCamera) {
            camera.aspect = w / h
            camera.updateProjectionMatrix()
          }
        }
        resize()
        ro = new ResizeObserver(resize)
        ro.observe(host)

        setIsLoading(false)
        const CENTER = new THREE.Vector3(0, 0, 0.5) // mesh bbox center
        if (useOrtho) {
          // Flat 2D image-warp: fixed orthographic camera; vertex (x,y) = output NDC.
          camera.position.set(0, 0, 5)
          camera.lookAt(0, 0, 0)
        }
        // --- motion auto-follow: detect the action in the raw feed, steer camera ---
        const followCanvas = document.createElement('canvas')
        followCanvas.width = 128
        followCanvas.height = 72
        const fctx = followCanvas.getContext('2d', { willReadFrequently: true })
        let prevLuma: Float32Array | null = null
        const Wc = followCanvas.width,
          Hc = followCanvas.height
        const accum = new Float32Array(Wc * Hc) // decaying motion heatmap (stable action region)
        let followFrame = 0
        let haveTarget = false
        const followTarget = { pan: 0, tilt: 0, fov: 42 }
        const velP = { v: 0 },
          velT = { v: 0 },
          velF = { v: 0 }
        // critically-damped smoothing (Unity SmoothDamp) — filters the high-freq
        // target jitter into slow, cinematic camera motion (no EMA overshoot).
        const smoothDamp = (
          cur: number,
          tgt: number,
          vel: { v: number },
          smoothTime: number,
          dt: number
        ) => {
          const omega = 2 / smoothTime,
            x = omega * dt
          const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
          const change = cur - tgt
          const temp = (vel.v + omega * change) * dt
          vel.v = (vel.v - omega * temp) * exp
          return tgt + (change + temp) * exp
        }
        const stepFollow = () => {
          const pano = panoRef.current
          if (!fctx || !pano || video.readyState < 2) return
          followFrame++
          if (followFrame % 3 === 0) {
            try {
              fctx.drawImage(video, 0, 0, Wc, Hc)
            } catch {
              return
            }
            const data = fctx.getImageData(0, 0, Wc, Hc).data
            const luma = new Float32Array(Wc * Hc)
            for (let i = 0; i < Wc * Hc; i++)
              luma[i] =
                0.299 * data[i * 4] +
                0.587 * data[i * 4 + 1] +
                0.114 * data[i * 4 + 2]
            if (prevLuma) {
              // integrate this frame's motion into a decaying heatmap, then take the
              // centroid of the ACCUMULATED motion — smooths out per-frame jumping
              // between players so the camera tracks the sustained action, not noise.
              let sw = 0,
                sx = 0,
                sy = 0,
                sxx = 0,
                syy = 0
              for (let py = 0; py < Hc; py++)
                for (let px = 0; px < Wc; px++) {
                  const i = py * Wc + px
                  const diff = Math.abs(luma[i] - prevLuma[i])
                  accum[i] = accum[i] * 0.9 + (diff > 14 ? diff : 0)
                  const a = accum[i]
                  if (a > 6) {
                    sw += a
                    sx += a * px
                    sy += a * py
                    sxx += a * px * px
                    syy += a * py * py
                  }
                }
              if (sw > 700) {
                const mx = sx / sw,
                  my = sy / sw
                const hit = pano.lookup(mx / Wc, my / Hc)
                if (hit) {
                  // EMA the target action-point too, so the spring chases a
                  // pre-smoothed goal (two-stage smoothing)
                  const k = haveTarget ? 0.35 : 1
                  followTarget.pan += (hit.pan - followTarget.pan) * k
                  followTarget.tilt += (hit.tilt - followTarget.tilt) * k
                  const varx = Math.max(0, sxx / sw - mx * mx),
                    vary = Math.max(0, syy / sw - my * my)
                  const spread = Math.sqrt(varx / (Wc * Wc) + vary / (Hc * Hc))
                  const fovT = clamp(34 + spread * 70, 30, CURVED_FOV_MAX)
                  followTarget.fov +=
                    (fovT - followTarget.fov) * (haveTarget ? 0.08 : 1)
                  haveTarget = true
                }
              }
            }
            prevLuma = luma
          }
          if (haveTarget) {
            // ease pan/tilt gently toward the (now stable) target; zoom even slower
            const v = viewRef.current,
              dt = 1 / 60
            viewRef.current = clampView({
              pan: smoothDamp(v.pan, followTarget.pan, velP, 0.5, dt),
              tilt: smoothDamp(v.tilt, followTarget.tilt, velT, 0.55, dt),
              fov: smoothDamp(v.fov, followTarget.fov, velF, 1.3, dt),
            })
            if (followFrame % 8 === 0) syncZoom()
          }
        }
        const loop = () => {
          raf = requestAnimationFrame(loop)
          if (autoFollowRef.current && curved && !autoSrc)
            stepFollow() // production feed handles Auto when autoSrc set
          else {
            prevLuma = null
            haveTarget = false
          }
          const { pan, tilt, fov } = viewRef.current
          if (!useOrtho && camera instanceof THREE.PerspectiveCamera) {
            if (inspect) {
              // External orbit camera looking AT the mesh to reveal its shape.
              const dist = 4.5
              camera.position.set(
                CENTER.x + dist * Math.sin(pan) * Math.cos(tilt),
                CENTER.y + dist * Math.sin(tilt),
                CENTER.z - dist * Math.cos(pan) * Math.cos(tilt)
              )
              if (camera.fov !== 55) {
                camera.fov = 55
                camera.updateProjectionMatrix()
              }
              camera.lookAt(CENTER)
            } else if (curved && panoRef.current) {
              // Perform's viewpoint: camera at the origin looking down the mean
              // world ray; pan yaws about the view up, tilt pitches about right.
              const pv = panoRef.current
              camera.position.set(0, 0, 0)
              if (camera.fov !== fov) {
                camera.fov = fov
                camera.updateProjectionMatrix()
              }
              const dir = pv.forward.clone().applyAxisAngle(pv.up, pan)
              const rightNow = camRight
                .copy(pv.right)
                .applyAxisAngle(pv.up, pan)
              dir.applyAxisAngle(rightNow, tilt)
              camera.up.copy(pv.up)
              camera.lookAt(dir)
            } else {
              // Viewer at the projection center (origin); surface sits toward +Z.
              camera.position.set(0, 0, 0)
              if (camera.fov !== fov) {
                camera.fov = fov
                camera.updateProjectionMatrix()
              }
              target.set(
                Math.sin(pan) * Math.cos(tilt),
                Math.sin(tilt),
                Math.cos(pan) * Math.cos(tilt)
              )
              camera.lookAt(target)
            }
          }
          renderer!.render(scene, camera)
        }
        loop()

        // cleanup registered via closure vars
        ;(host as HTMLDivElement & { __cleanup?: () => void }).__cleanup =
          () => {
            cancelAnimationFrame(raf)
            ro?.disconnect()
            if (onWheel) host.removeEventListener('wheel', onWheel)
            texture.dispose()
            for (const g of geometries) g.dispose()
            for (const m of materials) m.dispose()
            renderer?.forceContextLoss()
            renderer?.dispose()
            if (renderer && renderer.domElement.parentNode === host)
              host.removeChild(renderer.domElement)
          }
      } catch {
        if (!disposed) {
          setIsLoading(false)
          setError('Could not load the panorama calibration.')
        }
      }
    })()

    return () => {
      disposed = true
      const host2 = host as HTMLDivElement & { __cleanup?: () => void }
      host2.__cleanup?.()
      host2.__cleanup = undefined
    }
  }, [
    src,
    retry,
    meshBaseUrl,
    clampView,
    syncZoom,
    dismissHint,
    uvSwap,
    flipV,
    flipTexY,
    debug,
    inspect,
    proj,
    ortho,
    dewarp,
    autoSrc,
    seamOverlap,
    seamScale,
    seamShiftY,
    seamWarpA,
    seamWarpB,
  ])

  useEffect(() => {
    if (!showHint) return
    const t = setTimeout(() => setShowHint(false), 4500)
    return () => clearTimeout(t)
  }, [showHint])

  // --- pointer grab-pan (radians from pixels via current fov) ---
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    if (autoFollow) setAutoFollow(false) // taking manual control stops auto-follow
    dragRef.current = { x: e.clientX, y: e.clientY }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    dismissHint()
  }
  const toggleAutoFollow = () => {
    setAutoFollow((a) => !a)
    dismissHint()
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const start = dragRef.current
    const host = canvasHostRef.current
    if (!start || !host) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    dragRef.current = { x: e.clientX, y: e.clientY }
    const fovRad = viewRef.current.fov * DEG
    const perPxY = fovRad / host.clientHeight
    const perPxX =
      (fovRad * (host.clientWidth / host.clientHeight)) / host.clientWidth
    viewRef.current = clampView({
      pan: viewRef.current.pan + dx * perPxX,
      tilt: viewRef.current.tilt + dy * perPxY,
      fov: viewRef.current.fov,
    })
  }
  const endDrag = (e: React.PointerEvent) => {
    dragRef.current = null
    ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
  }

  const zoomBy = (f: number) => {
    viewRef.current = clampView({
      ...viewRef.current,
      fov: viewRef.current.fov / f,
    })
    syncZoom()
  }
  const resetView = () => {
    viewRef.current = clampView({ pan: 0, tilt: 0, fov: 70 })
    syncZoom()
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = 3 * DEG
    const v = viewRef.current
    let handled = true
    switch (e.key) {
      case 'ArrowLeft':
        viewRef.current = clampView({ ...v, pan: v.pan - step })
        break
      case 'ArrowRight':
        viewRef.current = clampView({ ...v, pan: v.pan + step })
        break
      case 'ArrowUp':
        viewRef.current = clampView({ ...v, tilt: v.tilt + step })
        break
      case 'ArrowDown':
        viewRef.current = clampView({ ...v, tilt: v.tilt - step })
        break
      case '+':
      case '=':
        zoomBy(1.25)
        break
      case '-':
      case '_':
        zoomBy(1 / 1.25)
        break
      case '0':
      case 'Home':
        resetView()
        break
      default:
        handled = false
    }
    if (handled) {
      e.preventDefault()
      dismissHint()
    }
  }

  const togglePlay = () => {
    const v = videoRef.current,
      a = autoVideoRef.current
    if (!v) return
    if (v.paused) {
      void v.play().catch(() => {})
      if (a) void a.play().catch(() => {})
    } else {
      v.pause()
      a?.pause()
    }
  }
  const onSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current,
      a = autoVideoRef.current
    if (!v) return
    v.currentTime = Number(e.target.value)
    if (a) a.currentTime = v.currentTime // keep the production feed time-aligned
    setCurrentTime(v.currentTime)
  }
  // sync the production feed to the main feed when Auto flips on/off
  useEffect(() => {
    const v = videoRef.current,
      a = autoVideoRef.current
    if (!v || !a || !autoSrc) return
    if (autoFollow) {
      a.currentTime = v.currentTime
      if (!v.paused) void a.play().catch(() => {})
    } else a.pause()
  }, [autoFollow, autoSrc])
  const toggleFullscreen = () => {
    const el = containerRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen?.()
  }
  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  // SLAVE MODE — follow the master clock (the flat production video). The raw-VP
  // <video> that feeds the WebGL texture mirrors the master's play/pause/seek/rate;
  // a rAF drift guard keeps them within ~0.15s so toggling the surface is seamless
  // (no restart / jump). Re-binds when the raw-VP element is recreated (`retry`).
  useEffect(() => {
    const master = masterVideoRef?.current
    if (!master) return
    let raf = 0
    const onPlay = () => {
      const v = videoRef.current
      if (!v) return
      v.currentTime = master.currentTime
      void v.play().catch(() => {})
    }
    const onPause = () => videoRef.current?.pause()
    const onSeeked = () => {
      const v = videoRef.current
      if (v) v.currentTime = master.currentTime
    }
    const onRate = () => {
      const v = videoRef.current
      if (v) v.playbackRate = master.playbackRate
    }
    master.addEventListener('play', onPlay)
    master.addEventListener('pause', onPause)
    master.addEventListener('seeked', onSeeked)
    master.addEventListener('ratechange', onRate)
    onSeeked()
    onRate()
    if (!master.paused) onPlay()
    const tick = () => {
      const v = videoRef.current
      if (v && v.readyState >= 1) {
        if (Math.abs(v.currentTime - master.currentTime) > 0.15)
          v.currentTime = master.currentTime
        if (!master.paused && v.paused) void v.play().catch(() => {})
        if (master.paused && !v.paused) v.pause()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      master.removeEventListener('play', onPlay)
      master.removeEventListener('pause', onPause)
      master.removeEventListener('seeked', onSeeked)
      master.removeEventListener('ratechange', onRate)
    }
  }, [masterVideoRef, retry])

  // Report pan-state up so DewarpControls (rendered in the shared bar's extras)
  // reflect Auto-pressed + zoom%. Fires when Auto flips via button OR a drag.
  useEffect(() => {
    onStateChange?.({ autoFollow, zoomPct })
  }, [autoFollow, zoomPct, onStateChange])

  // Publish the imperative control handle for the extras (ref-as-latest-callback,
  // same pattern as toggleFullscreenRef — the closures below are already defined).
  if (apiRef) {
    apiRef.current = {
      zoomIn: () => zoomBy(1.25),
      zoomOut: () => zoomBy(1 / 1.25),
      reset: resetView,
      toggleAuto: toggleAutoFollow,
    }
  }

  const seekPct =
    duration > 0 ? (Math.min(currentTime, duration) / duration) * 100 : 0
  const canInteract = !isLoading && !error

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative w-full overflow-hidden rounded-lg bg-[#050907] select-none',
        className
      )}
    >
      <div className="relative aspect-video w-full">
        <div
          ref={canvasHostRef}
          role="application"
          aria-label="Panoramic recording. Drag or arrow keys to look around; scroll or +/- to zoom."
          tabIndex={canInteract ? 0 : -1}
          className="absolute inset-0 cursor-grab outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--timberwolf)]"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
        />

        {autoSrc && (
          // Spiideo's pre-produced auto-follow feed, shown over the de-warp when
          // Auto is on. pointer-events-none so a drag falls through to the canvas
          // and drops back to the pannable view.
          <video
            ref={autoVideoRef}
            src={autoSrc}
            muted
            playsInline
            preload="auto"
            className={cn(
              'pointer-events-none absolute inset-0 h-full w-full bg-black object-contain transition-opacity duration-200',
              autoFollow ? 'z-10 opacity-100' : 'opacity-0'
            )}
          />
        )}

        {isLoading && !error && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#050907]">
            {posterUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={posterUrl}
                alt=""
                className="h-full w-full object-cover opacity-40"
              />
            ) : null}
            <Loader2 className="absolute h-8 w-8 animate-spin text-[var(--timberwolf)]" />
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#050907] px-6 text-center">
            <AlertTriangle className="h-6 w-6 text-[var(--ash-grey)]" />
            <p className="text-sm text-[var(--timberwolf)]">{error}</p>
            <Button variant="outline" size="sm" onClick={reload}>
              Try again
            </Button>
          </div>
        )}

        {!hideChrome && canInteract && !isPlaying && (
          <button
            type="button"
            onClick={togglePlay}
            aria-label="Play"
            className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/20 text-white backdrop-blur-sm transition hover:bg-white/30"
          >
            <Play className="h-7 w-7 translate-x-0.5" />
          </button>
        )}

        {showHint && canInteract && (
          <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
            <div className="flex items-center gap-2 rounded-full bg-black/60 px-4 py-2 text-sm text-[var(--timberwolf)] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2">
              <Move className="h-4 w-4" /> Drag to look around · scroll to zoom
            </div>
          </div>
        )}

        <div
          className={cn(
            'pointer-events-none absolute right-3 top-3 rounded-md bg-black/50 px-2 py-1 text-xs font-medium text-[var(--timberwolf)] tabular-nums transition-opacity',
            zoomPct <= 100 ? 'opacity-0' : 'opacity-100'
          )}
        >
          {zoomPct}%
        </div>

        {!hideChrome && canInteract && (
          <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-3 pb-2 pt-6">
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={Math.min(currentTime, duration || 0)}
              onChange={onSeek}
              aria-label="Seek"
              aria-valuetext={`${fmtTime(currentTime)} of ${fmtTime(duration)}`}
              style={{
                background: `linear-gradient(to right, #10b981 ${seekPct}%, rgba(255,255,255,0.25) ${seekPct}%)`,
              }}
              className="-my-2 h-1 w-full cursor-pointer appearance-none rounded-full py-2 accent-emerald-500"
            />
            <div className="flex items-center gap-2 text-white">
              <Button
                variant="ghost"
                size="icon"
                onClick={togglePlay}
                aria-label={isPlaying ? 'Pause' : 'Play'}
                className="h-9 w-9 text-white hover:bg-white/20 md:h-8 md:w-8"
              >
                {isPlaying ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
              </Button>
              <span className="text-xs tabular-nums text-[var(--ash-grey)]">
                {fmtTime(currentTime)} / {fmtTime(duration)}
              </span>
              <div className="ml-auto flex items-center gap-1">
                {curved && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleAutoFollow}
                    aria-label="Toggle auto-follow"
                    aria-pressed={autoFollow}
                    title={
                      autoFollow
                        ? 'Auto-follow on — drag to take control'
                        : 'Auto-follow the action'
                    }
                    className={cn(
                      'h-9 gap-1.5 px-2 text-white hover:bg-white/20 md:h-8',
                      autoFollow &&
                        'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                    )}
                  >
                    <Crosshair className="h-4 w-4" />
                    <span className="text-xs font-medium">Auto</span>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => zoomBy(1 / 1.25)}
                  aria-label="Zoom out"
                  className="h-9 w-9 text-white hover:bg-white/20 md:h-8 md:w-8"
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => zoomBy(1.25)}
                  aria-label="Zoom in"
                  className="h-9 w-9 text-white hover:bg-white/20 md:h-8 md:w-8"
                >
                  <Plus className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={resetView}
                  aria-label="Reset view"
                  className="h-9 w-9 text-white hover:bg-white/20 md:h-8 md:w-8"
                >
                  <Frame className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={toggleFullscreen}
                  aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                  className="h-9 w-9 text-white hover:bg-white/20 md:h-8 md:w-8"
                >
                  <Maximize className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
