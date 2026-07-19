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
  /** Jersey number (Tier 3): present only on fragments whose identity was
   *  strictly established (≥2 agreeing legible reads on a kit-consistent
   *  chain). Absent = honest-unlabelled — never inferred client-side. */
  jersey?: string
  /** Identity SLOT (Tier 3 / B3): kit-cluster letter + number (e.g. "a10"),
   *  with a "-2" suffix when two real bodies provably share a (number, kit),
   *  or a synthetic goalkeeper zone-slot ("g1".."g4" — per end per half,
   *  no jersey; the badge stays hidden). Kit slots mean SAME player;
   *  g-slots mean ZONE identity — "the keeper defending that end that
   *  half" (a mid-half keeper substitution rides the slot). Fragments
   *  sharing a slot draw one dot and the follow rides the slot across
   *  fragment gaps. Opaque equality key. Absent = honest-unlabelled. */
  slot?: string
  /** Inferred (interpolated) spans, `[t0, t1]` pairs on the same clock as `t`.
   *  The producer marks any gap in the ORIGINAL samples wider than its bridge
   *  threshold; smooth_and_resample lerps straight across it, so a sample
   *  whose time falls strictly inside a span is a GUESS (a stitch bridge or a
   *  dropout), not tracked data. The overlay dashes it so a wrong glide reads
   *  as uncertain instead of confident. Absent = fully tracked. */
  bridged?: [number, number][]
}

export interface Tracklets {
  version: number
  sampleFps: number
  t0OffsetSec: number
  objects: TrackletObject[]
  /** Roster cap (Tier 2a, meta.rosterN): players on the pitch. The overlay
   *  shows at most this many trackers. Absent on pre-Tier-2a artifacts → no cap. */
  rosterN?: number
  /** Last fragment end time (seconds) per slot id. Lets the follow prove a
   *  slot is EXHAUSTED (no fragment can ever re-appear — e.g. a per-half GK
   *  slot after half time) and expire instead of watching forever. */
  slotEnd: Record<string, number>
}

export interface TrackletSample {
  panDeg: number
  tiltDeg: number
}

// ~700k points ceiling mirrors the job's cap; anything bigger is not a real
// artifact (self-DoS guard on a CDN-served optional fetch). POINTS is the
// real payload/memory guard; the object cap only bounds bookkeeping.
// Stadium-bowl venues (HCT: whole-bowl tracking, ~9s median fragments over a
// 2.5h stream) legitimately publish ~25k fragments at 2.5Hz — a 5k object
// cap silently killed Spotlight there. Decimated objects can be as small as
// 2 points (endpoints only), so the points cap implies <= 400k objects; 40k
// is a sanity bound, not the size gate.
const MAX_TOTAL_POINTS = 800_000
const MAX_OBJECTS = 40_000

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
    // Optional jersey label — a 1-2 digit string or nothing. Malformed
    // values drop the FIELD, not the object (same degrade contract).
    const jersey =
      typeof e.jersey === 'string' && /^\d{1,2}$/.test(e.jersey)
        ? e.jersey
        : undefined
    // Optional slot key — kit letter + number (+ body suffix), or a
    // synthetic GK zone-slot ("g1".."g4"). Kit slots keep the jersey
    // co-presence contract (they are minted FROM jerseys — one without is
    // a buggy producer and gets dropped); only g-slots are valid alone
    // (they carry no number by design, badge stays hidden).
    const slotRaw =
      typeof e.slot === 'string' && /^[a-z]\d{1,2}(-\d{1,2})?$/.test(e.slot)
        ? e.slot
        : undefined
    const slot =
      slotRaw !== undefined && (jersey !== undefined || /^g\d$/.test(slotRaw))
        ? slotRaw
        : undefined
    // Optional bridged spans — finite `[t0, t1]` pairs with t0 < t1. Malformed
    // pairs are dropped individually (same degrade contract as jersey/slot); an
    // all-bad or absent array simply omits the field (fully-tracked).
    const bridged: [number, number][] = Array.isArray(e.bridged)
      ? (e.bridged.filter(
          (s): s is [number, number] =>
            Array.isArray(s) &&
            s.length === 2 &&
            Number.isFinite(s[0]) &&
            Number.isFinite(s[1]) &&
            (s[0] as number) < (s[1] as number)
        ) as [number, number][])
      : []
    objects.push({
      id,
      t: t as number[],
      pan: pan as number[],
      tilt: tilt as number[],
      ...(jersey !== undefined ? { jersey } : {}),
      ...(slot !== undefined ? { slot } : {}),
      ...(bridged.length > 0 ? { bridged } : {}),
    })
  }
  if (objects.length === 0) return null

  // Last fragment end per slot — the client's proof that a slot is
  // exhausted (its label can never re-appear), which bounds the otherwise
  // indefinite slot watch.
  const slotEnd: Record<string, number> = {}
  for (const obj of objects) {
    if (obj.slot !== undefined) {
      const end = obj.t[obj.t.length - 1]
      if (slotEnd[obj.slot] === undefined || end > slotEnd[obj.slot])
        slotEnd[obj.slot] = end
    }
  }

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
    slotEnd,
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

/**
 * Angular distance between two pan/tilt directions, in degrees. View- and
 * zoom-independent, unlike a pixel distance — the overlay merges duplicate
 * dots on this so two fragments of one body stay one dot at every zoom.
 */
export function angDistDeg(
  aPan: number,
  aTilt: number,
  bPan: number,
  bTilt: number
): number {
  return Math.hypot(aPan - bPan, aTilt - bTilt)
}

/**
 * Is the object's position at `sec` interpolated across a bridged gap? True
 * only STRICTLY inside a span — the endpoints are observed samples. Linear
 * over the (few) spans; called per active object per frame.
 */
export function isBridged(obj: TrackletObject, sec: number): boolean {
  const spans = obj.bridged
  if (!spans) return false
  for (const [t0, t1] of spans) if (sec > t0 && sec < t1) return true
  return false
}

export interface ActiveObject {
  index: number
  id: string
  panDeg: number
  tiltDeg: number
  /** Slot key of the underlying object, when labelled (see TrackletObject.slot). */
  slot?: string
  /** True when this sample is interpolated across a bridged gap (see
   *  isBridged) — the overlay dashes it as inferred rather than tracked. */
  bridged: boolean
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
      out.push({
        index: i,
        id: obj.id,
        panDeg: s.panDeg,
        tiltDeg: s.tiltDeg,
        ...(obj.slot !== undefined ? { slot: obj.slot } : {}),
        bridged: isBridged(obj, sec),
      })
  }
  return out
}

/**
 * Nearest active object to (panDeg, tiltDeg) at `sec`, within `maxDeg`
 * angular distance. Used for click-to-select and for fragment hand-off
 * (re-associating the followed player when its fragment ends).
 */
/**
 * The active fragment carrying `slot`, excluding `excludeIndex` — the
 * slot-riding hand-off: fragments sharing a slot are the same player by
 * strict (number, kit) labelling, so the follow may adopt a slot-mate at ANY
 * distance (the label, unlike geometry, does not decay with gap length).
 * Slots are unique among concurrent fragments by construction; if an
 * artifact ever violates that, the nearest mate to (panDeg, tiltDeg) wins.
 */
export function slotMate(
  track: Tracklets,
  sec: number,
  slot: string,
  panDeg: number,
  tiltDeg: number,
  excludeIndex = -1
): ActiveObject | null {
  let best: ActiveObject | null = null
  let bestD = Infinity
  for (const cand of objectsAt(track, sec)) {
    if (cand.index === excludeIndex || cand.slot !== slot) continue
    const dp = cand.panDeg - panDeg
    const dt = cand.tiltDeg - tiltDeg
    const d = Math.sqrt(dp * dp + dt * dt)
    if (d < bestD) {
      bestD = d
      best = cand
    }
  }
  return best
}

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
