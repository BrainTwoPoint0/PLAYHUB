// GET /api/admin/lyl/recordings
//
// Returns every playhub_recording_assignments row for LYL (sorted most
// recent match first), plus the subclub catalog the override modal
// needs for its dropdown. Platform-admin only.
//
// No pagination yet — at LYL pilot scale (~50-100 rows) the full list
// fits in one round-trip. Add limit/offset when a single league passes
// ~1K rows or load time exceeds ~500ms.

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUserStrict, createServiceClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'

const LEAGUE_CLUB_SLUG = 'lyl'

export async function GET(_request: NextRequest) {
  const { user } = await getAuthUserStrict()
  if (!user)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isPlatformAdmin(user.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const supabase = createServiceClient() as any

  // Two parallel reads — assignments table + subclub catalog.
  //
  // LIMIT 500 on assignments: defense in depth against unbounded growth.
  // LYL is ~100 rows today; if a league ever passes 500 we want to add
  // pagination explicitly, not silently truncate. Matches the senior
  // API-reviewer's "hard cap, even pre-pagination" guidance.
  const [assignmentsResult, subclubsResult] = await Promise.all([
    supabase
      .from('playhub_recording_assignments')
      .select('*')
      .eq('league_club_slug', LEAGUE_CLUB_SLUG)
      .order('match_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(500),
    supabase
      .from('playhub_academy_subclubs')
      .select('subclub_slug, display_name')
      .eq('club_slug', LEAGUE_CLUB_SLUG)
      .eq('is_active', true)
      .order('display_name'),
  ])

  // Server-side log full Supabase error; client gets a generic message
  // (Postgres error text can leak column/constraint names — matches the
  // 2026-03-01 hardening sweep applied across the rest of PLAYHUB).
  if (assignmentsResult.error) {
    console.error(
      'GET /api/admin/lyl/recordings: assignments lookup failed',
      assignmentsResult.error
    )
    return NextResponse.json(
      { error: 'recordings_lookup_failed' },
      { status: 500 }
    )
  }
  if (subclubsResult.error) {
    console.error(
      'GET /api/admin/lyl/recordings: subclubs lookup failed',
      subclubsResult.error
    )
    return NextResponse.json(
      { error: 'subclubs_lookup_failed' },
      { status: 500 }
    )
  }

  return NextResponse.json({
    recordings: assignmentsResult.data ?? [],
    subclubs: subclubsResult.data ?? [],
  })
}
