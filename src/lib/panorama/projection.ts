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
