// GET /api/venue/[venueId]/audit
// Returns a venue admin's audit log: who did what to which recording, when.
// Currently surfaces the admin-override delete/edit events on tags. Future
// privileged actions in playhub_audit_log automatically appear here.
//
// Auth: only venue admins (isVenueAdmin) can read. The audit log table is
// service-role-only at the RLS layer; we enforce admin scope here in app
// land.
//
// Query params:
//   ?cursor=<created_at>|<id>     — keyset pagination, returned by previous page
//   ?action=<recording_event.*>   — filter by exact action code
//   ?recording_id=<uuid>          — filter to one recording
//   ?limit=<n>                    — page size, capped at 100, default 50

import { NextResponse } from 'next/server'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

export async function GET(
  request: Request,
  { params }: { params: Promise<{ venueId: string }> }
) {
  const { venueId } = await params
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: 401 }
    )
  }

  // Only venue admins can see the venue's audit history. This mirrors the
  // delete/edit gate — same authority, same scope.
  const admin = await isVenueAdmin(user.id, venueId)
  if (!admin) {
    return NextResponse.json(
      { error: 'You do not have permission to view this audit history' },
      { status: 403 }
    )
  }

  const url = new URL(request.url)
  const action = url.searchParams.get('action')
  const recordingId = url.searchParams.get('recording_id')
  const cursor = url.searchParams.get('cursor')
  const limitRaw = url.searchParams.get('limit')
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(limitRaw) || DEFAULT_LIMIT)
  )

  const serviceClient = createServiceClient() as any

  let query = serviceClient
    .from('playhub_audit_log')
    .select('*')
    .eq('target_organization_id', venueId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1) // +1 so we can detect "has more"

  if (action) query = query.eq('action', action)
  if (recordingId) query = query.eq('target_recording_id', recordingId)

  // Keyset pagination — cursor is "<created_at>|<id>". Pull rows strictly
  // older than the cursor's (created_at, id) tuple. Postgres compares
  // tuples lexicographically, so .lt() on the row-constructor is exactly
  // the comparison we want, but Supabase's PostgREST doesn't expose that
  // directly — emulate with two filters that together produce the same
  // strict-ordering semantics.
  if (cursor) {
    const [cursorTime, cursorId] = cursor.split('|')
    if (cursorTime && cursorId) {
      query = query.or(
        `created_at.lt.${cursorTime},and(created_at.eq.${cursorTime},id.lt.${cursorId})`
      )
    }
  }

  const { data: rows, error } = await query
  if (error) {
    console.error('audit list failed', error.message)
    return NextResponse.json(
      { error: 'Failed to fetch audit log' },
      { status: 500 }
    )
  }

  const hasMore = (rows?.length || 0) > limit
  const trimmed = hasMore ? rows!.slice(0, limit) : rows || []

  // Enrich with actor + target metadata. Two follow-up queries against
  // their respective tables — keeps the audit_log row schema stable while
  // the UI gets human-readable names.
  const actorIds = Array.from(
    new Set(trimmed.map((r: any) => r.actor_user_id).filter(Boolean))
  )
  const recordingIds = Array.from(
    new Set(trimmed.map((r: any) => r.target_recording_id).filter(Boolean))
  )

  const [{ data: profiles }, { data: recordings }] = await Promise.all([
    actorIds.length > 0
      ? serviceClient
          .from('profiles')
          .select('user_id, username')
          .in('user_id', actorIds)
      : Promise.resolve({ data: [] as any[] }),
    recordingIds.length > 0
      ? serviceClient
          .from('playhub_match_recordings')
          .select('id, title, home_team, away_team, match_date')
          .in('id', recordingIds)
      : Promise.resolve({ data: [] as any[] }),
  ])

  const profileByUser = new Map<string, { user_id: string; username: string | null }>(
    (profiles || []).map((p: any) => [p.user_id, p])
  )
  const recordingById = new Map<string, any>(
    (recordings || []).map((r: any) => [r.id, r])
  )

  const enriched = trimmed.map((row: any) => ({
    id: row.id,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    target_recording_id: row.target_recording_id,
    target_organization_id: row.target_organization_id,
    was_admin_override: row.was_admin_override,
    metadata: row.metadata,
    created_at: row.created_at,
    actor: row.actor_user_id
      ? {
          user_id: row.actor_user_id,
          username: profileByUser.get(row.actor_user_id)?.username ?? null,
        }
      : null,
    target_recording: row.target_recording_id
      ? recordingById.get(row.target_recording_id) ?? null
      : null,
  }))

  // Build the next cursor from the last row, if any. Caller passes back as
  // ?cursor=... to fetch the next page.
  const nextCursor =
    hasMore && trimmed.length > 0
      ? `${trimmed[trimmed.length - 1].created_at}|${trimmed[trimmed.length - 1].id}`
      : null

  return NextResponse.json({
    rows: enriched,
    next_cursor: nextCursor,
  })
}
