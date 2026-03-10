// GET /api/org/[slug]/manage/team — List org admins
// POST /api/org/[slug]/manage/team — Add admin by email
// DELETE /api/org/[slug]/manage/team?id=<membershipId> — Remove admin

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { sendAdminInviteEmail, sendAdminAddedEmail } from '@/lib/email'

type RouteContext = { params: Promise<{ slug: string }> }

async function resolveOrgAndAuth(slug: string, userId: string) {
  const serviceClient = createServiceClient() as any

  const { data: org } = await serviceClient
    .from('organizations')
    .select('id, name, slug')
    .eq('slug', slug)
    .single()

  if (!org) return { org: null, authorized: false }

  const [isAdmin, isPlatform] = await Promise.all([
    isVenueAdmin(userId, org.id),
    isPlatformAdmin(userId),
  ])

  return { org, authorized: isAdmin || isPlatform }
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { slug } = await params
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { org, authorized } = await resolveOrgAndAuth(slug, user.id)
  if (!org || !authorized) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const serviceClient = createServiceClient() as any

  const { data: members } = await serviceClient
    .from('organization_members')
    .select(
      `
      id,
      role,
      created_at,
      profiles:profile_id (
        id,
        user_id,
        full_name,
        email
      )
    `
    )
    .eq('organization_id', org.id)
    .in('role', ['admin', 'manager', 'club_admin', 'league_admin'])
    .eq('is_active', true)
    .order('created_at', { ascending: true })

  // Also get pending invites
  const { data: pendingInvites } = await serviceClient
    .from('playhub_pending_admin_invites')
    .select('id, invited_email, role, invited_at')
    .eq('organization_id', org.id)

  const admins = (members || [])
    .filter((m: any) => m.profiles !== null)
    .map((m: any) => ({
      id: m.id,
      role: m.role,
      createdAt: m.created_at,
      userId: m.profiles?.user_id,
      fullName: m.profiles?.full_name,
      email: m.profiles?.email,
      isCurrentUser: m.profiles?.user_id === user.id,
    }))

  return NextResponse.json({
    admins,
    pendingInvites: pendingInvites || [],
  })
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { slug } = await params
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { org, authorized } = await resolveOrgAndAuth(slug, user.id)
  if (!org || !authorized) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json()
  const { email, role = 'admin' } = body

  if (!email || typeof email !== 'string') {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 })
  }

  if (!['admin', 'manager'].includes(role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
  }

  const serviceClient = createServiceClient() as any

  // Get inviter name
  const { data: inviterProfile } = await serviceClient
    .from('profiles')
    .select('full_name')
    .eq('user_id', user.id)
    .single()

  // Find target user
  const { data: targetProfile } = await serviceClient
    .from('profiles')
    .select('id, user_id, full_name, email')
    .eq('email', email.toLowerCase())
    .single()

  if (!targetProfile) {
    // Store pending invite
    const { error: inviteError } = await serviceClient
      .from('playhub_pending_admin_invites')
      .upsert(
        {
          organization_id: org.id,
          invited_email: email.toLowerCase(),
          role,
          invited_by: user.id,
          invited_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id,invited_email' }
      )

    if (inviteError) {
      return NextResponse.json(
        { error: 'Failed to send invitation' },
        { status: 500 }
      )
    }

    await sendAdminInviteEmail({
      toEmail: email.toLowerCase(),
      venueName: org.name,
      inviterName: inviterProfile?.full_name || undefined,
    })

    return NextResponse.json({
      success: true,
      invited: true,
      message: 'Invitation sent. They will be added after creating an account.',
    })
  }

  // Check if already a member
  const { data: existing } = await serviceClient
    .from('organization_members')
    .select('id, is_active')
    .eq('organization_id', org.id)
    .eq('profile_id', targetProfile.id)
    .single()

  if (existing?.is_active) {
    return NextResponse.json({ error: 'Already a member' }, { status: 400 })
  }

  if (existing) {
    // Reactivate
    await serviceClient
      .from('organization_members')
      .update({ is_active: true, role })
      .eq('id', existing.id)
  } else {
    // Create new
    await serviceClient.from('organization_members').insert({
      organization_id: org.id,
      profile_id: targetProfile.id,
      role,
      is_active: true,
    })
  }

  await sendAdminAddedEmail({
    toEmail: email.toLowerCase(),
    entityName: org.name,
    dashboardUrl: `/org/${org.slug}/manage`,
    inviterName: inviterProfile?.full_name || undefined,
  })

  return NextResponse.json({
    success: true,
    admin: {
      role,
      fullName: targetProfile.full_name,
      email: targetProfile.email,
    },
  })
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const { slug } = await params
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { org, authorized } = await resolveOrgAndAuth(slug, user.id)
  if (!org || !authorized) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const membershipId = request.nextUrl.searchParams.get('id')
  if (!membershipId) {
    return NextResponse.json({ error: 'id required' }, { status: 400 })
  }

  const serviceClient = createServiceClient() as any

  // Don't allow removing yourself
  const { data: membership } = await serviceClient
    .from('organization_members')
    .select('profile_id, profiles:profile_id (user_id)')
    .eq('id', membershipId)
    .eq('organization_id', org.id)
    .single()

  if (!membership) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 })
  }

  if ((membership as any).profiles?.user_id === user.id) {
    return NextResponse.json(
      { error: 'Cannot remove yourself' },
      { status: 400 }
    )
  }

  await serviceClient
    .from('organization_members')
    .update({ is_active: false })
    .eq('id', membershipId)

  return NextResponse.json({ success: true })
}
