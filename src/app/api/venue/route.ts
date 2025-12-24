// GET /api/venue - List venues (organizations) the user can manage

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabase = await createClient()

  // Get current user
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Use service client to bypass RLS for reading
  const serviceClient = createServiceClient()

  // Get user's profile
  const { data: profile } = await serviceClient
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }

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
        logo_url
      )
    `
    )
    .eq('profile_id', profile.id)
    .in('role', ['club_admin', 'league_admin'])
    .eq('is_active', true)

  if (error) {
    console.error('Failed to fetch venues:', error)
    return NextResponse.json(
      { error: 'Failed to fetch venues' },
      { status: 500 }
    )
  }

  const venues = (memberships || [])
    .map((m: any) => m.organizations)
    .filter(Boolean)

  return NextResponse.json({ venues })
}
