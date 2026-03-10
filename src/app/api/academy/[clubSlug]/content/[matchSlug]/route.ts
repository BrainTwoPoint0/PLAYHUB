// GET /api/academy/[clubSlug]/content/[matchSlug]
// Returns full match content (videos, highlights, stats)
// Cache-first: reads from Supabase cache, falls back to live Veo API if tokens available

import { getAuthUser } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { getClubBySlug } from '@/lib/academy/config'
import { getCachedMatchContent, writeCachedMatchContent } from '@/lib/veo/cache'
import { getMatchContentDirect } from '@/lib/veo/direct-client'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ clubSlug: string; matchSlug: string }> }
) {
  const { user } = await getAuthUser()

  if (!user) {
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
    // Try cache first
    const cached = await getCachedMatchContent(matchSlug)
    if (cached) {
      return NextResponse.json({
        videos: cached.videos,
        highlights: cached.highlights,
        stats: cached.stats,
        fromCache: true,
        lastFetchedAt: cached.lastFetchedAt,
      })
    }

    // Cache miss — try live Veo API (only works if tokens are valid)
    try {
      const content = await getMatchContentDirect(matchSlug)

      // Cache the result for next time
      await writeCachedMatchContent(matchSlug, content).catch((e) =>
        console.warn(`Failed to cache match content (${matchSlug}):`, e)
      )

      return NextResponse.json({
        ...content,
        fromCache: false,
      })
    } catch (liveError) {
      const msg =
        liveError instanceof Error ? liveError.message : String(liveError)
      // If tokens expired, tell the user to wait for next sync
      if (msg.includes('expired') || msg.includes('No valid Veo auth tokens')) {
        return NextResponse.json(
          {
            error:
              'Match content not yet cached. It will be available after the next sync.',
          },
          { status: 503 }
        )
      }
      throw liveError
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Match content API error (${matchSlug}):`, message)
    return NextResponse.json(
      { error: 'Failed to fetch match content' },
      { status: 500 }
    )
  }
}
