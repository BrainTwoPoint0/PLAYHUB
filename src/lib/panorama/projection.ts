/**
 * Cylindrical panorama de-warp — pure projection math.
 *
 * The raw Spiideo/fixed-camera panorama is a wide, barrel-ish image covering
 * the whole pitch. We treat it as a texture on the inside of a cylinder and
 * view it with a virtual perspective camera at the cylinder axis:
 *   - pan  = camera yaw   (look left/right)   — degrees
 *   - tilt = camera pitch (look up/down)      — degrees
 *   - fov  = vertical field of view           — degrees (smaller = zoomed in)
 *
 * This module is framework-agnostic (no three.js) so it is unit-testable and
 * later swappable for a calibrated mesh (Layer 2) behind the same view state.
 * All angles are in DEGREES; the renderer converts to radians.
 */

export interface ViewLimits {
  /** yaw bounds (deg). */
  minPan: number
  maxPan: number
  /** pitch bounds (deg). */
  minTilt: number
  maxTilt: number
  /** vertical FOV bounds (deg). minFov = most zoomed in, maxFov = zoomed out. */
  minFov: number
  maxFov: number
}

export interface ViewState {
  /** yaw (deg) */
  pan: number
  /** pitch (deg) */
  tilt: number
  /** vertical FOV (deg) */
  fov: number
}

/** Sensible defaults for a wide fixed pitch-side camera (~140° horizontal coverage). */
export const DEFAULT_LIMITS: ViewLimits = {
  minPan: -70,
  maxPan: 70,
  minTilt: -25,
  maxTilt: 25,
  minFov: 12,
  maxFov: 90,
}

const clampNum = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v))

const DEG = Math.PI / 180

/** Clamp a view state to its limits (each axis independently). */
export function clampView(
  s: ViewState,
  limits: ViewLimits = DEFAULT_LIMITS
): ViewState {
  return {
    pan: clampNum(s.pan, limits.minPan, limits.maxPan),
    tilt: clampNum(s.tilt, limits.minTilt, limits.maxTilt),
    fov: clampNum(s.fov, limits.minFov, limits.maxFov),
  }
}

/**
 * Zoom factor → vertical FOV. zoom=1 is fully zoomed out (fov=maxFov); higher
 * zoom narrows the FOV toward minFov. Inverse of {@link fovToZoom}.
 */
export function zoomToFov(
  zoom: number,
  limits: ViewLimits = DEFAULT_LIMITS
): number {
  const z = Math.max(1, zoom)
  return clampNum(limits.maxFov / z, limits.minFov, limits.maxFov)
}

/** Vertical FOV → zoom factor (>= 1). Inverse of {@link zoomToFov}. */
export function fovToZoom(
  fov: number,
  limits: ViewLimits = DEFAULT_LIMITS
): number {
  return limits.maxFov / clampNum(fov, limits.minFov, limits.maxFov)
}

/** Horizontal FOV (deg) from a vertical FOV (deg) and viewport aspect (w/h). */
export function horizontalFov(verticalFovDeg: number, aspect: number): number {
  const v = verticalFovDeg * DEG
  const h = 2 * Math.atan(Math.tan(v / 2) * aspect)
  return h / DEG
}

/**
 * Convert a pixel drag to a pan/tilt delta (deg) using "grab" semantics — the
 * point under the cursor stays under the cursor as you drag. Drag right → look
 * left (pan decreases); drag down → look up (tilt increases).
 */
export function dragToDelta(
  dxPx: number,
  dyPx: number,
  fovDeg: number,
  viewportW: number,
  viewportH: number
): { dPan: number; dTilt: number } {
  if (viewportW <= 0 || viewportH <= 0) return { dPan: 0, dTilt: 0 }
  const hFov = horizontalFov(fovDeg, viewportW / viewportH)
  const degPerPxX = hFov / viewportW
  const degPerPxY = fovDeg / viewportH
  return { dPan: -dxPx * degPerPxX, dTilt: dyPx * degPerPxY }
}

/** Apply a pixel drag to a view state and clamp. */
export function applyDrag(
  s: ViewState,
  dxPx: number,
  dyPx: number,
  viewportW: number,
  viewportH: number,
  limits: ViewLimits = DEFAULT_LIMITS
): ViewState {
  const { dPan, dTilt } = dragToDelta(dxPx, dyPx, s.fov, viewportW, viewportH)
  return clampView(
    { pan: s.pan + dPan, tilt: s.tilt + dTilt, fov: s.fov },
    limits
  )
}

/**
 * Apply a zoom step and clamp. `scale` > 1 zooms in (narrows FOV), < 1 zooms
 * out. Convert a wheel deltaY to a scale with e.g. `Math.exp(-deltaY * 0.001)`.
 */
export function applyZoom(
  s: ViewState,
  scale: number,
  limits: ViewLimits = DEFAULT_LIMITS
): ViewState {
  const safeScale = scale > 0 ? scale : 1
  return clampView({ ...s, fov: s.fov / safeScale }, limits)
}

/** Renderer-facing conversion: view state → camera yaw/pitch (radians) + FOV (deg). */
export function viewToCamera(s: ViewState): {
  yaw: number
  pitch: number
  fovDeg: number
} {
  return { yaw: s.pan * DEG, pitch: s.tilt * DEG, fovDeg: s.fov }
}

/** The default starting view: centered, zoomed out to show the whole pitch. */
export function initialView(limits: ViewLimits = DEFAULT_LIMITS): ViewState {
  return { pan: 0, tilt: 0, fov: limits.maxFov }
}

export interface DerivedGeometry {
  limits: ViewLimits
  /** horizontal arc of the panorama, radians. */
  arcRad: number
  /** cylinder height (world units) that preserves the source aspect at `radius`. */
  arcHeight: number
}

/**
 * Derive pan/tilt/zoom limits + the cylinder arc dimensions from the source
 * camera's horizontal FOV and the video's aspect. Limits keep the view inside
 * the arc (short of the edges) and never zoom out past the arc's vertical
 * extent. Guarded so extreme/degenerate aspects can't produce min > max.
 */
export function deriveViewLimits(
  horizontalFovDeg: number,
  videoAspect: number,
  radius: number
): DerivedGeometry {
  const hFov = Math.max(1, horizontalFovDeg)
  const aspect = Math.max(0.01, videoAspect)
  const arcRad = hFov * DEG
  const verticalFovDeg = hFov / aspect
  const arcHeight = 2 * radius * Math.tan((verticalFovDeg * DEG) / 2)
  const panMargin = Math.max(0, hFov / 2 - 8)
  const tiltMargin = Math.max(0, verticalFovDeg / 2 - 5)
  const minFov = 12
  const limits: ViewLimits = {
    minPan: -panMargin,
    maxPan: panMargin,
    minTilt: -tiltMargin,
    maxTilt: tiltMargin,
    minFov,
    maxFov: Math.max(minFov, Math.min(80, verticalFovDeg)),
  }
  return { limits, arcRad, arcHeight }
}

/*
 * Fov-adaptive pinhole↔cylindrical blend (the curved product path's view
 * projection). A rectilinear (pinhole) wide view of the pitch stretches the
 * edges ("rounded feel"); a cylindrical view fixes the stretch but bows
 * straight horizontal lines through the centre. The blend is exactly pinhole
 * when zoomed in and ramps toward cylindrical as the view widens, so each
 * fov gets the projection that reads flattest.
 *
 * Forward map for a camera-frame ray (dx, dy, dz), blend b ∈ [0, 1]:
 *   theta  = atan2(dx, dz)                  — azimuth off the view axis
 *   tanphi = dy / hypot(dx, dz)             — elevation
 *   x = (1−b)·tan(theta) + b·theta          — pinhole (b=0) ↔ cylindrical (b=1)
 *   y = ((1−b)/cos(theta) + b) · tanphi
 * The frame's horizontal ANGULAR extent is invariant in b (the edge ray at
 * hh always maps to xmax), so angular pan clamps hold under any blend.
 */

/** Blend ramp (vertical fov, deg): a mid-range BUMP, not a monotonic ramp.
 *  Pure pinhole below LO, bmax between HI and DOWN_LO, back to pure pinhole
 *  at/above DOWN_HI. Eye-tuned by Karim (2026-07-13, on the refit straight
 *  meshes): a mild blend (bmax 0.3) reads nicer through the normal viewing
 *  range, but the whole-window zoom-out must stay pure pinhole — Spiideo's
 *  live viewer is pinhole at every zoom (§0l) and the cylindrical term bows
 *  straight horizontals exactly where the full-pitch view shows them longest.
 *  Tuning knobs on /panorama-test: `blo`/`bhi`/`bmax`/`bdlo`/`bdhi`
 *  (`flat=1` = off). */
export const BLEND_FOV_LO = 42
export const BLEND_FOV_HI = 60
export const BLEND_FOV_DOWN_LO = 85
export const BLEND_FOV_DOWN_HI = 105
export const BLEND_MAX_DEFAULT = 0.3

/**
 * Blend factor b for a vertical fov:
 * `bmax · smoothstep(lo → hi) · (1 − smoothstep(downLo → downHi))`.
 * 0 = pinhole (exactly the stock render). Degenerate ramps (hi ≤ lo) fall
 * back to a step at `lo`; same for the down-ramp at `downLo`.
 */
export function blendFactor(
  vfovDeg: number,
  lo = BLEND_FOV_LO,
  hi = BLEND_FOV_HI,
  bmax = BLEND_MAX_DEFAULT,
  downLo = BLEND_FOV_DOWN_LO,
  downHi = BLEND_FOV_DOWN_HI
): number {
  const smooth = (t: number) => t * t * (3 - 2 * t)
  const up =
    hi <= lo
      ? vfovDeg >= lo
        ? 1
        : 0
      : clampNum((vfovDeg - lo) / (hi - lo), 0, 1)
  const down =
    downHi <= downLo
      ? vfovDeg >= downLo
        ? 1
        : 0
      : clampNum((vfovDeg - downLo) / (downHi - downLo), 0, 1)
  // b outside [0, 1] breaks the projection's monotonicity (the map folds
  // past |theta| = 45° for b > 1), so the cap is clamped, not trusted.
  return clampNum(bmax, 0, 1) * smooth(up) * (1 - smooth(down))
}

/**
 * Overview widening (the Perform-style "whole pitch at full zoom-out"). At
 * full cylindricality the frame's horizontal ANGULAR half-extent can exceed
 * the pinhole-equivalent hh — a cylinder happily represents rays past ±90°
 * off-axis, which no pinhole term can (tan folds). So the widening is gated
 * on b ≥ 0.999 (pure cylindrical map only) and ramps with fov from
 * OVERVIEW_FOV_LO to the zoom-out cap, reaching OVERVIEW_PAN_HALF_DEG. The
 * vertical extent simultaneously returns to the nominal tan(vfov/2) — the
 * un-widened blend's y = x/aspect quietly under-spans the fov at b=1.
 */
export const OVERVIEW_FOV_LO = 90
export const OVERVIEW_FOV_HI = 92
export const OVERVIEW_PAN_HALF_DEG = 95

export function overviewWiden(vfovDeg: number, b: number): number {
  if (b < 0.999) return 0
  const t = clampNum(
    (vfovDeg - OVERVIEW_FOV_LO) / (OVERVIEW_FOV_HI - OVERVIEW_FOV_LO),
    0,
    1
  )
  return t * t * (3 - 2 * t)
}

/**
 * Horizontal angular half-extent (deg) of the rendered frame — the pan-clamp
 * twin of {@link blendHalfExtents}. Below the overview ramp this is the
 * blend-invariant pinhole hh (the original extent-invariance law); inside it,
 * it widens toward OVERVIEW_PAN_HALF_DEG.
 */
export function blendPanHalfAngleDeg(
  vfovDeg: number,
  aspect: number,
  b: number
): number {
  const hhDeg = horizontalFov(vfovDeg, aspect) / 2
  const w = overviewWiden(vfovDeg, b)
  return hhDeg + Math.max(0, OVERVIEW_PAN_HALF_DEG - hhDeg) * w
}

/**
 * Half-extents of the projected frame in projection units for a vertical fov,
 * viewport aspect and blend b. NDC = projected coord / half-extent. At b=0
 * this is the pinhole frame (x = tan(hFov/2), y = tan(vFov/2)). Inside the
 * overview ramp (see {@link overviewWiden}) x is angular (b=1) and widens
 * toward OVERVIEW_PAN_HALF_DEG while y returns to tan(vfov/2).
 */
export function blendHalfExtents(
  vfovDeg: number,
  aspect: number,
  b: number
): { x: number; y: number } {
  const hh = Math.atan(Math.tan((vfovDeg * DEG) / 2) * aspect)
  const x0 = (1 - b) * Math.tan(hh) + b * hh
  const y0 = x0 / aspect
  const w = overviewWiden(vfovDeg, b)
  if (w === 0) return { x: x0, y: y0 }
  const x = x0 + Math.max(0, OVERVIEW_PAN_HALF_DEG * DEG - x0) * w
  const y = y0 + (Math.tan((vfovDeg * DEG) / 2) - y0) * w
  return { x, y }
}

/**
 * Project a camera-frame ray (dz > 0 = forward) under blend b. JS twin of
 * CYL_PROJECT_GLSL in VirtualPanoramaPlayer.tsx — keep the two in lockstep.
 * (The GLSL carries the same map multiplied through by w = dz, so it stays
 * continuous through dz = 0; on this function's dz > 0 domain they agree.)
 */
export function blendProject(
  dx: number,
  dy: number,
  dz: number,
  b: number
): { x: number; y: number } {
  const theta = Math.atan2(dx, dz)
  const tanphi = dy / Math.hypot(dx, dz)
  const x = (1 - b) * Math.tan(theta) + b * theta
  const y = ((1 - b) / Math.cos(theta) + b) * tanphi
  return { x, y }
}

/**
 * Intersect the mesh-derived pan limits (RADIANS) with an optional focus
 * window (half-pitch watch framing). The window may only NARROW the range:
 * a degenerate, inverted, non-finite, or disjoint window returns the mesh
 * limits untouched — a broken calibration must never lock the view.
 */
export function intersectPanWindow(
  minPan: number,
  maxPan: number,
  window: { minRad: number; maxRad: number } | null | undefined
): { minPan: number; maxPan: number } {
  if (!window) return { minPan, maxPan }
  const lo = Math.max(minPan, window.minRad)
  const hi = Math.min(maxPan, window.maxRad)
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo))
    return { minPan, maxPan }
  return { minPan: lo, maxPan: hi }
}

/** Ceiling for the scene-derived zoom-out cap: the tallest real window
 *  (Nazwa, tilt −89.95°..+37.07° ≈ 127°) — also the value the player
 *  historically hardcoded for every scene. */
export const CURVED_FOV_MAX_CEIL = 127

/**
 * Scene-derived zoom-out cap (deg). Spiideo ties the zoom-out floor to the
 * WINDOW's tilt height, so a short window (HCT is ~47° tall) must not zoom
 * out to a 127° pinhole: at fovs far beyond the window the frame is mostly
 * black with extreme edge stretch (the wide-fov "bowl"), and clampView's
 * pan bounds collapse toward the midpoint — a corner-pinned aim gets dragged
 * through a huge diagonal pan+tilt sweep during zoom, which reads as the
 * view "rotating" (apparent roll of frame content; a FIXED aim cannot rotate
 * under pure fov change). Tilt extents in RADIANS (mesh window extents).
 */
export function curvedFovMax(
  minTiltRad: number,
  maxTiltRad: number,
  minFovDeg = 12
): number {
  const spanDeg = (maxTiltRad - minTiltRad) / DEG
  return clampNum(spanDeg, minFovDeg, CURVED_FOV_MAX_CEIL)
}

/**
 * Keystone (vertical perspective) correction on NDC — a pure HOMOGRAPHY, so
 * every straight line stays straight (unlike the cylindrical blend's bow).
 * k > 0 narrows the bottom of the frame and widens the top, reducing the
 * ground-plane trapezoid splay (the "hill" percept: near side too wide, far
 * side too pinched). Cost: off-centre verticals lean slightly outward.
 * GLSL twin: the uKey term in CYL_PROJECT_GLSL (w' = w − k·y_clip).
 */
export function applyKeystone(
  x: number,
  y: number,
  k: number
): { x: number; y: number } {
  const d = 1 - k * y
  return { x: x / d, y: y / d }
}
