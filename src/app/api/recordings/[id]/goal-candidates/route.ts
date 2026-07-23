// GET /api/recordings/[id]/goal-candidates
//
// Lists the goal-detect review candidates for one recording (the platform-
// admin review strip), with short-lived signed clip URLs.
// playhub_goal_candidates is RLS deny-all for clients — this route is the
// only read path. PILOT POSTURE: platform admins ONLY (precision is ~0.31 by
// design; venue admins just see approved goals appear as /watch markers).
// The strip renders null on any !ok response, so non-admins simply see
// nothing (portrait-strip pattern).

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'

export const dynamic = 'force-dynamic'

const CLIPS_BUCKET = 'goal-review-clips'
const SIGNED_URL_TTL_SECONDS = 3600
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user } = await getAuthUser()
  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'unauthorized' },
      { status: 401 }
    )
  }
  const { id } = await params
  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: 'Bad recording id', code: 'bad_request' },
      { status: 400 }
    )
  }
  if (!(await isPlatformAdmin(user.id))) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'forbidden' },
      { status: 403 }
    )
  }

  const service = createServiceClient()
  const { data: rows, error } = await service
    .from('playhub_goal_candidates')
    .select(
      'id, t0_s, t1_s, anchor_s, sub_anchors_s, pko, deadctx, status, error, clip_path, clip_span_s, approved_event_id, detector_version, reviewed_at, created_at, updated_at'
    )
    .eq('match_recording_id', id)
    .order('anchor_s', { ascending: true })
  if (error) {
    console.error('[goal-candidates] query failed:', error.message)
    return NextResponse.json(
      { error: 'Query failed', code: 'query_failed' },
      { status: 500 }
    )
  }

  const candidates = rows ?? []

  // Linked goal events (multi-goal: one candidate can carry N markers).
  // Chips render from these; ordered by stamp for a stable mm:ss row.
  const eventsByCandidate = new Map<
    string,
    { eventId: string; stampSource: string; stampSeconds: number | null }[]
  >()
  if (candidates.length > 0) {
    const { data: links, error: linksErr } = await service
      .from('playhub_goal_candidate_events')
      .select('candidate_id, event_id, stamp_source, stamp_seconds')
      .in(
        'candidate_id',
        candidates.map((r) => r.id)
      )
      .order('stamp_seconds', { ascending: true, nullsFirst: false })
    if (linksErr) {
      console.error('[goal-candidates] links query failed:', linksErr.message)
      return NextResponse.json(
        { error: 'Query failed', code: 'query_failed' },
        { status: 500 }
      )
    }
    for (const l of links ?? []) {
      const entry = {
        eventId: l.event_id,
        stampSource: l.stamp_source,
        stampSeconds: l.stamp_seconds === null ? null : Number(l.stamp_seconds),
      }
      const list = eventsByCandidate.get(l.candidate_id)
      if (list) list.push(entry)
      else eventsByCandidate.set(l.candidate_id, [entry])
    }
  }

  // Per-cycle yes/no verdicts (refiner-label pilot) — keyed by the stored
  // sub-anchor value; the strip renders them on the cycle row. Never part
  // of the candidate's review state. Entries whose anchor is no longer in
  // sub_anchors_s (labels made before a re-detection) pass through
  // deliberately — the strip's per-cycle lookup simply never matches them,
  // and the refiner export wants them (epoch-stamped).
  const cyclesByCandidate = new Map<
    string,
    { cycleAnchorS: number; verdict: string }[]
  >()
  if (candidates.length > 0) {
    const { data: cycles, error: cyclesErr } = await service
      .from('playhub_goal_cycle_reviews')
      .select('candidate_id, cycle_anchor_s, verdict')
      .in(
        'candidate_id',
        candidates.map((r) => r.id)
      )
    if (cyclesErr) {
      console.error(
        '[goal-candidates] cycle reviews query failed:',
        cyclesErr.message
      )
      return NextResponse.json(
        { error: 'Query failed', code: 'query_failed' },
        { status: 500 }
      )
    }
    for (const c of cycles ?? []) {
      const entry = {
        cycleAnchorS: Number(c.cycle_anchor_s),
        verdict: c.verdict,
      }
      const list = cyclesByCandidate.get(c.candidate_id)
      if (list) list.push(entry)
      else cyclesByCandidate.set(c.candidate_id, [entry])
    }
  }

  const paths = candidates
    .filter((r) => r.clip_path && r.status !== 'error')
    .map((r) => r.clip_path as string)
  const urlByPath = new Map<string, string>()
  if (paths.length > 0) {
    const { data: signed, error: signErr } = await service.storage
      .from(CLIPS_BUCKET)
      .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)
    if (signErr) {
      console.error('[goal-candidates] sign failed:', signErr.message)
    } else {
      for (const s of signed ?? []) {
        if (s.signedUrl && s.path) urlByPath.set(s.path, s.signedUrl)
      }
    }
  }

  // no-store: the payload carries signed URLs of (potentially minors')
  // match footage — no proxy or browser cache may hold one viewer's URLs.
  return NextResponse.json(
    {
      candidates: candidates.map((r) => ({
        id: r.id,
        t0S: Number(r.t0_s),
        t1S: Number(r.t1_s),
        anchorS: Number(r.anchor_s),
        // Hint substrate for the strip's per-cycle stamp offers; NULL on
        // pre-hybrid rows -> empty (no hints, card renders like before).
        // NULL *elements* (legal in numeric[], never job-written) are
        // dropped — Number(null) is 0, which would render a phantom
        // actionable "goal at 0:00" chip (API review).
        subAnchorsS: (r.sub_anchors_s ?? [])
          .filter((v) => v !== null)
          .map(Number),
        pko: r.pko === null ? null : Number(r.pko),
        deadctx: r.deadctx === null ? null : Number(r.deadctx),
        status: r.status,
        error: r.error,
        clipUrl: r.clip_path ? (urlByPath.get(r.clip_path) ?? null) : null,
        // Encoded clip duration (adaptive tier); NULL = pre-adaptive row —
        // the strip falls back to the legacy fixed 300s cap for the
        // truncation badge.
        clipSpanS: r.clip_span_s === null ? null : Number(r.clip_span_s),
        approvedEventId: r.approved_event_id,
        events: eventsByCandidate.get(r.id) ?? [],
        cycleReviews: cyclesByCandidate.get(r.id) ?? [],
        detectorVersion: r.detector_version,
        reviewedAt: r.reviewed_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
