// GET /api/academy/[clubSlug]/content
// Returns Veo recordings list for the club (from Supabase cache)

import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { getClubBySlug } from '@/lib/academy/config'
import { getCachedRecordings } from '@/lib/veo/cache'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ clubSlug: string }> }
) {
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { clubSlug } = await params
  const club = await getClubBySlug(clubSlug)
  if (!club) {
    return NextResponse.json({ error: 'Club not found' }, { status: 404 })
  }

  // Two-tier auth: platform admin or org admin
  let role: 'platform_admin' | 'org_admin' | null = null
  if (await isPlatformAdmin(user.id)) {
    role = 'platform_admin'
  } else if (
    club.organizationId &&
    (await isVenueAdmin(user.id, club.organizationId))
  ) {
    role = 'org_admin'
  }
  if (!role) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (!club.veoClubSlug) {
    return NextResponse.json(
      { error: 'No Veo club configured for this academy' },
      { status: 404 }
    )
  }

  try {
    const cached = await getCachedRecordings(clubSlug)

    if (!cached) {
      return NextResponse.json(
        { error: 'No cached recordings. Wait for the next sync cycle.' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      clubName: club.name,
      recordings: cached.recordings,
      lastSyncedAt: cached.lastSyncedAt,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Content API error (${clubSlug}):`, message)
    return NextResponse.json(
      { error: 'Failed to fetch recordings' },
      { status: 500 }
    )
  }
}
