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

  // Get user's profile with email
  const { data: profile } = await serviceClient
    .from('profiles')
    .select('id, email')
    .eq('user_id', user.id)
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }

  // Process any pending admin invites for this user's email
  if (profile.email) {
    await processPendingAdminInvites(serviceClient, profile.id, profile.email)
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

// Process pending admin invites for a user who just logged in
async function processPendingAdminInvites(
  supabase: any,
  profileId: string,
  userEmail: string
) {
  try {
    // Find pending invites for this email
    const { data: pendingInvites } = await supabase
      .from('playhub_pending_admin_invites')
      .select('id, organization_id, role')
      .eq('invited_email', userEmail.toLowerCase())

    if (!pendingInvites || pendingInvites.length === 0) return

    // Process each pending invite
    for (const invite of pendingInvites) {
      // Check if already a member
      const { data: existingMember } = await supabase
        .from('organization_members')
        .select('id')
        .eq('organization_id', invite.organization_id)
        .eq('profile_id', profileId)
        .single()

      if (!existingMember) {
        // Create membership
        await supabase.from('organization_members').insert({
          organization_id: invite.organization_id,
          profile_id: profileId,
          role: invite.role,
          is_active: true,
        })
      }

      // Delete the pending invite
      await supabase
        .from('playhub_pending_admin_invites')
        .delete()
        .eq('id', invite.id)
    }

    console.log(
      `Processed ${pendingInvites.length} pending admin invites for ${userEmail}`
    )
  } catch (error) {
    console.error('Error processing pending admin invites:', error)
  }
}
