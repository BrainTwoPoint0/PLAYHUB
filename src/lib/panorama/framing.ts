// Framing law for the player-locked virtual camera (Explore Spotlight "Lock").
//
// When the user LOCKS onto a tracked player, the de-warp camera must zoom in to
// FRAME them — not just aim at them. The product decision (2026-07-17) is
// CONTEXT framing: show the player PLUS ~15-20m of pitch (their positioning /
// runs / space), never a tight portrait. Off-ball watching is the point, and a
// wider frame is far more forgiving of the ~5Hz tracklet wobble and the
// fisheye's soft edges.
//
// Design (prior-art: Cinemachine lead-room + broadcast zoom hysteresis +
// quality-aware zoom capping). A single small player's angular height is tiny
// and noisy, so we do NOT drive zoom to a "subject fills X% of frame" target
// (that demands extreme, breathing zoom). Instead the target fov is a near-
// CONSTANT context fov, only ever pushed WIDER by (a) the player's angular speed
// (a fast run needs more lead space) and (b) a distortion penalty that caps the
// zoom in the high-distortion regions of the fisheye (near the pan/tilt extents
// and the steep downward/near-camera tilt). Lead-room offsets the AIM in the
// direction of motion so a running player isn't pinned against the edge.
//
// Anti-breathing is enforced HERE, not left to the consumer's damper: a raw
// speed signal off the 5Hz tracker is noisy, and rectifying it with hypot()
// biases a *standing* player's fov wider than base. So the speed term has a
// FLOOR (a motionless-but-jittering player reads as speed 0), and the committed
// fov goal is SLEW-LIMITED per frame (a true dead-band, not a re-centering one)
// so residual noise can never chatter the goal to its peaks. The consumer's
// smoothDamp is then a second, independent smoother — not the only one.
//
// Pure + framework-free, matching projection.ts / aim-track.ts / tracklets.ts.
// ALL angles are DEGREES (the caller converts the radian view-limits at the
// boundary). All tunables live in DEFAULT_FRAMING so they are eye-tunable on
// /panorama-test. Every function degrades non-finite input to a SAFE-WIDE value
// — this feeds a live camera, and the safe direction is wide, never tight.

/** Zoom-in ceiling (narrowest fov), mirrors VirtualPanoramaPlayer's FOV_MIN. */
export const FOV_MIN = 12

export interface LimitsDeg {
  minPan: number
  maxPan: number
  minTilt: number
  maxTilt: number
}

export interface FramingParams {
  /** Nominal locked fov for a static, central player (deg). The #1 feel knob:
   *  smaller = tighter/closer, larger = more context. Kept wide for CONTEXT
   *  framing, but tighter than the scene's open fov so Lock visibly zooms in. */
  baseFrameFov: number
  /** Extra fov (deg) added per (deg/s) of angular speed ABOVE the floor. */
  speedFovGain: number
  /** Cap on the speed-based widening (deg). */
  speedFovMaxAdd: number
  /** Speed floor (deg/s): speed below this widens nothing. Kills the hypot()
   *  noise-rectification pedestal that would frame a standing player too wide. */
  speedFloorDeg: number
  /** Look-ahead horizon (s): aim offset = velocity · leadTimeSec. */
  leadTimeSec: number
  /** Absolute per-axis safety cap on the lead-room offset (deg). */
  leadMaxDeg: number
  /** Lead offset as a fraction of the CURRENT fov, so lead scales with the
   *  frame (a wide frame gives more lead room) instead of a fixed degree. */
  leadMaxFrac: number
  /** Tilt lead is damped: pano vertical motion is mostly perspective + noise,
   *  and un-damped tilt lead pushes the aim toward the near-camera nadir. */
  leadTiltScale: number
  /** Max per-frame change of the committed fov GOAL (deg). A slew limiter —
   *  a genuine dead-band that always attenuates goal chatter, unlike a
   *  re-centering deadzone which snaps to the noisy target. */
  fovGoalStepDeg: number
  /** Pan proximity-to-extent band (deg) over which the distortion penalty ramps
   *  from 0 (inside) to 1 (at the extent). */
  distEdgeMarginDeg: number
  /** Downward-tilt band (deg) above minTilt over which the near-camera fisheye
   *  penalty ramps from 1 (at the floor) to 0. Wide + gentle so a toward-camera
   *  run eases the frame rather than pumping it. */
  distTiltDownDeg: number
  /** Max extra fov (deg) the worst distortion forces (widen-only zoom cap). */
  distFovFloorAdd: number
  /** The wide "searching" fov to ease toward when the lock coasts / is lost. */
  searchFov: number
  /** Fallback zoom-out cap when the scene's is non-finite — degrade WIDE. */
  sceneFovMaxFallback: number
}

export const DEFAULT_FRAMING: FramingParams = {
  baseFrameFov: 30,
  speedFovGain: 0.8,
  speedFovMaxAdd: 12,
  speedFloorDeg: 4,
  leadTimeSec: 0.4,
  leadMaxDeg: 6,
  leadMaxFrac: 0.18,
  leadTiltScale: 0.25,
  fovGoalStepDeg: 2.5,
  distEdgeMarginDeg: 15,
  distTiltDownDeg: 22,
  distFovFloorAdd: 22,
  searchFov: 55,
  sceneFovMaxFallback: 100,
}

const clampNum = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v))

/** Hermite smoothstep of x over [edge0, edge1] → [0,1] (projection.ts twin). */
const smoothstep = (edge0: number, edge1: number, x: number): number => {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0
  const t = clampNum((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Magnitude of the EMA angular-velocity vector (deg/s). A non-finite component
 *  corrupts the whole vector → 0 (no speed-widen rather than a garbage value). */
export function angularSpeedDeg(vPanDeg: number, vTiltDeg: number): number {
  if (!Number.isFinite(vPanDeg) || !Number.isFinite(vTiltDeg)) return 0
  return Math.hypot(vPanDeg, vTiltDeg)
}

/**
 * Lead-room: offset the AIM in the direction of motion so a running player
 * trails the frame centre (space ahead of them). The per-axis cap is the
 * smaller of an absolute degree cap and a FRACTION of the current fov (so lead
 * grows with the frame). The tilt component is damped (`leadTiltScale`) — pano
 * tilt motion is mostly noisy perspective and un-damped tilt lead shoves the
 * aim toward the near-camera nadir. Zero at rest / on non-finite input.
 */
export function leadOffsetDeg(
  vPanDeg: number,
  vTiltDeg: number,
  fovDeg: number,
  p: FramingParams = DEFAULT_FRAMING
): { dPanDeg: number; dTiltDeg: number } {
  if (!Number.isFinite(vPanDeg) || !Number.isFinite(vTiltDeg))
    return { dPanDeg: 0, dTiltDeg: 0 }
  const cap = Math.min(
    p.leadMaxDeg,
    p.leadMaxFrac * (Number.isFinite(fovDeg) ? fovDeg : p.baseFrameFov)
  )
  return {
    dPanDeg: clampNum(vPanDeg * p.leadTimeSec, -cap, cap),
    dTiltDeg: p.leadTiltScale * clampNum(vTiltDeg * p.leadTimeSec, -cap, cap),
  }
}

/**
 * Distortion penalty in [0,1]: how far into a low-quality fisheye region the
 * player sits. Combines (a) proximity to either pan extent and (b) proximity to
 * the DOWNWARD tilt floor (minTilt — the near-camera edge) via a probabilistic
 * OR (`a + b − ab`), so a CORNER (both high) is penalized MORE than either edge
 * alone — closer to how fisheye resolution loss couples the two. The upward/sky
 * extent is NOT penalized (we never frame there). 0 = clean centre, 1 = worst.
 */
export function distortionPenalty(
  panDeg: number,
  tiltDeg: number,
  limitsDeg: LimitsDeg,
  p: FramingParams = DEFAULT_FRAMING
): number {
  if (!Number.isFinite(panDeg) || !Number.isFinite(tiltDeg)) return 0
  // how far inside the nearest pan extent (deg); 0 at the extent, big = central
  const panInside = Math.min(
    panDeg - limitsDeg.minPan,
    limitsDeg.maxPan - panDeg
  )
  const panPen = 1 - smoothstep(0, p.distEdgeMarginDeg, panInside)
  // how far above the downward floor (deg); 0 at the floor, big = higher up
  const tiltAboveFloor = tiltDeg - limitsDeg.minTilt
  const tiltPen = 1 - smoothstep(0, p.distTiltDownDeg, tiltAboveFloor)
  return clampNum(panPen + tiltPen - panPen * tiltPen, 0, 1)
}

/**
 * Distortion → a MINIMUM allowed fov (a cap on how far the lock may zoom in):
 * wider frame in worse regions, never tighter, never above the scene cap.
 */
export function distortionFovFloor(
  penalty: number,
  sceneFovMax: number,
  p: FramingParams = DEFAULT_FRAMING
): number {
  const pen = clampNum(Number.isFinite(penalty) ? penalty : 0, 0, 1)
  return Math.min(p.baseFrameFov + pen * p.distFovFloorAdd, sceneFovMax)
}

/** Base context fov widened by angular speed ABOVE the floor (fast run → more
 *  lead space; a jittering standing player stays at base). */
export function rawFramingFov(
  speedDeg: number,
  sceneFovMax: number,
  p: FramingParams = DEFAULT_FRAMING
): number {
  const over = Math.max(
    0,
    (Number.isFinite(speedDeg) ? speedDeg : 0) - p.speedFloorDeg
  )
  const add = Math.min(over * p.speedFovGain, p.speedFovMaxAdd)
  return clampNum(p.baseFrameFov + add, FOV_MIN, sceneFovMax)
}

/** Instantaneous desired fov = the WIDER of the speed-widen and the distortion
 *  floor, clamped to the scene's zoomable range. */
export function framingTargetFov(
  speedDeg: number,
  penalty: number,
  sceneFovMax: number,
  p: FramingParams = DEFAULT_FRAMING
): number {
  const raw = rawFramingFov(speedDeg, sceneFovMax, p)
  const floor = distortionFovFloor(penalty, sceneFovMax, p)
  return clampNum(Math.max(raw, floor), FOV_MIN, sceneFovMax)
}

/**
 * Slew-limited fov GOAL: the committed goal moves toward `desiredFov` by at most
 * `stepDeg` per frame. This is a genuine dead-band — residual target noise can
 * never chatter the goal to its peaks (unlike a re-centering deadzone, which
 * snaps to the noisy desired the instant it breaks the band and thus attenuates
 * nothing). A seed goal (<=0) or non-finite desired passes straight through.
 * The downstream smoothDamp then adds a second, independent smoothing stage.
 */
export function applyFovHysteresis(
  prevGoalFov: number,
  desiredFov: number,
  stepDeg: number = DEFAULT_FRAMING.fovGoalStepDeg
): number {
  if (!Number.isFinite(desiredFov)) return prevGoalFov
  if (!(prevGoalFov > 0)) return desiredFov
  const delta = desiredFov - prevGoalFov
  if (Math.abs(delta) <= stepDeg) return prevGoalFov
  return prevGoalFov + Math.sign(delta) * stepDeg
}

/** The wide fov to ease toward while coasting / lost (bounded to the scene). */
export function searchFov(
  sceneFovMax: number,
  p: FramingParams = DEFAULT_FRAMING
): number {
  return clampNum(p.searchFov, FOV_MIN, sceneFovMax)
}

export interface FramingInput {
  panDeg: number
  tiltDeg: number
  vPanDeg: number
  vTiltDeg: number
  limitsDeg: LimitsDeg
  sceneFovMax: number
  /** The lock's committed fov goal from the previous frame (0 = unset/seed). */
  prevGoalFov: number
  params?: Partial<FramingParams>
}

export interface FramingOutput {
  aimPanDeg: number
  aimTiltDeg: number
  /** Already clamped to [FOV_MIN, sceneFovMax] — clampView is a no-op on fov,
   *  so the smoothDamp goal is never clamped mid-motion (which would stall it). */
  targetFov: number
}

/**
 * One call for the RAF driver: lead-room aim + slew-limited context fov
 * (speed-widened above a floor, distortion-capped). Degrades to a safe WIDE
 * framing (aim = the player's position, target = base) if anything comes out
 * non-finite — never to the tightest zoom.
 */
export function computeFraming(input: FramingInput): FramingOutput {
  const p: FramingParams = input.params
    ? { ...DEFAULT_FRAMING, ...input.params }
    : DEFAULT_FRAMING
  const panDeg = input.panDeg
  const tiltDeg = input.tiltDeg
  // Degrade the scene cap WIDE, never to FOV_MIN (the most nauseating fallback).
  const sceneFovMax =
    Number.isFinite(input.sceneFovMax) && input.sceneFovMax >= FOV_MIN
      ? input.sceneFovMax
      : p.sceneFovMaxFallback
  const safe = (): FramingOutput => ({
    aimPanDeg: Number.isFinite(panDeg) ? panDeg : 0,
    aimTiltDeg: Number.isFinite(tiltDeg) ? tiltDeg : 0,
    targetFov: clampNum(p.baseFrameFov, FOV_MIN, sceneFovMax),
  })
  if (!Number.isFinite(panDeg) || !Number.isFinite(tiltDeg)) return safe()

  const speed = angularSpeedDeg(input.vPanDeg, input.vTiltDeg)
  const penalty = distortionPenalty(panDeg, tiltDeg, input.limitsDeg, p)
  const desired = framingTargetFov(speed, penalty, sceneFovMax, p)
  // slew-limit the goal, then clamp (a held goal can fall out of range if the
  // scene cap shrinks) — the clamp keeps the smoothDamp goal in [FOV_MIN, cap]
  const targetFov = clampNum(
    applyFovHysteresis(input.prevGoalFov, desired, p.fovGoalStepDeg),
    FOV_MIN,
    sceneFovMax
  )
  // lead scales with the committed fov (computed after the fov is known)
  const lead = leadOffsetDeg(input.vPanDeg, input.vTiltDeg, targetFov, p)

  const out: FramingOutput = {
    aimPanDeg: panDeg + lead.dPanDeg,
    aimTiltDeg: tiltDeg + lead.dTiltDeg,
    targetFov,
  }
  if (
    !Number.isFinite(out.aimPanDeg) ||
    !Number.isFinite(out.aimTiltDeg) ||
    !Number.isFinite(out.targetFov)
  )
    return safe()
  return out
}
