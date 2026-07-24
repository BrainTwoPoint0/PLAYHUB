// POST /api/academy/[clubSlug]/portrait-renders/[renderId]/feedback
//
// Records a human correction to a system-generated portrait draft — the training/QA
// signal. Label semantics: a draft marked "good enough" is UNEDITED by definition, so
// action='accepted' means the auto-detection passed and action='edited' means it did
// not (the diff says how).
//
// Same two-tier club gate + IDOR guard as the sibling PATCH route. This is a
// user-authored JSON sink feeding a corpus about minors' footage, so it is deliberately
// hardened: the club gate runs BEFORE the body is parsed (so the whole authenticated
// user base cannot drive validation work), the insert is built explicitly, geometry is
// range-checked, and free text is not accepted at all.

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { getClubBySlug } from '@/lib/academy/config'
import { isSameOrigin } from '@/lib/tiktok/route-helpers'
import {
  insertPortraitFeedback,
  REJECT_REASONS,
  type BaselineOrigin,
  type RejectReason,
} from '@/lib/academy/portrait-feedback'
import { SOURCE_WIDTH, CROP_WIDTH, type CropKeyframe } from '@/lib/editor/types'
import { MAX_KEYFRAMES_PER_JOB } from '@/lib/editor/validation'

export const dynamic = 'force-dynamic'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MAX_BODY_BYTES = 512 * 1024
/** Aligned with the render path: geometry the renderer would reject must not enter the corpus. */
const MAX_KEYFRAMES = MAX_KEYFRAMES_PER_JOB
const MAX_SCENE_CHANGES = 1000
/** Bounds a runaway client loop. Permanent for a render, hence 409 not 429. */
const MAX_ROWS_PER_RENDER = 50
/** A goal clip is ~25s; this is a generous sanity ceiling, not a business rule. */
const MAX_CLIP_SECONDS = 3600
const MAX_CROP_X = SOURCE_WIDTH - CROP_WIDTH
const SOURCES = new Set(['ai_ball', 'ai_tracked', 'ai_cluster', 'user'])

const JSON_HEADERS = { 'Cache-Control': 'no-store' } as const
const fail = (status: number, error: string, code: string) =>
  NextResponse.json({ error, code }, { status, headers: JSON_HEADERS })

/**
 * Accepts only well-formed, physically-plausible crop geometry. Rejects rather than
 * coerces, and rebuilds each object field-by-field so no client-supplied extra field
 * can reach the corpus. Range checks matter: type-valid but impossible geometry
 * (negative x, 1e308, t=10^9) is the remaining poisoning surface.
 */
function parseKeyframes(value: unknown): CropKeyframe[] | null {
  if (!Array.isArray(value)) return null
  if (value.length > MAX_KEYFRAMES) return null
  const out: CropKeyframe[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null
    const k = raw as Record<string, unknown>
    const { time, x, source, confidence } = k
    if (typeof time !== 'number' || !Number.isFinite(time)) return null
    if (time < 0 || time > MAX_CLIP_SECONDS) return null
    if (typeof x !== 'number' || !Number.isFinite(x)) return null
    if (x < 0 || x > MAX_CROP_X) return null
    if (typeof source !== 'string' || !SOURCES.has(source)) return null
    if (
      typeof confidence !== 'number' ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    )
      return null
    out.push({
      time,
      x,
      source: source as CropKeyframe['source'],
      confidence,
    })
  }
  return out
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ clubSlug: string; renderId: string }> }
) {
  if (!isSameOrigin(request)) return fail(403, 'Forbidden', 'forbidden')
  // Closes the simple-request CSRF path independently of the Origin check.
  const ctype = request.headers.get('content-type') ?? ''
  if (!ctype.toLowerCase().includes('application/json')) {
    return fail(
      415,
      'Content-Type must be application/json',
      'bad_content_type'
    )
  }

  const { user } = await getAuthUser()
  if (!user) return fail(401, 'Unauthorized', 'unauthorized')

  const { clubSlug, renderId } = await params
  if (!UUID_RE.test(renderId)) return fail(400, 'Bad render id', 'bad_request')

  // AUTHORIZE BEFORE PARSING. Any logged-in user (a parent, a player) can reach this
  // handler; only club admins should be able to make it do work.
  const club = await getClubBySlug(clubSlug)
  if (!club) return fail(404, 'Club not found', 'not_found')
  const allowed =
    (await isPlatformAdmin(user.id)) ||
    (club.organizationId && (await isVenueAdmin(user.id, club.organizationId)))
  if (!allowed) return fail(403, 'Forbidden', 'forbidden')

  // Read as text with a real byte budget: content-length is advisory (absent under
  // chunked encoding, NaN when malformed, and trivially lied about).
  let rawBody: string
  try {
    rawBody = await request.text()
  } catch {
    return fail(400, 'Bad body', 'bad_request')
  }
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return fail(413, 'Payload too large', 'too_large')
  }
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(rawBody)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail(400, 'Bad body', 'bad_request')
    }
    body = parsed as Record<string, unknown>
  } catch {
    return fail(400, 'Bad body', 'bad_request')
  }

  const action = String(body.action ?? '')
  if (action !== 'edited' && action !== 'accepted') {
    return fail(400, 'action must be edited or accepted', 'bad_request')
  }

  // Presence-vs-validity is checked independently of action: a present-but-invalid
  // payload must never be silently downgraded to a bare label.
  let keyframesAfter: CropKeyframe[] | null = null
  if (body.keyframesAfter !== undefined && body.keyframesAfter !== null) {
    keyframesAfter = parseKeyframes(body.keyframesAfter)
    if (!keyframesAfter) {
      return fail(
        400,
        'keyframesAfter must be valid crop geometry',
        'bad_request'
      )
    }
  }
  if (action === 'edited' && !keyframesAfter) {
    return fail(400, 'keyframesAfter required for an edit', 'bad_request')
  }
  // "accepted" means unedited by definition — a stored "after" could only contradict
  // the row's own label, so it is dropped rather than trusted.
  if (action === 'accepted') keyframesAfter = null

  let clientBefore: CropKeyframe[] | null = null
  if (body.keyframesBefore !== undefined && body.keyframesBefore !== null) {
    clientBefore = parseKeyframes(body.keyframesBefore)
    if (!clientBefore) {
      return fail(
        400,
        'keyframesBefore must be valid crop geometry',
        'bad_request'
      )
    }
  }

  let sceneChanges: number[] | null = null
  if (body.sceneChanges !== undefined && body.sceneChanges !== null) {
    if (
      !Array.isArray(body.sceneChanges) ||
      body.sceneChanges.length > MAX_SCENE_CHANGES
    ) {
      return fail(400, 'sceneChanges invalid or too long', 'bad_request')
    }
    if (
      !body.sceneChanges.every(
        (n) =>
          typeof n === 'number' &&
          Number.isFinite(n) &&
          n >= 0 &&
          n <= MAX_CLIP_SECONDS
      )
    ) {
      return fail(400, 'sceneChanges must be finite seconds', 'bad_request')
    }
    sceneChanges = body.sceneChanges as number[]
  }

  let trim: { start: number; end: number } | null = null
  if (body.trim !== undefined && body.trim !== null) {
    const t = body.trim as { start?: unknown; end?: unknown }
    const okTrim =
      typeof t.start === 'number' &&
      Number.isFinite(t.start) &&
      t.start >= 0 &&
      typeof t.end === 'number' &&
      Number.isFinite(t.end) &&
      t.end > t.start &&
      t.end <= MAX_CLIP_SECONDS
    // A nonsense trim window in the corpus is worse than a rejected request.
    if (!okTrim)
      return fail(400, 'trim must be {start>=0, end>start}', 'bad_request')
    trim = { start: t.start as number, end: t.end as number }
  }

  // Accepted now so that adding action='rejected' later is a pure enum widening.
  let reason: RejectReason | null = null
  if (body.reason !== undefined && body.reason !== null) {
    if (!REJECT_REASONS.includes(body.reason as RejectReason)) {
      return fail(400, 'reason must be a known value', 'bad_request')
    }
    reason = body.reason as RejectReason
  }

  // NOTE: free text is deliberately NOT accepted from the request body. The corpus
  // describes minors' footage and 500 chars is enough for a name, a phone number or a
  // URL; the `note` column exists for a future admin-only surface, not for this route.

  const service = createServiceClient()

  // The club filter is the IDOR guard; wrong-club or unknown id collapses to 404.
  // provider_event_id is derived from the row, never trusted from the client.
  const { data: render, error: readErr } = await service
    .from('playhub_portrait_renders')
    .select('id, provider_event_id, club_slug, keyframes')
    .eq('id', renderId)
    .eq('club_slug', clubSlug)
    .maybeSingle()
  if (readErr) {
    console.error('[portrait-feedback] render lookup failed:', readErr.message)
    return fail(500, 'Lookup failed', 'lookup_failed')
  }
  if (!render) return fail(404, 'Render not found', 'not_found')

  const { count: existing, error: countErr } = await service
    .from('playhub_portrait_render_feedback')
    .select('id', { count: 'exact', head: true })
    .eq('render_id', renderId)
  // Fail CLOSED: a broken count must not silently disable the cap.
  if (countErr) {
    console.error('[portrait-feedback] cap count failed:', countErr.message)
    return fail(500, 'Lookup failed', 'lookup_failed')
  }
  if ((existing ?? 0) >= MAX_ROWS_PER_RENDER) {
    // Permanent for this render — 409, not a retryable 429.
    return fail(
      409,
      'Feedback limit reached for this render',
      'feedback_limit_reached'
    )
  }

  // Prefer the FACT the draft was rendered with. `none` is a real outcome and must not
  // be dressed up as `session_detect`: diffing against an absent baseline would count
  // every keyframe as "added" and fabricate a maximal correction.
  const rowKeyframes = (render as { keyframes?: unknown }).keyframes
  const rowBaseline = rowKeyframes == null ? null : parseKeyframes(rowKeyframes)
  if (rowKeyframes != null && !rowBaseline) {
    // Schema-drift canary: the column exists but is not the shape we can diff.
    console.error(
      '[portrait-feedback] render.keyframes present but unparseable — persisted shape drifted'
    )
  }
  const keyframesBefore = rowBaseline ?? clientBefore
  const baselineOrigin: BaselineOrigin = rowBaseline
    ? 'render_row'
    : clientBefore
      ? 'session_detect'
      : 'none'

  const { ok, id, diff } = await insertPortraitFeedback(service, {
    renderId,
    providerEventId: render.provider_event_id as string,
    clubSlug,
    userId: user.id,
    action,
    keyframesBefore,
    keyframesAfter,
    baselineOrigin,
    reason,
    sceneChanges,
    trim,
  })
  if (!ok) return fail(500, 'Could not record feedback', 'write_failed')

  return NextResponse.json(
    {
      id,
      baselineOrigin,
      // A projection of the stored KeyframeDiff, not the whole thing.
      diffSummary: diff
        ? { counts: diff.counts, maxAbsDx: diff.maxAbsDx }
        : null,
    },
    { status: 201, headers: JSON_HEADERS }
  )
}
