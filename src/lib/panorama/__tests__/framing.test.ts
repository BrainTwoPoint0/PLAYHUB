import { describe, it, expect } from 'vitest'
import {
  FOV_MIN,
  DEFAULT_FRAMING,
  angularSpeedDeg,
  leadOffsetDeg,
  distortionPenalty,
  distortionFovFloor,
  rawFramingFov,
  framingTargetFov,
  applyFovHysteresis,
  searchFov,
  computeFraming,
  type LimitsDeg,
} from '../framing'

// A Nazwa-like scene: wide pan window, deep down-tilt, generous zoom-out cap.
const LIMITS: LimitsDeg = { minPan: -85, maxPan: 85, minTilt: -90, maxTilt: 37 }
const FOV_MAX = 127 // scene zoom-out cap (curvedFovMax)
const BASE = DEFAULT_FRAMING.baseFrameFov

describe('angularSpeedDeg', () => {
  it('is the euclidean magnitude of the velocity vector', () => {
    expect(angularSpeedDeg(3, 4)).toBeCloseTo(5)
    expect(angularSpeedDeg(0, 0)).toBe(0)
  })
  it('degrades non-finite input to 0', () => {
    expect(angularSpeedDeg(NaN, 4)).toBe(0)
    expect(angularSpeedDeg(3, Infinity)).toBe(0)
  })
})

describe('leadOffsetDeg', () => {
  const FOV = 30
  const cap = Math.min(
    DEFAULT_FRAMING.leadMaxDeg,
    DEFAULT_FRAMING.leadMaxFrac * FOV
  )
  it('offsets in the direction of motion (player trails, space ahead)', () => {
    const a = leadOffsetDeg(10, -5, FOV)
    expect(Math.sign(a.dPanDeg)).toBe(1)
    expect(Math.sign(a.dTiltDeg)).toBe(-1)
    const b = leadOffsetDeg(-10, 5, FOV)
    expect(Math.sign(b.dPanDeg)).toBe(-1)
    expect(Math.sign(b.dTiltDeg)).toBe(1)
  })
  it('is zero at rest', () => {
    expect(leadOffsetDeg(0, 0, FOV)).toEqual({ dPanDeg: 0, dTiltDeg: 0 })
  })
  it('clamps pan to the fov-scaled cap and damps the tilt component', () => {
    const a = leadOffsetDeg(1000, -1000, FOV)
    expect(a.dPanDeg).toBeCloseTo(cap)
    expect(a.dTiltDeg).toBeCloseTo(-cap * DEFAULT_FRAMING.leadTiltScale)
  })
  it('cap grows with fov (more lead room in a wider frame)', () => {
    const narrow = leadOffsetDeg(1000, 0, 20).dPanDeg
    const wide = leadOffsetDeg(1000, 0, 80).dPanDeg
    expect(wide).toBeGreaterThan(narrow)
    // never exceeds the absolute safety cap
    expect(wide).toBeLessThanOrEqual(DEFAULT_FRAMING.leadMaxDeg + 1e-9)
  })
  it('degrades non-finite input to 0', () => {
    expect(leadOffsetDeg(NaN, 5, FOV)).toEqual({ dPanDeg: 0, dTiltDeg: 0 })
  })
})

describe('distortionPenalty', () => {
  it('is 0 for a central, mid-tilt player', () => {
    expect(distortionPenalty(0, -25, LIMITS)).toBe(0)
  })
  it('rises to ~1 at the pan extents', () => {
    expect(distortionPenalty(LIMITS.maxPan, -25, LIMITS)).toBeCloseTo(1)
    expect(distortionPenalty(LIMITS.minPan, -25, LIMITS)).toBeCloseTo(1)
  })
  it('rises to ~1 at the downward tilt floor (near-camera fisheye)', () => {
    expect(distortionPenalty(0, LIMITS.minTilt, LIMITS)).toBeCloseTo(1)
  })
  it('does NOT penalize the upward/sky extent', () => {
    expect(distortionPenalty(0, LIMITS.maxTilt, LIMITS)).toBe(0)
  })
  it('penalizes a corner MORE than either edge alone', () => {
    const corner = distortionPenalty(
      LIMITS.maxPan - 4,
      LIMITS.minTilt + 4,
      LIMITS
    )
    const panEdge = distortionPenalty(LIMITS.maxPan - 4, -25, LIMITS)
    const tiltEdge = distortionPenalty(0, LIMITS.minTilt + 4, LIMITS)
    expect(corner).toBeGreaterThan(panEdge)
    expect(corner).toBeGreaterThan(tiltEdge)
  })
  it('is monotonic non-increasing as the player moves inward from an edge', () => {
    const atEdge = distortionPenalty(LIMITS.maxPan, -25, LIMITS)
    const nearEdge = distortionPenalty(LIMITS.maxPan - 5, -25, LIMITS)
    const inside = distortionPenalty(LIMITS.maxPan - 40, -25, LIMITS)
    expect(atEdge).toBeGreaterThanOrEqual(nearEdge)
    expect(nearEdge).toBeGreaterThanOrEqual(inside)
    expect(inside).toBe(0)
  })
  it('stays within [0,1] and degrades bad input to 0', () => {
    const p = distortionPenalty(LIMITS.maxPan, LIMITS.minTilt, LIMITS)
    expect(p).toBeGreaterThanOrEqual(0)
    expect(p).toBeLessThanOrEqual(1)
    expect(distortionPenalty(NaN, -25, LIMITS)).toBe(0)
  })
})

describe('distortionFovFloor', () => {
  it('is BASE at zero penalty and widens with penalty', () => {
    expect(distortionFovFloor(0, FOV_MAX)).toBeCloseTo(BASE)
    expect(distortionFovFloor(1, FOV_MAX)).toBeGreaterThan(BASE)
  })
  it('is monotonic non-decreasing in penalty', () => {
    expect(distortionFovFloor(0.7, FOV_MAX)).toBeGreaterThanOrEqual(
      distortionFovFloor(0.3, FOV_MAX)
    )
  })
  it('never exceeds sceneFovMax', () => {
    expect(distortionFovFloor(1, 40)).toBeLessThanOrEqual(40)
  })
})

describe('rawFramingFov', () => {
  it('is BASE for a static player', () => {
    expect(rawFramingFov(0, FOV_MAX)).toBeCloseTo(BASE)
  })
  it('ignores jitter below the speed floor (no noise pedestal)', () => {
    expect(
      rawFramingFov(DEFAULT_FRAMING.speedFloorDeg - 0.01, FOV_MAX)
    ).toBeCloseTo(BASE)
    expect(
      rawFramingFov(DEFAULT_FRAMING.speedFloorDeg + 10, FOV_MAX)
    ).toBeGreaterThan(BASE)
  })
  it('is non-decreasing in speed (fast run → more context)', () => {
    expect(rawFramingFov(20, FOV_MAX)).toBeGreaterThanOrEqual(
      rawFramingFov(2, FOV_MAX)
    )
  })
  it('caps the speed widening at SPEED_FOV_MAX_ADD', () => {
    const capped = BASE + DEFAULT_FRAMING.speedFovMaxAdd
    expect(rawFramingFov(1e6, FOV_MAX)).toBeCloseTo(Math.min(capped, FOV_MAX))
  })
  it('never below FOV_MIN nor above sceneFovMax', () => {
    expect(rawFramingFov(0, 40)).toBeLessThanOrEqual(40)
    expect(rawFramingFov(0, FOV_MAX)).toBeGreaterThanOrEqual(FOV_MIN)
  })
})

describe('framingTargetFov', () => {
  it('takes the WIDER of speed-widen and distortion-floor', () => {
    // penalty=1 forces the distortion floor; a slow player’s raw fov is BASE.
    const t = framingTargetFov(0, 1, FOV_MAX)
    expect(t).toBeCloseTo(distortionFovFloor(1, FOV_MAX))
    expect(t).toBeGreaterThan(BASE)
  })
  it('saturates at sceneFovMax for a short-window scene', () => {
    // HCT-like: curvedFovMax below BASE → target pinned to the cap.
    const small = 20
    expect(framingTargetFov(50, 1, small)).toBeLessThanOrEqual(small)
    expect(framingTargetFov(50, 1, small)).toBeCloseTo(small)
  })
  it('stays within [FOV_MIN, sceneFovMax]', () => {
    const t = framingTargetFov(5, 0.5, FOV_MAX)
    expect(t).toBeGreaterThanOrEqual(FOV_MIN)
    expect(t).toBeLessThanOrEqual(FOV_MAX)
  })
})

describe('applyFovHysteresis (slew-limited goal)', () => {
  const step = DEFAULT_FRAMING.fovGoalStepDeg
  it('seeds directly when prevGoal is unset (<=0)', () => {
    expect(applyFovHysteresis(0, 34)).toBe(34)
    expect(applyFovHysteresis(-1, 34)).toBe(34)
  })
  it('holds the goal for sub-step changes (no breathing)', () => {
    const prev = 30
    expect(applyFovHysteresis(prev, prev + step * 0.5)).toBe(prev)
    expect(applyFovHysteresis(prev, prev - step * 0.5)).toBe(prev)
  })
  it('moves by at most one step toward desired, never snapping to it', () => {
    const prev = 30
    expect(applyFovHysteresis(prev, prev + step * 5)).toBeCloseTo(prev + step)
    expect(applyFovHysteresis(prev, prev - step * 5)).toBeCloseTo(prev - step)
  })
  it('converges to within one step of a stable desired over several frames', () => {
    let goal = 30
    for (let i = 0; i < 50; i++) goal = applyFovHysteresis(goal, 45)
    // dead-band: settles within `step` of desired, never overshoots past it
    expect(goal).toBeGreaterThanOrEqual(45 - step - 1e-9)
    expect(goal).toBeLessThanOrEqual(45 + 1e-9)
  })
  it('an oscillating input within the band produces a constant output', () => {
    let goal = 30
    const outs: number[] = []
    for (let i = 0; i < 20; i++) {
      goal = applyFovHysteresis(goal, 30 + (i % 2 === 0 ? 1 : -1) * step * 0.4)
      outs.push(goal)
    }
    expect(new Set(outs).size).toBe(1)
  })
  it('ATTENUATES a large fast oscillation (the anti-breathing guarantee)', () => {
    // ±10° chatter around 30° → the goal must stay within ~one step of centre,
    // NOT track the peaks (the bug the slew limiter fixes).
    let goal = 30
    let lo = Infinity,
      hi = -Infinity
    for (let i = 0; i < 40; i++) {
      goal = applyFovHysteresis(goal, 30 + (i % 2 === 0 ? 10 : -10))
      if (i > 2) {
        lo = Math.min(lo, goal)
        hi = Math.max(hi, goal)
      }
    }
    expect(hi - lo).toBeLessThanOrEqual(2 * step + 1e-9) // vs 20° raw p2p
  })
})

describe('searchFov', () => {
  it('is wider than BASE and never above sceneFovMax', () => {
    expect(searchFov(FOV_MAX)).toBeGreaterThan(BASE)
    expect(searchFov(40)).toBeLessThanOrEqual(40)
    expect(searchFov(FOV_MAX)).toBeGreaterThanOrEqual(FOV_MIN)
  })
})

describe('computeFraming (façade)', () => {
  const base = {
    limitsDeg: LIMITS,
    sceneFovMax: FOV_MAX,
    prevGoalFov: 0,
  }
  it('a static central player: aim == position, target == BASE', () => {
    const out = computeFraming({
      ...base,
      panDeg: 0,
      tiltDeg: -25,
      vPanDeg: 0,
      vTiltDeg: 0,
    })
    expect(out.aimPanDeg).toBeCloseTo(0)
    expect(out.aimTiltDeg).toBeCloseTo(-25)
    expect(out.targetFov).toBeCloseTo(BASE)
  })
  it('a fast player near an edge: aim leads AND target widened, within bounds', () => {
    const out = computeFraming({
      ...base,
      panDeg: LIMITS.maxPan - 3,
      tiltDeg: -25,
      vPanDeg: 30,
      vTiltDeg: 0,
    })
    expect(out.aimPanDeg).toBeGreaterThan(LIMITS.maxPan - 3) // leads forward
    expect(out.targetFov).toBeGreaterThan(BASE) // widened by edge + speed
    expect(out.targetFov).toBeLessThanOrEqual(FOV_MAX)
  })
  it('respects the hysteresis baseline (holds a near-equal prev goal)', () => {
    const out = computeFraming({
      ...base,
      panDeg: 0,
      tiltDeg: -25,
      vPanDeg: 0,
      vTiltDeg: 0,
      prevGoalFov: BASE + DEFAULT_FRAMING.fovGoalStepDeg * 0.5,
    })
    expect(out.targetFov).toBe(BASE + DEFAULT_FRAMING.fovGoalStepDeg * 0.5)
  })
  it('degrades non-finite input to a safe framing (aim=pos, target in range)', () => {
    const out = computeFraming({
      ...base,
      panDeg: 0,
      tiltDeg: -25,
      vPanDeg: NaN,
      vTiltDeg: NaN,
    })
    expect(Number.isFinite(out.aimPanDeg)).toBe(true)
    expect(Number.isFinite(out.targetFov)).toBe(true)
    expect(out.targetFov).toBeGreaterThanOrEqual(FOV_MIN)
    expect(out.targetFov).toBeLessThanOrEqual(FOV_MAX)
  })
  it('degrades a non-finite scene cap WIDE, never to the tightest zoom', () => {
    const out = computeFraming({
      ...base,
      panDeg: 0,
      tiltDeg: -25,
      vPanDeg: 0,
      vTiltDeg: 0,
      sceneFovMax: NaN,
    })
    expect(out.targetFov).toBeGreaterThanOrEqual(BASE) // NOT FOV_MIN
    expect(out.targetFov).toBeLessThanOrEqual(
      DEFAULT_FRAMING.sceneFovMaxFallback
    )
  })
})
