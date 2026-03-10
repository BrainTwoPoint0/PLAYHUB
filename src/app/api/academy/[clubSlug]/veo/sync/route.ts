// POST /api/academy/[clubSlug]/veo/sync
// Returns list of canceled subscribers that should be removed from Veo ClubHouse.
// The Lambda handles actual removal via Playwright (Lambda has the chromium layer).
// Auth: x-api-key header (same SYNC_API_KEY as /api/veo/remove)

import { NextRequest, NextResponse } from 'next/server'
import { getClubBySlug, getAllProductIds } from '@/lib/academy/config'
import {
  getAcademySubscribers,
  getSubscribersByProduct,
} from '@/lib/academy/stripe'
import { createServiceClient } from '@/lib/supabase/server'
import { findRemovableMembers } from '@/lib/veo/sync'
import { getCachedClubData } from '@/lib/veo/cache'
import { verifyApiKey } from '@braintwopoint0/playback-commons/security'

const SYNC_API_KEY = process.env.SYNC_API_KEY || ''

type RouteContext = { params: Promise<{ clubSlug: string }> }

export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!verifyApiKey(request, SYNC_API_KEY)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { clubSlug } = await params
  const club = await getClubBySlug(clubSlug)
  if (!club) {
    return NextResponse.json({ error: 'Club not found' }, { status: 404 })
  }

  if (!club.veoClubSlug) {
    return NextResponse.json(
      { error: 'No Veo club configured for this academy' },
      { status: 404 }
    )
  }

  try {
    // 1. Get Veo teams+members from cache (updated every 4hrs by cache-sync Lambda)
    const cachedData = await getCachedClubData(clubSlug)
    if (!cachedData || cachedData.teams.length === 0) {
      return NextResponse.json(
        { error: 'No cached Veo data. Run cache-sync first.' },
        { status: 404 }
      )
    }

    // 2. Fetch all Stripe subscribers
    const productIds = getAllProductIds(club)
    const additionalIds = productIds.slice(1)
    const [primarySubs, ...additionalSubs] = await Promise.all([
      getAcademySubscribers(clubSlug),
      ...additionalIds.map((pid) => getSubscribersByProduct(pid)),
    ])
    const subscribers = [...primarySubs, ...additionalSubs.flat()]

    // 3. Fetch exceptions
    const supabase = createServiceClient() as any
    const { data: exceptionsData } = await supabase
      .from('playhub_veo_exceptions')
      .select('email')
      .eq('club_slug', clubSlug)

    const exceptionEmails = new Set<string>(
      (exceptionsData || []).map((e: { email: string }) =>
        e.email.toLowerCase()
      )
    )

    // 4. Find removable members
    const { removable, excepted, stats } = findRemovableMembers(
      cachedData.teams,
      subscribers,
      exceptionEmails
    )

    return NextResponse.json({
      mode: 'dry-run',
      clubSlug,
      removable,
      excepted,
      stats,
    })
  } catch (error) {
    console.error(`Veo sync error (${clubSlug}):`, error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Sync failed' },
      { status: 500 }
    )
  }
}
