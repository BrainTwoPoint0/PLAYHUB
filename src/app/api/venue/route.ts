// GET /api/venue - List venues (organizations) the user can manage

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { isPlatformAdmin } from '@/lib/admin/auth'

export async function GET() {
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Use service client to bypass RLS for reading
  const serviceClient = createServiceClient()

  // Get user's profile with email
  const { data: profile } = await serviceClient
    .from('profiles')
    .select('id, email')
    .eq('user_id', user.id)
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }

  // Platform admins see all organizations
  const isAdmin = await isPlatformAdmin(user.id)
  if (isAdmin) {
    const { data: allOrgs } = await (serviceClient as any)
      .from('organizations')
      .select(
        'id, name, slug, logo_url, type, feature_recordings, feature_streaming, feature_graphic_packages'
      )
      .eq('type', 'venue')
      .eq('is_active', true)
      .order('name', { ascending: true })

    return NextResponse.json({ venues: allOrgs || [] })
  }

  // Pending admin invites are processed by the handle_new_user DB trigger on signup

  // Get organizations where user is admin
  const { data: memberships, error } = await serviceClient
    .from('organization_members')
    .select(
      `
      organization_id,
      role,
      organizations:organization_id (
        id,
        name,
        slug,
        logo_url,
        type,
        feature_recordings,
        feature_streaming,
        feature_graphic_packages
      )
    `
    )
    .eq('profile_id', profile.id)
    .in('role', ['admin', 'manager', 'club_admin', 'league_admin'])
    .eq('is_active', true)

  if (error) {
    console.error('Failed to fetch venues:', error)
    return NextResponse.json(
      { error: 'Failed to fetch venues' },
      { status: 500 }
    )
  }

  const directOrgs = (memberships || [])
    .map((m: any) => m.organizations)
    .filter(Boolean) as any[]

  // For group-type orgs, also include their child venues
  const groupOrgIds = directOrgs
    .filter((o: any) => o.type === 'group')
    .map((o: any) => o.id)

  let childVenues: any[] = []
  if (groupOrgIds.length > 0) {
    const { data: children } = await (serviceClient as any)
      .from('organizations')
      .select(
        'id, name, slug, logo_url, type, feature_recordings, feature_streaming, feature_graphic_packages'
      )
      .in('parent_organization_id', groupOrgIds)
      .eq('is_active', true)

    childVenues = children || []
  }

  // Merge direct orgs + child venues, deduplicate by id
  const seen = new Set<string>()
  const venues: any[] = []
  for (const org of [...directOrgs, ...childVenues]) {
    if (!seen.has(org.id)) {
      seen.add(org.id)
      venues.push(org)
    }
  }

  return NextResponse.json({ venues })
}
