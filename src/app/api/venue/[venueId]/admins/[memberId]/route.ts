// DELETE /api/venue/[venueId]/admins/[memberId] - Remove admin from venue

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ venueId: string; memberId: string }> }
) {
  const { venueId, memberId } = await params
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Check if user is admin for this venue
  const isAdmin = await isVenueAdmin(user.id, venueId)
  if (!isAdmin) {
    return NextResponse.json(
      { error: 'Not authorized for this venue' },
      { status: 403 }
    )
  }

  const serviceClient = createServiceClient()

  // Get the membership to verify it belongs to this venue
  const { data: membership } = await serviceClient
    .from('organization_members')
    .select(
      `
      id,
      organization_id,
      profile_id,
      profiles:profile_id (
        user_id
      )
    `
    )
    .eq('id', memberId)
    .single()

  if (!membership) {
    return NextResponse.json({ error: 'Admin not found' }, { status: 404 })
  }

  if (membership.organization_id !== venueId) {
    return NextResponse.json(
      { error: 'Admin does not belong to this venue' },
      { status: 403 }
    )
  }

  // Prevent removing yourself
  const memberUserId = (membership.profiles as any)?.user_id
  if (memberUserId === user.id) {
    return NextResponse.json(
      { error: 'You cannot remove yourself as admin' },
      { status: 400 }
    )
  }

  // Deactivate the membership (soft delete)
  const { error: updateError } = await serviceClient
    .from('organization_members')
    .update({ is_active: false })
    .eq('id', memberId)

  if (updateError) {
    console.error('Failed to remove admin:', updateError)
    return NextResponse.json(
      { error: 'Failed to remove admin' },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true })
}
