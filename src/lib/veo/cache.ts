// Veo ClubHouse Cache — read/write Veo data from Supabase
// Used by the read endpoint (fast reads) and cache-sync endpoint (writes)

import { createServiceClient } from '@/lib/supabase/server'

// ============================================================================
// Types (duplicated from client.ts to avoid importing Playwright transitively)
// ============================================================================

interface VeoTeam {
  id: string
  slug: string
  name: string
  member_count: number
}

interface VeoMember {
  id: string
  email: string
  name: string
  status: string
  permission_role: string
}

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
// Read: get cached recordings for a club
// ============================================================================

export interface CachedRecording {
  slug: string
  title: string
  duration: number
  privacy: string
  thumbnail: string
  uuid?: string
  match_date?: string
  home_team?: string | null
  away_team?: string | null
  home_score?: number | null
  away_score?: number | null
  processing_status?: string
}

export async function getCachedRecordings(
  clubSlug: string
): Promise<{ recordings: CachedRecording[]; lastSyncedAt: string | null } | null> {
  const supabase = createServiceClient() as any

  const { data, error } = await supabase
    .from('playhub_veo_recordings_cache')
    .select('*')
    .eq('club_slug', clubSlug)
    .order('match_date', { ascending: false, nullsFirst: false })

  if (error) throw new Error(`Failed to read recordings cache: ${error.message}`)
  if (!data || data.length === 0) return null

  return {
    recordings: data.map((r: any) => ({
      slug: r.match_slug,
      title: r.title || '',
      duration: r.duration || 0,
      privacy: r.privacy || 'unknown',
      thumbnail: r.thumbnail || '',
      uuid: r.uuid || undefined,
      match_date: r.match_date || undefined,
      home_team: r.home_team,
      away_team: r.away_team,
      home_score: r.home_score,
      away_score: r.away_score,
      processing_status: r.processing_status || undefined,
    })),
    lastSyncedAt: data[0]?.last_synced_at || null,
  }
}

// ============================================================================
// Read/Write: cached match content (highlights, stats, videos)
// ============================================================================

export interface CachedMatchContent {
  videos: any[]
  highlights: any[]
  stats: Record<string, unknown> | null
  lastFetchedAt: string
}

export async function getCachedMatchContent(
  matchSlug: string
): Promise<CachedMatchContent | null> {
  const supabase = createServiceClient() as any

  const { data, error } = await supabase
    .from('playhub_veo_match_content_cache')
    .select('*')
    .eq('match_slug', matchSlug)
    .single()

  if (error || !data) return null

  return {
    videos: data.videos || [],
    highlights: data.highlights || [],
    stats: data.stats || null,
    lastFetchedAt: data.last_fetched_at,
  }
}

export async function writeCachedMatchContent(
  matchSlug: string,
  content: { videos: any[]; highlights: any[]; stats: Record<string, unknown> | null }
): Promise<void> {
  const supabase = createServiceClient() as any

  await supabase.from('playhub_veo_match_content_cache').upsert(
    {
      match_slug: matchSlug,
      videos: content.videos,
      highlights: content.highlights,
      stats: content.stats,
      last_fetched_at: new Date().toISOString(),
    },
    { onConflict: 'match_slug' }
  )
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
