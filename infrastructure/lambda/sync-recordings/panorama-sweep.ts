// Panorama capture sweep — the durable half of the preserve-first decision
// (2026-07-07): Spiideo purges the RAW source needed to render a recording's
// VirtualPanorama ~30 DAYS after the game. Anything not captured in that
// window is unrecoverable (234 of the first 268 recordings were lost this
// way). This sweep runs on every sync invocation: find published recordings
// still missing their panorama, claim them with the same atomic CAS the
// panorama-source route uses, and submit the vp-materialize Batch job.
//
// Concurrency safety: the CAS (idle -> pending compare-and-set) makes this
// sweep, the watch-page route, and any manual backfill runner mutually safe —
// exactly one claimer wins a row. CLAIM RULE: `.update(..., {count:'exact'})`
// with NO `.select()` — PostgREST 400s when a top-level or= filter is combined
// with return=representation (see docs/decisions + the route's comment).

import type { SupabaseClient } from '@supabase/supabase-js'

export const SWEEP_MAX_PER_RUN = 2 // 96 runs/day -> up to 192 captures/day
export const GLOBAL_INFLIGHT_CAP = 5 // CE sized for this (vp-materialize-batch.tf)
export const SWEEP_WINDOW_DAYS = 45 // ~30d Spiideo purge + margin; older = gone
// 30 min, deliberately LOOSER than the route's 10: Batch queue wait has no
// heartbeat, and reclaiming a merely-queued job double-submits it. A dead job
// is still detected within one threshold (the running job heartbeats every 2m).
export const CAPTURE_STUCK_MS = 30 * 60_000
export const ERROR_COOLDOWN_MS = 5 * 60_000
export const MAX_ATTEMPTS = 3

export interface PanoramaCandidate {
  id: string
  spiideo_game_id: string | null
  panorama_capture_status: string | null
  panorama_capture_started_at: string | null
  panorama_capture_attempts: number | null
  panorama_s3_key: string | null
}

/**
 * Is this row claimable right now? Same shape as the route's CAS or=
 * predicate, with one deliberate divergence: the pending clause also caps
 * attempts (the route's does not), so a row that keeps dying mid-capture
 * can't be reclaimed by the sweep forever.
 */
export function isClaimable(row: PanoramaCandidate, nowMs: number): boolean {
  if (!row.spiideo_game_id || row.panorama_s3_key) return false
  const status = row.panorama_capture_status
  if (status === 'ready') return false
  const startedAt = row.panorama_capture_started_at
    ? Date.parse(row.panorama_capture_started_at)
    : 0
  if (status === null) return true
  if (status === 'error')
    return (
      (row.panorama_capture_attempts ?? 0) < MAX_ATTEMPTS &&
      nowMs - startedAt >= ERROR_COOLDOWN_MS
    )
  if (status === 'pending')
    return (
      (row.panorama_capture_attempts ?? 0) < MAX_ATTEMPTS &&
      nowMs - startedAt >= CAPTURE_STUCK_MS
    )
  return false
}

export type SubmitPanoramaJob = (
  recordingId: string,
  gameId: string
) => Promise<string | undefined> // returns Batch jobId

export async function sweepPanoramaCaptures(
  supabase: SupabaseClient,
  submitJob: SubmitPanoramaJob,
  nowMs = Date.now()
): Promise<{ submitted: number; candidates: number }> {
  const windowStart = new Date(
    nowMs - SWEEP_WINDOW_DAYS * 24 * 3600_000
  ).toISOString()
  const { data, error } = await supabase
    .from('playhub_match_recordings')
    .select(
      'id, spiideo_game_id, panorama_capture_status, panorama_capture_started_at, panorama_capture_attempts, panorama_s3_key'
    )
    .eq('status', 'published')
    .eq('content_type', 'hosted_video')
    .not('spiideo_game_id', 'is', null)
    .is('panorama_s3_key', null)
    // Exhausted rows (attempts cap reached) must not occupy limit-25 slots —
    // with enough of them the sweep would go blind to claimable rows that
    // are still inside their purge window.
    .or(
      `panorama_capture_attempts.is.null,panorama_capture_attempts.lt.${MAX_ATTEMPTS}`
    )
    // The purge clock runs from the GAME (~30d after match_date), not from
    // when the row was created — a backfilled row can be brand new while its
    // source is already gone. match_date is written on every Spiideo sync;
    // null falls back to created_at (conservative for pre-game rows).
    .or(
      `match_date.gte.${windowStart},and(match_date.is.null,created_at.gte.${windowStart})`
    )
    .order('match_date', { ascending: true, nullsFirst: true }) // oldest game = closest to the purge cliff
    .order('created_at', { ascending: true }) // deterministic among null match_dates
    .limit(25)
  if (error) throw new Error(`panorama sweep query: ${error.message}`)

  const claimable = (data ?? []).filter((r) => isClaimable(r, nowMs))

  // Global in-flight gate: leave CE headroom for interactive watch-page
  // captures. Fresh 'pending' rows (heartbeated) = running or queued jobs.
  const freshCutoff = new Date(nowMs - CAPTURE_STUCK_MS).toISOString()
  const { count: inFlight, error: inFlightErr } = await supabase
    .from('playhub_match_recordings')
    .select('id', { count: 'exact', head: true })
    .eq('panorama_capture_status', 'pending')
    .gte('panorama_capture_started_at', freshCutoff)
  if (inFlightErr)
    throw new Error(`panorama sweep in-flight count: ${inFlightErr.message}`)
  const budget = Math.max(
    0,
    Math.min(SWEEP_MAX_PER_RUN, GLOBAL_INFLIGHT_CAP - (inFlight ?? 0))
  )

  let submitted = 0
  // Budget counts submit ATTEMPTS, not successes: under a persistent submit
  // failure (IAM drift, deleted job def) counting successes would burn
  // claim -> SubmitJob -> rollback on all 25 candidates every run.
  let attempted = 0
  for (const row of claimable) {
    if (attempted >= budget) break
    const stuckCutoff = new Date(nowMs - CAPTURE_STUCK_MS).toISOString()
    const errorCutoff = new Date(nowMs - ERROR_COOLDOWN_MS).toISOString()
    // Atomic claim — same predicate as the route; count-CAS, never .select()
    const { count, error: claimErr } = await supabase
      .from('playhub_match_recordings')
      .update(
        {
          panorama_capture_status: 'pending',
          panorama_capture_started_at: new Date(nowMs).toISOString(),
          panorama_capture_error: null,
          panorama_capture_attempts: (row.panorama_capture_attempts ?? 0) + 1,
        },
        { count: 'exact' }
      )
      .eq('id', row.id)
      .or(
        `panorama_capture_status.is.null,` +
          `and(panorama_capture_status.eq.error,panorama_capture_attempts.lt.${MAX_ATTEMPTS},panorama_capture_started_at.lt.${errorCutoff}),` +
          `and(panorama_capture_status.eq.pending,panorama_capture_attempts.lt.${MAX_ATTEMPTS},panorama_capture_started_at.lt.${stuckCutoff})`
      )
    if (claimErr) {
      console.error(
        `panorama sweep: claim failed for ${row.id}: ${claimErr.message}`
      )
      continue
    }
    if (!count) continue // lost the race to the route or a backfill runner — fine

    attempted++
    try {
      const jobId = await submitJob(row.id, String(row.spiideo_game_id))
      if (!jobId) throw new Error('no jobId returned')
      console.log(`panorama sweep: submitted ${row.id} -> job ${jobId}`)
      submitted++
    } catch (err) {
      // Roll the claim to 'error' so the row isn't stuck 'pending' for 10 min
      console.error(
        `panorama sweep: submit failed for ${row.id}: ${err instanceof Error ? err.message : err}`
      )
      await supabase
        .from('playhub_match_recordings')
        .update({
          panorama_capture_status: 'error',
          panorama_capture_error: 'sweep submit failed',
          // restore the pre-claim value: plumbing failures (IAM, queue) must
          // not burn the 3-attempt capture budget inside the purge window
          panorama_capture_attempts: row.panorama_capture_attempts ?? 0,
        })
        .eq('id', row.id)
    }
  }
  return { submitted, candidates: claimable.length }
}

// ── Aim-track sweep ──────────────────────────────────────────────────────────
// Sibling sweep for the reg-SIFT auto-follow track: once a recording has BOTH
// the produced Play mp4 (s3_key) and the preserved raw panorama
// (panorama_s3_key), an aim-track Batch job can compute Spiideo's camera path
// from our own S3 — no purge window applies (both inputs are ours forever).
// Newest games first: they're the ones being watched.

export const AIM_SWEEP_MAX_PER_RUN = 1 // jobs run 4-7h; trickle the backlog
export const AIM_INFLIGHT_CAP = 2 // 2 vCPU each on the shared 16-vCPU CE
// Stuck threshold is HOURS, not the panorama's 30 min: a queued Batch job has
// no heartbeat, and reclaiming one here duplicates a 4-7h job. Aim tracks
// have no purge deadline (both inputs are ours forever), so patience is free.
// A genuinely dead job (heartbeat every 2 min while running) is still
// reclaimed within one threshold.
export const AIM_STUCK_MS = 3 * 3600_000

export interface AimTrackCandidate {
  id: string
  spiideo_game_id: string | null
  s3_key: string | null
  panorama_s3_key: string | null
  aim_track_status: string | null
  aim_track_started_at: string | null
  aim_track_attempts: number | null
}

/** Same claimability contract as isClaimable, over the aim_track_* columns. */
export function isAimClaimable(row: AimTrackCandidate, nowMs: number): boolean {
  if (!row.spiideo_game_id || !row.s3_key || !row.panorama_s3_key) return false
  const status = row.aim_track_status
  if (status === 'ready') return false
  const startedAt = row.aim_track_started_at
    ? Date.parse(row.aim_track_started_at)
    : 0
  if (status === null) return true
  if (status === 'error')
    return (
      (row.aim_track_attempts ?? 0) < MAX_ATTEMPTS &&
      nowMs - startedAt >= ERROR_COOLDOWN_MS
    )
  if (status === 'pending')
    return (
      (row.aim_track_attempts ?? 0) < MAX_ATTEMPTS &&
      nowMs - startedAt >= AIM_STUCK_MS
    )
  return false
}

export async function sweepAimTracks(
  supabase: SupabaseClient,
  submitJob: SubmitPanoramaJob,
  nowMs = Date.now()
): Promise<{ submitted: number; candidates: number }> {
  const { data, error } = await supabase
    .from('playhub_match_recordings')
    .select(
      'id, spiideo_game_id, s3_key, panorama_s3_key, aim_track_status, aim_track_started_at, aim_track_attempts'
    )
    .eq('status', 'published')
    .not('spiideo_game_id', 'is', null)
    .not('s3_key', 'is', null)
    .not('panorama_s3_key', 'is', null)
    // NOT .neq('aim_track_status','ready') — SQL three-valued logic would drop
    // the NULL (never-attempted) rows, which are the whole point.
    .or(`aim_track_status.is.null,aim_track_status.neq.ready`)
    .or(`aim_track_attempts.is.null,aim_track_attempts.lt.${MAX_ATTEMPTS}`)
    .order('match_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false }) // deterministic among equal dates
    .limit(25)
  if (error) throw new Error(`aim sweep query: ${error.message}`)

  const claimable = (data ?? []).filter((r) => isAimClaimable(r, nowMs))

  const freshCutoff = new Date(nowMs - AIM_STUCK_MS).toISOString()
  const { count: inFlight, error: inFlightErr } = await supabase
    .from('playhub_match_recordings')
    .select('id', { count: 'exact', head: true })
    .eq('aim_track_status', 'pending')
    .gte('aim_track_started_at', freshCutoff)
  if (inFlightErr)
    throw new Error(`aim sweep in-flight count: ${inFlightErr.message}`)
  const budget = Math.max(
    0,
    Math.min(AIM_SWEEP_MAX_PER_RUN, AIM_INFLIGHT_CAP - (inFlight ?? 0))
  )

  let submitted = 0
  let attempted = 0
  for (const row of claimable) {
    if (attempted >= budget) break
    const stuckCutoff = new Date(nowMs - AIM_STUCK_MS).toISOString()
    const errorCutoff = new Date(nowMs - ERROR_COOLDOWN_MS).toISOString()
    const { count, error: claimErr } = await supabase
      .from('playhub_match_recordings')
      .update(
        {
          aim_track_status: 'pending',
          aim_track_started_at: new Date(nowMs).toISOString(),
          aim_track_error: null,
          aim_track_attempts: (row.aim_track_attempts ?? 0) + 1,
        },
        { count: 'exact' }
      )
      .eq('id', row.id)
      .or(
        `aim_track_status.is.null,` +
          `and(aim_track_status.eq.error,aim_track_attempts.lt.${MAX_ATTEMPTS},aim_track_started_at.lt.${errorCutoff}),` +
          `and(aim_track_status.eq.pending,aim_track_attempts.lt.${MAX_ATTEMPTS},aim_track_started_at.lt.${stuckCutoff})`
      )
    if (claimErr) {
      console.error(
        `aim sweep: claim failed for ${row.id}: ${claimErr.message}`
      )
      continue
    }
    if (!count) continue

    attempted++
    try {
      const jobId = await submitJob(row.id, String(row.spiideo_game_id))
      if (!jobId) throw new Error('no jobId returned')
      console.log(`aim sweep: submitted ${row.id} -> job ${jobId}`)
      submitted++
    } catch (err) {
      console.error(
        `aim sweep: submit failed for ${row.id}: ${err instanceof Error ? err.message : err}`
      )
      await supabase
        .from('playhub_match_recordings')
        .update({
          aim_track_status: 'error',
          aim_track_error: 'sweep submit failed',
          aim_track_attempts: row.aim_track_attempts ?? 0,
        })
        .eq('id', row.id)
    }
  }
  return { submitted, candidates: claimable.length }
}

// ── Player-tracklets sweep ───────────────────────────────────────────────────
// Sibling sweep for the spotlight feature: fetch Spiideo's tracklets +
// detections data streams, solve the per-game metric→ray homography, and
// publish tracklets.json next to the mesh. Needs NO video (neither ours nor
// Spiideo's) — only the mesh, so candidates are mesh-scene recordings.
// Games recorded before a venue's tracklets rollout (Nazwa: pre 2026-06-09)
// have no stream; the job errors clearly and the attempts cap settles them.

export const TRK_SWEEP_MAX_PER_RUN = 1 // jobs run ~2 min; 1/tick drains fast
export const TRK_INFLIGHT_CAP = 1 // 1 vCPU on the shared CE (16-vCPU budget)
// Job runtime is minutes, but a QUEUED Batch job has no heartbeat — a job
// stuck RUNNABLE >1h can be reclaimed while still queued (rare double-submit
// accepted: both writes are idempotent x-upserts of the same artifact).
export const TRK_STUCK_MS = 3600_000

export interface TrackletsCandidate {
  id: string
  spiideo_game_id: string | null
  spiideo_scene_id: string | null
  tracklets_status: string | null
  tracklets_started_at: string | null
  tracklets_attempts: number | null
}

/** Same claimability contract as isAimClaimable, over the tracklets_* columns. */
export function isTrackletsClaimable(
  row: TrackletsCandidate,
  meshSceneIds: Set<string>,
  nowMs: number
): boolean {
  if (!row.spiideo_game_id || !row.spiideo_scene_id) return false
  if (!meshSceneIds.has(row.spiideo_scene_id)) return false
  const status = row.tracklets_status
  if (status === 'ready') return false
  const startedAt = row.tracklets_started_at
    ? Date.parse(row.tracklets_started_at)
    : 0
  if (status === null) return true
  if (status === 'error')
    return (
      (row.tracklets_attempts ?? 0) < MAX_ATTEMPTS &&
      nowMs - startedAt >= ERROR_COOLDOWN_MS
    )
  if (status === 'pending')
    return (
      (row.tracklets_attempts ?? 0) < MAX_ATTEMPTS &&
      nowMs - startedAt >= TRK_STUCK_MS
    )
  return false
}

export async function sweepPlayerTracklets(
  supabase: SupabaseClient,
  submitJob: SubmitPanoramaJob,
  // The registry is SCENE-level but the job reads PER-GAME mesh files —
  // a mesh-scene recording whose game folder was never materialized would
  // claim, 404 in the job, and burn all 3 attempts at 1 claim/tick while
  // sitting at the top of the newest-first window. One cheap HEAD per claim
  // candidate prevents that. Null (tests/legacy callers) skips the check.
  hasGameMesh: ((gameId: string) => Promise<boolean>) | null = null,
  nowMs = Date.now()
): Promise<{ submitted: number; candidates: number }> {
  // Spotlight is only usable in the de-warp view, which needs a scene mesh —
  // the registry is the source of truth for which scenes have one.
  const { data: scenes, error: scenesErr } = await supabase
    .from('playhub_panorama_scene_meshes')
    .select('scene_id')
  if (scenesErr)
    throw new Error(`tracklets sweep scene registry: ${scenesErr.message}`)
  const meshSceneIds = new Set((scenes ?? []).map((s) => String(s.scene_id)))
  if (meshSceneIds.size === 0) return { submitted: 0, candidates: 0 }

  const { data, error } = await supabase
    .from('playhub_match_recordings')
    .select(
      'id, spiideo_game_id, spiideo_scene_id, tracklets_status, tracklets_started_at, tracklets_attempts'
    )
    .eq('status', 'published')
    .not('spiideo_game_id', 'is', null)
    .in('spiideo_scene_id', Array.from(meshSceneIds))
    // NOT .neq(...,'ready') — three-valued logic drops NULL rows (the point).
    .or(`tracklets_status.is.null,tracklets_status.neq.ready`)
    .or(`tracklets_attempts.is.null,tracklets_attempts.lt.${MAX_ATTEMPTS}`)
    .order('match_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(25)
  if (error) throw new Error(`tracklets sweep query: ${error.message}`)

  const claimable = (data ?? []).filter((r) =>
    isTrackletsClaimable(r, meshSceneIds, nowMs)
  )

  const freshCutoff = new Date(nowMs - TRK_STUCK_MS).toISOString()
  const { count: inFlight, error: inFlightErr } = await supabase
    .from('playhub_match_recordings')
    .select('id', { count: 'exact', head: true })
    .eq('tracklets_status', 'pending')
    .gte('tracklets_started_at', freshCutoff)
  if (inFlightErr)
    throw new Error(`tracklets sweep in-flight count: ${inFlightErr.message}`)
  const budget = Math.max(
    0,
    Math.min(TRK_SWEEP_MAX_PER_RUN, TRK_INFLIGHT_CAP - (inFlight ?? 0))
  )

  let submitted = 0
  let attempted = 0
  for (const row of claimable) {
    if (attempted >= budget) break
    if (hasGameMesh) {
      try {
        if (!(await hasGameMesh(String(row.spiideo_game_id)))) continue
      } catch {
        continue // storage hiccup — try the row again next tick, unclaimed
      }
    }
    const stuckCutoff = new Date(nowMs - TRK_STUCK_MS).toISOString()
    const errorCutoff = new Date(nowMs - ERROR_COOLDOWN_MS).toISOString()
    const { count, error: claimErr } = await supabase
      .from('playhub_match_recordings')
      .update(
        {
          tracklets_status: 'pending',
          tracklets_started_at: new Date(nowMs).toISOString(),
          tracklets_error: null,
          tracklets_attempts: (row.tracklets_attempts ?? 0) + 1,
        },
        { count: 'exact' }
      )
      .eq('id', row.id)
      .or(
        `tracklets_status.is.null,` +
          `and(tracklets_status.eq.error,tracklets_attempts.lt.${MAX_ATTEMPTS},tracklets_started_at.lt.${errorCutoff}),` +
          `and(tracklets_status.eq.pending,tracklets_attempts.lt.${MAX_ATTEMPTS},tracklets_started_at.lt.${stuckCutoff})`
      )
    if (claimErr) {
      console.error(
        `tracklets sweep: claim failed for ${row.id}: ${claimErr.message}`
      )
      continue
    }
    if (!count) continue

    attempted++
    try {
      const jobId = await submitJob(row.id, String(row.spiideo_game_id))
      if (!jobId) throw new Error('no jobId returned')
      console.log(`tracklets sweep: submitted ${row.id} -> job ${jobId}`)
      submitted++
    } catch (err) {
      console.error(
        `tracklets sweep: submit failed for ${row.id}: ${err instanceof Error ? err.message : err}`
      )
      await supabase
        .from('playhub_match_recordings')
        .update({
          tracklets_status: 'error',
          tracklets_error: 'sweep submit failed',
          tracklets_attempts: row.tracklets_attempts ?? 0,
        })
        .eq('id', row.id)
    }
  }
  return { submitted, candidates: claimable.length }
}

// ── Jersey-labels sweep ──────────────────────────────────────────────────────
// Downstream of the tracklets sweep (Tier-3 identity): for allowlisted
// organized-kit venues whose tracklets are `ready` AND whose raw panorama is
// banked, submit the jersey-labels Batch job (reads numbers off the raw
// panorama, assembles (number, kit) slots, republishes the enriched
// tracklets.json). The tracklets job resets jersey_status on its own success,
// so a tracklets re-run automatically queues re-enrichment here.
// JERSEY_VENUES (scene ids) empty = feature disabled — rec-football venues
// have nothing to read (measured; the spotlight stays honest-loss there).

export const JERSEY_SWEEP_MAX_PER_RUN = 1
export const JERSEY_INFLIGHT_CAP = 1 // dedicated 8-vCPU CE fits exactly one
// Jobs run ~60-90 min with a 4h Batch timeout; a QUEUED job has no heartbeat,
// so reclaim only after the timeout has certainly fired.
export const JERSEY_STUCK_MS = 18_000_000 // 5h > the 4h job timeout

export interface JerseyCandidate {
  id: string
  spiideo_game_id: string | null
  spiideo_scene_id: string | null
  panorama_s3_key: string | null
  tracklets_status: string | null
  jersey_status: string | null
  jersey_started_at: string | null
  jersey_attempts: number | null
}

/** Same claimability contract as isTrackletsClaimable, over jersey_* columns,
 *  plus the upstream gates: tracklets ready + raw panorama banked + venue
 *  allowlisted. */
export function isJerseyClaimable(
  row: JerseyCandidate,
  jerseyVenues: Set<string>,
  nowMs: number
): boolean {
  if (!row.spiideo_game_id || !row.spiideo_scene_id) return false
  if (!jerseyVenues.has(row.spiideo_scene_id)) return false
  if (row.tracklets_status !== 'ready') return false
  if (!row.panorama_s3_key) return false
  const status = row.jersey_status
  if (status === 'ready') return false
  const startedAt = row.jersey_started_at
    ? Date.parse(row.jersey_started_at)
    : 0
  if (status === null) return true
  if (status === 'error')
    return (
      (row.jersey_attempts ?? 0) < MAX_ATTEMPTS &&
      nowMs - startedAt >= ERROR_COOLDOWN_MS
    )
  if (status === 'pending')
    return (
      (row.jersey_attempts ?? 0) < MAX_ATTEMPTS &&
      nowMs - startedAt >= JERSEY_STUCK_MS
    )
  return false
}

export async function sweepJerseyLabels(
  supabase: SupabaseClient,
  jerseyVenues: string[],
  submitJob: SubmitPanoramaJob,
  nowMs = Date.now()
): Promise<{ submitted: number; candidates: number }> {
  if (jerseyVenues.length === 0) return { submitted: 0, candidates: 0 }
  const venueSet = new Set(jerseyVenues)

  const { data, error } = await supabase
    .from('playhub_match_recordings')
    .select(
      'id, spiideo_game_id, spiideo_scene_id, panorama_s3_key, tracklets_status, jersey_status, jersey_started_at, jersey_attempts'
    )
    .eq('status', 'published')
    .eq('tracklets_status', 'ready')
    .not('spiideo_game_id', 'is', null)
    .not('panorama_s3_key', 'is', null)
    .in('spiideo_scene_id', jerseyVenues)
    // NOT .neq(...,'ready') — three-valued logic drops NULL rows (the point).
    .or(`jersey_status.is.null,jersey_status.neq.ready`)
    // NULL status is claimable REGARDLESS of attempts (all three layers —
    // query, isJerseyClaimable, CAS — agree), so an operator reset of the
    // status alone is a real reset, not the silent no-op the veo-capture
    // lockstep incident shipped. Settled errors (status=error, attempts>=3)
    // stay excluded so they can't starve the LIMIT window.
    .or(
      `jersey_status.is.null,jersey_attempts.is.null,jersey_attempts.lt.${MAX_ATTEMPTS}`
    )
    // Enrichment queue, not a deadline race: newest content first is right
    // here (fresh matches are what admins/players open).
    .order('match_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(25)
  if (error) throw new Error(`jersey sweep query: ${error.message}`)

  const claimable = (data ?? []).filter((r) =>
    isJerseyClaimable(r, venueSet, nowMs)
  )

  const freshCutoff = new Date(nowMs - JERSEY_STUCK_MS).toISOString()
  const { count: inFlight, error: inFlightErr } = await supabase
    .from('playhub_match_recordings')
    .select('id', { count: 'exact', head: true })
    .eq('jersey_status', 'pending')
    .gte('jersey_started_at', freshCutoff)
  if (inFlightErr)
    throw new Error(`jersey sweep in-flight count: ${inFlightErr.message}`)
  const budget = Math.max(
    0,
    Math.min(JERSEY_SWEEP_MAX_PER_RUN, JERSEY_INFLIGHT_CAP - (inFlight ?? 0))
  )

  let submitted = 0
  let attempted = 0
  for (const row of claimable) {
    if (attempted >= budget) break
    const stuckCutoff = new Date(nowMs - JERSEY_STUCK_MS).toISOString()
    const errorCutoff = new Date(nowMs - ERROR_COOLDOWN_MS).toISOString()
    const { count, error: claimErr } = await supabase
      .from('playhub_match_recordings')
      .update(
        {
          jersey_status: 'pending',
          jersey_started_at: new Date(nowMs).toISOString(),
          jersey_error: null,
          jersey_attempts: (row.jersey_attempts ?? 0) + 1,
        },
        { count: 'exact' }
      )
      .eq('id', row.id)
      .or(
        `jersey_status.is.null,` +
          `and(jersey_status.eq.error,jersey_attempts.lt.${MAX_ATTEMPTS},jersey_started_at.lt.${errorCutoff}),` +
          `and(jersey_status.eq.pending,jersey_attempts.lt.${MAX_ATTEMPTS},jersey_started_at.lt.${stuckCutoff})`
      )
    if (claimErr) {
      console.error(
        `jersey sweep: claim failed for ${row.id}: ${claimErr.message}`
      )
      continue
    }
    if (!count) continue

    attempted++
    try {
      const jobId = await submitJob(row.id, String(row.spiideo_game_id))
      if (!jobId) throw new Error('no jobId returned')
      console.log(`jersey sweep: submitted ${row.id} -> job ${jobId}`)
      submitted++
    } catch (err) {
      console.error(
        `jersey sweep: submit failed for ${row.id}: ${err instanceof Error ? err.message : err}`
      )
      await supabase
        .from('playhub_match_recordings')
        .update({
          jersey_status: 'error',
          jersey_error: 'sweep submit failed',
          jersey_attempts: row.jersey_attempts ?? 0,
        })
        .eq('id', row.id)
    }
  }
  return { submitted, candidates: claimable.length }
}

// ── Portrait-render sweep ────────────────────────────────────────────────────
// Feed for the portrait-render Batch job (9:16 goal drafts, review-first):
// club-allowlisted Veo matches with unrendered tagged goals, served by the
// playhub_portrait_render_candidates view (service-role only). No CAS columns:
// the job upserts per-event rows idempotently and skips published/rejected/
// draft, so a duplicate submission wastes a little Modal compute at worst —
// the caller guards active-duplicate jobs via a Batch ListJobs name check.

export const PORTRAIT_SWEEP_MAX_PER_RUN = 1

export interface PortraitCandidate {
  club_slug: string
  match_slug: string
  goal_events: number
  renders: number
}

export type SubmitPortraitJob = (
  matchSlug: string,
  clubSlug: string
) => Promise<string | undefined> // Batch jobId; undefined = skipped (duplicate)

export async function sweepPortraitRenders(
  supabase: SupabaseClient,
  allowedClubs: string[],
  submitJob: SubmitPortraitJob
): Promise<{ submitted: number; candidates: number }> {
  if (allowedClubs.length === 0) return { submitted: 0, candidates: 0 }
  const { data, error } = await supabase
    .from('playhub_portrait_render_candidates')
    .select('club_slug, match_slug, goal_events, renders')
    .in('club_slug', allowedClubs)
    .order('latest_event_at', { ascending: false }) // newest matches first
    .limit(10)
  if (error) throw new Error(`portrait sweep query: ${error.message}`)

  const candidates = (data ?? []) as PortraitCandidate[]
  let submitted = 0
  let attempted = 0
  for (const c of candidates) {
    if (attempted >= PORTRAIT_SWEEP_MAX_PER_RUN) break
    attempted++
    try {
      const jobId = await submitJob(c.match_slug, c.club_slug)
      if (jobId) {
        console.log(
          `portrait sweep: submitted ${c.club_slug}/${c.match_slug} (${c.renders}/${c.goal_events} rendered) -> job ${jobId}`
        )
        submitted++
      }
    } catch (err) {
      console.error(
        `portrait sweep: submit failed for ${c.match_slug}: ${err instanceof Error ? err.message : err}`
      )
    }
  }
  return { submitted, candidates: candidates.length }
}

// ── Veo capture sweep ────────────────────────────────────────────────────────
// Preserve-first, the Veo edition (2026-07-15). Veo is the free LABELLER for our
// own jersey model — production must never call their AI — but the corpus only
// exists while the PIXELS do, and the pixels expire: the native .ts panorama is
// `available` at <=40d and Glacier'd (`InvalidObjectState`) by ~150d. This is the
// same trap that cost us 234/268 Spiideo panoramas before capture-on-publish, so
// it gets the same answer.
//
// Candidates come from the playhub_veo_capture_candidates VIEW (cache LEFT JOIN
// captures; PostgREST can't express the join). State lives on
// playhub_veo_captures, deliberately NOT on the recordings cache — that table is
// pruned when a match leaves Veo's listing (cache-writer.ts:306), which would
// orphan a ~9.5GB S3 object with no record of its key.
//
// isClaimable MUST stay in lockstep with the view's settlement predicate. Drift
// livelocks the sweep — the view keeps offering rows the sweep will never claim
// and the budget burns re-reading them (portrait-render, 20260714000500).

export const VEO_SWEEP_MAX_PER_RUN = 1
// A ~9.5GB transfer each. The shared CE has no headroom for more (see
// veo-capture-batch.tf), and there is no deadline pressure inside a ~120d window.
export const VEO_INFLIGHT_CAP = 2
// Looser than the job's 2-min heartbeat: a queued Batch job does not heartbeat,
// and reclaiming a merely-queued one double-spends a multi-GB download.
export const VEO_CAPTURE_STUCK_MS = 60 * 60_000

export interface VeoCaptureCandidate {
  veo_club_slug: string
  match_slug: string
  match_date: string | null
  capture_id: string | null
  capture_status: string | null
  capture_attempts: number | null
  capture_started_at: string | null
}

export function isVeoCaptureClaimable(
  row: VeoCaptureCandidate,
  nowMs: number
): boolean {
  if (!row.veo_club_slug || !row.match_slug) return false
  const status = row.capture_status
  if (status === 'ready') return false
  if (!row.capture_id || status === null) return true // never attempted
  const startedAt = row.capture_started_at
    ? Date.parse(row.capture_started_at)
    : 0
  if (status === 'error')
    return (
      (row.capture_attempts ?? 0) < MAX_ATTEMPTS &&
      nowMs - startedAt >= ERROR_COOLDOWN_MS
    )
  if (status === 'pending')
    return (
      (row.capture_attempts ?? 0) < MAX_ATTEMPTS &&
      nowMs - startedAt >= VEO_CAPTURE_STUCK_MS
    )
  return false
}

export type SubmitVeoCaptureJob = (
  captureId: string,
  matchSlug: string
) => Promise<string | undefined> // returns Batch jobId

export async function sweepVeoCaptures(
  supabase: SupabaseClient,
  submitJob: SubmitVeoCaptureJob,
  now: Date = new Date()
): Promise<{ submitted: number; candidates: number }> {
  const nowMs = now.getTime()

  const { data, error } = await supabase
    .from('playhub_veo_capture_candidates')
    .select(
      'veo_club_slug, match_slug, match_date, capture_id, capture_status, capture_attempts, capture_started_at'
    )
    // OLDEST FIRST — the opposite of every sibling sweep, deliberately.
    //
    // Those sweeps chase fresh content for product UX, so newest-first is right.
    // This one is a DEADLINE queue: the panorama is Glacier'd at ~150d and the
    // loss is irreversible. Newest-first captures the matches with the MOST slack
    // and reaches the ones nearest expiry LAST — and LIMIT 25 makes it structural,
    // not probabilistic: ranks 26+ are invisible until the 25 above them settle.
    // Measured at ship time: 354 candidates, ~78 captures/day, 4 rows within 2
    // days of expiry sitting at rank ~351 — the sweep would have reached them on
    // day ~4.5 and lost all four. Earliest-deadline-first is the only correct
    // order here.
    .order('match_date', { ascending: true, nullsFirst: false })
    .limit(25)
  if (error) {
    console.error(`veo capture sweep: candidate query failed: ${error.message}`)
    return { submitted: 0, candidates: 0 }
  }

  const rows = (data ?? []) as VeoCaptureCandidate[]
  const claimable = rows.filter((r) => isVeoCaptureClaimable(r, nowMs))
  if (!claimable.length) {
    // "the view offers rows the sweep will never claim" is the livelock
    // signature, and reporting candidates:0 here made it INVISIBLE (index.ts
    // only logs when candidates > 0). Say it out loud: with a 150-day
    // irreversible deadline, silence is the expensive failure.
    if (rows.length)
      console.warn(
        `veo capture sweep: ${rows.length} offered but NONE claimable — check the view/isClaimable lockstep`
      )
    return { submitted: 0, candidates: rows.length }
  }

  // In-flight = fresh pending rows only; a stale pending is a dead job, not a
  // running one, and must not hold the cap hostage.
  const { count: inFlight, error: cErr } = await supabase
    .from('playhub_veo_captures')
    .select('id', { count: 'exact', head: true })
    .eq('capture_status', 'pending')
    .gte(
      'capture_started_at',
      new Date(nowMs - VEO_CAPTURE_STUCK_MS).toISOString()
    )
  // Swallowing this would leave count null -> `inFlight ?? 0` -> a budget computed
  // as if nothing were running -> the cap breached and two ~9.5GB transfers on a
  // CE sized for exactly two. All three sibling sweeps throw here; so does this.
  if (cErr) throw new Error(`in-flight count failed: ${cErr.message}`)
  const budget = Math.min(
    VEO_SWEEP_MAX_PER_RUN,
    VEO_INFLIGHT_CAP - (inFlight ?? 0)
  )
  if (budget <= 0) return { submitted: 0, candidates: claimable.length }

  let submitted = 0
  let attempted = 0
  const startedAt = now.toISOString()
  const errorCutoff = new Date(nowMs - ERROR_COOLDOWN_MS).toISOString()
  const stuckCutoff = new Date(nowMs - VEO_CAPTURE_STUCK_MS).toISOString()

  for (const row of claimable) {
    // Budget counts ATTEMPTS, not successes: a persistent submit failure (a
    // missing IAM grant, say) must not claim-and-roll-back every candidate on
    // every tick. That exact bug left the tracklets sweep inert for a day.
    if (attempted >= budget) break

    let captureId = row.capture_id
    let priorAttempts = row.capture_attempts ?? 0

    if (!captureId) {
      // Never attempted: the unique (veo_club_slug, match_slug) IS the claim.
      // A concurrent runner inserting first makes this a no-op and we skip.
      const { data: ins, error: insErr } = await supabase
        .from('playhub_veo_captures')
        .insert({
          veo_club_slug: row.veo_club_slug,
          match_slug: row.match_slug,
          match_date: row.match_date,
          capture_status: 'pending',
          capture_started_at: startedAt,
          capture_attempts: 1,
        })
        .select('id')
        .maybeSingle()
      // 23505 = duplicate key = another runner claimed it first, which is fine.
      // Anything else (RLS denial, schema drift, network) is a real fault and was
      // being swallowed identically — silently, forever.
      if (insErr && insErr.code !== '23505')
        console.error(
          `veo capture sweep: insert failed for ${row.match_slug}: ${insErr.message}`
        )
      if (insErr || !ins) continue
      captureId = ins.id
      priorAttempts = 0
    } else {
      // Retry: atomic CAS on the existing row. `.update(..., {count:'exact'})`
      // with NO `.select()` — PostgREST 400s when a top-level or= filter meets
      // return=representation.
      const { count, error: claimErr } = await supabase
        .from('playhub_veo_captures')
        .update(
          {
            capture_status: 'pending',
            capture_started_at: startedAt,
            capture_error: null,
            capture_attempts: priorAttempts + 1,
          },
          { count: 'exact' }
        )
        .eq('id', captureId)
        .or(
          // `capture_status.is.null` is NOT redundant: an operator reset leaves
          // the row present with a NULL status, and without this branch the CAS
          // silently matches nothing and the row is stuck forever. The view has
          // the matching branch — the two MUST agree.
          `capture_status.is.null,` +
            `and(capture_status.eq.error,capture_attempts.lt.${MAX_ATTEMPTS},capture_started_at.lt.${errorCutoff}),` +
            `and(capture_status.eq.pending,capture_attempts.lt.${MAX_ATTEMPTS},capture_started_at.lt.${stuckCutoff})`
        )
      if (claimErr) {
        console.error(
          `veo capture sweep: claim failed for ${row.match_slug}: ${claimErr.message}`
        )
        continue
      }
      if (!count) continue // lost the race
    }

    attempted++
    try {
      const jobId = await submitJob(captureId, row.match_slug)
      if (!jobId) throw new Error('no jobId returned')
      console.log(
        `veo capture sweep: submitted ${row.match_slug} -> job ${jobId}`
      )
      submitted++
    } catch (err) {
      console.error(
        `veo capture sweep: submit failed for ${row.match_slug}: ${err instanceof Error ? err.message : err}`
      )
      await supabase
        .from('playhub_veo_captures')
        .update({
          capture_status: 'error',
          capture_error: 'sweep submit failed',
          // restore the pre-claim value: plumbing failures must not burn the
          // 3-attempt budget inside the Glacier window
          capture_attempts: priorAttempts,
        })
        .eq('id', captureId)
        // CAS, not a blind write: SubmitJob can throw AFTER Batch accepted the
        // job (a response timeout, a socket reset). Rolling the row back
        // unconditionally would mark a RUNNING 9.5GB capture as re-claimable and
        // start a second one. Only roll back the claim we ourselves just made.
        .eq('capture_status', 'pending')
        .eq('capture_started_at', startedAt)
    }
  }
  return { submitted, candidates: claimable.length }
}
