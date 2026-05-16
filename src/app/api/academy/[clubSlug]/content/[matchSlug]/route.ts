// GET /api/academy/[clubSlug]/content/[matchSlug]
// Returns full match content (videos, highlights, stats)
// Cache-first: reads from Supabase cache, falls back to live Veo API if tokens available

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { getClubBySlug } from '@/lib/academy/config'
import { getCachedMatchContent, writeCachedMatchContent } from '@/lib/veo/cache'
import { getMatchContentDirect } from '@/lib/veo/direct-client'

interface VeoEvent {
  id: string
  event_type: string
  timestamp_seconds: number
  team: string | null
  confidence_score: number | null
}

interface VeoEventsByType {
  goals: VeoEvent[]
}

/**
 * Confirm matchSlug actually belongs to clubSlug (IDOR guard). Without this,
 * an org_admin of Club A could pass any matchSlug from Club B and read its
 * events, since the role check above only verifies admin-of-this-clubSlug,
 * not match-belongs-to-this-club. Uses service-role to query the cache; the
 * lookup itself leaks no information (404 returned regardless of why).
 */
async function matchBelongsToClub(
  matchSlug: string,
  clubSlug: string
): Promise<boolean> {
  const supabase = createServiceClient()
  // Table not in generated types yet — cast to bypass strict typing.
  const { data } = await (supabase as any)
    .from('playhub_veo_recordings_cache')
    .select('match_slug')
    .eq('match_slug', matchSlug)
    .eq('club_slug', clubSlug)
    .maybeSingle()
  return !!data
}

/**
 * Fetch goal events for a Veo match from playhub_recording_events. Uses the
 * service-role client because RLS blocks user-side reads of ai_detected events
 * (visibility='private', created_by=null). The admin + match-ownership checks
 * upstream guard this escape hatch.
 */
async function fetchVeoEvents(matchSlug: string): Promise<VeoEventsByType> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('playhub_recording_events')
    .select('id, event_type, timestamp_seconds, team, confidence_score')
    .eq('provider', 'veo')
    .eq('provider_recording_id', matchSlug)
    .eq('source', 'ai_detected')
    .eq('event_type', 'goal')
    .order('timestamp_seconds', { ascending: true })
  if (error) {
    console.warn(
      `Events fetch failed for ${matchSlug} (non-fatal):`,
      error.message
    )
    return { goals: [] }
  }
  return { goals: (data as VeoEvent[] | null) ?? [] }
}

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

  // IDOR guard: an org_admin of Club A must not be able to pass Club B's
  // matchSlug. Platform admins skip this — they're authorized cross-org.
  if (role === 'org_admin') {
    const ok = await matchBelongsToClub(matchSlug, clubSlug)
    if (!ok) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
  }

  try {
    // Try cache first
    const cached = await getCachedMatchContent(matchSlug)
    if (cached) {
      const events = await fetchVeoEvents(matchSlug)
      return NextResponse.json({
        videos: cached.videos,
        highlights: cached.highlights,
        stats: cached.stats,
        events,
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

      const events = await fetchVeoEvents(matchSlug)
      return NextResponse.json({
        videos: content.videos,
        highlights: content.highlights,
        stats: content.stats,
        events,
        fromCache: false,
        lastFetchedAt: null,
      })
    } catch (liveError) {
      const msg =
        liveError instanceof Error ? liveError.message : String(liveError)
      // If tokens expired, tell the user to wait for next sync
      if (msg.includes('expired') || msg.includes('No valid Veo auth tokens')) {
        return NextResponse.json(
          {
            error:
              'Match content is being processed and will be available shortly.',
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
