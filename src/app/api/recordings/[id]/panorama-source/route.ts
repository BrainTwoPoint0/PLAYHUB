// POST /api/recordings/[id]/panorama-source
//
// Resolves the RAW VirtualPanorama (fisheye) source for a recording's de-warp
// "free-look" layer on /watch/[id]. Design B (server-side pre-capture) per the A2
// security review — the raw VP is materialized + remuxed into OUR private S3 by a
// Lambda (the Spiideo bearer JWT never leaves our infra), and this route serves a
// short-TTL signed URL exactly like the Auto production. It is idempotent: call it
// to poll; it serves the signed URL when ready, else triggers a capture and
// returns { status: 'pending' }.
//
// Security invariants (all enforced below; see the review):
//  - Access-gate PARITY with the watch page: published && (timing-safe token match
//    || checkRecordingAccess). checkRecordingAccess alone omits the share-token
//    path, so we reproduce the exact predicate.
//  - Single recording-row fetch drives BOTH the access decision and the key/game
//    lookup (closes IDOR — never "check access on A, serve key of B").
//  - game id comes from OUR DB row, never the caller (closes SSRF into Spiideo).
//  - The raw VP is minors' footage → same private-bucket, 1h-signed regime as the
//    production; force-dynamic + no-store so no proxy caches one viewer's URL.
//  - Capability SPLIT: anyone with access may VIEW an already-captured panorama;
//    only an authenticated GRANT-holder (not an anonymous bearer-token viewer) may
//    TRIGGER a fresh capture — shrinks the untrusted, expensive-op surface.
//  - DB-backed atomic idle→pending compare-and-set (not an in-memory Map, which a
//    multi-instance serverless deploy doesn't share) + a global in-flight cap
//    rate-limit the Spiideo-actuating capture.

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { BatchClient, SubmitJobCommand } from '@aws-sdk/client-batch'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { checkRecordingAccess } from '@/lib/recordings/access-control'
import { getPlaybackUrl } from '@/lib/s3/client'
import { meshExists } from '@/lib/panorama/mesh'

// Signed URLs (minors' footage) must never be cached across viewers.
export const dynamic = 'force-dynamic'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SIGNED_URL_TTL = 3600 // 1h, matches the production's getPlaybackUrl
const CAPTURE_STUCK_MS = 10 * 60_000 // a pending capture older than this can retry
// (the Batch job heartbeats started_at, so a genuinely-running job never looks stuck)
const ERROR_COOLDOWN_MS = 5 * 60_000 // wait this long before retrying a failed capture
const MAX_ATTEMPTS = 3 // stop re-submitting the Batch job for a VP that can't materialize
const GLOBAL_INFLIGHT_CAP = 5 // max concurrent captures across all recordings

function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

function sameOriginOk(request: NextRequest): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true // same-origin navigations may omit Origin
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

function noStore(json: unknown, status = 200): NextResponse {
  const res = NextResponse.json(json, { status })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!UUID_RE.test(id))
    return noStore({ error: 'bad id', code: 'bad_request' }, 400)
  if (!sameOriginOk(request))
    return noStore({ error: 'forbidden', code: 'forbidden' }, 403)

  const token =
    request.nextUrl.searchParams.get('token') ||
    (await request.json().catch(() => ({})))?.token ||
    null

  const supabase = createServiceClient() as any
  // ONE fetch drives both access and the key/game lookup — no A-vs-B IDOR.
  const { data: rec } = await supabase
    .from('playhub_match_recordings')
    .select(
      'id, status, share_token, content_type, spiideo_game_id, panorama_s3_key, panorama_capture_status, panorama_capture_started_at, panorama_capture_attempts'
    )
    .eq('id', id)
    .maybeSingle()

  // Mirror the watch page's 404 semantics exactly (don't reveal existence).
  if (!rec || rec.status !== 'published')
    return noStore({ error: 'not found', code: 'not_found' }, 404)

  // Access-gate PARITY with page.tsx: published && (token match || grant).
  const tokenMatches = !!(
    token &&
    rec.share_token &&
    timingSafeStrEqual(String(token), String(rec.share_token))
  )
  const { user } = await getAuthUser()
  const grant = user
    ? await checkRecordingAccess(id, user.id)
    : { hasAccess: false }
  const hasAccess = tokenMatches || grant.hasAccess
  if (!hasAccess) return noStore({ error: 'not found', code: 'not_found' }, 404)

  // FAST PATH — already captured: serve a short-TTL signed URL (private bucket,
  // same regime as the production). Re-gated on every poll above.
  if (rec.panorama_s3_key) {
    try {
      const url = await getPlaybackUrl(rec.panorama_s3_key, SIGNED_URL_TTL)
      return noStore({ status: 'ready', url })
    } catch (err) {
      console.error(
        '[panorama-source] sign failed:',
        err instanceof Error ? err.message : err
      )
      return noStore({ error: 'sign failed', code: 'sign_error' }, 500)
    }
  }

  // De-warp availability keys off the Spiideo game (raw VP is materialized from
  // it), NOT content_type: the default view of a Spiideo recording is the hosted
  // Play production ('hosted_video'), yet it still has a pannable raw panorama.
  // The watch page only shows "Explore" when a mesh exists for this game; here we
  // independently require just the game id.
  if (!rec.spiideo_game_id) {
    return noStore({ status: 'unavailable' })
  }

  const attempts = rec.panorama_capture_attempts ?? 0
  const startedAt = rec.panorama_capture_started_at
    ? new Date(rec.panorama_capture_started_at).getTime()
    : 0
  const age = Date.now() - startedAt

  // Permanently failed (VP can't materialize) → stop retrying, don't offer it.
  if (rec.panorama_capture_status === 'error' && attempts >= MAX_ATTEMPTS) {
    return noStore({ status: 'unavailable' })
  }
  // A capture is in flight (and not stuck) → keep polling.
  if (rec.panorama_capture_status === 'pending' && age < CAPTURE_STUCK_MS) {
    return noStore({ status: 'pending' })
  }
  // A recent failure → wait out the cooldown before another attempt (still poll).
  if (rec.panorama_capture_status === 'error' && age < ERROR_COOLDOWN_MS) {
    return noStore({ status: 'pending' })
  }

  // TRIGGER — capability split: only an authenticated GRANT-holder may actuate a
  // fresh Spiideo capture. Anonymous bearer-token viewers can view a ready
  // panorama (fast path above) but cannot trigger one.
  if (!grant.hasAccess) return noStore({ status: 'unavailable' })

  // Don't actuate an expensive multi-GB capture for a game with no published
  // de-warp mesh — its raw VP would be un-renderable (the watch page needs the
  // mesh to de-warp). This mirrors page.tsx's gate so route eligibility == UI
  // eligibility structurally, not just via the hidden Explore button. Cheap
  // public HEAD, and only grant-holders on the trigger path reach it (pending
  // polls returned above).
  if (!(await meshExists(rec.spiideo_game_id))) {
    return noStore({ status: 'unavailable' })
  }

  const jobQueue = process.env.VP_MATERIALIZE_JOB_QUEUE
  const jobDefinition = process.env.VP_MATERIALIZE_JOB_DEFINITION
  const awsKeyId = process.env.SNAPSHOT_INVOKE_AWS_ACCESS_KEY_ID
  const awsSecret = process.env.SNAPSHOT_INVOKE_AWS_SECRET_ACCESS_KEY
  if (!jobQueue || !jobDefinition || !awsKeyId || !awsSecret) {
    return noStore({ error: 'not configured', code: 'not_configured' }, 503)
  }

  // Global in-flight cap — bound the number of concurrent Spiideo-actuating captures.
  const { count: inflight } = await supabase
    .from('playhub_match_recordings')
    .select('id', { count: 'exact', head: true })
    .eq('panorama_capture_status', 'pending')
    .gt(
      'panorama_capture_started_at',
      new Date(Date.now() - CAPTURE_STUCK_MS).toISOString()
    )
  // Global cap hit → transient; tell the client to keep polling (a later poll
  // triggers once capacity frees). NOT terminal 'busy' (the client would give up).
  if ((inflight ?? 0) >= GLOBAL_INFLIGHT_CAP) {
    return noStore({ status: 'pending' })
  }

  // ATOMIC idle→pending compare-and-set: only invoke if THIS update wins the race.
  // Claimable iff: never-captured (null), OR a failed capture past its cooldown and
  // under the attempt cap, OR a stuck-pending past the (heartbeated) stuck window.
  // Scoping started_at to each status (not a bare `started_at.lt`) keeps a 'ready'
  // row structurally unclaimable. A concurrent claim re-evaluates post-lock and
  // matches 0 rows (Postgres EvalPlanQual) — exactly one submitter wins.
  const stuckCutoff = new Date(Date.now() - CAPTURE_STUCK_MS).toISOString()
  const errorCutoff = new Date(Date.now() - ERROR_COOLDOWN_MS).toISOString()
  // Claim via affected-row COUNT, not return=representation. PostgREST 400s
  // ("column does not exist") when a mutation combines a top-level or=/and=
  // logical filter with return=representation — which is exactly what the
  // supabase-js `.select()`-after-`.update()` path emits. `count: 'exact'`
  // returns the row count via Content-Range with return=minimal instead, dodging
  // that bug. It's the SAME single atomic UPDATE, so the compare-and-set
  // semantics (exactly one concurrent claimer wins, EvalPlanQual) are unchanged.
  const { count: claimedCount, error: claimErr } = await supabase
    .from('playhub_match_recordings')
    .update(
      {
        panorama_capture_status: 'pending',
        panorama_capture_started_at: new Date().toISOString(),
        panorama_capture_error: null,
        panorama_capture_attempts: attempts + 1,
      },
      { count: 'exact' }
    )
    .eq('id', id)
    .or(
      `panorama_capture_status.is.null,` +
        `and(panorama_capture_status.eq.error,panorama_capture_attempts.lt.${MAX_ATTEMPTS},panorama_capture_started_at.lt.${errorCutoff}),` +
        `and(panorama_capture_status.eq.pending,panorama_capture_started_at.lt.${stuckCutoff})`
    )
  if (claimErr) {
    // A claim that ERRORS is not a claim that LOST — surfacing it as 500 (which
    // the client retries, then times out visibly) prevents the exact silent
    // forever-'pending' failure the PostgREST representation bug caused. Never
    // masquerade a broken claim as a legitimate lost race.
    console.error(
      '[panorama-source] claim failed:',
      claimErr.code,
      claimErr.message
    )
    return noStore({ error: 'claim failed', code: 'claim_error' }, 500)
  }
  if (!claimedCount) {
    // Someone else just claimed it (or it's freshly pending) — poll.
    return noStore({ status: 'pending' })
  }

  // Submit the multi-GB full-match remux to AWS Batch (Fargate) as the scoped IAM
  // invoker. The Batch job owns the terminal lifecycle (writes ready/error +
  // panorama_s3_key), so a failed submit here only leaves a 'pending' that expires
  // after CAPTURE_STUCK_MS. gameId comes from OUR row, never the caller (SSRF-safe).
  const batch = new BatchClient({
    region: process.env.SNAPSHOT_INVOKE_AWS_REGION || 'eu-west-2',
    credentials: { accessKeyId: awsKeyId, secretAccessKey: awsSecret },
    maxAttempts: 1,
  })
  let jobId: string | undefined
  try {
    const out = await batch.send(
      new SubmitJobCommand({
        jobName: `vp-materialize-${id}`,
        jobQueue,
        jobDefinition,
        containerOverrides: {
          environment: [
            { name: 'RECORDING_ID', value: id },
            { name: 'GAME_ID', value: String(rec.spiideo_game_id) },
          ],
        },
      })
    )
    jobId = out.jobId
  } catch (err) {
    console.error(
      '[panorama-source] submit error:',
      err instanceof Error ? err.message : err
    )
  }
  if (!jobId) {
    // Roll the claim back to 'error' so it isn't stuck 'pending' for 10 min.
    await supabase
      .from('playhub_match_recordings')
      .update({ panorama_capture_status: 'error' })
      .eq('id', id)
    return noStore(
      { error: 'capture could not be started', code: 'submit_failed' },
      502
    )
  }
  return noStore({ status: 'pending' })
}
