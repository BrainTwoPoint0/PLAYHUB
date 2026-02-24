// Veo ClubHouse Cache — read/write Veo data from Supabase
// Used by the read endpoint (fast reads) and cache-sync endpoint (writes)

import { createServiceClient } from '@/lib/supabase/server'
import type { VeoTeam, VeoMember } from './client'

// ============================================================================
// Types
// ============================================================================

export interface CachedClubData {
  clubName: string
  teams: (VeoTeam & { members: VeoMember[] })[]
  lastSyncedAt: string | null
  syncStatus: string
}

export interface ClubSyncStatus {
  lastSyncedAt: string | null
  syncStatus: string
  syncError: string | null
}

// ============================================================================
// Read: get cached club data shaped like listClubTeamsWithMembers() output
// ============================================================================

export async function getCachedClubData(
  clubSlug: string
): Promise<CachedClubData | null> {
  const supabase = createServiceClient() as any

  // Get club record
  const { data: club } = await supabase
    .from('playhub_veo_clubs')
    .select('*')
    .eq('club_slug', clubSlug)
    .single()

  if (!club) return null

  // Get teams for this club
  const { data: teams } = await supabase
    .from('playhub_veo_teams')
    .select('*')
    .eq('veo_club_slug', club.veo_club_slug)
    .order('name')

  if (!teams) return null

  // Get all members for this club
  const { data: members } = await supabase
    .from('playhub_veo_members')
    .select('*')
    .eq('veo_club_slug', club.veo_club_slug)

  const membersByTeam = new Map<string, VeoMember[]>()
  for (const m of (members || []) as any[]) {
    const key = m.veo_team_slug
    if (!membersByTeam.has(key)) membersByTeam.set(key, [])
    membersByTeam.get(key)!.push({
      id: m.veo_member_id,
      email: m.email || '',
      name: m.name || '',
      status: m.status || '',
      permission_role: m.permission_role || '',
    })
  }

  return {
    clubName: club.name,
    teams: teams.map((t: any) => ({
      id: t.veo_team_id || '',
      slug: t.veo_team_slug,
      name: t.name,
      member_count: t.member_count || 0,
      members: membersByTeam.get(t.veo_team_slug) || [],
    })),
    lastSyncedAt: club.last_synced_at,
    syncStatus: club.sync_status || 'pending',
  }
}

// ============================================================================
// Write: delete+insert fresh data for a club
// ============================================================================

export async function writeCachedClubData(
  clubSlug: string,
  veoClubSlug: string,
  data: { clubName: string; teams: (VeoTeam & { members: VeoMember[] })[] }
): Promise<void> {
  const supabase = createServiceClient() as any

  // Upsert club record
  const { error: clubError } = await supabase.from('playhub_veo_clubs').upsert(
    {
      veo_club_slug: veoClubSlug,
      club_slug: clubSlug,
      name: data.clubName,
      team_count: data.teams.length,
      last_synced_at: new Date().toISOString(),
      sync_status: 'success',
      sync_error: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'club_slug' }
  )
  if (clubError) throw new Error(`Failed to upsert club: ${clubError.message}`)

  // Delete old members then teams for this club
  const { error: delMembersError } = await supabase
    .from('playhub_veo_members')
    .delete()
    .eq('veo_club_slug', veoClubSlug)
  if (delMembersError)
    throw new Error(`Failed to delete members: ${delMembersError.message}`)

  const { error: delTeamsError } = await supabase
    .from('playhub_veo_teams')
    .delete()
    .eq('veo_club_slug', veoClubSlug)
  if (delTeamsError)
    throw new Error(`Failed to delete teams: ${delTeamsError.message}`)

  // Insert fresh teams
  if (data.teams.length > 0) {
    const { error: teamsError } = await supabase
      .from('playhub_veo_teams')
      .insert(
        data.teams.map((t) => ({
          veo_team_id: t.id,
          veo_team_slug: t.slug,
          veo_club_slug: veoClubSlug,
          name: t.name,
          member_count: t.members.length,
        }))
      )
    if (teamsError)
      throw new Error(`Failed to insert teams: ${teamsError.message}`)
  }

  // Insert fresh members
  const allMembers = data.teams.flatMap((t) =>
    t.members.map((m) => ({
      veo_member_id: m.id,
      veo_team_slug: t.slug,
      veo_club_slug: veoClubSlug,
      email: m.email || null,
      name: m.name || null,
      status: m.status || null,
      permission_role: m.permission_role || null,
      last_seen_at: new Date().toISOString(),
    }))
  )

  if (allMembers.length > 0) {
    const { error: membersError } = await supabase
      .from('playhub_veo_members')
      .insert(allMembers)
    if (membersError)
      throw new Error(`Failed to insert members: ${membersError.message}`)
  }
}

// ============================================================================
// Status: get sync status for a club
// ============================================================================

export async function getClubSyncStatus(
  clubSlug: string
): Promise<ClubSyncStatus | null> {
  const supabase = createServiceClient() as any

  const { data: club } = await supabase
    .from('playhub_veo_clubs')
    .select('last_synced_at, sync_status, sync_error')
    .eq('club_slug', clubSlug)
    .single()

  if (!club) return null

  return {
    lastSyncedAt: club.last_synced_at,
    syncStatus: club.sync_status || 'pending',
    syncError: club.sync_error,
  }
}

// ============================================================================
// Helpers: update sync status (used by cache-sync endpoint)
// ============================================================================

export async function setSyncStatus(
  clubSlug: string,
  veoClubSlug: string,
  status: 'syncing' | 'error',
  error?: string
): Promise<void> {
  const supabase = createServiceClient() as any

  await supabase.from('playhub_veo_clubs').upsert(
    {
      veo_club_slug: veoClubSlug,
      club_slug: clubSlug,
      name: clubSlug, // placeholder, will be overwritten on success
      sync_status: status,
      sync_error: status === 'error' ? error || 'Unknown error' : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'club_slug' }
  )
}
