// GET /api/venue/[venueId]
// Returns a single venue's metadata + the count of venues the user has
// access to (used by the page to decide whether to show the "Switch
// Venue" affordance).
//
// Replaces the previous pattern of fetching ALL venues from /api/venue
// just to find one — that's an N-row payload and 4-5 queries when we only
// need 2-3 queries and ~1KB of data.

import { NextResponse } from 'next/server'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ venueId: string }> }
) {
  const { venueId } = await params
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const serviceClient = createServiceClient() as any

  // Single column projection — we don't need the full row, the page only
  // reads name/slug/logo/type/feature_* flags.
  const { data: venue, error: venueErr } = await serviceClient
    .from('organizations')
    .select(
      'id, name, slug, logo_url, type, feature_recordings, feature_streaming, feature_graphic_packages, parent_organization_id, is_active'
    )
    .eq('id', venueId)
    .maybeSingle()

  if (venueErr) {
    console.error('venue fetch failed', venueErr.message)
    return NextResponse.json(
      { error: 'Failed to fetch venue' },
      { status: 500 }
    )
  }
  if (!venue || venue.is_active === false) {
    return NextResponse.json({ error: 'Venue not found' }, { status: 404 })
  }

  // Authorization: platform admin sees everything. Otherwise the user
  // must be an admin/manager of THIS venue OR of its parent group.
  let authorized = await isPlatformAdmin(user.id)
  if (!authorized) {
    const { data: profile } = await serviceClient
      .from('profiles')
      .select('id')
      .eq('user_id', user.id)
      .single()
    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
    }

    // Check direct membership on the venue, OR membership on its parent
    // group org if it has one. Single OR'd query.
    const orgIdsToCheck = [venue.id]
    if (venue.parent_organization_id) {
      orgIdsToCheck.push(venue.parent_organization_id)
    }
    const { data: membership } = await serviceClient
      .from('organization_members')
      .select('organization_id')
      .eq('profile_id', profile.id)
      .in('organization_id', orgIdsToCheck)
      .in('role', ['admin', 'manager', 'club_admin', 'league_admin'])
      .eq('is_active', true)
      .limit(1)
      .maybeSingle()
    authorized = !!membership
  }

  if (!authorized) {
    return NextResponse.json(
      { error: 'You do not have access to this venue' },
      { status: 403 }
    )
  }

  // Venue count for the "Switch Venue" affordance — head-only count
  // query on memberships, no full row payload.
  let venueCount = 1
  if (await isPlatformAdmin(user.id)) {
    const { count } = await serviceClient
      .from('organizations')
      .select('id', { count: 'exact', head: true })
      .eq('type', 'venue')
      .eq('is_active', true)
    venueCount = count ?? 1
  } else {
    const { data: profile } = await serviceClient
      .from('profiles')
      .select('id')
      .eq('user_id', user.id)
      .single()
    if (profile) {
      const { count } = await serviceClient
        .from('organization_members')
        .select('organization_id', { count: 'exact', head: true })
        .eq('profile_id', profile.id)
        .in('role', ['admin', 'manager', 'club_admin', 'league_admin'])
        .eq('is_active', true)
      venueCount = count ?? 1
    }
  }

  // Strip the auth-helper field before returning.
  const { is_active: _, ...venueResponse } = venue
  return NextResponse.json(
    { venue: venueResponse, venueCount },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
