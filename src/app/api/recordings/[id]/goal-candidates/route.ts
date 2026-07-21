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
      'id, t0_s, t1_s, anchor_s, pko, deadctx, status, error, clip_path, approved_event_id, detector_version, reviewed_at, created_at, updated_at'
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
        pko: r.pko === null ? null : Number(r.pko),
        deadctx: r.deadctx === null ? null : Number(r.deadctx),
        status: r.status,
        error: r.error,
        clipUrl: r.clip_path ? (urlByPath.get(r.clip_path) ?? null) : null,
        approvedEventId: r.approved_event_id,
        detectorVersion: r.detector_version,
        reviewedAt: r.reviewed_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
