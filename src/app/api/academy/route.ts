// GET /api/academy - List clubs the current user can access

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { getAllClubs, type AcademyClub } from '@/lib/academy/config'

export async function GET() {
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const isAdmin = await isPlatformAdmin(user.id)

  if (isAdmin) {
    // Platform admins see all clubs
    return NextResponse.json({
      clubs: await getAllClubs(),
      role: 'platform_admin',
    })
  }

  // Check which clubs this user is an admin for (via organization_members)
  const serviceClient = createServiceClient() as any

  // Look up profile first — organization_members uses profile_id, not user_id
  const { data: profile } = await serviceClient
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .single()

  if (!profile) {
    return NextResponse.json(
      { error: 'You do not have access to any academy clubs' },
      { status: 403 }
    )
  }

  const { data: memberships } = await serviceClient
    .from('organization_members')
    .select('organization_id')
    .eq('profile_id', profile.id)
    .in('role', ['admin', 'manager', 'club_admin', 'league_admin'])
    .eq('is_active', true)

  const orgIds = new Set((memberships || []).map((m: any) => m.organization_id))

  const allClubs = await getAllClubs()
  const accessibleClubs = allClubs.filter(
    (club) => club.organizationId && orgIds.has(club.organizationId)
  )

  if (accessibleClubs.length === 0) {
    return NextResponse.json(
      { error: 'You do not have access to any academy clubs' },
      { status: 403 }
    )
  }

  return NextResponse.json({ clubs: accessibleClubs, role: 'org_admin' })
}
