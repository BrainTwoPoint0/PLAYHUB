// GET /api/admin/lyl/runs
//
// Returns recent playhub_recording_sync_runs rows (most recent first)
// for the admin UI's run-history panel. Default limit 25, max 100.

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUserStrict, createServiceClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'

const LEAGUE_CLUB_SLUG = 'lyl'
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

export async function GET(request: NextRequest) {
  const { user } = await getAuthUserStrict()
  if (!user)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isPlatformAdmin(user.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const rawLimit = parseInt(searchParams.get('limit') ?? '', 10)
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(MAX_LIMIT, rawLimit))
    : DEFAULT_LIMIT

  const supabase = createServiceClient() as any
  const { data, error } = await supabase
    .from('playhub_recording_sync_runs')
    .select('*')
    .eq('league_club_slug', LEAGUE_CLUB_SLUG)
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) {
    console.error('GET /api/admin/lyl/runs: lookup failed', error)
    return NextResponse.json({ error: 'runs_lookup_failed' }, { status: 500 })
  }
  return NextResponse.json({ runs: data ?? [] })
}
