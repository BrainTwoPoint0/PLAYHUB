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
