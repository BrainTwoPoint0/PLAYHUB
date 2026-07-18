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
  BLEND_FOV_LO,
  BLEND_FOV_HI,
  BLEND_FOV_DOWN_LO,
  BLEND_FOV_DOWN_HI,
  BLEND_MAX_DEFAULT,
  blendFactor,
  blendHalfExtents,
  blendPanHalfAngleDeg,
  overviewWiden,
  OVERVIEW_PAN_HALF_DEG,
  OVERVIEW_FOV_LO,
  blendProject,
  applyKeystone,
  curvedFovMax,
  CURVED_FOV_MAX_CEIL,
  type ViewLimits,
  intersectPanWindow,
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

describe('blendFactor (mid-range bump)', () => {
  it('is 0 at/below the up-ramp start and bmax on the plateau', () => {
    expect(blendFactor(BLEND_FOV_LO)).toBe(0)
    expect(blendFactor(BLEND_FOV_LO - 20)).toBe(0)
    expect(blendFactor(BLEND_FOV_HI)).toBe(BLEND_MAX_DEFAULT)
    expect(blendFactor(BLEND_FOV_DOWN_LO)).toBe(BLEND_MAX_DEFAULT)
    expect(blendFactor(70, BLEND_FOV_LO, BLEND_FOV_HI, 0.6)).toBe(0.6)
  })
  it('returns to PURE PINHOLE at/above the down-ramp end (whole-window zoom-out, Spiideo parity)', () => {
    expect(blendFactor(BLEND_FOV_DOWN_HI)).toBe(0)
    expect(blendFactor(127)).toBe(0)
    expect(
      blendFactor((BLEND_FOV_DOWN_LO + BLEND_FOV_DOWN_HI) / 2)
    ).toBeCloseTo(BLEND_MAX_DEFAULT / 2)
  })
  it('is 0.5·bmax at the up-ramp midpoint, monotone up then monotone down', () => {
    const mid = (BLEND_FOV_LO + BLEND_FOV_HI) / 2
    expect(blendFactor(mid)).toBeCloseTo(BLEND_MAX_DEFAULT * 0.5)
    let prev = -1
    for (let f = BLEND_FOV_LO; f <= BLEND_FOV_HI; f += 1) {
      const b = blendFactor(f)
      expect(b).toBeGreaterThanOrEqual(prev)
      prev = b
    }
    prev = BLEND_MAX_DEFAULT + 1
    for (let f = BLEND_FOV_DOWN_LO; f <= BLEND_FOV_DOWN_HI; f += 1) {
      const b = blendFactor(f)
      expect(b).toBeLessThanOrEqual(prev)
      prev = b
    }
  })
  it('legacy monotonic behaviour with the down-ramp pushed to Infinity', () => {
    expect(blendFactor(80, 42, 60, 1, Infinity, Infinity)).toBe(1)
    expect(blendFactor(150, 42, 60, 1, Infinity, Infinity)).toBe(1)
  })
  it('degenerate ramps (hi <= lo) are steps', () => {
    expect(blendFactor(45, 50, 50, 1, Infinity, Infinity)).toBe(0)
    expect(blendFactor(55, 50, 50, 1, Infinity, Infinity)).toBe(1)
    expect(blendFactor(101, 42, 60, 1, 100, 100)).toBe(0)
    expect(blendFactor(99, 42, 60, 1, 100, 100)).toBe(1)
  })
  it('clamps bmax to [0, 1] — b > 1 would fold the projection past 45°', () => {
    expect(blendFactor(70, BLEND_FOV_LO, BLEND_FOV_HI, 2)).toBe(1)
    expect(blendFactor(70, BLEND_FOV_LO, BLEND_FOV_HI, -1)).toBe(0)
  })
})

describe('blendProject', () => {
  const rays = [
    [0.3, 0.1, 1],
    [-0.8, -0.25, 1.4],
    [0.01, 0.4, 2],
    [1.6, -0.3, 1], // theta ≈ 58° — past the small-angle regime
  ] as const
  it('b=0 is the pinhole map (x = dx/dz, y = dy/dz)', () => {
    for (const [dx, dy, dz] of rays) {
      const { x, y } = blendProject(dx, dy, dz, 0)
      expect(x).toBeCloseTo(dx / dz, 12)
      expect(y).toBeCloseTo(dy / dz, 12)
    }
  })
  it('b=1 is the cylindrical map (x = theta, y = dy/hypot(dx,dz))', () => {
    for (const [dx, dy, dz] of rays) {
      const { x, y } = blendProject(dx, dy, dz, 1)
      expect(x).toBeCloseTo(Math.atan2(dx, dz), 12)
      expect(y).toBeCloseTo(dy / Math.hypot(dx, dz), 12)
    }
  })
  it('x is strictly monotone in dx for every blend', () => {
    for (const b of [0, 0.5, 1]) {
      let prev = -Infinity
      for (let dx = -1.2; dx <= 1.2; dx += 0.1) {
        const { x } = blendProject(dx, 0.2, 1, b)
        expect(x).toBeGreaterThan(prev)
        prev = x
      }
    }
  })
})

describe('blendHalfExtents', () => {
  it('b=0 is the pinhole frame (ties to horizontalFov)', () => {
    const { x, y } = blendHalfExtents(46, 16 / 9, 0)
    const DEG = Math.PI / 180
    expect(x).toBeCloseTo(Math.tan((horizontalFov(46, 16 / 9) / 2) * DEG), 12)
    expect(y).toBeCloseTo(Math.tan((46 / 2) * DEG), 12)
  })
  it('edge ray at hh projects to xmax for EVERY blend (angular extent invariant — why clampView needs no change)', () => {
    const DEG = Math.PI / 180
    const aspect = 16 / 9
    for (const vfov of [30, 46, 60]) {
      const hh = Math.atan(Math.tan((vfov / 2) * DEG) * aspect)
      for (const b of [0, 0.25, 0.5, 0.75, 1]) {
        const { x } = blendHalfExtents(vfov, aspect, b)
        const edge = blendProject(Math.sin(hh), 0, Math.cos(hh), b)
        expect(edge.x).toBeCloseTo(x, 12)
      }
    }
  })
  it('vertical footprint under blend never exceeds the pinhole frame (clamp stays conservative)', () => {
    for (const b of [0.25, 0.5, 1]) {
      const pin = blendHalfExtents(60, 16 / 9, 0)
      const bl = blendHalfExtents(60, 16 / 9, b)
      expect(bl.y).toBeLessThanOrEqual(pin.y)
    }
  })
})

describe('overview widening', () => {
  const DEG = Math.PI / 180
  const aspect = 16 / 9
  it('inactive below full cylindricality or below the fov ramp (extent-invariance law preserved)', () => {
    expect(overviewWiden(92, 0.99)).toBe(0)
    expect(overviewWiden(60, 1)).toBe(0)
    expect(overviewWiden(OVERVIEW_FOV_LO, 1)).toBe(0)
    // un-widened b=1 extents still follow the original x0 = hh law
    const hh = Math.atan(Math.tan((60 / 2) * DEG) * aspect)
    expect(blendHalfExtents(60, aspect, 1).x).toBeCloseTo(hh, 12)
  })
  it('reaches the full overview half-angle at the zoom-out cap', () => {
    expect(blendPanHalfAngleDeg(92, aspect, 1)).toBeCloseTo(
      OVERVIEW_PAN_HALF_DEG,
      9
    )
    expect(blendHalfExtents(92, aspect, 1).x).toBeCloseTo(
      OVERVIEW_PAN_HALF_DEG * DEG,
      9
    )
  })
  it('vertical extent returns to the nominal tan(vfov/2) at full widening', () => {
    expect(blendHalfExtents(92, aspect, 1).y).toBeCloseTo(
      Math.tan((92 / 2) * DEG),
      9
    )
  })
  it('is continuous at the ramp start', () => {
    const a = blendHalfExtents(OVERVIEW_FOV_LO, aspect, 1)
    const b = blendHalfExtents(OVERVIEW_FOV_LO + 1e-6, aspect, 1)
    expect(b.x - a.x).toBeLessThan(1e-4)
    expect(Math.abs(b.y - a.y)).toBeLessThan(1e-4)
  })
  it('clamp twin matches the render extents in the widened regime (angular units)', () => {
    for (const fov of [75, 84, 92]) {
      expect(blendPanHalfAngleDeg(fov, aspect, 1) * DEG).toBeCloseTo(
        blendHalfExtents(fov, aspect, 1).x,
        9
      )
    }
  })
})

describe('curvedFovMax (scene-derived zoom-out cap)', () => {
  const DEG = Math.PI / 180
  it('equals the window tilt height for a short window (HCT: ~47° tall)', () => {
    // HCT scene 315f936b: tilt −26.53°..+20.36°
    expect(curvedFovMax(-0.4630174526886419, 0.3554184441970182)).toBeCloseTo(
      46.9,
      1
    )
  })
  it('caps at the ceiling for the tallest window (Nazwa: −89.95..+37.07 ≈ 127°)', () => {
    expect(curvedFovMax(-89.95 * DEG, 37.07 * DEG)).toBe(CURVED_FOV_MAX_CEIL)
  })
  it('floors at minFovDeg for degenerate or inverted windows', () => {
    expect(curvedFovMax(-0.01, 0.01)).toBe(12)
    expect(curvedFovMax(0.5, -0.5)).toBe(12)
    expect(curvedFovMax(-0.01, 0.01, 30)).toBe(30)
  })
})

describe('applyKeystone', () => {
  it('k=0 is the identity', () => {
    expect(applyKeystone(0.4, -0.7, 0)).toEqual({ x: 0.4, y: -0.7 })
  })
  it('k > 0 narrows the bottom and widens the top', () => {
    expect(Math.abs(applyKeystone(0.5, -0.8, 0.2).x)).toBeLessThan(0.5)
    expect(Math.abs(applyKeystone(0.5, 0.8, 0.2).x)).toBeGreaterThan(0.5)
  })
  it('preserves collinearity (it is a homography — straight lines stay straight)', () => {
    // three collinear points on y = 0.3x − 0.2
    const pts = [-0.9, 0.1, 0.8].map((x) =>
      applyKeystone(x, 0.3 * x - 0.2, 0.25)
    )
    const [a, b, c] = pts
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    expect(Math.abs(cross)).toBeLessThan(1e-12)
  })
})

describe('intersectPanWindow', () => {
  it('narrows the mesh limits to the window', () => {
    expect(
      intersectPanWindow(-1.5, 1.5, { minRad: -0.4, maxRad: 0.9 })
    ).toEqual({ minPan: -0.4, maxPan: 0.9 })
  })
  it('no window returns the mesh limits', () => {
    expect(intersectPanWindow(-1.5, 1.5, null)).toEqual({
      minPan: -1.5,
      maxPan: 1.5,
    })
    expect(intersectPanWindow(-1.5, 1.5, undefined)).toEqual({
      minPan: -1.5,
      maxPan: 1.5,
    })
  })
  it('a window may only NARROW — wider bounds clamp to the mesh', () => {
    expect(intersectPanWindow(-1.0, 1.0, { minRad: -2, maxRad: 2 })).toEqual({
      minPan: -1.0,
      maxPan: 1.0,
    })
  })
  it('inverted, disjoint, or non-finite windows are ignored', () => {
    expect(intersectPanWindow(-1, 1, { minRad: 0.5, maxRad: -0.5 })).toEqual({
      minPan: -1,
      maxPan: 1,
    })
    expect(intersectPanWindow(-1, 1, { minRad: 2, maxRad: 3 })).toEqual({
      minPan: -1,
      maxPan: 1,
    })
    expect(intersectPanWindow(-1, 1, { minRad: NaN, maxRad: 0.5 })).toEqual({
      minPan: -1,
      maxPan: 1,
    })
  })
})
