// Recording Access Control for PLAYHUB
// Handles checking and granting access to match recordings

import { createServiceClient } from '@/lib/supabase/server'

// Types
export interface AccessCheckResult {
  hasAccess: boolean
  reason: string
  expiresAt?: string
}

export interface RecordingAccessGrant {
  id: string
  recordingId: string
  userId: string | null
  userEmail: string | null
  invitedEmail: string | null
  grantedBy: string | null
  grantedAt: string
  expiresAt: string | null
  isActive: boolean
  notes: string | null
}

export interface Recording {
  id: string
  organization_id: string | null
  title: string
  s3_key: string | null
  status: string
}

/**
 * Check if a user is an admin for a specific venue/organization
 */
export async function isVenueAdmin(
  userId: string,
  organizationId: string
): Promise<boolean> {
  // Use service client to bypass RLS - this is server-side code
  const supabase = createServiceClient()

  // Get user's profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('user_id', userId)
    .single()

  if (!profile) return false

  // Check organization membership
  const { data: membership } = await supabase
    .from('organization_members')
    .select('role')
    .eq('profile_id', profile.id)
    .eq('organization_id', organizationId)
    .eq('is_active', true)
    .single()

  return (
    !!membership && ['club_admin', 'league_admin'].includes(membership.role)
  )
}

/**
 * Get venues (organizations) that a user can manage
 */
export async function getManagedVenues(userId: string): Promise<
  Array<{
    id: string
    name: string
    slug: string | null
    logo_url: string | null
  }>
> {
  // Use service client to bypass RLS - this is server-side code
  const supabase = createServiceClient()

  // Get user's profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('user_id', userId)
    .single()

  if (!profile) return []

  // Get organizations where user is admin
  const { data: memberships } = await supabase
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

  if (!memberships) return []

  return memberships.map((m: any) => m.organizations).filter(Boolean) as Array<{
    id: string
    name: string
    slug: string | null
    logo_url: string | null
  }>
}

/**
 * Check if a user has access to a specific recording
 */
export async function checkRecordingAccess(
  recordingId: string,
  userId: string | null
): Promise<AccessCheckResult> {
  // Use service client to bypass RLS - this is server-side code
  const supabase = createServiceClient()

  // Fetch recording details
  const { data: recording, error } = await (supabase as any)
    .from('playhub_match_recordings')
    .select('id, organization_id, status')
    .eq('id', recordingId)
    .single()

  if (error || !recording) {
    return { hasAccess: false, reason: 'Recording not found' }
  }

  // If no user, check if recording is public (no access control)
  if (!userId) {
    return { hasAccess: false, reason: 'Authentication required' }
  }

  // 1. Check if user is venue admin (always has access)
  if (recording.organization_id) {
    const isAdmin = await isVenueAdmin(userId, recording.organization_id)
    if (isAdmin) {
      return { hasAccess: true, reason: 'Venue admin' }
    }
  }

  // 2. Check explicit user_id-based access grant
  const { data: userAccess } = await (supabase as any)
    .from('playhub_access_rights')
    .select('id, expires_at, is_active')
    .eq('match_recording_id', recordingId)
    .eq('user_id', userId)
    .eq('is_active', true)
    .single()

  if (userAccess) {
    if (userAccess.expires_at && new Date(userAccess.expires_at) < new Date()) {
      return {
        hasAccess: false,
        reason: 'Access expired',
        expiresAt: userAccess.expires_at,
      }
    }
    return {
      hasAccess: true,
      reason: 'Access granted',
      expiresAt: userAccess.expires_at,
    }
  }

  // 3. Check email-based access (for users who were invited before signup)
  // Get user's email from profiles table
  const { data: userProfile } = await supabase
    .from('profiles')
    .select('email')
    .eq('user_id', userId)
    .single()

  const userEmail = userProfile?.email

  if (userEmail) {
    const { data: emailAccess } = await (supabase as any)
      .from('playhub_access_rights')
      .select('id, expires_at, is_active')
      .eq('match_recording_id', recordingId)
      .eq('invited_email', userEmail.toLowerCase())
      .eq('is_active', true)
      .single()

    if (emailAccess) {
      // Convert email-based access to user_id based access
      await (supabase as any)
        .from('playhub_access_rights')
        .update({ user_id: userId, invited_email: null })
        .eq('id', emailAccess.id)

      if (
        emailAccess.expires_at &&
        new Date(emailAccess.expires_at) < new Date()
      ) {
        return {
          hasAccess: false,
          reason: 'Access expired',
          expiresAt: emailAccess.expires_at,
        }
      }
      return {
        hasAccess: true,
        reason: 'Access granted (email)',
        expiresAt: emailAccess.expires_at,
      }
    }
  }

  return { hasAccess: false, reason: 'No access' }
}

/**
 * Grant access to a recording for a user (by user_id or email)
 */
export async function grantRecordingAccess(
  recordingId: string,
  grantedBy: string,
  options: {
    userId?: string
    email?: string
    expiresAt?: Date
    notes?: string
  }
): Promise<{
  success: boolean
  error?: string
  accessId?: string
  userExists?: boolean
}> {
  if (!options.userId && !options.email) {
    return { success: false, error: 'Either userId or email must be provided' }
  }

  // Use service client to bypass RLS
  const supabase = createServiceClient()

  // If email provided, check if user exists
  let targetUserId = options.userId
  let userExists = !!options.userId
  if (options.email && !options.userId) {
    const { data: existingUser } = await supabase
      .from('profiles')
      .select('user_id')
      .eq('email', options.email.toLowerCase())
      .single()

    if (existingUser) {
      targetUserId = existingUser.user_id
      userExists = true
    }
  }

  const normalizedEmail = options.email?.toLowerCase() || null

  // Check if access already exists (avoid duplicates)
  let existingAccess = null
  if (targetUserId) {
    const { data } = await (supabase as any)
      .from('playhub_access_rights')
      .select('id')
      .eq('match_recording_id', recordingId)
      .eq('user_id', targetUserId)
      .single()
    existingAccess = data
  } else if (normalizedEmail) {
    const { data } = await (supabase as any)
      .from('playhub_access_rights')
      .select('id')
      .eq('match_recording_id', recordingId)
      .eq('invited_email', normalizedEmail)
      .single()
    existingAccess = data
  }

  // If exists, update it (reactivate if needed)
  if (existingAccess) {
    const { error } = await (supabase as any)
      .from('playhub_access_rights')
      .update({
        is_active: true,
        granted_by: grantedBy,
        granted_at: new Date().toISOString(),
        expires_at: options.expiresAt?.toISOString() || null,
        notes: options.notes || null,
        revoked_at: null,
        revoked_reason: null,
      })
      .eq('id', existingAccess.id)

    if (error) {
      console.error('Failed to update recording access:', error)
      return { success: false, error: error.message }
    }
    return { success: true, accessId: existingAccess.id, userExists }
  }

  // Insert new access grant
  const insertData: any = {
    match_recording_id: recordingId,
    granted_by: grantedBy,
    granted_at: new Date().toISOString(),
    expires_at: options.expiresAt?.toISOString() || null,
    is_active: true,
    notes: options.notes || null,
    user_id: targetUserId || null,
    invited_email: targetUserId ? null : normalizedEmail,
  }

  const { data, error } = await (supabase as any)
    .from('playhub_access_rights')
    .insert(insertData)
    .select('id')
    .single()

  if (error) {
    console.error('Failed to grant recording access:', error)
    return { success: false, error: error.message }
  }

  return { success: true, accessId: data?.id, userExists }
}

/**
 * Grant access to multiple emails at once
 */
export async function grantRecordingAccessBulk(
  recordingId: string,
  grantedBy: string,
  emails: string[],
  options?: {
    expiresAt?: Date
    notes?: string
  }
): Promise<{
  success: boolean
  results: Array<{
    email: string
    success: boolean
    error?: string
    userExists?: boolean
  }>
}> {
  const results = await Promise.all(
    emails.map(async (email) => {
      const result = await grantRecordingAccess(recordingId, grantedBy, {
        email,
        expiresAt: options?.expiresAt,
        notes: options?.notes,
      })
      return {
        email,
        success: result.success,
        error: result.error,
        userExists: result.userExists,
      }
    })
  )

  return {
    success: results.every((r) => r.success),
    results,
  }
}

/**
 * Revoke access to a recording
 */
export async function revokeRecordingAccess(
  accessId: string,
  revokedBy: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()

  const { error } = await (supabase as any)
    .from('playhub_access_rights')
    .update({
      is_active: false,
      revoked_at: new Date().toISOString(),
      revoked_reason: `Revoked by user ${revokedBy}`,
    })
    .eq('id', accessId)

  if (error) {
    console.error('Failed to revoke recording access:', error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

/**
 * List all access grants for a recording
 */
export async function listRecordingAccess(
  recordingId: string
): Promise<RecordingAccessGrant[]> {
  // Use service client to bypass RLS - this is server-side code
  const supabase = createServiceClient()

  const { data, error } = await (supabase as any)
    .from('playhub_access_rights')
    .select('*')
    .eq('match_recording_id', recordingId)
    .order('granted_at', { ascending: false })

  if (error) {
    console.error('Failed to list recording access:', error)
    return []
  }

  // Get user emails for user_id based grants
  const userIds = (data || [])
    .map((row: any) => row.user_id)
    .filter((id: string | null) => id !== null)

  let userEmails: Record<string, string> = {}
  if (userIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('user_id, email')
      .in('user_id', userIds)

    profiles?.forEach((p: any) => {
      if (p.email) userEmails[p.user_id] = p.email
    })
  }

  // Filter out entries where user was deleted (has user_id but no profile)
  // Keep entries with invited_email (user hasn't signed up yet)
  return (data || [])
    .filter((row: any) => {
      // Keep if no user_id (invited by email, not signed up)
      if (!row.user_id) return true
      // Keep if user_id has a corresponding profile
      return userEmails[row.user_id] !== undefined
    })
    .map((row: any) => ({
      id: row.id,
      recordingId: row.match_recording_id,
      userId: row.user_id,
      userEmail: row.user_id ? userEmails[row.user_id] || null : null,
      invitedEmail: row.invited_email,
      grantedBy: row.granted_by,
      grantedAt: row.granted_at,
      expiresAt: row.expires_at,
      isActive: row.is_active,
      notes: row.notes,
    }))
}

/**
 * Get recordings that a user has access to
 */
export async function getAccessibleRecordings(
  userId: string
): Promise<string[]> {
  // Use service client to bypass RLS - this is server-side code
  const supabase = createServiceClient()

  // Get user's email from profiles
  const { data: userProfile } = await supabase
    .from('profiles')
    .select('email')
    .eq('user_id', userId)
    .single()

  const userEmail = userProfile?.email

  const now = new Date().toISOString()

  // Get recordings with explicit access grants (not expired)
  const { data: userGrants } = await (supabase as any)
    .from('playhub_access_rights')
    .select('match_recording_id, expires_at')
    .eq('user_id', userId)
    .eq('is_active', true)

  const recordingIds = new Set<string>()

  // Add user_id based grants (filter out expired)
  userGrants?.forEach((g: any) => {
    if (!g.expires_at || g.expires_at > now) {
      recordingIds.add(g.match_recording_id)
    }
  })

  // Also check email-based grants
  if (userEmail) {
    const { data: emailGrants } = await (supabase as any)
      .from('playhub_access_rights')
      .select('match_recording_id, expires_at')
      .eq('invited_email', userEmail.toLowerCase())
      .eq('is_active', true)

    // Filter out expired grants
    emailGrants?.forEach((g: any) => {
      if (!g.expires_at || g.expires_at > now) {
        recordingIds.add(g.match_recording_id)
      }
    })
  }

  // Add recordings from venues the user manages
  const venues = await getManagedVenues(userId)
  if (venues.length > 0) {
    const { data: venueRecordings } = await (supabase as any)
      .from('playhub_match_recordings')
      .select('id')
      .in(
        'organization_id',
        venues.map((v) => v.id)
      )

    venueRecordings?.forEach((r: any) => recordingIds.add(r.id))
  }

  return Array.from(recordingIds)
}
