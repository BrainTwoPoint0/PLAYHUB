// GET /api/nav — Returns all navbar permissions in a single call

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { isPlatformAdmin } from '@/lib/admin/auth'

export async function GET() {
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json({
      hasVenues: false,
      hasAcademy: false,
      isAdmin: false,
      managedOrgs: [],
    })
  }

  const serviceClient = createServiceClient() as any

  // Get profile + platform admin check in parallel
  const [{ data: profile }, isAdmin] = await Promise.all([
    serviceClient.from('profiles').select('id').eq('user_id', user.id).single(),
    isPlatformAdmin(user.id),
  ])

  if (!profile) {
    return NextResponse.json({
      hasVenues: false,
      hasAcademy: false,
      isAdmin,
      managedOrgs: [],
    })
  }

  // Platform admins: we know they have access to everything
  if (isAdmin) {
    const { data: orgs } = await serviceClient
      .from('organizations')
      .select('slug, name, type')
      .neq('type', 'venue')
      .eq('is_active', true)
      .order('name', { ascending: true })

    return NextResponse.json({
      hasVenues: true,
      hasAcademy: true,
      isAdmin: true,
      managedOrgs: orgs || [],
    })
  }

  // Regular users: get all memberships in one query
  const { data: memberships } = await serviceClient
    .from('organization_members')
    .select(
      `
      organization_id,
      role,
      organizations:organization_id (
        id, name, slug, type
      )
    `
    )
    .eq('profile_id', profile.id)
    .in('role', ['admin', 'manager', 'club_admin', 'league_admin'])
    .eq('is_active', true)

  const orgs = (memberships || [])
    .map((m: any) => m.organizations)
    .filter(Boolean) as any[]

  const hasVenues = orgs.some(
    (o: any) => o.type === 'venue' || o.type === 'group'
  )
  const hasAcademy = orgs.some((o: any) => o.type === 'academy')
  const managedOrgs = orgs
    .filter((o: any) => o.type !== 'venue')
    .map((o: any) => ({ slug: o.slug, name: o.name, type: o.type }))

  return NextResponse.json({
    hasVenues,
    hasAcademy,
    isAdmin: false,
    managedOrgs,
  })
}
