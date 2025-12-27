// Admin authentication utilities

import { createServiceClient } from '@/lib/supabase/server'

/**
 * Check if a user is a platform admin
 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const supabase = createServiceClient() as any

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_platform_admin')
    .eq('user_id', userId)
    .single()

  return profile?.is_platform_admin === true
}

/**
 * Get admin stats for dashboard
 */
export async function getAdminStats() {
  const supabase = createServiceClient() as any

  // Get counts in parallel
  const [
    { count: usersCount },
    { count: venuesCount },
    { count: recordingsCount },
    { count: pendingAdminInvitesCount },
  ] = await Promise.all([
    supabase.from('profiles').select('*', { count: 'exact', head: true }),
    supabase.from('organizations').select('*', { count: 'exact', head: true }),
    supabase.from('playhub_match_recordings').select('*', { count: 'exact', head: true }),
    supabase.from('playhub_pending_admin_invites').select('*', { count: 'exact', head: true }),
  ])

  // Get recent activity
  const { data: recentRecordings } = await supabase
    .from('playhub_match_recordings')
    .select('id, title, status, created_at')
    .order('created_at', { ascending: false })
    .limit(5)

  const { data: recentUsers } = await supabase
    .from('profiles')
    .select('id, full_name, email, created_at')
    .order('created_at', { ascending: false })
    .limit(5)

  return {
    users: usersCount || 0,
    venues: venuesCount || 0,
    recordings: recordingsCount || 0,
    pendingInvites: pendingAdminInvitesCount || 0,
    recentRecordings: recentRecordings || [],
    recentUsers: recentUsers || [],
  }
}

/**
 * Get all venues with admin counts
 */
export async function getAllVenues() {
  const supabase = createServiceClient() as any

  const { data: venues } = await supabase
    .from('organizations')
    .select(`
      id,
      name,
      slug,
      logo_url,
      created_at
    `)
    .order('name', { ascending: true })

  if (!venues) return []

  // Get admin counts and recording counts for each venue
  const venueIds = venues.map((v: any) => v.id)

  const { data: memberCounts } = await supabase
    .from('organization_members')
    .select('organization_id')
    .in('organization_id', venueIds)
    .in('role', ['club_admin', 'league_admin'])
    .eq('is_active', true)

  const { data: recordingCounts } = await supabase
    .from('playhub_match_recordings')
    .select('organization_id')
    .in('organization_id', venueIds)

  // Count per venue
  const adminCountMap: Record<string, number> = {}
  const recordingCountMap: Record<string, number> = {}

  memberCounts?.forEach((m: any) => {
    adminCountMap[m.organization_id] = (adminCountMap[m.organization_id] || 0) + 1
  })

  recordingCounts?.forEach((r: any) => {
    recordingCountMap[r.organization_id] = (recordingCountMap[r.organization_id] || 0) + 1
  })

  return venues.map((v: any) => ({
    ...v,
    adminCount: adminCountMap[v.id] || 0,
    recordingCount: recordingCountMap[v.id] || 0,
  }))
}

/**
 * Get all users
 */
export async function getAllUsers() {
  const supabase = createServiceClient() as any

  const { data: users } = await supabase
    .from('profiles')
    .select('id, user_id, full_name, username, email, is_platform_admin, created_at')
    .order('created_at', { ascending: false })

  return users || []
}

/**
 * Get all recordings
 */
export async function getAllRecordings() {
  const supabase = createServiceClient() as any

  const { data: recordings } = await supabase
    .from('playhub_match_recordings')
    .select(`
      id,
      title,
      status,
      match_date,
      home_team,
      away_team,
      organization_id,
      s3_key,
      created_at
    `)
    .order('created_at', { ascending: false })

  if (!recordings) return []

  // Get venue names
  const orgIds = Array.from(new Set(recordings.map((r: any) => r.organization_id).filter(Boolean)))

  let venueMap: Record<string, string> = {}
  if (orgIds.length > 0) {
    const { data: venues } = await supabase
      .from('organizations')
      .select('id, name')
      .in('id', orgIds)

    venues?.forEach((v: any) => {
      venueMap[v.id] = v.name
    })
  }

  // Get access counts
  const recordingIds = recordings.map((r: any) => r.id)
  const { data: accessCounts } = await supabase
    .from('playhub_access_rights')
    .select('match_recording_id')
    .in('match_recording_id', recordingIds)
    .eq('is_active', true)

  const accessCountMap: Record<string, number> = {}
  accessCounts?.forEach((a: any) => {
    accessCountMap[a.match_recording_id] = (accessCountMap[a.match_recording_id] || 0) + 1
  })

  return recordings.map((r: any) => ({
    ...r,
    venueName: r.organization_id ? venueMap[r.organization_id] : null,
    accessCount: accessCountMap[r.id] || 0,
  }))
}

/**
 * Toggle platform admin status for a user
 */
export async function togglePlatformAdmin(profileId: string, isAdmin: boolean) {
  const supabase = createServiceClient() as any

  const { error } = await supabase
    .from('profiles')
    .update({ is_platform_admin: isAdmin })
    .eq('id', profileId)

  return { success: !error, error: error?.message }
}

/**
 * Delete a user (auth account and profile)
 * - Prevents deleting platform admins (must remove admin status first)
 * - Prevents self-deletion
 * - Cascading deletes handle memberships and access rights
 * - Purchase records are preserved with user_id set to null
 */
export async function deleteUser(
  profileId: string,
  currentUserId: string
): Promise<{ success: boolean; error?: string; warning?: string }> {
  const supabase = createServiceClient() as any

  // Get the target user's profile
  const { data: targetProfile, error: profileError } = await supabase
    .from('profiles')
    .select('id, user_id, is_platform_admin, email, full_name')
    .eq('id', profileId)
    .single()

  if (profileError || !targetProfile) {
    return { success: false, error: 'User not found' }
  }

  // Prevent self-deletion
  if (targetProfile.user_id === currentUserId) {
    return { success: false, error: 'You cannot delete your own account' }
  }

  // Prevent deleting platform admins
  if (targetProfile.is_platform_admin) {
    return { success: false, error: 'Cannot delete a platform admin. Remove admin status first.' }
  }

  // Delete in order: profile first (cascades to related data), then auth user
  try {
    // Step 1: Delete profile (cascades to organization_members, access_rights, etc.)
    const { error: profileDeleteError } = await supabase
      .from('profiles')
      .delete()
      .eq('id', profileId)

    if (profileDeleteError) {
      console.error('Error deleting profile:', profileDeleteError)
      return { success: false, error: profileDeleteError.message || 'Failed to delete profile' }
    }

    // Step 2: Delete auth user via direct SQL (more reliable than admin API)
    const { error: authDeleteError } = await supabase.rpc('delete_auth_user', {
      user_id: targetProfile.user_id
    })

    if (authDeleteError) {
      console.error('Error deleting auth user:', authDeleteError)
      // Profile is already deleted, so user can't access anything
      // But warn that auth record remains
      return { success: true, warning: 'Profile deleted but auth record may remain' }
    }

    return { success: true }
  } catch (err: any) {
    console.error('Exception deleting user:', err)
    return { success: false, error: err?.message || 'Unexpected error deleting user' }
  }
}
