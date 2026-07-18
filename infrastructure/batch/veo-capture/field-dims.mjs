// The metric scale for a match's player tracking. Its own module so it can be
// unit-tested: entrypoint.mjs builds a Supabase client at import time and cannot
// be imported from a test.
//
// WHY THIS EXISTS (measured 2026-07-15, cfa-u11 + cfa-u10 held out):
// tracking.json's xNorm/yNorm are normalised against THIS MATCH's pitch, whose
// real dimensions live in alignment.veo. They are NOT the 105x68 "FIFA standard"
// this job used to hardcode. Observed across four captures: 68x41.0, 68x42.8,
// 68x37.2 and 105x73.4 -- field_length is a round preset (68 or 105),
// field_width is fitted and messy. Projecting Veo's own tracking through Veo's
// own calibration puts players on YOLO-detected feet at a 0.86 match rate /
// 14.8px median at the match's own dims, and at 0.075 -- indistinguishable from
// a null -- at 105x68.
//
// The 105x68 was a real measurement, correctly performed, on hollands-blair-u23:
// a genuine full-size adult pitch. The defect was generalising n=1 to a constant.

/** Bounds are deliberately WIDE. A false reject here is not a schema bug, it is
 * a lost panorama: the caller treats an unreadable alignment.veo as a hard
 * failure, and Veo Glaciers the pixels at ~150d. These reject the unusable
 * (absent, non-numeric, NaN, zero, absurd) and nothing else. Do NOT add tighter
 * "sanity" checks -- e.g. length >= width looks safe until the one match that
 * breaks it costs us a corpus item we cannot re-fetch. Being wrong-lax writes a
 * recoverable schema; being wrong-strict destroys data. */
const MIN_M = 20
const MAX_M = 140

/**
 * @param {string} text raw alignment.veo body
 * @returns {{ lengthM: number, widthM: number }} this match's real pitch metres
 * @throws if the scale cannot be established -- never guesses, never defaults.
 */
export function parseFieldDims(text) {
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    throw new Error('alignment.veo is not valid JSON')
  }
  const a = doc?.alignment
  if (!a || typeof a !== 'object')
    throw new Error('alignment.veo has no `alignment` object')

  const dims = {}
  for (const [key, out] of [
    ['field_length', 'lengthM'],
    ['field_width', 'widthM'],
  ]) {
    const v = a[key]
    if (typeof v !== 'number' || !Number.isFinite(v))
      throw new Error(
        `alignment.veo ${key} is not a finite number (got ${JSON.stringify(v)})`
      )
    if (v < MIN_M || v > MAX_M)
      throw new Error(
        `alignment.veo ${key}=${v} is outside ${MIN_M}-${MAX_M}m — refusing to guess`
      )
    dims[out] = v
  }
  return dims
}

/** The schema block that travels WITH tracking.json. Built from this match's own
 * calibration, never from a constant: a wrong self-describing schema is worse
 * than none, because it is what a reader trusts instead of checking.
 *
 * @param {{lengthM: number, widthM: number} | null} dims null when the scale
 *   could not be established. The block then OMITS `metric` and says so, rather
 *   than guessing or emitting a null formula: an absent formula misleads nobody,
 *   a wrong one silently poisons every crop built from it. Recoverable via
 *   scripts/player-identity/backfill_tracking_schema.mjs.
 */
export function trackingSchema(dims) {
  return {
    // The discriminator consumers should BRANCH on. `pitchSource` is prose and
    // nobody will regex a sentence; omitting `metric` fails loudly for
    // `schema.pitch.lengthM` (TypeError) but SILENTLY for anything that evals it
    // (`eval(undefined)` returns undefined, it does not throw). One flag, machine
    // readable, so neither consumer has to notice the absence of a field.
    //
    // This is reachable in practice even though the row never reaches 'ready':
    // the DB under-reports S3 (which is why the backfill is prefix-driven), so a
    // prefix-driven consumer WILL meet a metric-less tracking.json.
    scaleKnown: Boolean(dims),
    // Column semantics do not depend on the scale, so they are always emitted: a
    // capture with an unusable calibration is still decodable as NORMALISED
    // positions and still carries its jersey labels.
    ...(dims
      ? {
          pitch: { lengthM: dims.lengthM, widthM: dims.widthM },
          // Provenance: per-match, but DECLARED by Veo — not verified by us, and
          // the `M` suffix is not a promise. See unitsVerified below.
          pitchSource:
            'alignment.veo field_length/field_width (per-match, Veo-declared)',
          // ⚠️ The scale is SELF-CONSISTENT, not metric. Veo solves the camera
          // pose from the operator-declared pitch size against a human's 4 corner
          // clicks, so the pose inherits whatever the operator typed. Measured on
          // cfa-u11 (2026-07-16) against TWO independent goals of different known
          // sizes (11v11 7.32m and 7v7 3.66m, agreeing within 3%): the true scale
          // is ~0.64x the declared one — the "68x41m" pitch is really ~43x26m,
          // players come out 1.4m (right for U11) not 2.2m, and the camera is
          // 3.6m up rather than 5.6m.
          //
          // What this does and does not break:
          //   SAFE  — projection/crops. Pitch and camera are scaled TOGETHER, so
          //           every ground ray is unchanged and feet land correctly (0.86
          //           match rate). Anything expressed in these units is coherent.
          //   WRONG — any real-world length: player heights, distances covered,
          //           and probably `speedKmh`, all by the same factor.
          // Do not "convert to metres" without re-deriving k per match from an
          // object of known size. k is per-match: it is the operator's error.
          unitsVerified: false,
          unitsNote:
            'Self-consistent units, NOT verified metres. Veo derives the camera pose from the operator-declared pitch size, so both inherit the same scale error (measured ~0.64x on cfa-u11 via two known-size goals). Safe for projection and crops; do NOT treat as metres for distances, heights or speed.',
          metric: `x = (xNorm - 0.5) * ${dims.lengthM} ; y = (yNorm - 0.5) * ${dims.widthM}`,
        }
      : {
          pitch: null,
          pitchSource:
            'UNKNOWN — alignment.veo unusable at capture. xNorm/yNorm CANNOT be scaled to metres; `metric` is deliberately absent rather than guessed. Backfill from this match’s own alignment.veo before any metric use.',
        }),
    columns: [
      'trackId',
      'roleTeam',
      'xNorm',
      'yNorm',
      'jersey',
      'unknown5',
      'speedKmh',
      'team',
    ],
    roleTeam: {
      0: 'left-GK',
      1: 'left-outfield',
      2: 'right-GK',
      3: 'right-outfield',
      6: 'ball',
    },
    team: { 2: 'left', 1: 'right', 0: 'ball' },
    jersey: '-1 = not read',
    sampleHz: 2.5,
  }
}

/** Fetch the calibration, retrying only what is worth retrying.
 *
 * The 4xx/5xx split is the point: a 404 is deterministic and retrying it is pure
 * latency, while a 5xx or a socket reset is worth three seconds. The caller's
 * whole attempt budget is 3 sweep attempts SHARED with every other transient in
 * the job (Playwright login flake, videos/ 5xx, Supabase blip) — ~45 min from
 * first blip to permanent settlement — so a bare unretried fetch here spends a
 * budget that is already oversubscribed. The timeout matters too: undici's
 * default is 300s, so a hung socket would stall the job for five minutes.
 *
 * Never retry the PARSE. Schema drift is deterministic; a retry loop would only
 * burn the budget faster.
 */
export async function fetchAlignment(url, tries = 3, fetchImpl = fetch) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) })
      if (r.ok) return await r.text()
      last = new Error(`alignment.veo returned ${r.status}`)
      if (r.status < 500) throw last // deterministic — do not spend an attempt
    } catch (e) {
      last = e
      if (i === tries - 1 || /returned 4\d\d/.test(String(e?.message))) throw e
    }
    // Never sleep after the final attempt — that is pure latency before a throw.
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i))
  }
  throw last
}
