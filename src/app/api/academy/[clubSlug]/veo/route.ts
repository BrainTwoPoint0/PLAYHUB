// GET /api/academy/[clubSlug]/veo
// Returns Veo ClubHouse teams + members cross-referenced with Stripe subscribers

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { getClubBySlug, getAllProductIds } from '@/lib/academy/config'
import { getCachedClubData } from '@/lib/veo/cache'
import {
  getAcademySubscribers,
  getSubscribersByProduct,
  clearCache,
} from '@/lib/academy/stripe'

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

  // Two-tier auth: platform admin (full) or org admin (read-only)
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

  // Clear Stripe cache if requested (e.g. after editing customer emails)
  const { searchParams } = new URL(request.url)
  if (searchParams.get('refresh') === '1') {
    clearCache()
  }

  try {
    // Read Veo data from cache + fetch live Stripe subscribers in parallel
    const productIds = getAllProductIds(club)
    const additionalIds = productIds.slice(1) // skip primary (fetched via clubSlug)

    let cachedData,
      primarySubs: Awaited<ReturnType<typeof getAcademySubscribers>>,
      additionalSubs: Awaited<ReturnType<typeof getSubscribersByProduct>>[]
    try {
      cachedData = await getCachedClubData(clubSlug)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`getCachedClubData failed (${clubSlug}):`, msg)
      return NextResponse.json(
        {
          error: 'Failed to fetch Veo data',
          detail: `Supabase cache read failed: ${msg}`,
        },
        { status: 500 }
      )
    }

    try {
      primarySubs = await getAcademySubscribers(clubSlug)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`getAcademySubscribers failed (${clubSlug}):`, msg)
      return NextResponse.json(
        {
          error: 'Failed to fetch Veo data',
          detail: `Stripe subscribers failed: ${msg}`,
        },
        { status: 500 }
      )
    }

    try {
      additionalSubs = await Promise.all(
        additionalIds.map((pid) => getSubscribersByProduct(pid))
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`getSubscribersByProduct failed (${clubSlug}):`, msg)
      return NextResponse.json(
        {
          error: 'Failed to fetch Veo data',
          detail: `Stripe additional products failed: ${msg}`,
        },
        { status: 500 }
      )
    }

    // Merge all subscribers, dedup by email (keep first/best match)
    const subscribers = [...primarySubs, ...additionalSubs.flat()]

    if (!cachedData) {
      return NextResponse.json(
        {
          error: 'No cached data. Click "Sync Now" to populate.',
          needsSync: true,
        },
        { status: 404 }
      )
    }

    // Build email → subscriber lookup (lowercase), prefer active status on duplicates
    const statusPriority: Record<string, number> = {
      active: 0,
      trialing: 1,
      past_due: 2,
      canceled: 3,
    }
    const subsByEmail = new Map<
      string,
      {
        status: string
        isScholarship: boolean
        registrationTeam: string | null
      }
    >()
    for (const sub of subscribers) {
      if (sub.customerEmail) {
        const email = sub.customerEmail.toLowerCase()
        const existing = subsByEmail.get(email)
        // Keep the better status (active > trialing > past_due > canceled)
        if (
          !existing ||
          (statusPriority[sub.status] ?? 9) <
            (statusPriority[existing.status] ?? 9)
        ) {
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

    // Inverse lookup: Stripe subscribers whose email is NOT in any Veo team
    const veoEmails = new Set<string>()
    for (const team of cachedData.teams) {
      for (const m of team.members) {
        if (m.email) veoEmails.add(m.email.toLowerCase())
      }
    }

    const stripeOnlySubscribers: {
      email: string
      name: string | null
      status: string
      isScholarship: boolean
      registrationTeam: string | null
    }[] = []

    // Deduplicate subscribers by email, keeping best status (same logic as subsByEmail)
    const seenStripeOnly = new Map<
      string,
      {
        name: string | null
        status: string
        isScholarship: boolean
        registrationTeam: string | null
      }
    >()
    for (const sub of subscribers) {
      if (!sub.customerEmail) continue
      const email = sub.customerEmail.toLowerCase()
      // Skip if this email exists in Veo
      if (veoEmails.has(email)) continue
      // Skip canceled — they don't need Veo access
      if (sub.status === 'canceled') continue

      const existing = seenStripeOnly.get(email)
      if (
        !existing ||
        (statusPriority[sub.status] ?? 9) <
          (statusPriority[existing.status] ?? 9)
      ) {
        seenStripeOnly.set(email, {
          name: sub.customerName ?? null,
          status: sub.status,
          isScholarship: sub.isScholarship,
          registrationTeam: sub.registrationTeam,
        })
      }
    }

    for (const [email, info] of seenStripeOnly) {
      stripeOnlySubscribers.push({ email, ...info })
    }

    // Fetch exempt emails so both platform_admin and org_admin can see correct status
    let exemptEmails: string[] = []
    try {
      const serviceClient = createServiceClient() as any
      const { data: exceptions } = await serviceClient
        .from('playhub_veo_exceptions')
        .select('email')
        .eq('club_slug', clubSlug)
      if (exceptions) {
        exemptEmails = exceptions.map((e: { email: string }) => e.email.toLowerCase())
      }
    } catch {
      // Non-critical — exemptions just won't show
    }

    return NextResponse.json({
      clubName: club.name,
      veoClubSlug: club.veoClubSlug,
      hasScholarships: club.hasScholarships ?? false,
      role,
      teams,
      stripeOnlySubscribers,
      exemptEmails,
      lastSyncedAt: cachedData.lastSyncedAt,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack : undefined
    console.error(`Academy Veo API error (${clubSlug}):`, message, stack)
    return NextResponse.json(
      { error: 'Failed to fetch Veo data', detail: message },
      { status: 500 }
    )
  }
}
