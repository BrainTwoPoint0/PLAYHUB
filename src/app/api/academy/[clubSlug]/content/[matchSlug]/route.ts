// GET /api/academy/[clubSlug]/content/[matchSlug]
// Returns full match content (videos, highlights, stats) via direct HTTP

import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { getClubBySlug } from '@/lib/academy/config'
import { getMatchContentDirect } from '@/lib/veo/direct-client'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ clubSlug: string; matchSlug: string }> }
) {
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { clubSlug, matchSlug } = await params
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

  try {
    const content = await getMatchContentDirect(matchSlug)
    return NextResponse.json(content)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Match content API error (${matchSlug}):`, message)
    return NextResponse.json(
      { error: 'Failed to fetch match content' },
      { status: 500 }
    )
  }
}
