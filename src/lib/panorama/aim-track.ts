// Aim track — Spiideo's own camera path recovered offline by the aim-track
// Batch job (reg-SIFT of the produced Play render against the raw panorama)
// and published as panorama-meshes/{gameId}/aim-track.json. The player's
// Auto-follow mode samples it at the master video clock.
//
// Angles are DEGREES in the dewarp convention (pan about up, tilt about the
// panned right); fov is VERTICAL — the three.js PerspectiveCamera convention
// the player consumes (the job converts from the horizontal span via the
// 16:9 pinhole relation). `t` is seconds on the produced video's
// presentation timeline — the same clock the control bar scrubs.

export interface AimTrack {
  version: number
  sampleFps: number
  coverage: number
  t: number[]
  pan: number[]
  tilt: number[]
  fov: number[]
}

export interface AimSample {
  panDeg: number
  tiltDeg: number
  fovDeg: number
}

/**
 * Validate a fetched aim-track.json. CDN-served and optional, so malformed
 * payloads must degrade to null (no Auto-follow), never throw into the mesh
 * load path — same contract as tuning.json's saneGain handling.
 */
export function parseAimTrack(raw: unknown): AimTrack | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.version !== 1) return null
  const t = o.t,
    pan = o.pan,
    tilt = o.tilt,
    fov = o.fov
  if (
    !Array.isArray(t) ||
    !Array.isArray(pan) ||
    !Array.isArray(tilt) ||
    !Array.isArray(fov)
  )
    return null
  const n = t.length
  if (n < 2 || pan.length !== n || tilt.length !== n || fov.length !== n)
    return null
  let prev = -Infinity
  for (let i = 0; i < n; i++) {
    if (
      !Number.isFinite(t[i]) ||
      !Number.isFinite(pan[i]) ||
      !Number.isFinite(tilt[i]) ||
      !Number.isFinite(fov[i])
    )
      return null
    if ((t[i] as number) <= prev) return null // must be strictly ascending
    prev = t[i] as number
  }
  return {
    version: 1,
    sampleFps: typeof o.sample_fps === 'number' ? o.sample_fps : 5,
    coverage: typeof o.coverage === 'number' ? o.coverage : 1,
    t: t as number[],
    pan: pan as number[],
    tilt: tilt as number[],
    fov: fov as number[],
  }
}

/**
 * Sample the track at time `sec` (linear interpolation; clamped to the track
 * ends so pre-roll and post-roll hold the first/last aim).
 */
export function sampleAimTrack(track: AimTrack, sec: number): AimSample {
  const { t, pan, tilt, fov } = track
  const n = t.length
  if (sec <= t[0]) return { panDeg: pan[0], tiltDeg: tilt[0], fovDeg: fov[0] }
  if (sec >= t[n - 1])
    return { panDeg: pan[n - 1], tiltDeg: tilt[n - 1], fovDeg: fov[n - 1] }
  // Binary search for the interval [lo, lo+1] containing sec.
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (t[mid] <= sec) lo = mid
    else hi = mid
  }
  const f = (sec - t[lo]) / (t[lo + 1] - t[lo])
  return {
    panDeg: pan[lo] + (pan[lo + 1] - pan[lo]) * f,
    tiltDeg: tilt[lo] + (tilt[lo + 1] - tilt[lo]) * f,
    fovDeg: fov[lo] + (fov[lo + 1] - fov[lo]) * f,
  }
}
