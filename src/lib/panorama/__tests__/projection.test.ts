import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LIMITS,
  clampView,
  zoomToFov,
  fovToZoom,
  horizontalFov,
  dragToDelta,
  applyDrag,
  applyZoom,
  viewToCamera,
  initialView,
  deriveViewLimits,
  type ViewLimits,
} from '../projection'

const L: ViewLimits = DEFAULT_LIMITS

describe('clampView', () => {
  it('clamps each axis independently to limits', () => {
    expect(clampView({ pan: 999, tilt: -999, fov: 999 })).toEqual({
      pan: L.maxPan,
      tilt: L.minTilt,
      fov: L.maxFov,
    })
  })
  it('leaves in-range values untouched', () => {
    const s = { pan: 10, tilt: -5, fov: 45 }
    expect(clampView(s)).toEqual(s)
  })
})

describe('zoom <-> fov', () => {
  it('zoom=1 is fully zoomed out (maxFov)', () => {
    expect(zoomToFov(1)).toBe(L.maxFov)
  })
  it('higher zoom narrows fov toward minFov and clamps', () => {
    expect(zoomToFov(2)).toBeCloseTo(L.maxFov / 2)
    expect(zoomToFov(1000)).toBe(L.minFov) // clamped, never below minFov
  })
  it('zoom below 1 is treated as 1 (cannot zoom out past the full frame)', () => {
    expect(zoomToFov(0.1)).toBe(L.maxFov)
  })
  it('fovToZoom is the inverse of zoomToFov within range', () => {
    const fov = zoomToFov(3)
    expect(fovToZoom(fov)).toBeCloseTo(3)
  })
})

describe('horizontalFov', () => {
  it('equals vertical fov at aspect 1', () => {
    expect(horizontalFov(60, 1)).toBeCloseTo(60)
  })
  it('is wider than vertical fov for a landscape aspect', () => {
    expect(horizontalFov(60, 16 / 9)).toBeGreaterThan(60)
  })
})

describe('dragToDelta (grab semantics)', () => {
  it('drag right looks left (pan decreases), drag down looks up (tilt increases)', () => {
    const { dPan, dTilt } = dragToDelta(100, 100, 60, 1920, 1080)
    expect(dPan).toBeLessThan(0)
    expect(dTilt).toBeGreaterThan(0)
  })
  it('scales with fov — a narrower fov (more zoom) moves less per pixel', () => {
    const wide = dragToDelta(100, 0, 80, 1920, 1080).dPan
    const narrow = dragToDelta(100, 0, 20, 1920, 1080).dPan
    expect(Math.abs(narrow)).toBeLessThan(Math.abs(wide))
  })
  it('returns zero for a degenerate viewport', () => {
    expect(dragToDelta(100, 100, 60, 0, 0)).toEqual({ dPan: 0, dTilt: 0 })
  })
})

describe('applyDrag', () => {
  it('moves the view and clamps at the pan limit', () => {
    const start = { pan: L.maxPan - 1, tilt: 0, fov: 60 }
    // large leftward drag → pan would exceed maxPan → clamped
    const next = applyDrag(start, -5000, 0, 1920, 1080)
    expect(next.pan).toBe(L.maxPan)
    expect(next.fov).toBe(60)
  })
})

describe('applyZoom', () => {
  it('scale > 1 zooms in (fov shrinks), clamped at minFov', () => {
    const next = applyZoom({ pan: 0, tilt: 0, fov: 60 }, 100)
    expect(next.fov).toBe(L.minFov)
  })
  it('scale < 1 zooms out (fov grows), clamped at maxFov', () => {
    const next = applyZoom({ pan: 0, tilt: 0, fov: 60 }, 0.01)
    expect(next.fov).toBe(L.maxFov)
  })
  it('non-positive scale is a no-op on fov', () => {
    expect(applyZoom({ pan: 0, tilt: 0, fov: 60 }, 0).fov).toBe(60)
  })
})

describe('viewToCamera', () => {
  it('converts degrees to radians and passes fov through in degrees', () => {
    const { yaw, pitch, fovDeg } = viewToCamera({ pan: 90, tilt: -45, fov: 50 })
    expect(yaw).toBeCloseTo(Math.PI / 2)
    expect(pitch).toBeCloseTo(-Math.PI / 4)
    expect(fovDeg).toBe(50)
  })
})

describe('initialView', () => {
  it('starts centered and fully zoomed out', () => {
    expect(initialView()).toEqual({ pan: 0, tilt: 0, fov: L.maxFov })
  })
})

describe('deriveViewLimits', () => {
  it('produces sane limits + arc for a normal 16:9 wide cam', () => {
    const { limits, arcRad, arcHeight } = deriveViewLimits(140, 16 / 9, 100)
    expect(limits.maxPan).toBeCloseTo(62) // 140/2 - 8
    expect(limits.minPan).toBeCloseTo(-62)
    expect(limits.maxTilt).toBeGreaterThan(0)
    expect(limits.maxFov).toBeGreaterThanOrEqual(limits.minFov)
    expect(arcRad).toBeGreaterThan(0)
    expect(arcHeight).toBeGreaterThan(0)
  })
  it('never yields min > max even for a degenerate ultra-wide aspect', () => {
    const { limits } = deriveViewLimits(140, 30, 100) // verticalFov tiny
    expect(limits.minTilt).toBeLessThanOrEqual(limits.maxTilt)
    expect(limits.minPan).toBeLessThanOrEqual(limits.maxPan)
    expect(limits.maxFov).toBeGreaterThanOrEqual(limits.minFov)
  })
  it('guards against zero/negative aspect', () => {
    const { arcHeight, limits } = deriveViewLimits(140, 0, 100)
    expect(Number.isFinite(arcHeight)).toBe(true)
    expect(limits.maxFov).toBeGreaterThanOrEqual(limits.minFov)
  })
})
