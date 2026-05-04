// GET /api/me/pending-grants
// Returns recording-access invitations for the current user — both ones
// that are still email-keyed (haven't been claimed by a logged-in user
// yet) AND ones already linked to the user's account but never watched.
//
// Purpose: closes the "salted-account" abuse vector flagged by the
// security review — anyone with access can now grant access to anyone
// (incl. emails of users who haven't signed up). Surfacing pre-existing
// grants on the recipient's recordings page lets them review and decline
// unwanted invitations explicitly, instead of silently inheriting them.

import { NextResponse } from 'next/server'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'

const DEFAULT_LOOKBACK_DAYS = 30

export async function GET() {
  const { user } = await getAuthUser()
  if (!user) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: 401 }
    )
  }

  const serviceClient = createServiceClient() as any

  // We need the user's email to find email-keyed grants that haven't been
  // claimed yet. Source-of-truth is auth.users; fall back to the profile's
  // stored email if needed. Lower-case for the comparison since invitations
  // are normalised on insert.
  const rawEmail = (user.email || '').toLowerCase()

  // Defence-in-depth: PostgREST's `.or()` parses commas / parens as filter
  // syntax, so any user-controllable string interpolated in must be free
  // of those chars. Supabase email validation should already reject these
  // but we don't trust the upstream — a stray `,` would silently widen
  // the filter to additional predicates.
  const email = /^[^\s,()<>"'\\]+@[^\s,()<>"'\\]+\.[^\s,()<>"'\\]+$/.test(
    rawEmail
  )
    ? rawEmail
    : ''

  // Active grants where either user_id matches OR invited_email matches.
  // .or() lets us combine the two predicates in a single query without an
  // RLS-bypassing UNION dance.
  const sinceIso = new Date(
    Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString()

  const conditions = email
    ? `user_id.eq.${user.id},invited_email.eq.${email}`
    : `user_id.eq.${user.id}`

  const { data: grants, error } = await serviceClient
    .from('playhub_access_rights')
    .select(
      'id, match_recording_id, user_id, invited_email, granted_by, granted_at, expires_at, notes'
    )
    .eq('is_active', true)
    .or(conditions)
    .gte('granted_at', sinceIso)
    .order('granted_at', { ascending: false })
    .limit(100)

  if (error) {
    console.error('pending-grants list failed', error.message)
    return NextResponse.json(
      { error: 'Failed to fetch invitations' },
      { status: 500 }
    )
  }

  // Filter out grants the user has already engaged with — anything they've
  // recorded watch history against. The remaining set is "things granted
  // to you that you haven't actually used", which is the actionable
  // population for accept/decline decisions.
  const recordingIds = Array.from(
    new Set((grants || []).map((g: any) => g.match_recording_id))
  )

  const [{ data: history }, { data: recordings }, { data: granters }] =
    await Promise.all([
      recordingIds.length > 0
        ? serviceClient
            .from('playhub_view_history')
            .select('match_recording_id')
            .eq('user_id', user.id)
            .in('match_recording_id', recordingIds)
        : Promise.resolve({ data: [] }),
      recordingIds.length > 0
        ? serviceClient
            .from('playhub_match_recordings')
            .select('id, title, home_team, away_team, match_date, organization_id')
            .in('id', recordingIds)
        : Promise.resolve({ data: [] }),
      Array.from(new Set((grants || []).map((g: any) => g.granted_by))).filter(
        Boolean
      ).length > 0
        ? serviceClient
            .from('profiles')
            .select('user_id, username, full_name')
            .in(
              'user_id',
              Array.from(
                new Set((grants || []).map((g: any) => g.granted_by))
              ).filter(Boolean)
            )
        : Promise.resolve({ data: [] }),
    ])

  const watched = new Set(
    (history || []).map((h: any) => h.match_recording_id)
  )
  const recordingById = new Map<string, any>(
    (recordings || []).map((r: any) => [r.id, r])
  )
  const granterById = new Map<
    string,
    { user_id: string; username: string | null; full_name: string | null }
  >((granters || []).map((p: any) => [p.user_id, p]))

  const enriched = (grants || [])
    .filter((g: any) => !watched.has(g.match_recording_id))
    .map((g: any) => ({
      id: g.id,
      granted_at: g.granted_at,
      expires_at: g.expires_at,
      // null user_id means "still email-keyed, hasn't been claimed yet";
      // a populated user_id means "claimed but not watched yet". UI can
      // show different copy if it cares.
      claimed: !!g.user_id,
      recording: recordingById.get(g.match_recording_id) ?? null,
      granted_by: g.granted_by
        ? {
            user_id: g.granted_by,
            display:
              granterById.get(g.granted_by)?.full_name ??
              granterById.get(g.granted_by)?.username ??
              null,
          }
        : null,
    }))

  return NextResponse.json(
    { grants: enriched },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
