// GET /api/academy/[clubSlug]/veo
// Returns Veo ClubHouse teams + members cross-referenced with Stripe subscribers

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { getClubBySlug, getAllProductIds } from '@/lib/academy/config'
import { getCachedClubData } from '@/lib/veo/cache'
import {
  getAcademySubscribers,
  getSubscribersByProduct,
  buildRegistrationTeamMap,
  clearCache,
} from '@/lib/academy/stripe'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ clubSlug: string }> }
) {
  const { user } = await getAuthUser()

  if (!user) {
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
    // Fan everything out in parallel: Veo Supabase cache + primary Stripe
    // subscribers + per-extra-product Stripe subscribers all run together.
    // Was previously sequential (~3 roundtrips back-to-back). On a cold
    // load this halves end-to-end latency for clubs with extra products
    // (SEFA: Maidstone, H&B). Per-fetch error details preserved via
    // Promise.allSettled + selective surface.
    const productIds = getAllProductIds(club)
    const additionalIds = productIds.slice(1) // skip primary (fetched via clubSlug)

    const [cachedRes, primaryRes, additionalRes, dbTeamRes] =
      await Promise.allSettled([
        getCachedClubData(clubSlug),
        getAcademySubscribers(clubSlug),
        Promise.all(additionalIds.map((pid) => getSubscribersByProduct(pid))),
        // Registration teams for unified-checkout clubs (LYL): they pass the
        // team via Stripe metadata, invisible to the subscriber path above,
        // but the webhook persists it to playhub_academy_subscriptions. Read
        // it back here so the team shows for those subscribers. Keyed by
        // stripe_subscription_id (not email — see buildRegistrationTeamMap).
        // Runs in the fan-out (not sequentially after it) so it's off the
        // warm-Stripe-cache critical path. NON-CRITICAL: deliberately kept out
        // of the 500 ladder below — on failure we fall back to the Stripe-
        // derived team.
        (async () => {
          const serviceClient = createServiceClient() as any
          const { data: dbSubs } = await serviceClient
            .from('playhub_academy_subscriptions')
            .select(
              'stripe_subscription_id, registration_team, registration_subclub'
            )
            .eq('club_slug', clubSlug)
          return buildRegistrationTeamMap(dbSubs ?? [])
        })(),
      ])

    // Log every rejection up front — when multiple legs fail, the first-
    // rejection-wins branch ladder below would otherwise swallow the others
    // and leave them invisible in CloudWatch. Logging here preserves the
    // full picture for debugging without changing the error envelope.
    for (const [label, res] of [
      ['getCachedClubData', cachedRes],
      ['getAcademySubscribers', primaryRes],
      ['getSubscribersByProduct', additionalRes],
      ['registrationTeams', dbTeamRes],
    ] as const) {
      if (res.status === 'rejected') {
        const msg =
          res.reason instanceof Error ? res.reason.message : String(res.reason)
        console.error(`[academy-veo] ${label} rejected (${clubSlug}):`, msg)
      }
    }

    // Branch precedence: cache → primary → additional. Cached data is the
    // upstream dependency, primary subs gate the response shape, additional
    // are augmentation. Surfacing them in that order keeps the 500 detail
    // pointed at the root cause rather than a downstream symptom.
    if (cachedRes.status === 'rejected') {
      const msg =
        cachedRes.reason instanceof Error
          ? cachedRes.reason.message
          : String(cachedRes.reason)
      return NextResponse.json(
        {
          error: 'Failed to fetch Veo data',
          detail: `Supabase cache read failed: ${msg}`,
        },
        { status: 500 }
      )
    }
    if (primaryRes.status === 'rejected') {
      const msg =
        primaryRes.reason instanceof Error
          ? primaryRes.reason.message
          : String(primaryRes.reason)
      return NextResponse.json(
        {
          error: 'Failed to fetch Veo data',
          detail: `Stripe subscribers failed: ${msg}`,
        },
        { status: 500 }
      )
    }
    if (additionalRes.status === 'rejected') {
      const msg =
        additionalRes.reason instanceof Error
          ? additionalRes.reason.message
          : String(additionalRes.reason)
      return NextResponse.json(
        {
          error: 'Failed to fetch Veo data',
          detail: `Stripe additional products failed: ${msg}`,
        },
        { status: 500 }
      )
    }

    const cachedData = cachedRes.value
    const primarySubs = primaryRes.value
    const additionalSubs = additionalRes.value

    // Merge all subscribers, dedup by email (keep first/best match)
    const subscribers = [...primarySubs, ...additionalSubs.flat()]

    // Non-critical leg (see fan-out above): fall back to the Stripe-derived
    // team on failure. Rejection is already logged in the loop above.
    const dbTeamBySubId =
      dbTeamRes.status === 'fulfilled'
        ? dbTeamRes.value
        : new Map<string, string>()

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
            registrationTeam:
              dbTeamBySubId.get(sub.subscriptionId) ?? sub.registrationTeam,
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
          registrationTeam:
            dbTeamBySubId.get(sub.subscriptionId) ?? sub.registrationTeam,
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
        exemptEmails = exceptions.map((e: { email: string }) =>
          e.email.toLowerCase()
        )
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
