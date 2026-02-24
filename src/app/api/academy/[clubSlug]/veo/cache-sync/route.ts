// POST /api/academy/[clubSlug]/veo/cache-sync
// Triggers a fresh Veo ClubHouse scrape and writes results to Supabase cache.
// Auth: x-api-key (Lambda) OR platform admin session (manual Sync Now button)

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { getClubBySlug } from '@/lib/academy/config'
import { listClubTeamsWithMembers } from '@/lib/veo/client'
import { writeCachedClubData, setSyncStatus } from '@/lib/veo/cache'

const SYNC_API_KEY = process.env.SYNC_API_KEY

type RouteContext = { params: Promise<{ clubSlug: string }> }

async function isAuthorized(request: NextRequest): Promise<boolean> {
  // Check API key first (Lambda calls)
  const apiKey = request.headers.get('x-api-key')
  if (apiKey && apiKey === SYNC_API_KEY && !!SYNC_API_KEY) {
    return true
  }

  // Check platform admin session (manual Sync Now)
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (user) {
    return isPlatformAdmin(user.id)
  }

  return false
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { clubSlug } = await params
  const club = getClubBySlug(clubSlug)
  if (!club) {
    return NextResponse.json({ error: 'Club not found' }, { status: 404 })
  }

  if (!club.veoClubSlug) {
    return NextResponse.json(
      { error: 'No Veo club configured for this academy' },
      { status: 404 }
    )
  }

  const startTime = Date.now()

  try {
    // Mark as syncing
    await setSyncStatus(clubSlug, club.veoClubSlug, 'syncing')

    // Fetch fresh data from Veo via Playwright
    const veoResult = await listClubTeamsWithMembers(club.veoClubSlug)

    if (!veoResult.success || !veoResult.data) {
      await setSyncStatus(
        clubSlug,
        club.veoClubSlug,
        'error',
        veoResult.message || 'Failed to fetch Veo data'
      )
      return NextResponse.json(
        { error: 'Failed to fetch Veo data', message: veoResult.message },
        { status: 500 }
      )
    }

    // Write to cache
    await writeCachedClubData(clubSlug, club.veoClubSlug, veoResult.data)

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    const teamCount = veoResult.data.teams.length
    const memberCount = veoResult.data.teams.reduce(
      (sum, t) => sum + t.members.length,
      0
    )

    return NextResponse.json({
      success: true,
      clubSlug,
      stats: { teams: teamCount, members: memberCount },
      elapsed: `${elapsed}s`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sync failed'
    console.error(`Cache sync error (${clubSlug}):`, error)

    await setSyncStatus(clubSlug, club.veoClubSlug, 'error', message)

    return NextResponse.json({ error: message }, { status: 500 })
  }
}
