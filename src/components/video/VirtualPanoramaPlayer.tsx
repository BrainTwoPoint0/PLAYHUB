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
import { useTranslations } from 'next-intl'
import Hls from 'hls.js'
import { Button } from '@braintwopoint0/playback-commons/ui'
import {
  parseAimTrack,
  sampleAimTrack,
  type AimTrack,
} from '@/lib/panorama/aim-track'
import {
  parseTracklets,
  sampleObject,
  objectsAt,
  nearestObject,
  slotMate,
  type Tracklets,
} from '@/lib/panorama/tracklets'
import { computeFraming, searchFov } from '@/lib/panorama/framing'
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
  UserSearch,
  Focus,
} from 'lucide-react'
import { cn } from '@braintwopoint0/playback-commons/utils'
import {
  BLEND_FOV_LO,
  BLEND_FOV_HI,
  BLEND_FOV_DOWN_LO,
  BLEND_FOV_DOWN_HI,
  BLEND_MAX_DEFAULT,
  blendFactor,
  blendHalfExtents,
  blendPanHalfAngleDeg,
  curvedFovMax,
  intersectPanWindow,
  CURVED_FOV_MAX_CEIL,
} from '@/lib/panorama/projection'

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
  /** Reports pan-state changes (auto-follow toggled by button OR by a drag; zoom %; which optional artifacts loaded; spotlight armed) up to the shared bar's extras. */
  onStateChange?: (s: {
    autoFollow: boolean
    zoomPct: number
    hasAimTrack: boolean
    hasTracklets: boolean
    spotlight: boolean
    hasSelection: boolean
    lock: boolean
  }) => void
  /**
   * Debug: disable the fov-adaptive pinhole↔cylindrical blend and render with
   * the stock pinhole projection (the pre-blend look). A/B via `?flat=1`.
   */
  flatProjection?: boolean
  /**
   * Blend ramp overrides (vertical fov, deg) — a mid-range BUMP: pure pinhole
   * at/below `blendFovLo`, `blendMax` (≤1, 1 = full cylindrical) between
   * `blendFovHi` and `blendFovDownLo`, back to pure pinhole at/above
   * `blendFovDownHi` (the whole-window zoom-out stays pinhole, Spiideo
   * parity). Defaults from projection.ts; exposed for live eye-tuning on
   * /panorama-test.
   */
  blendFovLo?: number
  blendFovHi?: number
  blendMax?: number
  blendFovDownLo?: number
  blendFovDownHi?: number
  /**
   * Keystone (vertical perspective) strength — a pure homography, straight
   * lines stay straight. k > 0 narrows the near side / widens the far side
   * (reduces ground-trapezoid splay). Sensible range ~0–0.3. Default 0.
   */
  keystone?: number
  /**
   * Half-pitch watch framing: pan sub-window (RADIANS, panorama frame)
   * derived at watch time from the scene's active calibration midline. Only
   * narrows the mesh-derived pan limits (intersectPanWindow) — degenerate or
   * disjoint windows are ignored. The opening view centres in the window.
   */
  panWindow?: { minRad: number; maxRad: number }
}

/** Imperative surface controls, surfaced so DewarpControls can drive them from the shared bar. */
export interface DewarpSurfaceApi {
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
  toggleAuto: () => void
  toggleSpotlight: () => void
  toggleLock: () => void
}

const FOV_MIN = 12
const FOV_MAX = 100
/** Curved mode: full zoom-out shows the ENTIRE panorama window as a wide
 * PINHOLE, matching Spiideo's live viewer exactly (their cloud-control bundle
 * shader is pure `.xyzz` pinhole at every zoom — the "flattened cylinder"
 * look is the scene WINDOW boundary imaged as conics, not a projection; see
 * AIM_RESUME §0l). Spiideo ties the zoom-out floor to the window's tilt
 * height, so the cap is PER-SCENE (`curvedFovMax` from the mesh's tilt
 * extents): Nazwa −90°..+37° → 127°, HCT −26.5°..+20.4° → ~47°. A cap wider
 * than the window lets clampView's pan bounds collapse and drag a corner-
 * pinned aim during zoom (the corner-zoom "rotation"), with the frame mostly
 * black at extreme edge stretch. Straight world lines stay straight at every
 * zoom. */
/** Legacy motion-auto zoom target keeps the old ceiling — it should frame play,
 * never the whole-window overview. */
const CURVED_FOV_FOLLOW_MAX = 62
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

export interface SceneProjection {
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

/*
 * Fov-adaptive pinhole↔cylindrical view projection (uBlend b: 0 = pinhole,
 * 1 = cylindrical). Replaces three's `#include <project_vertex>` — the mesh
 * positions are world rays from the camera at origin, so modelViewMatrix
 * yields the camera-frame ray directly (dz = −mvPosition.z, camera looks
 * down −Z). Keeping w = dz makes b=0 bit-identical to the stock pipeline
 * (same NDC, same perspective-correct interpolation, behind-camera clipping
 * for free) — at b=0 this IS Spiideo's own captured `.xyzz` shader form.
 * Math twin: blendProject() in src/lib/panorama/projection.ts — keep in sync.
 */
const CYL_PROJECT_GLSL = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
mvPosition = modelViewMatrix * mvPosition;
if ( uBlend >= 0.999 ) {
  // PURE CYLINDRICAL (including the wide overview): atan2 covers the full
  // circle and w = hyp never flips sign, so rays past ±90° off-axis — the
  // overview's wing content, which the dz-form below cannot represent —
  // render correctly. Same NDC as the dz-form at b=1 on its shared domain
  // (xc/wc = theta/uHalf.x, yc/wc = tanphi/uHalf.y), just multiplied
  // through by w = hyp instead of w = dz. Collapse only true wrap-around
  // geometry (>149° off-axis, far outside any extent) to a same-side
  // off-screen point.
  float dxc = mvPosition.x;
  float dyc = mvPosition.y;
  float dzc = -mvPosition.z;
  float theta = atan( dxc, dzc );
  float hyp = length( vec2( dxc, dzc ) );
  if ( abs( theta ) > 2.6 || hyp < 1e-5 ) {
    float sx = dxc >= 0.0 ? 8.0 : -8.0;
    float sy = dyc >= 0.0 ? 8.0 : -8.0;
    gl_Position = vec4( sx, sy, 2.0, 1.0 );
  } else {
    float xc = theta * hyp / uHalf.x;
    float yc = dyc / uHalf.y;            // tanphi·hyp = dy
    float wc = hyp - uKey * yc;
    gl_Position = vec4( xc, yc, 0.5 * wc, wc );
  }
} else if ( -mvPosition.z <= 0.0 ) {
  // Behind the camera. The stock pinhole is a true projective map, so the
  // hardware clipper handles camera-plane-straddling triangles exactly — but
  // the blended x = theta·dz term is NOT projective, and those triangles get
  // garbage clip intersections that smear across the whole frame (the mesh
  // wraps ±135° + a full-wrap floor bowl, so they always exist). Collapse
  // behind-camera vertices to a far off-screen point ON THE VERTEX'S OWN
  // SIDE (sign of its camera-frame x/y): all-behind triangles vanish
  // (z=2 > w clips them), and straddling triangles stretch AWAY from the
  // frame instead of across it. Collapsing to centre (0,0) — the first
  // version — dragged straddler slivers through the visible frame once the
  // zoom-out cap exceeded ~62°: a straddling edge runs from its on/near-
  // screen vertex to the collapse point, so the collapse point must lie
  // beyond the frame on the same side, never at the centre.
  float sx = mvPosition.x >= 0.0 ? 8.0 : -8.0;
  float sy = mvPosition.y >= 0.0 ? 8.0 : -8.0;
  gl_Position = vec4( sx, sy, 2.0, 1.0 );
} else {
  float dx = mvPosition.x;
  float dy = mvPosition.y;
  float dz = -mvPosition.z;
  float theta = atan( dx, dz );
  float hyp = length( vec2( dx, dz ) );
  float tanphi = dy / hyp;
  // Projection multiplied through by w = dz (tan(theta)·dz = dx and
  // dz/cos(theta) = hyp); at uBlend = 0 this collapses to LITERALLY the
  // stock pinhole clip coords (dx/uHalf.x, dy/uHalf.y, ·, dz).
  float xc = ( ( 1.0 - uBlend ) * dx + uBlend * theta * dz ) / uHalf.x;
  float yc = ( ( 1.0 - uBlend ) * hyp + uBlend * dz ) * tanphi / uHalf.y;
  // Keystone: w' = w − k·y_clip is an exact homography on NDC (straight lines
  // stay straight); k > 0 narrows the near side / widens the far side.
  float wc = dz - uKey * yc;
  gl_Position = vec4( xc, yc, 0.5 * wc, wc );
}`

interface BlendUniforms {
  uBlend: { value: number }
  uHalf: { value: THREE.Vector2 }
  uKey: { value: number }
}

/** Patch a MeshBasicMaterial with the blend projection. Must be applied to BOTH
 *  the base and the seam-blend materials or the seam overlay diverges. */
function patchBlendProjection(
  mat: THREE.MeshBasicMaterial,
  uniforms: BlendUniforms
) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBlend = uniforms.uBlend
    shader.uniforms.uHalf = uniforms.uHalf
    shader.uniforms.uKey = uniforms.uKey
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uBlend;\nuniform vec2 uHalf;\nuniform float uKey;'
      )
      .replace('#include <project_vertex>', CYL_PROJECT_GLSL)
  }
  // Stock MeshBasicMaterial programs must not be reused for the patched shader.
  mat.customProgramCacheKey = () => 'cyl-blend-v2'
}

export interface PanoramaView {
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

/** Optional per-scene render tuning, served next to the mesh files
 *  (scripts/vp-calibration/color_match_overlap.py). All values LINEAR-light
 *  (the sRGB video texture is hardware-decoded before they apply).
 *  colorGains: per-projection RGB multipliers — the simple cross-camera
 *  exposure match; rides the vertex-colour path in the seam-blend material.
 *  Normalised so the BASE projection (the last, drawn opaque) is [1,1,1].
 *  colorLuts: per-projection tone curves for cameras whose difference is
 *  brightness-dependent (HCT: ratio ~1.8 in shadows → ~1.1 in highlights —
 *  no gain can flatten that seam). `rgb` = size×3 linear outputs indexed by
 *  the sRGB-encoded input; applied as a fragment LUT on the overlay
 *  material. */
interface MeshTuning {
  colorGains?: number[][]
  colorLuts?: ({ size: number; encoding: string; rgb: number[] } | null)[]
}

/** Validate + build the overlay tone-LUT texture from tuning.colorLuts (first
 *  non-null overlay entry). CDN-served and unvalidated, so anything malformed
 *  → null (identity), never NaN into a texture. */
function buildLutTexture(
  tuning: MeshTuning | null | undefined,
  nProjs: number
): THREE.DataTexture | null {
  const luts = tuning?.colorLuts
  if (!Array.isArray(luts)) return null
  for (let pi = 0; pi < nProjs - 1; pi++) {
    const l = luts[pi]
    if (!l || l.encoding !== 'srgb-index' || !Array.isArray(l.rgb)) continue
    const size = l.size
    if (!Number.isInteger(size) || size < 2 || size > 4096) continue
    if (l.rgb.length !== size * 3) continue
    const data = new Uint16Array(size * 4)
    let ok = true
    for (let i = 0; i < size; i++) {
      for (let c = 0; c < 3; c++) {
        const v = Number(l.rgb[i * 3 + c])
        if (!Number.isFinite(v) || v < 0 || v > 4) {
          ok = false
          break
        }
        data[i * 4 + c] = THREE.DataUtils.toHalfFloat(v)
      }
      if (!ok) break
      data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1)
    }
    if (!ok) continue
    // half-float: filterable in core WebGL2 (FloatType would need
    // OES_texture_float_linear) with ~10-bit precision — beats 8-bit
    const tex = new THREE.DataTexture(
      data,
      size,
      1,
      THREE.RGBAFormat,
      THREE.HalfFloatType
    )
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    tex.needsUpdate = true
    return tex
  }
  return null
}

/** Patch the overlay material with the per-channel tone LUT: sample by the
 *  sRGB-encoded texel value (shadow-resolving index) right after
 *  map_fragment, i.e. on the LINEAR texel before the vertex-colour multiply.
 *  Chains any existing onBeforeCompile (the blend projection patch). */
function patchColorLut(mat: THREE.MeshBasicMaterial, lut: THREE.DataTexture) {
  const prevCompile = mat.onBeforeCompile
  const prevKey = mat.customProgramCacheKey.bind(mat)
  mat.onBeforeCompile = (shader, renderer) => {
    prevCompile?.call(mat, shader, renderer)
    shader.uniforms.uColorLut = { value: lut }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform sampler2D uColorLut;'
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
{
  // half-texel-centred index into the tone LUT (see MeshTuning.colorLuts)
  vec3 lutIdx = pow( clamp( diffuseColor.rgb, 0.0, 1.0 ), vec3( 1.0 / 2.4 ) );
  lutIdx = lutIdx * ${'0.99609375'} + ${'0.001953125'};
  diffuseColor.rgb = vec3(
    texture2D( uColorLut, vec2( lutIdx.r, 0.5 ) ).r,
    texture2D( uColorLut, vec2( lutIdx.g, 0.5 ) ).g,
    texture2D( uColorLut, vec2( lutIdx.b, 0.5 ) ).b
  );
}`
      )
  }
  mat.customProgramCacheKey = () => `${prevKey()}|lut-v1`
}

export function buildExactPanorama(
  vbuf: ArrayBuffer,
  ibuf: ArrayBuffer,
  sceneProjs: SceneProjection[],
  tuning?: MeshTuning | null
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
  // per-projection triangle-referenced vertex masks (filled by the map below)
  const refMasks: Uint8Array[] = []
  // per-projection colour gains, sanitised: tuning.json is CDN-served and
  // unvalidated at runtime — a non-numeric/negative/huge entry must degrade
  // to identity, not write NaN into the vertex buffer (black/flickering seam)
  const saneGain = (x: unknown): number => {
    const v = Number(x)
    return Number.isFinite(v) && v > 0 && v < 4 ? v : 1
  }
  const projGains = projs.map((P) => {
    const g = tuning?.colorGains?.[P.pi]
    return [saneGain(g?.[0]), saneGain(g?.[1]), saneGain(g?.[2])]
  })
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
      // Spiideo's baked feather alpha (f4); rgb = the per-projection colour
      // gain (cross-camera exposure match — identity when no tuning; LINEAR-
      // light values, since the sRGB texture is hardware-decoded before the
      // vertex colour multiplies). Only the seam-blend material reads vertex
      // colours, and the tool normalises the base projection to [1,1,1], so
      // the opaque base stays untouched.
      const a = F[j * 5 + 4]
      const gain = projGains[P.pi]
      rgba[k * 4] = gain[0]
      rgba[k * 4 + 1] = gain[1]
      rgba[k * 4 + 2] = gain[2]
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
    // triangle-referenced mask: culled vertices remain in vertices.bin with
    // garbage f0/f1/UV (2026-07-12 invariant) — extents below must skip them
    const mask = new Uint8Array(P.count)
    for (const t of tris) mask[t] = 1
    refMasks[P.pi] = mask
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

  // angular extents of the panorama about (forward, right, up) → pan/tilt
  // limits. TRIANGLE-REFERENCED vertices only: culled vertices keep garbage
  // f0/f1 in vertices.bin, and these extents now also set the zoom-out cap
  // (curvedFovMax) and the opening tilt — garbage would silently inflate both.
  let panMin = Infinity,
    panMax = -Infinity,
    tiltMin = Infinity,
    tiltMax = -Infinity
  const d = new THREE.Vector3()
  for (const P of projs)
    for (let j = P.vStart; j < P.vStart + P.count; j++) {
      if (!refMasks[P.pi][j - P.vStart]) continue
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
  flatProjection = false,
  blendFovLo = BLEND_FOV_LO,
  blendFovHi = BLEND_FOV_HI,
  blendMax = BLEND_MAX_DEFAULT,
  blendFovDownLo = BLEND_FOV_DOWN_LO,
  blendFovDownHi = BLEND_FOV_DOWN_HI,
  keystone = 0,
  panWindow,
}: VirtualPanoramaPlayerProps) {
  const t = useTranslations('player')
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
  // scene-derived zoom-out cap (deg) — set from the mesh's tilt window on
  // load (see curvedFovMax); the ceiling is only a pre-load fallback
  const curvedFovMaxRef = useRef(CURVED_FOV_MAX_CEIL)

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
  // Reg-SIFT aim track (Spiideo's own camera path, computed offline) — when
  // present it replaces the motion-follow driver for Auto mode.
  const aimTrackRef = useRef<AimTrack | null>(null)
  const [hasAimTrack, setHasAimTrack] = useState(false)
  useEffect(() => {
    autoFollowRef.current = autoFollow
  }, [autoFollow])
  // Player spotlight (per-player tracklets, computed offline): armed = the
  // toggle is on and clicks select a player; the selection itself lives in a
  // ref (updated every RAF frame — fragment hand-off must not re-render).
  const trackletsRef = useRef<Tracklets | null>(null)
  const [hasTracklets, setHasTracklets] = useState(false)
  const [spotlight, setSpotlight] = useState(false)
  const spotlightRef = useRef(false)
  useEffect(() => {
    spotlightRef.current = spotlight
  }, [spotlight])
  const spotSelRef = useRef<{
    index: number
    slot: string | null // identity slot (Tier 3): fragments sharing it are the
    // same player by strict (number, kit) labelling — the follow rides the slot
    follow: boolean
    lock: boolean // camera zoom-LOCK on the player (Tier 1b) — off = ring+aim only
    frameFov: number // committed fov goal (deg) for the lock; 0 = seed (reset damp)
    relaxFov: number // >0 = ease the (unlocked) fov back to this wide value once,
    // then clear — the "zoom back out" transient after an explicit Lock-off
    lastPan: number // deg — last known position, drives re-association
    lastTilt: number
    vPan: number // deg/s — EMA angular velocity (projects the gap search)
    vTilt: number
    lostSince: number | null // clock seconds when the fragment ran out
    coastDeg: number // deg of aim coast spent this loss (capped, then freeze)
    lastClock: number | null // detects seeks (a jump invalidates the selection)
    hops: number // identity confidence decays per hand-off — hard cap 2
    adoptedAt: number // clock when the current chain was adopted (min dwell)
    fadeUntil: number // performance.now() ms — ring fades in after a >1° hop
  } | null>(null)
  // React mirrors of the (ref-held) selection, so the Lock affordance can render
  // its pressed state + gate on "a player is selected" without per-frame churn.
  // Updated (deduped) from the RAF overlay pass, like spotNotice.
  const [hasSelection, setHasSelection] = useState(false)
  const hasSelectionRef = useRef(false)
  const [spotLock, setSpotLock] = useState(false)
  const spotLockRef = useRef(false)
  // Double-tap accelerator: a second select within this window locks the camera.
  const lastSelectTapRef = useRef(0)
  const DOUBLE_TAP_MS = 350
  // Status pill state machine: base kind is derived every frame in the
  // overlay update ('hint' armed+unselected, 'nodata' armed in an untracked
  // stretch, null otherwise); transient kinds override it briefly.
  type SpotNotice =
    'hint' | 'nodata' | 'following' | 'locked' | 'searching' | 'lost' | null
  const [spotNotice, setSpotNotice] = useState<SpotNotice>(null)
  const spotNoticeRef = useRef<SpotNotice>(null)
  const spotNoticeOverride = useRef<{ kind: SpotNotice; until: number } | null>(
    null
  )
  // Set inside the render effect (needs the live camera): screen NDC -> the
  // dewarp pan/tilt (deg) under the pointer. Null until the scene is built.
  const pickRef = useRef<
    | ((
        nx: number,
        ny: number
      ) => {
        panDeg: number
        tiltDeg: number
      } | null)
    | null
  >(null)
  const spotSvgRef = useRef<SVGSVGElement | null>(null)

  const dismissHint = useCallback(() => setShowHint(false), [])
  const syncZoom = useCallback(
    () =>
      setZoomPct(
        Math.round(
          ((curved ? curvedFovMaxRef.current : FOV_MAX) / viewRef.current.fov) *
            100
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
      // the view's angular size (collapsing to the midpoint when it inverts).
      // Holds under the fov-adaptive blend too: horizontally, the frame's
      // ANGULAR half-extent is invariant in the blend by construction (the
      // edge ray at hHalf always projects to the frame edge — see the
      // extent-invariance test in projection.test.ts); vertically, the
      // blended frame's max elevation anywhere is atan(yHalf_blend) <
      // atan(tan(fov/2)) = vHalf (yHalf shrinks with b and sy ≥ 1), so the
      // pinhole margin stays conservative. Caveat (pre-existing): hHalf
      // assumes 16:9 while the render uses the live canvas aspect — fine
      // while the container enforces aspect-video.
      const fov = clamp(v.fov, FOV_MIN, curvedFovMaxRef.current)
      const vHalf = (fov / 2) * DEG
      // horizontal half-extent matches the render exactly, including the
      // overview widening (blendPanHalfAngleDeg is the render's clamp twin)
      const b = flatProjection
        ? 0
        : blendFactor(
            fov,
            blendFovLo,
            blendFovHi,
            blendMax,
            blendFovDownLo,
            blendFovDownHi
          )
      const hHalf = blendPanHalfAngleDeg(fov, 16 / 9, b) * DEG
      const panMid = (l.minPan + l.maxPan) / 2
      const tiltMid = (l.minTilt + l.maxTilt) / 2
      const panMin = Math.min(l.minPan + hHalf, panMid)
      const panMax = Math.max(l.maxPan - hHalf, panMid)
      // tilt-down is FREE to the window floor (aim straight below the
      // camera; the frame bottom past the nadir shows honest black, exactly
      // like the pan ends past the mesh) — only the ceiling keeps the
      // frame-on-mesh rule (sky-black above the top edge is useless).
      const tiltMin = Math.min(l.minTilt, tiltMid)
      const tiltMax = Math.max(l.maxTilt - vHalf, tiltMid)
      return {
        pan: clamp(v.pan, panMin, panMax),
        tilt: clamp(v.tilt, tiltMin, tiltMax),
        fov,
      }
    },
    [
      curved,
      flatProjection,
      blendFovLo,
      blendFovHi,
      blendMax,
      blendFovDownLo,
      blendFovDownHi,
    ]
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
          setError(t('loadFailed'))
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
      setError(t('loadFailed'))
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
    let lutTexRef: THREE.DataTexture | null = null

    ;(async () => {
      try {
        const [scene_, vbuf, ibuf, tuning, aimTrack, tracklets] =
          await Promise.all([
            fetch(`${meshBaseUrl}/scene.json`).then(
              (r) => r.json() as Promise<SceneJson>
            ),
            fetch(`${meshBaseUrl}/vertices.bin`).then((r) => r.arrayBuffer()),
            fetch(`${meshBaseUrl}/indices.bin`).then((r) => r.arrayBuffer()),
            // optional per-scene render tuning (multi-cam colour match) —
            // absent for most scenes, never load-blocking: 404/bad-JSON → null,
            // and the timeout stops a hung CDN request from stalling every
            // scene's mesh load (this sits in the same Promise.all)
            fetch(`${meshBaseUrl}/tuning.json`, {
              signal: AbortSignal.timeout(3000),
            })
              .then((r) => (r.ok ? (r.json() as Promise<MeshTuning>) : null))
              .catch(() => null),
            // optional reg-SIFT aim track (same optional-artifact contract, but
            // a LARGER payload — ~1MB for a 2h match — so it gets a longer
            // timeout than tuning.json; still null-degrading, never blocking)
            fetch(`${meshBaseUrl}/aim-track.json`, {
              signal: AbortSignal.timeout(10000),
            })
              .then((r) => (r.ok ? r.json() : null))
              .then((j) => parseAimTrack(j))
              .catch(() => null),
            // optional per-player tracklets (spotlight) — the largest optional
            // artifact (~2MB gzipped for a full match), hence the longest
            // timeout; still null-degrading, never blocking
            fetch(`${meshBaseUrl}/tracklets.json`, {
              signal: AbortSignal.timeout(15000),
            })
              .then((r) => (r.ok ? r.json() : null))
              .then((j) => parseTracklets(j))
              .catch(() => null),
          ])
        if (disposed) return
        aimTrackRef.current = aimTrack
        setHasAimTrack(aimTrack !== null)
        trackletsRef.current = tracklets
        // A selection indexes into the PREVIOUS artifact — stale indices
        // into a refetched object list would ring the wrong body (and a
        // slot-bearing selection no longer expires on the 60s clock).
        spotSelRef.current = null
        setHasTracklets(tracklets !== null)
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
        // Shared by all patched materials; written every frame in the loop.
        const projUniforms: BlendUniforms = {
          uBlend: { value: 0 },
          uHalf: { value: new THREE.Vector2(1, 1) },
          uKey: { value: 0 },
        }
        if (curved && projs && projs.length >= 1) {
          // Exact reproduction of Perform's de-warp shader (see buildExactPanorama).
          const view = buildExactPanorama(
            vbuf,
            ibuf,
            projs as unknown as SceneProjection[],
            tuning
          )
          panoRef.current = view
          // pan/tilt limits from the panorama's real angular extents; the
          // optional half-pitch focus window may only NARROW the pan range
          const focusPan = intersectPanWindow(
            view.panMin,
            view.panMax,
            panWindow
          )
          limitsRef.current = {
            minPan: focusPan.minPan,
            maxPan: focusPan.maxPan,
            minTilt: view.tiltMin,
            maxTilt: view.tiltMax,
          }
          // zoom-out floor = the window's tilt height (Spiideo semantics):
          // Nazwa → 127, HCT → ~47. A wider cap collapses the pan clamp and
          // drags a corner-pinned aim during zoom (the "rotation" percept).
          curvedFovMaxRef.current = curvedFovMax(view.tiltMin, view.tiltMax)
          // open at a flat broadcast-style zoom (a wide fov fisheyes the
          // edges), aimed at the pitch band — the mesh ceiling now extends to
          // the capture boundary (~+30°), so tilt 0 would open on the skyline.
          // −20° suits tall down-looking windows (Nazwa/FP, whose vertical
          // midpoints are ≈−26°); never open BELOW the window's midpoint —
          // short elevated windows (HCT, mid ≈+6°) put the pitch band there,
          // and −20° would open on the floor with the frame half black.
          // NOTE pan/tilt are RADIANS (fov is degrees).
          const openTilt = Math.max(
            -20 * DEG,
            (view.tiltMin + view.tiltMax) / 2
          )
          // half-pitch focus opens centred in its window, not on the mesh mid
          const openPan = panWindow
            ? (focusPan.minPan + focusPan.maxPan) / 2
            : 0
          viewRef.current = clampView({ pan: openPan, tilt: openTilt, fov: 46 })
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
          // Fov-adaptive projection: NOT in inspect (the orbit camera needs the
          // real projectionMatrix on these same meshes). The shader ignores the
          // camera's projectionMatrix, so disable three's pinhole-frustum CPU
          // culling — the blend frame can see geometry the pinhole frustum cuts.
          if (!inspect && !flatProjection) {
            patchBlendProjection(material, projUniforms)
            patchBlendProjection(blend, projUniforms)
            for (const m of meshes) m.frustumCulled = false
          }
          // Cross-camera tone LUT (tuning.colorLuts) on the OVERLAY material —
          // chained after any blend patch. All overlays share one material, so
          // the first valid overlay LUT applies (real LUTs only exist on
          // 2-camera scenes, which have exactly one overlay).
          const lutTex = buildLutTexture(tuning, gs.length)
          if (lutTex) {
            lutTexRef = lutTex
            patchColorLut(blend, lutTex)
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
          const v = viewRef.current
          const next = clampView({
            ...v,
            fov: v.fov / Math.exp(-e.deltaY * 0.0015),
          })
          // Zoom about the CURSOR, not the frame centre (map-style): keep the
          // world direction under the pointer fixed while the fov changes.
          // Centre-anchored zoom slides off-centre content radially outward,
          // which at the frame edges reads as the view "rotating".
          // atan(n·tan(fov/2)) = the cursor ray's angular offset from the view
          // axis; the aim absorbs the offset change. Signs follow the grab-
          // drag convention above (+pan moves content right, +tilt moves it
          // down); clampView still bounds the adjusted aim.
          const rect = host.getBoundingClientRect()
          if (next.fov !== v.fov && rect.width > 0 && rect.height > 0) {
            const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1
            const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1 // +down
            const aspect = rect.width / rect.height
            const tanOld = Math.tan((v.fov / 2) * DEG)
            const tanNew = Math.tan((next.fov / 2) * DEG)
            const dPan =
              Math.atan(nx * tanOld * aspect) - Math.atan(nx * tanNew * aspect)
            const dTilt = Math.atan(ny * tanOld) - Math.atan(ny * tanNew)
            viewRef.current = clampView({
              pan: next.pan - dPan,
              tilt: next.tilt - dTilt,
              fov: next.fov,
            })
          } else {
            viewRef.current = next
          }
          // Manual zoom while locked = the user takes zoom control: release the
          // zoom-lock but KEEP the aim-follow (re-engage via Lock/double-tap).
          // A silent drop is confusing, so caption it when it was actually on.
          const sw = spotSelRef.current
          if (sw?.follow) {
            const wasLocked = sw.lock
            sw.lock = false
            sw.relaxFov = 0
            if (wasLocked)
              spotNoticeOverride.current = {
                kind: 'following',
                until: Date.now() + 2500,
              }
          }
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
                  const fovT = clamp(
                    34 + spread * 70,
                    30,
                    Math.min(CURVED_FOV_FOLLOW_MAX, curvedFovMaxRef.current)
                  )
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
        const stepAim = (track: AimTrack) => {
          // Deterministic Auto: sample Spiideo's recovered camera path at the
          // MASTER clock (the produced video the control bar scrubs) — the
          // slave raw-VP video may drift up to 1.5s. smoothDamp irons out
          // seeks and the 5 Hz track quantization; clampView keeps the frame
          // on the mesh exactly like every other driver.
          const clock =
            masterVideoRef?.current?.currentTime ?? video.currentTime
          const aim = sampleAimTrack(track, clock)
          const v = viewRef.current,
            dt = 1 / 60
          viewRef.current = clampView({
            pan: smoothDamp(v.pan, aim.panDeg * DEG, velP, 0.25, dt),
            tilt: smoothDamp(v.tilt, aim.tiltDeg * DEG, velT, 0.25, dt),
            fov: smoothDamp(v.fov, aim.fovDeg, velF, 0.6, dt),
          })
          if (followFrame++ % 8 === 0) syncZoom()
        }
        // --- player spotlight: click-to-select ring + trail + camera-follow ---
        // Objects are identity FRAGMENTS: when the followed one ends,
        // re-associate to the nearest object at the last known position
        // (the tracker almost always re-detects the same player in place);
        // past the gate for a few seconds → the selection is honestly LOST.
        const SPOT_FOLLOW_SMOOTH = 0.35
        // Zoom is driven SLOWER than the aim (cinematic; avoids visible zoom
        // jitter) — see prior-art in framing.ts. The lost/searching widen eases
        // slower still, so a brief occlusion doesn't yank the frame wide.
        const SPOT_FOV_SMOOTH = 0.9
        const SPOT_FOV_SEARCH_SMOOTH = 1.1
        const SPOT_REASSOC_DEG = 2.0
        const SPOT_LOST_SEC = 3
        // WATCHING window (eyes-on finding, 2026-07-18): the tracker drops
        // STATIONARY players (goalkeepers!) for tens of seconds routinely —
        // measured on the HCT pilot: inter-fragment gaps at the goal cells
        // have median 15-56s and 80% exceed the 3s drop window, while the
        // player is plainly visible. Past SPOT_LOST_SEC the selection is not
        // dropped; it WATCHES the frozen spot for up to SPOT_WATCH_SEC and
        // re-acquires ONLY on strong evidence: a slot-mate, or a CO-LOCATED
        // pickup at the frozen position with no rival nearby (after a long
        // gap the co-location IS the identity evidence; stale velocity is
        // not, so the velocity gate deliberately does not apply). No 2°
        // wandering re-assoc past SPOT_LOST_SEC — that would be guessing.
        const SPOT_WATCH_SEC = 60
        const SPOT_WATCH_COLOCATED_DEG = 1.0
        // Post-loss coast: decay the terminal velocity and CAP total coast
        // displacement at the re-assoc radius, so a lost aim eases to a stop
        // near where the player vanished instead of walking to the frame edge
        // chasing nobody (then the widen reveals that spot for a re-tap).
        const SPOT_COAST_SEC = 0.6
        const SPOT_COAST_DECAY = 0.9 // per 1/60s frame
        const SPOT_COAST_MAX_DEG = SPOT_REASSOC_DEG
        // A pickup within this angular distance is the SAME player re-indexed in
        // place (a fresh fragment id, not an identity jump) — adopt it without
        // spending a hop, so a player re-fragmenting in place stays followed.
        const SPOT_COLOCATED_DEG = 0.5
        // Overlay dots closer than this on screen are the same body (or the
        // ring's own player) — merged, killing the "two trackers on one player".
        const SPOT_DOT_MERGE_PX = 12
        // Distinguishes a real seek from a suspended RAF (backgrounded tab).
        let lastRafMs = performance.now()
        // The SLAVE raw-VP video is what the user SEES (its frames feed the
        // WebGL texture) and it may lag the master by up to 1.5s (the loose
        // drift guard). The ring must sit on the VISIBLE player, so spotlight
        // samples at the slave clock — unlike stepAim, whose whole-frame
        // camera aim tolerates the lead and stays on the master transport.
        const spotClock = () => video.currentTime
        const stepSpotlight = () => {
          const track = trackletsRef.current
          const sel = spotSelRef.current
          if (!track || !sel) return
          const clock = spotClock()
          // A clock JUMP (seek/skip) invalidates the selection: re-associating
          // at the OLD position after a scrub confidently rings whoever is
          // standing there minutes later — worse than honestly letting go.
          // Exception: a suspended RAF (backgrounded tab) reads as the same
          // jump while playback was CONTINUOUS — resync and keep tracking.
          if (sel.lastClock !== null && Math.abs(clock - sel.lastClock) > 2.5) {
            const rafWasSuspended = performance.now() - lastRafMs > 2000
            if (!rafWasSuspended) {
              spotSelRef.current = null
              return
            }
          }
          const dtClock = sel.lastClock === null ? 0 : clock - sel.lastClock
          sel.lastClock = clock
          const s = sampleObject(track.objects[sel.index], clock)
          if (s) {
            // Track angular velocity (EMA) while locked — it projects the
            // search centre during hand-off gaps (a sprinter's true
            // continuation exits a static cone in well under a second).
            if (dtClock > 1e-3) {
              const a = 0.3
              sel.vPan =
                sel.vPan * (1 - a) + ((s.panDeg - sel.lastPan) / dtClock) * a
              sel.vTilt =
                sel.vTilt * (1 - a) + ((s.tiltDeg - sel.lastTilt) / dtClock) * a
            }
            sel.lastPan = s.panDeg
            sel.lastTilt = s.tiltDeg
            // Recovering from a coast: re-seed the fov goal so the locked drive
            // restarts the zoom damp cleanly (fires the frameFov<=0 velF reset),
            // easing from the widened "searching" fov back to the frame.
            if (sel.lostSince !== null) sel.frameFov = 0
            sel.lostSince = null
            sel.coastDeg = 0
          } else {
            if (sel.lostSince === null) {
              sel.lostSince = clock
              sel.coastDeg = 0 // fresh coast budget for this loss episode
            }
            const gap = Math.abs(clock - sel.lostSince)
            // Coast the ring a SHORT, DECAYING distance through the gap — do NOT
            // project the terminal velocity at full strength (that walks the aim
            // to the frame edge, tracking nobody). Total coast displacement is
            // capped at the re-assoc radius; past that we would be inventing
            // motion, so freeze and let the widen reveal the spot for a re-tap.
            if (gap <= SPOT_COAST_SEC && dtClock > 0) {
              const decay = Math.pow(SPOT_COAST_DECAY, dtClock * 60)
              sel.vPan *= decay
              sel.vTilt *= decay
              const stepPan = sel.vPan * dtClock
              const stepTilt = sel.vTilt * dtClock
              const mag = Math.hypot(stepPan, stepTilt)
              const left = SPOT_COAST_MAX_DEG - sel.coastDeg
              if (mag > 0 && left > 0) {
                const k = Math.min(1, left / mag)
                sel.lastPan += stepPan * k
                sel.lastTilt += stepTilt * k
                sel.coastDeg += mag * k
              }
            }
            // SLOT hand-off first (Tier 3): a live fragment carrying the same
            // slot IS the followed player — the strict (number, kit) label
            // does not decay with gap length, so adopt at any distance with
            // no ambiguity/velocity/dwell gates and no hop spent. This is
            // what makes the follow survive occlusions geometry cannot.
            let slotAdopted = false
            let slotDeferred = false
            if (sel.slot) {
              const mate = slotMate(
                track,
                clock,
                sel.slot,
                sel.lastPan,
                sel.lastTilt,
                sel.index
              )
              if (mate) {
                const jump = Math.hypot(
                  mate.panDeg - sel.lastPan,
                  mate.tiltDeg - sel.lastTilt
                )
                // Beyond-geometry jumps (> 2× the re-assoc radius) are moves
                // the old system could never make. Two guards on them:
                // (a) anti-ping-pong dwell — an impure slot (two real bodies
                //     sharing a number+kit) would otherwise yank the camera
                //     cross-pitch on every fragment death; rate-limit long
                //     adoptions to once per dwell period (UX review),
                // (b) a visible caption when one happens (below) — a silent
                //     cross-pitch glide reads as the camera going rogue.
                const longJump = jump > SPOT_REASSOC_DEG * 2
                if (longJump && clock - sel.adoptedAt < 2) {
                  slotDeferred = true // mate exists — keep the selection alive
                } else {
                  sel.index = mate.index
                  sel.lastPan = mate.panDeg
                  sel.lastTilt = mate.tiltDeg
                  sel.lostSince = null
                  sel.coastDeg = 0
                  sel.frameFov = 0 // recovered → re-seed the zoom damp
                  sel.adoptedAt = clock
                  if (jump > 1) sel.fadeUntil = performance.now() + 350
                  if (longJump)
                    spotNoticeOverride.current = {
                      kind: 'following',
                      until: Date.now() + 2500,
                    }
                  slotAdopted = true
                }
              }
            }
            // ONE-SHOT re-association with ambiguity refusal: the server
            // already bridged everything unambiguous, so what reaches the
            // client is by construction harder — be stricter, and refuse
            // rather than risk following a stranger. Geometry re-assoc only
            // runs inside the short loss window; past it the WATCHING state
            // below owns re-acquisition (co-located or slot-mate only).
            const cand =
              slotAdopted || gap > SPOT_LOST_SEC
                ? null
                : nearestObject(
                    track,
                    clock,
                    sel.lastPan,
                    sel.lastTilt,
                    SPOT_REASSOC_DEG,
                    sel.index
                  )
            if (cand) {
              const d1 = Math.hypot(
                cand.panDeg - sel.lastPan,
                cand.tiltDeg - sel.lastTilt
              )
              const rival = nearestObject(
                track,
                clock,
                sel.lastPan,
                sel.lastTilt,
                SPOT_REASSOC_DEG * 2,
                cand.index
              )
              // A labelled pickup carrying a DIFFERENT slot is a proven other
              // player — geometry proximity cannot override the label.
              const slotConflict =
                sel.slot !== null &&
                cand.slot !== undefined &&
                cand.slot !== sel.slot
              const ambiguous =
                slotConflict ||
                (rival &&
                  rival.index !== sel.index &&
                  Math.hypot(
                    rival.panDeg - sel.lastPan,
                    rival.tiltDeg - sel.lastTilt
                  ) < Math.max(2 * d1, d1 + 0.8))
              // velocity consistency: the pickup must MOVE like the player
              // we lost (a sprinter must not hand off to a stander)
              const n1 = sampleObject(track.objects[cand.index], clock + 0.2)
              const cv = n1
                ? {
                    p: (n1.panDeg - cand.panDeg) / 0.2,
                    t: (n1.tiltDeg - cand.tiltDeg) / 0.2,
                  }
                : null
              const velOk =
                !cv || Math.hypot(cv.p - sel.vPan, cv.t - sel.vTilt) <= 5
              const dwellOk = clock - sel.adoptedAt >= 2
              // A pickup at essentially the SAME spot is the tracker re-indexing
              // the same player in place (a fresh fragment id), not an identity
              // jump — adopt it immediately (exempt from the dwell timer) and
              // don't spend an identity-hop on it, so a player re-fragmenting in
              // place stays followed. The ambiguity + velocity gates still guard.
              const coLocated = d1 < SPOT_COLOCATED_DEG
              if (
                !ambiguous &&
                velOk &&
                (dwellOk || coLocated) &&
                sel.hops < 2
              ) {
                sel.index = cand.index
                // Upgrade identity ONLY on the co-located evidence tier — a
                // same-spot re-index is the same body; an ordinary 2° hop is
                // heuristic, and inheriting a slot from it would convert one
                // wrong pickup into permanent confident wrong identity
                // (CV + senior reviews, 2026-07-18).
                if (coLocated && cand.slot !== undefined) sel.slot = cand.slot
                sel.lastPan = cand.panDeg
                sel.lastTilt = cand.tiltDeg
                sel.lostSince = null
                sel.coastDeg = 0
                sel.frameFov = 0 // recovered via re-assoc → re-seed the zoom damp
                if (!coLocated) sel.hops += 1 // a re-index in place is not a hop
                sel.adoptedAt = clock
                if (d1 > 1) sel.fadeUntil = performance.now() + 350 // hop = fade, not swoosh
              }
              // A refused/gated candidate no longer ends the follow — the
              // WATCHING window below owns the endgame (an ambiguous crossing
              // resolves when the player re-emerges at the frozen spot or a
              // slot-mate appears; dropping at 3s threw away goalkeepers).
            } else if (!slotAdopted && gap > SPOT_LOST_SEC) {
              // WATCHING: co-located re-acquisition at the frozen spot. The
              // tracker drops stationary players for tens of seconds (HCT
              // measured: median goal-cell gap 15-56s) — a body reappearing
              // exactly where the lost one stood, with no rival nearby, is
              // the same evidence tier as the co-located re-index (velocity
              // gate deliberately absent: after a long gap the co-location
              // IS the evidence and the stale velocity is meaningless).
              const pickup = nearestObject(
                track,
                clock,
                sel.lastPan,
                sel.lastTilt,
                SPOT_WATCH_COLOCATED_DEG,
                sel.index
              )
              if (pickup) {
                const d1 = Math.hypot(
                  pickup.panDeg - sel.lastPan,
                  pickup.tiltDeg - sel.lastTilt
                )
                const rival = nearestObject(
                  track,
                  clock,
                  sel.lastPan,
                  sel.lastTilt,
                  SPOT_WATCH_COLOCATED_DEG * 2,
                  pickup.index
                )
                const slotConflict =
                  sel.slot !== null &&
                  pickup.slot !== undefined &&
                  pickup.slot !== sel.slot
                const ambiguous =
                  slotConflict ||
                  (rival &&
                    rival.index !== sel.index &&
                    Math.hypot(
                      rival.panDeg - sel.lastPan,
                      rival.tiltDeg - sel.lastTilt
                    ) < Math.max(2 * d1, d1 + 0.8))
                if (!ambiguous) {
                  sel.index = pickup.index
                  if (pickup.slot !== undefined) sel.slot = pickup.slot
                  sel.lastPan = pickup.panDeg
                  sel.lastTilt = pickup.tiltDeg
                  sel.lostSince = null
                  sel.coastDeg = 0
                  sel.frameFov = 0
                  sel.adoptedAt = clock
                  sel.fadeUntil = performance.now() + 350
                }
              }
              // A slot-bearing selection outlives the 60s cap: the slot
              // label is proof whenever its next fragment appears, and
              // goalkeepers go UNTRACKED for minutes while play is away
              // (measured HCT: multi-minute holes between keeper
              // fragments). But it must NOT outlive the slot itself: once
              // the clock passes the slot's LAST fragment (track.slotEnd)
              // the label provably cannot re-appear — a per-half GK slot
              // after half time, a subbed-off jersey — and watching on
              // would eventually confidently adopt whoever stands at the
              // frozen goalmouth (the other team's keeper). Geometry-only
              // selections keep the 60s cap — past it a co-located pickup
              // is a guess about whoever wandered in.
              const slotExhausted =
                sel.slot !== null &&
                clock > (track.slotEnd[sel.slot] ?? -Infinity) + SPOT_WATCH_SEC
              if (
                spotSelRef.current === sel &&
                sel.lostSince !== null &&
                (sel.slot === null ? gap > SPOT_WATCH_SEC : slotExhausted) &&
                !slotDeferred
              ) {
                spotSelRef.current = null // truly gone — drop the ring
                spotNoticeOverride.current = {
                  kind: 'lost',
                  until: Date.now() + 3000,
                }
                return
              }
            }
          }
          if (sel.follow && sel.lostSince === null) {
            const v = viewRef.current,
              dt = 1 / 60
            if (sel.lock) {
              // LOCKED: drive fov to frame the player (context framing + a
              // distortion cap + speed widen) and lead the aim in the motion
              // direction. framing.ts clamps targetFov to the scene range, so
              // clampView is a no-op on fov (a clamped goal would stall the
              // damper). Seed frameFov (<=0) resets velF for a clean zoom start.
              const l = limitsRef.current
              if (sel.frameFov <= 0) velF.v = 0
              const f = computeFraming({
                panDeg: sel.lastPan,
                tiltDeg: sel.lastTilt,
                vPanDeg: sel.vPan,
                vTiltDeg: sel.vTilt,
                limitsDeg: {
                  minPan: l.minPan / DEG,
                  maxPan: l.maxPan / DEG,
                  minTilt: l.minTilt / DEG,
                  maxTilt: l.maxTilt / DEG,
                },
                sceneFovMax: curvedFovMaxRef.current,
                prevGoalFov: sel.frameFov,
              })
              sel.frameFov = f.targetFov
              viewRef.current = clampView({
                pan: smoothDamp(
                  v.pan,
                  f.aimPanDeg * DEG,
                  velP,
                  SPOT_FOLLOW_SMOOTH,
                  dt
                ),
                tilt: smoothDamp(
                  v.tilt,
                  f.aimTiltDeg * DEG,
                  velT,
                  SPOT_FOLLOW_SMOOTH,
                  dt
                ),
                fov: smoothDamp(v.fov, f.targetFov, velF, SPOT_FOV_SMOOTH, dt),
              })
            } else {
              // UNLOCKED (default tap): aim only, zoom stays the user's —
              // byte-identical to the pre-Tier-1b behavior — EXCEPT the brief
              // "zoom back out" ease after an explicit Lock-off (relaxFov > 0),
              // which self-clears once it arrives.
              let fov = v.fov
              if (sel.relaxFov > 0) {
                fov = smoothDamp(v.fov, sel.relaxFov, velF, SPOT_FOV_SMOOTH, dt)
                if (Math.abs(fov - sel.relaxFov) < 0.5) sel.relaxFov = 0
              }
              viewRef.current = clampView({
                pan: smoothDamp(
                  v.pan,
                  sel.lastPan * DEG,
                  velP,
                  SPOT_FOLLOW_SMOOTH,
                  dt
                ),
                tilt: smoothDamp(
                  v.tilt,
                  sel.lastTilt * DEG,
                  velT,
                  SPOT_FOLLOW_SMOOTH,
                  dt
                ),
                fov,
              })
            }
            if (followFrame++ % 8 === 0) syncZoom()
          } else if (sel.follow && sel.lostSince !== null && sel.lock) {
            // LOCKED + coasting/lost: ease the frame WIDER toward the searching
            // fov so the user can re-find and re-tap, while the aim gently
            // tracks the dead-reckoned position. (Unlocked-lost holds, as before.)
            const v = viewRef.current,
              dt = 1 / 60
            viewRef.current = clampView({
              pan: smoothDamp(
                v.pan,
                sel.lastPan * DEG,
                velP,
                SPOT_FOLLOW_SMOOTH,
                dt
              ),
              tilt: smoothDamp(
                v.tilt,
                sel.lastTilt * DEG,
                velT,
                SPOT_FOLLOW_SMOOTH,
                dt
              ),
              fov: smoothDamp(
                v.fov,
                searchFov(curvedFovMaxRef.current),
                velF,
                SPOT_FOV_SEARCH_SMOOTH,
                dt
              ),
            })
            if (followFrame++ % 8 === 0) syncZoom()
          }
        }

        // SVG overlay (dots on tracked players while armed; emerald ring +
        // trail on the selection). DOM-positioned per frame via the SAME
        // pinhole camera the panorama renders through — production runs with
        // the projection blend OFF, so ndc = dir.project(camera) is exact.
        const svgNS = 'http://www.w3.org/2000/svg'
        const svg = spotSvgRef.current
        const dotPool: SVGCircleElement[] = []
        const badgePool: SVGTextElement[] = []
        let ringEl: SVGEllipseElement | null = null
        let ringCasingEl: SVGEllipseElement | null = null
        let trailEl: SVGPolylineElement | null = null
        if (svg && curved) {
          while (svg.firstChild) svg.removeChild(svg.firstChild) // retry re-runs
          trailEl = document.createElementNS(svgNS, 'polyline')
          trailEl.setAttribute('fill', 'none')
          trailEl.setAttribute('stroke', '#34d399')
          trailEl.setAttribute('stroke-width', '2')
          trailEl.setAttribute('stroke-linejoin', 'round')
          trailEl.setAttribute('stroke-linecap', 'round')
          trailEl.setAttribute('opacity', '0.5')
          svg.appendChild(trailEl)
          for (let i = 0; i < 40; i++) {
            const c = document.createElementNS(svgNS, 'circle')
            c.setAttribute('r', '4')
            c.setAttribute('fill', 'rgba(255,255,255,0.8)')
            c.setAttribute('stroke', 'rgba(10,16,13,0.6)')
            c.setAttribute('stroke-width', '1.25')
            c.style.display = 'none'
            svg.appendChild(c)
            dotPool.push(c)
            // Jersey badge above the dot (Tier 3) — dark keyline casing keeps
            // the number legible on any grass tone, same treatment as the ring.
            const b = document.createElementNS(svgNS, 'text')
            b.setAttribute('text-anchor', 'middle')
            b.setAttribute('font-size', '11')
            b.setAttribute('font-weight', '600')
            b.setAttribute('fill', 'rgba(255,255,255,0.92)')
            b.setAttribute('stroke', 'rgba(6,10,8,0.65)')
            b.setAttribute('stroke-width', '2.5')
            b.setAttribute('paint-order', 'stroke')
            b.style.display = 'none'
            svg.appendChild(b)
            badgePool.push(b)
          }
          // Casing under the ring (map-cartography keyline): the dark edge is
          // what keeps an emerald mark legible on any grass tone.
          ringCasingEl = document.createElementNS(svgNS, 'ellipse')
          ringCasingEl.setAttribute('fill', 'none')
          ringCasingEl.setAttribute('stroke', 'rgba(6,10,8,0.5)')
          ringCasingEl.style.display = 'none'
          svg.appendChild(ringCasingEl)
          ringEl = document.createElementNS(svgNS, 'ellipse')
          ringEl.setAttribute('fill', 'rgba(16,185,129,0.1)')
          ringEl.setAttribute('stroke', '#34d399')
          ringEl.style.display = 'none'
          svg.appendChild(ringEl)
        }
        // The ring's rendered position is smoothed separately from the camera
        // (raw 5 Hz tracklet samples inside a smooth-damped frame read as
        // wobble); ~0.07s time constant, reset on selection change.
        const ringSm = { pan: 0, tilt: 0, forIndex: -1 }
        const camDir = new THREE.Vector3()
        const objDir = new THREE.Vector3()
        const objRight = new THREE.Vector3()
        const projScratch = new THREE.Vector3()
        const projectToPx = (
          panDeg: number,
          tiltDeg: number,
          w: number,
          h: number
        ) => {
          const pv = panoRef.current
          if (!pv) return null
          const p = panDeg * DEG,
            tl = tiltDeg * DEG
          objDir.copy(pv.forward).applyAxisAngle(pv.up, p)
          objRight.copy(pv.right).applyAxisAngle(pv.up, p)
          objDir.applyAxisAngle(objRight, tl)
          if (objDir.dot(camDir) < 0.05) return null // behind the camera
          const v = projScratch.copy(objDir).project(camera)
          if (v.x < -1.15 || v.x > 1.15 || v.y < -1.15 || v.y > 1.15)
            return null
          return { x: ((v.x + 1) / 2) * w, y: (1 - (v.y + 1) / 2) * h }
        }
        const setNotice = (kind: SpotNotice) => {
          if (spotNoticeRef.current !== kind) {
            spotNoticeRef.current = kind
            setSpotNotice(kind)
          }
        }
        // Apparent-size factor from ground-plane geometry: a player at tilt θ
        // below the horizon stands at ground distance ∝ 1/tan(−θ), so their
        // apparent size ∝ tan(−θ). Normalized at −9° (mid-field for these
        // mounts) and clamped so extremes stay legible: far players get
        // smaller marks, near players bigger — same factor drives dot radius,
        // ring size, badge size, and the pixel-space dedup radius (a fixed
        // 12px merged two DISTINCT far players while under-merging near
        // duplicates).
        const REF_TILT_TAN = Math.tan(9 * DEG)
        const tiltScale = (tiltDeg: number) =>
          clamp(
            Math.tan(Math.max(0.6, -tiltDeg) * DEG) / REF_TILT_TAN,
            0.45,
            2.2
          )
        const updateSpotlightOverlay = () => {
          if (!svg || !curved) return
          const track = trackletsRef.current
          const sel = spotSelRef.current
          // Mirror selection presence + lock to React (deduped) so the Lock
          // affordance gates on "a player is selected" and shows its pressed
          // state. Done before the early return so a disarm/drop clears it too.
          const hs = sel !== null
          if (hasSelectionRef.current !== hs) {
            hasSelectionRef.current = hs
            setHasSelection(hs)
          }
          const lk = sel?.lock === true
          if (spotLockRef.current !== lk) {
            spotLockRef.current = lk
            setSpotLock(lk)
          }
          if (!track || (!spotlightRef.current && !sel)) {
            svg.style.display = 'none'
            setNotice(null)
            return
          }
          svg.style.display = ''
          const w = host.clientWidth || 1
          const h = host.clientHeight || 1
          svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
          camera.updateMatrixWorld()
          camera.getWorldDirection(camDir)
          const clock = spotClock()
          const active = objectsAt(track, clock)
          let di = 0
          if (spotlightRef.current) {
            // De-duplicate on screen: skip a dot within SPOT_DOT_MERGE_PX of an
            // already-placed dot or of the followed player's ring. Two tracker
            // fragments on one body (or ring + a stray dot on the same player)
            // read as a bug; pixel-space is what the eye actually sees.
            const placed: { x: number; y: number }[] = []
            const ringPx = sel
              ? projectToPx(sel.lastPan, sel.lastTilt, w, h)
              : null
            // Roster cap (Tier 2a): never show more trackers than players. The
            // followed player's ring is one of the N, so its dot budget is N-1.
            // Absent rosterN (pre-Tier-2a artifacts) → no cap.
            const dotCap =
              track.rosterN != null
                ? Math.max(0, track.rosterN - (sel ? 1 : 0))
                : dotPool.length
            const maxDots = Math.min(dotPool.length, dotCap)
            // Zoom factor shared with the ring: marks shrink as you zoom out.
            const zoomK = clamp((26 / viewRef.current.fov) * (h / 800), 0.5, 2)
            // One dot per SLOT (Tier 3): concurrent duplicate fragments of a
            // labelled body share a slot — pixel-merge can miss them at high
            // zoom (world 2-3m apart), the slot key cannot.
            const drawnSlots = new Set<string>()
            for (const a of active) {
              if (sel && a.index === sel.index) continue
              // Same-slot dot near the ring = duplicate fragment of the
              // followed body — the ring covers it. A same-slot dot FAR
              // from the ring is contradiction evidence (mislabelled slot)
              // and must stay visible for the pilot's eyes-on.
              if (
                sel &&
                sel.slot !== null &&
                a.slot === sel.slot &&
                Math.hypot(a.panDeg - sel.lastPan, a.tiltDeg - sel.lastTilt) < 5
              )
                continue
              if (a.slot !== undefined && drawnSlots.has(a.slot)) continue
              if (di >= maxDots) break
              const p = projectToPx(a.panDeg, a.tiltDeg, w, h)
              if (!p) continue
              if (a.slot !== undefined) drawnSlots.add(a.slot)
              const ts = tiltScale(a.tiltDeg)
              const mergePx = SPOT_DOT_MERGE_PX * ts * zoomK
              if (
                ringPx &&
                Math.hypot(p.x - ringPx.x, p.y - ringPx.y) < mergePx
              )
                continue
              if (
                placed.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < mergePx)
              )
                continue
              placed.push(p)
              const c = dotPool[di]
              c.setAttribute('cx', p.x.toFixed(1))
              c.setAttribute('cy', p.y.toFixed(1))
              c.setAttribute('r', clamp(4 * ts * zoomK, 2, 9).toFixed(1))
              // stand down once someone is selected — the ring is the story
              c.style.opacity = sel ? '0.35' : '1'
              c.style.display = ''
              // Jersey badge (Tier 3): only strictly-identified fragments
              // carry a number; everyone else stays an unlabelled dot.
              const jersey = track.objects[a.index]?.jersey
              const b = badgePool[di]
              if (jersey) {
                const fs = clamp(11 * ts * zoomK, 9, 18)
                b.textContent = jersey
                b.setAttribute('font-size', fs.toFixed(1))
                b.setAttribute('x', p.x.toFixed(1))
                b.setAttribute('y', (p.y - fs * 0.82).toFixed(1))
                b.style.opacity = sel ? '0.35' : '1'
                b.style.display = ''
              } else {
                b.style.display = 'none'
              }
              di++
            }
          }
          for (let i = di; i < dotPool.length; i++) {
            dotPool[i].style.display = 'none'
            badgePool[i].style.display = 'none'
          }
          if (sel && ringEl && ringCasingEl && trailEl) {
            const lost = sel.lostSince !== null
            // Ring position is smoothed separately from the camera: raw 5 Hz
            // samples inside a smooth-damped frame read as wobble.
            if (ringSm.forIndex !== sel.index) {
              ringSm.pan = sel.lastPan
              ringSm.tilt = sel.lastTilt
              ringSm.forIndex = sel.index
            } else {
              ringSm.pan += (sel.lastPan - ringSm.pan) * 0.35
              ringSm.tilt += (sel.lastTilt - ringSm.tilt) * 0.35
            }
            const p = projectToPx(ringSm.pan, ringSm.tilt, w, h)
            if (p) {
              // Distance-scaled (tiltScale): a far player gets a smaller
              // ring, a near player a bigger one — zoom scaling alone kept
              // the ring one size across the pitch depth.
              const rx = Math.max(
                8,
                (2.6 / viewRef.current.fov) * h * tiltScale(ringSm.tilt)
              )
              const ry = Math.max(4, rx * 0.38)
              const sw = Math.min(2.5, Math.max(1.75, rx * 0.12))
              for (const el of [ringCasingEl, ringEl]) {
                el.setAttribute('cx', p.x.toFixed(1))
                el.setAttribute('cy', p.y.toFixed(1))
                el.setAttribute('rx', rx.toFixed(1))
                el.setAttribute('ry', ry.toFixed(1))
                el.style.display = ''
              }
              ringCasingEl.setAttribute('stroke-width', (sw + 2).toFixed(2))
              ringEl.setAttribute('stroke-width', sw.toFixed(2))
              if (lost) {
                // "coasting/searching": desaturated + dashed is a semantic
                // state, not a fade — opacity-only reads as a glitch.
                ringEl.setAttribute('stroke', '#b9baa3')
                ringEl.setAttribute('stroke-dasharray', '5 4')
                ringEl.setAttribute('fill', 'none')
                ringEl.style.opacity = '0.8'
              } else {
                ringEl.setAttribute('stroke', '#34d399')
                ringEl.setAttribute('stroke-dasharray', '')
                ringEl.setAttribute('fill', 'rgba(16,185,129,0.1)')
                // After a >1° hand-off the ring FADES in at the new player —
                // a lerped swoosh across the pitch would read as motion.
                const fadeLeft = sel.fadeUntil - performance.now()
                ringEl.style.opacity =
                  fadeLeft > 0
                    ? String(Math.max(0.15, 1 - fadeLeft / 350))
                    : '1'
              }
              if (lost) {
                trailEl.setAttribute('points', '')
              } else {
                const obj = track.objects[sel.index]
                const pts: string[] = []
                for (let i = 0; i < obj.t.length; i++) {
                  if (obj.t[i] < clock - 2.5) continue
                  if (obj.t[i] > clock) break
                  const tp = projectToPx(obj.pan[i], obj.tilt[i], w, h)
                  if (tp) pts.push(`${tp.x.toFixed(1)},${tp.y.toFixed(1)}`)
                }
                pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`)
                trailEl.setAttribute('points', pts.join(' '))
              }
            } else {
              ringEl.style.display = 'none'
              ringCasingEl.style.display = 'none'
              trailEl.setAttribute('points', '')
            }
          } else if (ringEl && ringCasingEl && trailEl) {
            ringEl.style.display = 'none'
            ringCasingEl.style.display = 'none'
            trailEl.setAttribute('points', '')
            ringSm.forIndex = -1
          }
          // Status pill: transient overrides first, then the derived base.
          const ov = spotNoticeOverride.current
          if (ov && Date.now() < ov.until) {
            setNotice(ov.kind)
          } else {
            if (ov) spotNoticeOverride.current = null
            if (sel && sel.lostSince !== null)
              setNotice('searching') // coasting — caption the widening frame
            else if (!spotlightRef.current) setNotice(null)
            else if (active.length === 0)
              setNotice('nodata') // untracked stretch — taps CAN'T work here
            else if (!sel) setNotice('hint')
            else setNotice(null)
          }
        }
        // Screen NDC -> dewarp pan/tilt (deg) for click-to-select. Canonical
        // basis inversion of the camera dir composition: pan = atan2(−x, z),
        // tilt = −asin(y). Exact while the projection blend is off (the
        // production default); debug blend params may skew edge picks.
        pickRef.current = !curved
          ? null
          : (nx: number, ny: number) => {
              camera.updateMatrixWorld()
              const v = new THREE.Vector3(nx, ny, 0.5)
                .unproject(camera)
                .normalize()
              return {
                panDeg: Math.atan2(-v.x, v.z) / DEG,
                tiltDeg: -Math.asin(clamp(v.y, -1, 1)) / DEG,
              }
            }

        // Zero the smoothDamp velocity accumulators when the active camera
        // driver changes — a minutes-old fov velocity from stepAim replaying
        // into a fresh engagement produces a one-off transient.
        let lastDriver = ''
        const loop = () => {
          raf = requestAnimationFrame(loop)
          // Driver-key velocity reset runs BEFORE stepSpotlight so engaging or
          // releasing the zoom-lock pre-empts a stale-velF kick this frame
          // (rather than cleaning it one frame late). 'spot-lock' vs 'spot'
          // makes the lock toggle a driver change. Transitions that flip INSIDE
          // stepSpotlight (lost↔found) are handled by the frameFov<=0 re-seed.
          {
            const sel0 = spotSelRef.current
            const following0 = Boolean(sel0?.follow && sel0?.lostSince === null)
            const driver = following0
              ? sel0?.lock
                ? 'spot-lock'
                : 'spot'
              : autoFollowRef.current && curved && !autoSrc
                ? 'auto'
                : ''
            if (driver !== lastDriver) {
              velP.v = 0
              velT.v = 0
              velF.v = 0
              lastDriver = driver
            }
          }
          if (curved) stepSpotlight()
          lastRafMs = performance.now()
          const spotFollowing = Boolean(
            spotSelRef.current?.follow && spotSelRef.current?.lostSince === null
          )
          if (!spotFollowing && autoFollowRef.current && curved && !autoSrc) {
            const track = aimTrackRef.current
            if (track) stepAim(track)
            else stepFollow() // motion driver = fallback when no reg track
          } else if (!spotFollowing) {
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
              // Fov-adaptive projection: refresh the blend uniforms from the
              // live fov + canvas aspect (cheap; covers zoom AND resize).
              const b = flatProjection
                ? 0
                : blendFactor(
                    fov,
                    blendFovLo,
                    blendFovHi,
                    blendMax,
                    blendFovDownLo,
                    blendFovDownHi
                  )
              const he = blendHalfExtents(fov, camera.aspect, b)
              projUniforms.uBlend.value = b
              projUniforms.uHalf.value.set(he.x, he.y)
              projUniforms.uKey.value = flatProjection ? 0 : keystone
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
          updateSpotlightOverlay()
          renderer!.render(scene, camera)
        }
        loop()

        // cleanup registered via closure vars
        ;(host as HTMLDivElement & { __cleanup?: () => void }).__cleanup =
          () => {
            cancelAnimationFrame(raf)
            pickRef.current = null
            if (svg) {
              svg.style.display = 'none'
              while (svg.firstChild) svg.removeChild(svg.firstChild)
            }
            ro?.disconnect()
            if (onWheel) host.removeEventListener('wheel', onWheel)
            texture.dispose()
            for (const g of geometries) g.dispose()
            for (const m of materials) m.dispose()
            lutTexRef?.dispose()
            renderer?.forceContextLoss()
            renderer?.dispose()
            if (renderer && renderer.domElement.parentNode === host)
              host.removeChild(renderer.domElement)
          }
      } catch {
        if (!disposed) {
          setIsLoading(false)
          setError(t('calibrationFailed'))
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
    flatProjection,
    blendFovLo,
    blendFovHi,
    blendMax,
    blendFovDownLo,
    blendFovDownHi,
    keystone,
  ])

  useEffect(() => {
    if (!showHint) return
    const t = setTimeout(() => setShowHint(false), 4500)
    return () => clearTimeout(t)
  }, [showHint])

  // --- pointer grab-pan (radians from pixels via current fov) ---
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  // Distinguish a CLICK (spotlight select) from a drag: total movement under
  // this many px between pointerdown and pointerup counts as a click.
  const clickRef = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    if (autoFollow) setAutoFollow(false) // taking manual control stops auto-follow
    // NOTE: spotlight camera-follow is NOT disengaged here — only a real DRAG
    // does that (in onPointerMove). A tap that misses a player must not
    // silently stop the follow the user deliberately started.
    dragRef.current = { x: e.clientX, y: e.clientY }
    clickRef.current = { x: e.clientX, y: e.clientY, moved: false }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    dismissHint()
  }
  // Side effects stay OUTSIDE the state updaters (updaters must be pure —
  // StrictMode double-invokes them and concurrent React may replay them).
  const toggleAutoFollow = () => {
    const next = !autoFollow
    if (next) {
      // one follow mode at a time — Auto takes over from Spotlight
      spotSelRef.current = null
      setSpotlight(false)
    }
    setAutoFollow(next)
    dismissHint()
  }
  const toggleSpotlight = () => {
    const next = !spotlight
    if (next) setAutoFollow(false)
    else spotSelRef.current = null // disarm clears the selection too
    setSpotlight(next)
    dismissHint()
  }
  // Zoom-LOCK toggle (Tier 1b) — only meaningful with a live selection.
  const toggleLock = () => {
    const sel = spotSelRef.current
    if (!sel) return
    const next = !sel.lock
    sel.lock = next
    sel.frameFov = 0 // reset the fov goal so the zoom damp seeds cleanly
    if (next) {
      sel.relaxFov = 0
      setAutoFollow(false)
      spotNoticeOverride.current = { kind: 'locked', until: Date.now() + 3000 }
    } else {
      // Lock off: ease the frame back out to a wide follow (aim-follow stays);
      // caption it so the zoom-out isn't a silent, unexplained change.
      sel.relaxFov = searchFov(curvedFovMaxRef.current)
      spotNoticeOverride.current = {
        kind: 'following',
        until: Date.now() + 2500,
      }
    }
    setSpotLock(next)
    spotLockRef.current = next
    dismissHint()
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const start = dragRef.current
    const host = canvasHostRef.current
    if (!start || !host) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    const c = clickRef.current
    // Touch fingers roll ~10px on a natural tap — a tight slop misclassifies
    // taps as drags (and then a "drag" of a few px kills the follow).
    const slop = e.pointerType === 'touch' ? 12 : 6
    if (
      c &&
      !c.moved &&
      Math.abs(e.clientX - c.x) + Math.abs(e.clientY - c.y) > slop
    ) {
      c.moved = true
      // A real drag = taking manual control: disengage spotlight camera-
      // follow AND the zoom-lock (ring stays; tapping the player again
      // re-follows, and Lock/double-tap re-engages the zoom).
      if (spotSelRef.current) {
        spotSelRef.current.follow = false
        spotSelRef.current.lock = false
        spotSelRef.current.relaxFov = 0 // user has aim control; cancel any relax
      }
    }
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
    // A CANCELLED gesture (orientation change, system dialog) is not a click
    // — running the select path would spotlight a random player.
    const wasClick =
      e.type !== 'pointercancel' && clickRef.current && !clickRef.current.moved
    dragRef.current = null
    clickRef.current = null
    ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
    // Spotlight select: an armed, non-drag tap picks the nearest tracked
    // player under the pointer (gate scales with zoom so a tap works at any
    // fov). Empty taps keep the current selection.
    if (!wasClick || !spotlightRef.current) return
    const host = canvasHostRef.current
    const track = trackletsRef.current
    const pick = pickRef.current
    const master = masterVideoRef?.current
    if (!host || !track || !pick) return
    const rect = host.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1)
    const at = pick(nx, ny)
    if (!at) return
    const clock = master?.currentTime ?? videoRef.current?.currentTime ?? 0
    // Touch needs a ≥40px effective target; the pointer aims a whole player,
    // not a 5px dot, and nearest-object semantics resolve crowding.
    const coarse = e.pointerType === 'touch'
    const gateDeg = Math.max(
      coarse ? 2.2 : 1.5,
      viewRef.current.fov * (coarse ? 0.09 : 0.06)
    )
    const hit = nearestObject(track, clock, at.panDeg, at.tiltDeg, gateDeg)
    if (hit) {
      // Double-tap accelerator: a second select within DOUBLE_TAP_MS engages the
      // zoom-lock immediately (single tap = ring + aim only, today's behavior).
      const now = Date.now()
      const dbl = now - lastSelectTapRef.current < DOUBLE_TAP_MS
      lastSelectTapRef.current = now
      spotSelRef.current = {
        index: hit.index,
        slot: hit.slot ?? null,
        follow: true,
        lock: dbl,
        frameFov: 0,
        relaxFov: 0,
        lastPan: hit.panDeg,
        lastTilt: hit.tiltDeg,
        vPan: 0,
        vTilt: 0,
        lostSince: null,
        coastDeg: 0,
        lastClock: clock,
        hops: 0,
        adoptedAt: clock,
        fadeUntil: 0,
      }
      setAutoFollow(false)
      spotNoticeOverride.current = {
        kind: dbl ? 'locked' : 'following',
        until: Date.now() + 4000,
      }
    } else if (spotSelRef.current) {
      // Confirmed empty tap with an existing selection: re-assert follow so a
      // stray screen tap never silently stops tracking the chosen player.
      // Clear any pending unlock-relax so a re-follow isn't a surprise zoom-out.
      spotSelRef.current.follow = true
      spotSelRef.current.relaxFov = 0
    }
  }

  const zoomBy = (f: number) => {
    viewRef.current = clampView({
      ...viewRef.current,
      fov: viewRef.current.fov / f,
    })
    // Manual zoom releases the zoom-lock (keeps aim-follow), like the wheel.
    const sw = spotSelRef.current
    if (sw?.follow) {
      const wasLocked = sw.lock
      sw.lock = false
      sw.relaxFov = 0
      if (wasLocked)
        spotNoticeOverride.current = {
          kind: 'following',
          until: Date.now() + 2500,
        }
    }
    syncZoom()
  }
  const resetView = () => {
    // The "back to wide" home: drop follow + lock (ring stays; tap to re-follow)
    // so the reset isn't instantly fought by the follow driver.
    if (spotSelRef.current) {
      spotSelRef.current.follow = false
      spotSelRef.current.lock = false
      spotSelRef.current.relaxFov = 0
    }
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
      case 'Enter': {
        // Keyboard selection: when armed, spotlight the tracked player
        // nearest to screen centre (arrows already aim the view).
        const track = trackletsRef.current
        const pick = pickRef.current
        if (!spotlightRef.current || !track || !pick) {
          handled = false
          break
        }
        const at = pick(0, 0)
        if (!at) break
        const clock =
          masterVideoRef?.current?.currentTime ??
          videoRef.current?.currentTime ??
          0
        const hit = nearestObject(
          track,
          clock,
          at.panDeg,
          at.tiltDeg,
          Math.max(2.5, viewRef.current.fov * 0.12)
        )
        if (hit) {
          spotSelRef.current = {
            index: hit.index,
            slot: hit.slot ?? null,
            follow: true,
            lock: false,
            frameFov: 0,
            relaxFov: 0,
            lastPan: hit.panDeg,
            lastTilt: hit.tiltDeg,
            vPan: 0,
            vTilt: 0,
            lostSince: null,
            coastDeg: 0,
            lastClock: clock,
            hops: 0,
            adoptedAt: clock,
            fadeUntil: 0,
          }
          setAutoFollow(false)
          spotNoticeOverride.current = {
            kind: 'following',
            until: Date.now() + 4000,
          }
        }
        break
      }
      case 'l':
      case 'L':
        // Keyboard parity for the Lock toggle (only with a live selection).
        if (spotSelRef.current) toggleLock()
        else handled = false
        break
      case 'Escape':
        if (spotSelRef.current) spotSelRef.current = null
        else handled = false
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
  // <video> that feeds the WebGL texture must PLAY FREELY for smooth video; we
  // only mirror discrete master events (play/pause/seek/rate) and correct drift
  // LOOSELY (>1.5s, checked every 2s). An earlier per-frame drift-seek re-seeked
  // the 4K feed whenever it fell >0.15s behind, which a heavy decode can't avoid
  // → it played frame-by-frame instead of smoothly. Re-binds on `retry`.
  useEffect(() => {
    const master = masterVideoRef?.current
    if (!master) return
    const align = () => {
      const v = videoRef.current
      if (v && Math.abs(v.currentTime - master.currentTime) > 0.5)
        v.currentTime = master.currentTime
    }
    const onPlay = () => {
      const v = videoRef.current
      if (!v) return
      align()
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
    // Loose keep-alive: re-assert play/pause state + correct only BAD drift
    // (>1.5s) on a slow cadence, so normal playback is never interrupted.
    const drift = setInterval(() => {
      const v = videoRef.current
      if (!v) return
      if (!master.paused && v.paused) void v.play().catch(() => {})
      else if (master.paused && !v.paused) v.pause()
      if (Math.abs(v.currentTime - master.currentTime) > 1.5)
        v.currentTime = master.currentTime
    }, 2000)
    return () => {
      clearInterval(drift)
      master.removeEventListener('play', onPlay)
      master.removeEventListener('pause', onPause)
      master.removeEventListener('seeked', onSeeked)
      master.removeEventListener('ratechange', onRate)
    }
  }, [masterVideoRef, retry])

  // Report pan-state up so DewarpControls (rendered in the shared bar's extras)
  // reflect Auto-pressed + zoom%. Fires when Auto flips via button OR a drag.
  useEffect(() => {
    onStateChange?.({
      autoFollow,
      zoomPct,
      hasAimTrack,
      hasTracklets,
      spotlight,
      hasSelection,
      lock: spotLock,
    })
  }, [
    autoFollow,
    zoomPct,
    hasAimTrack,
    hasTracklets,
    spotlight,
    hasSelection,
    spotLock,
    onStateChange,
  ])

  // Publish the imperative control handle for the extras (ref-as-latest-callback,
  // same pattern as toggleFullscreenRef — the closures below are already defined).
  if (apiRef) {
    apiRef.current = {
      zoomIn: () => zoomBy(1.25),
      zoomOut: () => zoomBy(1 / 1.25),
      reset: resetView,
      toggleAuto: toggleAutoFollow,
      toggleSpotlight,
      toggleLock,
    }
  }

  const seekPct =
    duration > 0 ? (Math.min(currentTime, duration) / duration) * 100 : 0
  const canInteract = !isLoading && !error

  return (
    <div
      ref={containerRef}
      // Media-player chrome stays LTR by convention (seek bar, time readout).
      dir="ltr"
      className={cn(
        'relative w-full overflow-hidden rounded-lg bg-[#050907] select-none',
        className
      )}
    >
      <div className="relative aspect-video w-full">
        <div
          ref={canvasHostRef}
          role="application"
          aria-label={t('panoramaAria')}
          tabIndex={canInteract ? 0 : -1}
          className="absolute inset-0 cursor-grab outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--timberwolf)]"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
        />

        {/* Spotlight overlay — dots/ring/trail drawn per RAF frame by the
            render loop (imperative SVG children; no React churn). */}
        <svg
          ref={spotSvgRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
          style={{ display: 'none' }}
        />

        {spotNotice && canInteract && (
          <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
            <div
              key={spotNotice}
              className="flex items-center gap-2 rounded-full bg-black/60 px-4 py-2 text-sm text-[var(--timberwolf)] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2"
            >
              <UserSearch
                className={cn(
                  'h-4 w-4',
                  spotNotice === 'nodata' ||
                    spotNotice === 'lost' ||
                    spotNotice === 'searching'
                    ? 'text-[var(--ash-grey)]'
                    : 'text-emerald-400'
                )}
              />{' '}
              {t(
                spotNotice === 'nodata'
                  ? 'spotlightNoData'
                  : spotNotice === 'following'
                    ? 'spotlightFollowing'
                    : spotNotice === 'locked'
                      ? 'spotlightLocked'
                      : spotNotice === 'searching'
                        ? 'spotlightSearching'
                        : spotNotice === 'lost'
                          ? 'spotlightLost'
                          : 'spotlightHint'
              )}
            </div>
          </div>
        )}
        {/* Screen-reader announcements for pointer-driven state changes. */}
        <span aria-live="polite" className="sr-only">
          {spotNotice
            ? t(
                spotNotice === 'nodata'
                  ? 'spotlightNoData'
                  : spotNotice === 'following'
                    ? 'spotlightFollowing'
                    : spotNotice === 'locked'
                      ? 'spotlightLocked'
                      : spotNotice === 'searching'
                        ? 'spotlightSearching'
                        : spotNotice === 'lost'
                          ? 'spotlightLost'
                          : 'spotlightHint'
              )
            : ''}
        </span>

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
              {t('tryAgain')}
            </Button>
          </div>
        )}

        {!hideChrome && canInteract && !isPlaying && (
          <button
            type="button"
            onClick={togglePlay}
            aria-label={t('play')}
            className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/20 text-white backdrop-blur-sm transition hover:bg-white/30"
          >
            <Play className="h-7 w-7 translate-x-0.5" />
          </button>
        )}

        {showHint && canInteract && (
          <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
            <div className="flex items-center gap-2 rounded-full bg-black/60 px-4 py-2 text-sm text-[var(--timberwolf)] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2">
              <Move className="h-4 w-4" /> {t('panoramaHint')}
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
              aria-label={t('seek')}
              aria-valuetext={t('seekValue', {
                current: fmtTime(currentTime),
                duration: fmtTime(duration),
              })}
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
                aria-label={isPlaying ? t('pause') : t('play')}
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
                    aria-label={t('autoFollowToggle')}
                    aria-pressed={autoFollow}
                    title={
                      autoFollow
                        ? t('autoFollowOnTitle')
                        : t('autoFollowOffTitle')
                    }
                    className={cn(
                      'h-9 gap-1.5 px-2 text-white hover:bg-white/20 md:h-8',
                      autoFollow &&
                        'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                    )}
                  >
                    <Crosshair className="h-4 w-4" />
                    <span className="text-xs font-medium">{t('auto')}</span>
                  </Button>
                )}
                {curved && hasTracklets && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleSpotlight}
                    aria-label={t('spotlightToggle')}
                    aria-pressed={spotlight}
                    title={
                      spotlight ? t('spotlightOnTitle') : t('spotlightOffTitle')
                    }
                    className={cn(
                      'h-9 gap-1.5 px-2 text-white hover:bg-white/20 md:h-8',
                      spotlight &&
                        'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                    )}
                  >
                    <UserSearch className="h-4 w-4" />
                    <span className="text-xs font-medium">
                      {t('spotlight')}
                    </span>
                  </Button>
                )}
                {/* Reserved once Spotlight is armed (disabled until a player is
                    selected) so it never pops in mid-session or shifts the
                    zoom/reset cluster under the user's thumb. */}
                {curved && hasTracklets && spotlight && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleLock}
                    disabled={!hasSelection}
                    aria-label={t('lockToggle')}
                    aria-pressed={spotLock}
                    title={
                      !hasSelection
                        ? t('lockDisabledTitle')
                        : spotLock
                          ? t('lockOnTitle')
                          : t('lockOffTitle')
                    }
                    className={cn(
                      'h-9 gap-1.5 px-2 text-white hover:bg-white/20 md:h-8 disabled:opacity-40',
                      spotLock &&
                        'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                    )}
                  >
                    <Focus className="h-4 w-4" />
                    <span className="text-xs font-medium">{t('lock')}</span>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => zoomBy(1 / 1.25)}
                  aria-label={t('zoomOut')}
                  className="h-9 w-9 text-white hover:bg-white/20 md:h-8 md:w-8"
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => zoomBy(1.25)}
                  aria-label={t('zoomIn')}
                  className="h-9 w-9 text-white hover:bg-white/20 md:h-8 md:w-8"
                >
                  <Plus className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={resetView}
                  aria-label={t('resetView')}
                  className="h-9 w-9 text-white hover:bg-white/20 md:h-8 md:w-8"
                >
                  <Frame className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={toggleFullscreen}
                  aria-label={
                    isFullscreen ? t('exitFullscreen') : t('fullscreen')
                  }
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
