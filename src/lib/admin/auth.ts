// Admin authentication and management utilities

import { createServiceClient } from '@/lib/supabase/server'

/** Slug must be lowercase alphanumeric with hyphens, no leading/trailing hyphens */
export const SLUG_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

export const VALID_ORG_TYPES = ['venue', 'league', 'academy', 'group'] as const

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
    supabase
      .from('playhub_match_recordings')
      .select('*', { count: 'exact', head: true }),
    supabase
      .from('playhub_pending_admin_invites')
      .select('*', { count: 'exact', head: true }),
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
    .select(
      `
      id,
      name,
      slug,
      logo_url,
      created_at
    `
    )
    .eq('type', 'venue')
    .order('name', { ascending: true })

  if (!venues) return []

  // Get admin counts and recording counts for each venue
  const venueIds = venues.map((v: any) => v.id)

  const { data: memberCounts } = await supabase
    .from('organization_members')
    .select('organization_id')
    .in('organization_id', venueIds)
    .in('role', ['admin', 'manager', 'club_admin', 'league_admin'])
    .eq('is_active', true)

  const { data: recordingCounts } = await supabase
    .from('playhub_match_recordings')
    .select('organization_id')
    .in('organization_id', venueIds)

  // Count per venue
  const adminCountMap: Record<string, number> = {}
  const recordingCountMap: Record<string, number> = {}

  memberCounts?.forEach((m: any) => {
    adminCountMap[m.organization_id] =
      (adminCountMap[m.organization_id] || 0) + 1
  })

  recordingCounts?.forEach((r: any) => {
    recordingCountMap[r.organization_id] =
      (recordingCountMap[r.organization_id] || 0) + 1
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
    .select(
      'id, user_id, full_name, username, email, is_platform_admin, created_at'
    )
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
    .select(
      `
      id,
      title,
      status,
      match_date,
      home_team,
      away_team,
      organization_id,
      s3_key,
      created_at
    `
    )
    .order('created_at', { ascending: false })

  if (!recordings) return []

  // Get venue names
  const orgIds = Array.from(
    new Set(recordings.map((r: any) => r.organization_id).filter(Boolean))
  )

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
    accessCountMap[a.match_recording_id] =
      (accessCountMap[a.match_recording_id] || 0) + 1
  })

  return recordings.map((r: any) => ({
    ...r,
    venueName: r.organization_id ? venueMap[r.organization_id] : null,
    accessCount: accessCountMap[r.id] || 0,
  }))
}

/**
 * Get all organizations with feature flags and hierarchy data
 */
export async function getAllOrganizations() {
  const supabase = createServiceClient() as any

  const { data: orgs } = await supabase
    .from('organizations')
    .select(
      `
      id,
      name,
      slug,
      type,
      logo_url,
      description,
      location,
      is_active,
      is_verified,
      marketplace_enabled,
      feature_recordings,
      feature_streaming,
      feature_graphic_packages,
      parent_organization_id,
      created_at
    `
    )
    .order('type', { ascending: true })
    .order('name', { ascending: true })

  if (!orgs) return []

  // Build parent name map and children map
  const orgMap: Record<string, any> = {}
  orgs.forEach((o: any) => {
    orgMap[o.id] = o
  })

  return orgs.map((o: any) => ({
    ...o,
    parent_name: o.parent_organization_id
      ? orgMap[o.parent_organization_id]?.name || null
      : null,
    children: orgs
      .filter((c: any) => c.parent_organization_id === o.id)
      .map((c: any) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        type: c.type,
      })),
  }))
}

/**
 * Get all venue access entries
 */
export async function getAllVenueAccess() {
  const supabase = createServiceClient() as any

  const { data } = await supabase
    .from('organization_venue_access')
    .select('*')
    .order('created_at', { ascending: false })

  return data || []
}

/**
 * Set parent organization for a child org
 */
export async function setParentOrg(
  childOrgId: string,
  parentOrgId: string | null
) {
  const supabase = createServiceClient() as any

  // Prevent self-reference
  if (parentOrgId && childOrgId === parentOrgId) {
    return { success: false, error: 'An organization cannot be its own parent' }
  }

  // Validate parent is a group (if setting a parent)
  if (parentOrgId) {
    const { data: parent } = await supabase
      .from('organizations')
      .select('id, type')
      .eq('id', parentOrgId)
      .single()

    if (!parent) {
      return { success: false, error: 'Parent organization not found' }
    }
    if (parent.type !== 'group') {
      return { success: false, error: 'Parent organization must be a group' }
    }
  }

  const { error } = await supabase
    .from('organizations')
    .update({ parent_organization_id: parentOrgId })
    .eq('id', childOrgId)

  if (error) {
    console.error('Failed to set parent org:', error)
    return { success: false, error: 'Failed to update parent organization' }
  }

  return { success: true }
}

/**
 * Create or update a venue access entry
 */
export async function upsertVenueAccess(data: {
  organization_id: string
  venue_organization_id: string
  can_record?: boolean
  can_stream?: boolean
  billing_responsibility?: string
  is_active?: boolean
  notes?: string
}) {
  const supabase = createServiceClient() as any

  const { error } = await supabase
    .from('organization_venue_access')
    .upsert(data, { onConflict: 'organization_id,venue_organization_id' })

  return { success: !error, error: error?.message }
}

/**
 * Delete a venue access entry
 */
export async function deleteVenueAccess(id: string) {
  const supabase = createServiceClient() as any

  const { error } = await supabase
    .from('organization_venue_access')
    .delete()
    .eq('id', id)

  return { success: !error, error: error?.message }
}

/**
 * Update feature flags for an organization
 */
export async function updateOrgFeatures(
  orgId: string,
  features: {
    feature_recordings?: boolean
    feature_streaming?: boolean
    feature_graphic_packages?: boolean
    marketplace_enabled?: boolean
  }
) {
  const supabase = createServiceClient() as any

  const { error } = await supabase
    .from('organizations')
    .update(features)
    .eq('id', orgId)

  return { success: !error, error: error?.message }
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
 * Create a new organization
 */
export async function createOrganization(data: {
  name: string
  slug: string
  type: string
  description?: string | null
  location?: string | null
  logo_url?: string | null
  parent_organization_id?: string | null
  feature_recordings?: boolean
  feature_streaming?: boolean
  feature_graphic_packages?: boolean
  marketplace_enabled?: boolean
}): Promise<{ success: boolean; organization?: any; error?: string }> {
  const supabase = createServiceClient() as any

  // Check slug uniqueness
  const { data: existing } = await supabase
    .from('organizations')
    .select('id')
    .eq('slug', data.slug)
    .maybeSingle()

  if (existing) {
    return { success: false, error: 'Slug already in use' }
  }

  // If parent provided, verify it exists and is a group
  if (data.parent_organization_id) {
    const { data: parent } = await supabase
      .from('organizations')
      .select('id, type')
      .eq('id', data.parent_organization_id)
      .single()

    if (!parent) {
      return { success: false, error: 'Parent organization not found' }
    }
    if (parent.type !== 'group') {
      return { success: false, error: 'Parent organization must be a group' }
    }
  }

  const { data: org, error } = await supabase
    .from('organizations')
    .insert({
      name: data.name.trim(),
      slug: data.slug,
      type: data.type,
      description: data.description || null,
      location: data.location || null,
      logo_url: data.logo_url || null,
      parent_organization_id: data.parent_organization_id || null,
      feature_recordings: data.feature_recordings ?? false,
      feature_streaming: data.feature_streaming ?? false,
      feature_graphic_packages: data.feature_graphic_packages ?? false,
      marketplace_enabled: data.marketplace_enabled ?? false,
      is_active: true,
    })
    .select()
    .single()

  if (error) {
    console.error('Failed to create organization:', error)
    // Check for unique constraint violation on slug
    if (error.code === '23505') {
      return { success: false, error: 'Slug already in use' }
    }
    return { success: false, error: 'Failed to create organization' }
  }

  return { success: true, organization: org }
}

/**
 * Update an existing organization
 */
export async function updateOrganization(
  orgId: string,
  data: {
    name?: string
    slug?: string
    type?: string
    description?: string | null
    location?: string | null
    logo_url?: string | null
    is_active?: boolean
    is_verified?: boolean
  }
): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient() as any

  // If slug is changing, check uniqueness
  if (data.slug) {
    const { data: existing } = await supabase
      .from('organizations')
      .select('id')
      .eq('slug', data.slug)
      .neq('id', orgId)
      .maybeSingle()

    if (existing) {
      return { success: false, error: 'Slug already in use' }
    }
  }

  // If changing type away from 'group', check for existing children
  if (data.type && data.type !== 'group') {
    const { data: children } = await supabase
      .from('organizations')
      .select('id')
      .eq('parent_organization_id', orgId)
      .limit(1)

    if (children && children.length > 0) {
      return {
        success: false,
        error: 'Cannot change type from group while child organizations exist',
      }
    }
  }

  // Build update object, only include defined fields
  const updates: Record<string, any> = {}
  if (data.name !== undefined) updates.name = data.name.trim()
  if (data.slug !== undefined) updates.slug = data.slug
  if (data.type !== undefined) updates.type = data.type
  if (data.description !== undefined) updates.description = data.description
  if (data.location !== undefined) updates.location = data.location
  if (data.logo_url !== undefined) updates.logo_url = data.logo_url
  if (data.is_active !== undefined) updates.is_active = data.is_active
  if (data.is_verified !== undefined) updates.is_verified = data.is_verified

  if (Object.keys(updates).length === 0) {
    return { success: true }
  }

  const { error } = await supabase
    .from('organizations')
    .update(updates)
    .eq('id', orgId)

  if (error) {
    console.error('Failed to update organization:', error)
    if (error.code === '23505') {
      return { success: false, error: 'Slug already in use' }
    }
    return { success: false, error: 'Failed to update organization' }
  }

  return { success: true }
}

/**
 * Get all scene-to-venue mappings
 */
export async function getAllSceneMappings() {
  const supabase = createServiceClient() as any

  const { data } = await supabase
    .from('playhub_scene_venue_mapping')
    .select('*')
    .order('created_at', { ascending: false })

  return data || []
}

/**
 * Assign or unassign a Spiideo scene to a venue
 */
export async function upsertSceneMapping(data: {
  scene_id: string
  organization_id: string | null
  scene_name?: string | null
}): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient() as any

  if (!data.organization_id) {
    // Unassign: delete the mapping
    const { error } = await supabase
      .from('playhub_scene_venue_mapping')
      .delete()
      .eq('scene_id', data.scene_id)

    if (error) {
      console.error('Failed to unassign scene:', error)
      return { success: false, error: 'Failed to unassign scene' }
    }
    return { success: true }
  }

  // Assign or reassign
  const { error } = await supabase.from('playhub_scene_venue_mapping').upsert(
    {
      scene_id: data.scene_id,
      organization_id: data.organization_id,
      scene_name: data.scene_name || null,
    },
    { onConflict: 'scene_id' }
  )

  if (error) {
    console.error('Failed to assign scene:', error)
    return { success: false, error: 'Failed to assign scene' }
  }
  return { success: true }
}

/**
 * Fetch all scenes from Spiideo API
 */
export async function fetchSpiideoScenes(): Promise<{
  scenes: { id: string; name: string; accountId: string }[]
  error?: string
}> {
  try {
    const { getScenes, getAccountConfig } = await import('@/lib/spiideo/client')
    const config = getAccountConfig()
    if (!config.accountId) {
      return { scenes: [], error: 'Spiideo account not configured' }
    }
    const response = await getScenes(config.accountId)
    return { scenes: response.content || [] }
  } catch (err: any) {
    console.error('Failed to fetch Spiideo scenes:', err)
    return { scenes: [], error: 'Failed to connect to Spiideo' }
  }
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
    return {
      success: false,
      error: 'Cannot delete a platform admin. Remove admin status first.',
    }
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
      return {
        success: false,
        error: 'Failed to delete profile',
      }
    }

    // Step 2: Delete auth user via direct SQL (more reliable than admin API)
    const { error: authDeleteError } = await supabase.rpc('delete_auth_user', {
      user_id: targetProfile.user_id,
    })

    if (authDeleteError) {
      console.error('Error deleting auth user:', authDeleteError)
      // Profile is already deleted, so user can't access anything
      // But warn that auth record remains
      return {
        success: true,
        warning: 'Profile deleted but auth record may remain',
      }
    }

    return { success: true }
  } catch (err: any) {
    console.error('Exception deleting user:', err)
    return {
      success: false,
      error: 'Failed to delete user',
    }
  }
}
