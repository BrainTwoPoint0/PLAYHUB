// GET /api/org — List organizations the user can manage (non-venue types)

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { isPlatformAdmin } from '@/lib/admin/auth'

export async function GET() {
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const serviceClient = createServiceClient() as any

  // Platform admins see all non-venue orgs
  const isAdmin = await isPlatformAdmin(user.id)
  if (isAdmin) {
    const { data: allOrgs } = await serviceClient
      .from('organizations')
      .select('id, name, slug, type, logo_url')
      .neq('type', 'venue')
      .eq('is_active', true)
      .order('name', { ascending: true })

    return NextResponse.json({ organizations: allOrgs || [] })
  }

  // Get user's profile
  const { data: profile } = await serviceClient
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .single()

  if (!profile) {
    return NextResponse.json({ organizations: [] })
  }

  // Get orgs where user is admin, excluding venue type
  const { data: memberships } = await serviceClient
    .from('organization_members')
    .select(
      `
      organizations:organization_id (
        id,
        name,
        slug,
        type,
        logo_url
      )
    `
    )
    .eq('profile_id', profile.id)
    .in('role', ['admin', 'club_admin', 'league_admin'])
    .eq('is_active', true)

  const orgs = (memberships || [])
    .map((m: any) => m.organizations)
    .filter((o: any) => o && o.type !== 'venue')

  return NextResponse.json({ organizations: orgs })
}
