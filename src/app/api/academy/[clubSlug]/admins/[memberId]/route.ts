// DELETE /api/academy/[clubSlug]/admins/[memberId] - Remove admin from academy
// Platform admin only

import { getAuthUserStrict, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { getClubBySlug } from '@/lib/academy/config'

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ clubSlug: string; memberId: string }> }
) {
  const { clubSlug, memberId } = await params
  const { user } = await getAuthUserStrict()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!(await isPlatformAdmin(user.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const club = await getClubBySlug(clubSlug)
  if (!club?.organizationId) {
    return NextResponse.json({ error: 'Club not found' }, { status: 404 })
  }

  const serviceClient = createServiceClient()

  // Get the membership to verify it belongs to this academy
  const { data: membership } = await serviceClient
    .from('organization_members')
    .select(
      `
      id,
      organization_id,
      profile_id,
      profiles:profile_id (
        user_id,
        email,
        is_platform_admin
      )
    `
    )
    .eq('id', memberId)
    .single()

  if (!membership) {
    return NextResponse.json({ error: 'Admin not found' }, { status: 404 })
  }

  if (membership.organization_id !== club.organizationId) {
    return NextResponse.json(
      { error: 'Admin does not belong to this academy' },
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

  // Prevent removing platform admins
  const memberIsPlatformAdmin = (membership.profiles as any)?.is_platform_admin
  if (memberIsPlatformAdmin) {
    return NextResponse.json(
      {
        error:
          'Cannot remove a platform admin. Remove their platform admin status first.',
      },
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

  // Clean up any pending invites for this member's email
  const memberEmail = (membership.profiles as any)?.email
  if (memberEmail) {
    const { error: cleanupError } = await (serviceClient as any)
      .from('playhub_pending_admin_invites')
      .delete()
      .eq('invited_email', memberEmail.toLowerCase())
      .eq('organization_id', club.organizationId)
    if (cleanupError) {
      console.error('Failed to clean up pending invites:', cleanupError)
    }
  }

  return NextResponse.json({ success: true })
}
