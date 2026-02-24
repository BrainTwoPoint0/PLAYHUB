// GET /api/academy/[clubSlug]/veo
// Returns Veo ClubHouse teams + members cross-referenced with Stripe subscribers

import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { getClubBySlug, getAllProductIds } from '@/lib/academy/config'
import { getCachedClubData } from '@/lib/veo/cache'
import { getAcademySubscribers, getSubscribersByProduct, clearCache } from '@/lib/academy/stripe'

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

  // Platform admin only (Veo access is sensitive)
  const isAdmin = await isPlatformAdmin(user.id)
  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
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

  // Clear Stripe cache if requested (e.g. after editing customer emails)
  const { searchParams } = new URL(request.url)
  if (searchParams.get('refresh') === '1') {
    clearCache()
  }

  try {
    // Read Veo data from cache + fetch live Stripe subscribers in parallel
    const productIds = getAllProductIds(club)
    const additionalIds = productIds.slice(1) // skip primary (fetched via clubSlug)

    const [cachedData, primarySubs, ...additionalSubs] = await Promise.all([
      getCachedClubData(clubSlug),
      getAcademySubscribers(clubSlug),
      ...additionalIds.map((pid) => getSubscribersByProduct(pid)),
    ])

    // Merge all subscribers, dedup by email (keep first/best match)
    const subscribers = [...primarySubs, ...additionalSubs.flat()]

    if (!cachedData) {
      return NextResponse.json(
        { error: 'No cached data. Click "Sync Now" to populate.', needsSync: true },
        { status: 404 }
      )
    }

    // Build email → subscriber lookup (lowercase), prefer active status on duplicates
    const statusPriority: Record<string, number> = {
      active: 0, trialing: 1, past_due: 2, canceled: 3,
    }
    const subsByEmail = new Map<
      string,
      { status: string; isScholarship: boolean; registrationTeam: string | null }
    >()
    for (const sub of subscribers) {
      if (sub.customerEmail) {
        const email = sub.customerEmail.toLowerCase()
        const existing = subsByEmail.get(email)
        // Keep the better status (active > trialing > past_due > canceled)
        if (!existing || (statusPriority[sub.status] ?? 9) < (statusPriority[existing.status] ?? 9)) {
          subsByEmail.set(email, {
            status: sub.status,
            isScholarship: sub.isScholarship,
            registrationTeam: sub.registrationTeam,
          })
        }
      }
    }

    // Roles that require a Stripe subscription (players/viewers)
    const playerRoles = new Set(['viewer'])

    // Enrich Veo members with Stripe data
    const teams = cachedData.teams.map((team) => {
      const enrichedMembers = team.members.map((m) => {
        const stripeSub = m.email
          ? subsByEmail.get(m.email.toLowerCase())
          : undefined
        const isPlayer = playerRoles.has(m.permission_role)
        return {
          id: m.id,
          email: m.email,
          name: m.name,
          veoRole: m.permission_role,
          isPlayer,
          stripeStatus: stripeSub?.status || null,
          isScholarship: stripeSub?.isScholarship || false,
          registrationTeam: stripeSub?.registrationTeam || null,
          hasSubscription: !!stripeSub,
        }
      })

      return {
        slug: team.slug,
        name: team.name,
        memberCount: team.member_count,
        members: enrichedMembers,
      }
    })

    return NextResponse.json({
      clubName: club.name,
      veoClubSlug: club.veoClubSlug,
      teams,
      lastSyncedAt: cachedData.lastSyncedAt,
    })
  } catch (error) {
    console.error(`Academy Veo API error (${clubSlug}):`, error)
    return NextResponse.json(
      { error: 'Failed to fetch Veo data' },
      { status: 500 }
    )
  }
}
