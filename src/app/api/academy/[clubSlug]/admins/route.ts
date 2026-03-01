// GET /api/academy/[clubSlug]/admins - List academy admins
// POST /api/academy/[clubSlug]/admins - Invite admin by email
// Platform admin only

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { getClubBySlug } from '@/lib/academy/config'
import { sendAdminInviteEmail, sendAdminAddedEmail } from '@/lib/email'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ clubSlug: string }> }
) {
  const { clubSlug } = await params
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
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

  const { data: members, error } = await serviceClient
    .from('organization_members')
    .select(
      `
      id,
      role,
      is_active,
      created_at,
      profile_id,
      profiles:profile_id (
        id,
        user_id,
        full_name,
        email
      )
    `
    )
    .eq('organization_id', club.organizationId)
    .in('role', ['club_admin', 'league_admin'])
    .eq('is_active', true)
    .order('created_at', { ascending: true })

  if (error) {
    console.error('Failed to fetch academy admins:', error)
    return NextResponse.json(
      { error: 'Failed to fetch admins' },
      { status: 500 }
    )
  }

  const admins = (members || [])
    .filter((m: any) => m.profiles !== null)
    .map((m: any) => ({
      id: m.id,
      role: m.role,
      createdAt: m.created_at,
      userId: m.profiles?.user_id,
      fullName: m.profiles?.full_name,
      email: m.profiles?.email,
    }))

  return NextResponse.json({ admins })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ clubSlug: string }> }
) {
  const { clubSlug } = await params
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!(await isPlatformAdmin(user.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const club = await getClubBySlug(clubSlug)
  if (!club?.organizationId) {
    return NextResponse.json({ error: 'Club not found' }, { status: 404 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { email, role = 'club_admin' } = body

  if (!email || typeof email !== 'string') {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 })
  }

  if (!['club_admin', 'league_admin'].includes(role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
  }

  const serviceClient = createServiceClient()

  // Get inviter's name
  const { data: inviterProfile } = await serviceClient
    .from('profiles')
    .select('full_name')
    .eq('user_id', user.id)
    .single()

  // Find user by email
  const { data: targetProfile } = await serviceClient
    .from('profiles')
    .select('id, user_id, full_name, email')
    .eq('email', email.toLowerCase())
    .single()

  if (!targetProfile) {
    // User doesn't exist — store pending invite and send email
    const { error: inviteError } = await (serviceClient as any)
      .from('playhub_pending_admin_invites')
      .upsert(
        {
          organization_id: club.organizationId,
          invited_email: email.toLowerCase(),
          role,
          invited_by: user.id,
          invited_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id,invited_email' }
      )

    if (inviteError) {
      console.error('Failed to store pending invite:', inviteError)
      return NextResponse.json(
        { error: 'Failed to send invitation' },
        { status: 500 }
      )
    }

    await sendAdminInviteEmail({
      toEmail: email.toLowerCase(),
      venueName: club.name,
      inviterName: inviterProfile?.full_name || undefined,
    })

    return NextResponse.json({
      success: true,
      invited: true,
      message:
        'Invitation email sent. They will be added as admin after creating an account.',
    })
  }

  // Check if already an admin
  const { data: existingMember } = await serviceClient
    .from('organization_members')
    .select('id, is_active')
    .eq('organization_id', club.organizationId)
    .eq('profile_id', targetProfile.id)
    .single()

  if (existingMember) {
    if (existingMember.is_active) {
      return NextResponse.json(
        { error: 'User is already an admin for this academy' },
        { status: 400 }
      )
    }

    // Reactivate existing membership
    const { error: updateError } = await serviceClient
      .from('organization_members')
      .update({ is_active: true, role })
      .eq('id', existingMember.id)

    if (updateError) {
      console.error('Failed to reactivate admin:', updateError)
      return NextResponse.json(
        { error: 'Failed to add admin' },
        { status: 500 }
      )
    }

    await sendAdminAddedEmail({
      toEmail: email.toLowerCase(),
      entityName: club.name,
      dashboardUrl: `/academy/${clubSlug}/access`,
      inviterName: inviterProfile?.full_name || undefined,
    })

    return NextResponse.json({
      success: true,
      admin: {
        id: existingMember.id,
        role,
        fullName: targetProfile.full_name,
        email: targetProfile.email,
      },
    })
  }

  // Create new membership
  const { data: newMember, error: insertError } = await serviceClient
    .from('organization_members')
    .insert({
      organization_id: club.organizationId,
      profile_id: targetProfile.id,
      role,
      is_active: true,
    })
    .select('id')
    .single()

  if (insertError) {
    console.error('Failed to add admin:', insertError)
    return NextResponse.json({ error: 'Failed to add admin' }, { status: 500 })
  }

  await sendAdminAddedEmail({
    toEmail: email.toLowerCase(),
    entityName: club.name,
    dashboardUrl: `/academy/${clubSlug}/access`,
    inviterName: inviterProfile?.full_name || undefined,
  })

  return NextResponse.json({
    success: true,
    admin: {
      id: newMember.id,
      role,
      fullName: targetProfile.full_name,
      email: targetProfile.email,
    },
  })
}
