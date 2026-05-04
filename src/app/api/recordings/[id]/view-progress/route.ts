// POST /api/recordings/[id]/view-progress
// Persist the user's last-watched position so the player can resume on
// reload. Backed by an upsert on (user_id, match_recording_id) — the table
// has a unique constraint enforcing one row per pair.
//
// Body: { position_seconds: number, total_seconds?: number }
//
// Response shapes:
//   - 200 { persisted: true }                     — saved
//   - 200 { persisted: false, reason: 'anonymous' } — bearer-link viewer
//   - 4xx                                         — validation / auth
//   - 500                                         — DB error

import { NextResponse } from 'next/server'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { checkRecordingAccess } from '@/lib/recordings/access-control'

// Hard ceiling for either field. 24h covers any plausible match recording
// (longest current real-world: ~3h). Defends against integer overflow on
// the underlying `integer` columns and against a misbehaving client.
const MAX_SECONDS = 24 * 60 * 60

// Auto-mark completion at this percentage so we can distinguish "the user
// finished this" from "the user is a few minutes from the end" downstream.
const COMPLETION_THRESHOLD = 95

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { user } = await getAuthUser()

  // Bearer-link viewers can't be keyed against a user — they get a real
  // 200 with a discriminated body so the client can distinguish "anonymous"
  // from a missing-cookie auth bug at a glance.
  if (!user) {
    return NextResponse.json(
      { persisted: false, reason: 'anonymous' },
      { status: 200 }
    )
  }

  const access = await checkRecordingAccess(id, user.id)
  if (!access.hasAccess) {
    return NextResponse.json({ error: 'No access' }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const positionRaw = Number(body?.position_seconds)
  if (!Number.isFinite(positionRaw) || positionRaw < 0) {
    return NextResponse.json(
      { error: 'position_seconds must be a non-negative number' },
      { status: 400 }
    )
  }
  const totalRaw =
    body?.total_seconds != null && Number.isFinite(Number(body.total_seconds))
      ? Math.max(0, Math.floor(Number(body.total_seconds)))
      : null
  if (totalRaw != null && totalRaw > MAX_SECONDS) {
    return NextResponse.json(
      { error: 'total_seconds exceeds maximum' },
      { status: 400 }
    )
  }

  // Cap position at the per-field ceiling AND at total when known. A buggy
  // client that reports `position > duration` produces nonsensical
  // completion rates downstream — clamp here.
  const total = totalRaw
  const position = Math.min(
    Math.floor(positionRaw),
    MAX_SECONDS,
    total != null ? total : MAX_SECONDS
  )

  const completion =
    total && total > 0 ? Math.min(100, (position / total) * 100) : null

  // Auto-mark completion. NULL means "not finished" — only flip to a
  // timestamp once and leave it; if the user re-watches and scrubs back
  // we keep the original completion mark (last-watch finishing matters
  // more for product analytics than first-watch).
  const completedAt =
    completion != null && completion >= COMPLETION_THRESHOLD
      ? new Date().toISOString()
      : null

  const serviceClient = createServiceClient() as any
  const now = new Date().toISOString()

  // Upsert against the unique constraint. Supabase upsert compiles to
  // INSERT ... ON CONFLICT DO UPDATE SET col = EXCLUDED.col for every
  // column in the payload. To preserve the existing started_at on every
  // tick we OMIT it from the payload entirely — Postgres fills it on the
  // insert path via the column DEFAULT (set in the matching migration),
  // and on the conflict path it simply isn't in EXCLUDED so it stays put.
  // Same trick for completed_at: only included when we just crossed the
  // threshold, otherwise omitted so the prior value (or NULL) is kept.
  const { error } = await serviceClient
    .from('playhub_view_history')
    .upsert(
      {
        user_id: user.id,
        match_recording_id: id,
        watched_duration_seconds: position,
        total_duration_seconds: total,
        completion_percentage: completion,
        last_position_at: now,
        ...(completedAt ? { completed_at: completedAt } : {}),
      },
      {
        onConflict: 'user_id,match_recording_id',
        ignoreDuplicates: false,
      }
    )

  if (error) {
    console.error('view-progress upsert failed', error.message)
    return NextResponse.json(
      { error: 'Failed to record progress' },
      { status: 500 }
    )
  }

  return NextResponse.json({ persisted: true }, { status: 200 })
}
