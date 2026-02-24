// POST /api/academy/[clubSlug]/veo/sync
// Automated Veo Clubhouse cleanup — removes canceled subscribers
// Auth: x-api-key header (same SYNC_API_KEY as /api/veo/remove)

import { NextRequest, NextResponse } from 'next/server'
import { getClubBySlug, getAllProductIds } from '@/lib/academy/config'
import { listClubTeamsWithMembers, removeMember } from '@/lib/veo/client'
import {
  getAcademySubscribers,
  getSubscribersByProduct,
} from '@/lib/academy/stripe'
import { createServiceClient } from '@/lib/supabase/server'
import { findRemovableMembers } from '@/lib/veo/sync'

const SYNC_API_KEY = process.env.SYNC_API_KEY

type RouteContext = { params: Promise<{ clubSlug: string }> }

function verifyApiKey(request: Request): boolean {
  const apiKey = request.headers.get('x-api-key')
  return apiKey === SYNC_API_KEY && !!SYNC_API_KEY
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!verifyApiKey(request)) {
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

  const body = await request.json().catch(() => ({}))
  const mode: 'dry-run' | 'execute' = body.mode === 'execute' ? 'execute' : 'dry-run'

  try {
    // 1. Fetch Veo teams+members
    const veoResult = await listClubTeamsWithMembers(club.veoClubSlug)
    if (!veoResult.success || !veoResult.data) {
      return NextResponse.json(
        { error: 'Failed to fetch Veo data' },
        { status: 500 }
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

    const exceptionEmails = new Set(
      (exceptionsData || []).map((e: { email: string }) => e.email.toLowerCase())
    )

    // 4. Find removable members
    const { removable, excepted, stats } = findRemovableMembers(
      veoResult.data.teams,
      subscribers,
      exceptionEmails
    )

    // 5. Dry-run: just report
    if (mode === 'dry-run') {
      return NextResponse.json({
        mode: 'dry-run',
        clubSlug,
        removable,
        excepted,
        stats,
      })
    }

    // 6. Execute: remove each member from Veo
    const results: {
      email: string
      teamSlug: string
      success: boolean
      message: string
    }[] = []

    for (const target of removable) {
      const result = await removeMember(
        club.veoClubSlug!,
        target.teamSlug,
        target.email
      )
      results.push({
        email: target.email,
        teamSlug: target.teamSlug,
        success: result.success,
        message: result.message,
      })
    }

    return NextResponse.json({
      mode: 'execute',
      clubSlug,
      results,
      excepted,
      stats: {
        ...stats,
        attempted: results.length,
        succeeded: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
      },
    })
  } catch (error) {
    console.error(`Veo sync error (${clubSlug}):`, error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Sync failed' },
      { status: 500 }
    )
  }
}
