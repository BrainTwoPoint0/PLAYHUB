// Player tracklets — Spiideo's per-player world positions converted to the
// dewarp's pan/tilt space by the player-tracklets Batch job and published as
// panorama-meshes/{gameId}/tracklets.json. The player's Spotlight mode reads
// it: click a player → ring + trail + camera-follow on that object.
//
// Angles are DEGREES in the dewarp convention. `t` is seconds on the produced
// video's presentation timeline (same clock as aim-track). Objects are
// identity FRAGMENTS (Spiideo tracklets fragment every ~10-15s and the job
// stitches only unambiguous bridges) — consumers re-associate on fragment end
// rather than assuming an object spans the match.

export interface TrackletObject {
  id: string
  t: number[]
  pan: number[]
  tilt: number[]
}

export interface Tracklets {
  version: number
  sampleFps: number
  t0OffsetSec: number
  objects: TrackletObject[]
  /** Roster cap (Tier 2a, meta.rosterN): players on the pitch. The overlay
   *  shows at most this many trackers. Absent on pre-Tier-2a artifacts → no cap. */
  rosterN?: number
}

export interface TrackletSample {
  panDeg: number
  tiltDeg: number
}

// ~700k points ceiling mirrors the job's cap; anything bigger is not a real
// artifact (self-DoS guard on a CDN-served optional fetch).
const MAX_TOTAL_POINTS = 800_000
const MAX_OBJECTS = 5_000

/**
 * Validate a fetched tracklets.json. CDN-served and optional, so malformed
 * payloads must degrade to null (no Spotlight), never throw into the mesh
 * load path — same contract as aim-track.json.
 *
 * Structural problems (wrong version, no object list, size-cap breach)
 * reject the whole payload; a malformed INDIVIDUAL object is skipped so one
 * bad fragment can't kill the feature for the whole match.
 */
export function parseTracklets(raw: unknown): Tracklets | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.version !== 1) return null
  if (!Array.isArray(o.objects)) return null
  if (o.objects.length === 0 || o.objects.length > MAX_OBJECTS) return null

  let total = 0
  const objects: TrackletObject[] = []
  entries: for (const entry of o.objects) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const { id, t, pan, tilt } = e
    if (typeof id !== 'string' || id.length === 0 || id.length > 32) continue
    if (!Array.isArray(t) || !Array.isArray(pan) || !Array.isArray(tilt))
      continue
    const n = t.length
    if (n < 2 || pan.length !== n || tilt.length !== n) continue
    total += n
    if (total > MAX_TOTAL_POINTS) return null // DoS guard is payload-level
    let prev = -Infinity
    for (let i = 0; i < n; i++) {
      if (
        !Number.isFinite(t[i]) ||
        !Number.isFinite(pan[i]) ||
        !Number.isFinite(tilt[i])
      )
        continue entries
      if ((t[i] as number) <= prev) continue entries // strictly ascending
      prev = t[i] as number
    }
    objects.push({
      id,
      t: t as number[],
      pan: pan as number[],
      tilt: tilt as number[],
    })
  }
  if (objects.length === 0) return null

  // Optional roster cap (meta.rosterN) — a positive integer or nothing.
  const meta =
    o.meta && typeof o.meta === 'object'
      ? (o.meta as Record<string, unknown>)
      : undefined
  const rosterN =
    meta && Number.isInteger(meta.rosterN) && (meta.rosterN as number) > 0
      ? (meta.rosterN as number)
      : undefined

  return {
    version: 1,
    sampleFps: Number.isFinite(o.sampleFps) ? (o.sampleFps as number) : 5,
    t0OffsetSec: Number.isFinite(o.t0OffsetSec) ? (o.t0OffsetSec as number) : 0,
    objects,
    rosterN,
  }
}

/**
 * Sample one object at time `sec`. Returns null outside the object's span —
 * fragments must NOT extrapolate (a held stale position reads as a frozen
 * ghost); the caller handles fragment hand-off explicitly.
 */
export function sampleObject(
  obj: TrackletObject,
  sec: number
): TrackletSample | null {
  const { t, pan, tilt } = obj
  const n = t.length
  if (sec < t[0] || sec > t[n - 1]) return null
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (t[mid] <= sec) lo = mid
    else hi = mid
  }
  const f = t[lo + 1] === t[lo] ? 0 : (sec - t[lo]) / (t[lo + 1] - t[lo])
  return {
    panDeg: pan[lo] + (pan[lo + 1] - pan[lo]) * f,
    tiltDeg: tilt[lo] + (tilt[lo + 1] - tilt[lo]) * f,
  }
}

export interface ActiveObject {
  index: number
  id: string
  panDeg: number
  tiltDeg: number
}

/**
 * All objects active at time `sec` with their interpolated positions —
 * the hit-test set for click-to-select and the dot overlay. Linear over the
 * object list (a few thousand fragments), but each miss is a two-comparison
 * span check; fine at RAF rates for real artifacts.
 */
export function objectsAt(track: Tracklets, sec: number): ActiveObject[] {
  const out: ActiveObject[] = []
  for (let i = 0; i < track.objects.length; i++) {
    const obj = track.objects[i]
    const s = sampleObject(obj, sec)
    if (s)
      out.push({ index: i, id: obj.id, panDeg: s.panDeg, tiltDeg: s.tiltDeg })
  }
  return out
}

/**
 * Nearest active object to (panDeg, tiltDeg) at `sec`, within `maxDeg`
 * angular distance. Used for click-to-select and for fragment hand-off
 * (re-associating the followed player when its fragment ends).
 */
export function nearestObject(
  track: Tracklets,
  sec: number,
  panDeg: number,
  tiltDeg: number,
  maxDeg: number,
  excludeIndex = -1
): ActiveObject | null {
  let best: ActiveObject | null = null
  let bestD = maxDeg
  for (const cand of objectsAt(track, sec)) {
    if (cand.index === excludeIndex) continue
    const dp = cand.panDeg - panDeg
    const dt = cand.tiltDeg - tiltDeg
    const d = Math.sqrt(dp * dp + dt * dt)
    if (d <= bestD) {
      bestD = d
      best = cand
    }
  }
  return best
}
