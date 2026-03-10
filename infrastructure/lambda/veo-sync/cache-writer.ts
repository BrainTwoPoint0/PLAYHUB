// Veo cache writer for AWS Lambda
// Standalone Supabase client (no Next.js dependency)
// Adapted from src/lib/veo/cache.ts

import { createClient } from '@supabase/supabase-js'
import type { VeoTeam, VeoMember, VeoRecording } from './veo-scraper'

// ============================================================================
// Supabase client (service role — bypasses RLS)
// ============================================================================

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment'
    )
  }
  return createClient(url, key)
}

// ============================================================================
// Write: delete+insert fresh data for a club
// ============================================================================

export async function writeCachedClubData(
  clubSlug: string,
  veoClubSlug: string,
  data: { clubName: string; teams: (VeoTeam & { members: VeoMember[] })[] }
): Promise<void> {
  const supabase = getSupabase()

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
// Recordings cache: delete+insert fresh recordings for a club
// ============================================================================

export async function writeCachedRecordings(
  clubSlug: string,
  veoClubSlug: string,
  recordings: VeoRecording[]
): Promise<void> {
  const supabase = getSupabase()

  // Delete old recordings for this club
  const { error: delError } = await supabase
    .from('playhub_veo_recordings_cache')
    .delete()
    .eq('veo_club_slug', veoClubSlug)
  if (delError)
    throw new Error(`Failed to delete old recordings: ${delError.message}`)

  if (recordings.length === 0) return

  // Insert in batches of 100 (Supabase insert limit)
  const BATCH_SIZE = 100
  for (let i = 0; i < recordings.length; i += BATCH_SIZE) {
    const batch = recordings.slice(i, i + BATCH_SIZE).map((r) => ({
      club_slug: clubSlug,
      veo_club_slug: veoClubSlug,
      match_slug: r.slug,
      title: r.title || null,
      duration: r.duration != null ? Math.round(r.duration) : null,
      privacy: r.privacy || null,
      thumbnail: r.thumbnail || null,
      uuid: r.uuid || null,
      match_date: r.match_date || null,
      home_team: r.home_team || null,
      away_team: r.away_team || null,
      home_score: r.home_score ?? null,
      away_score: r.away_score ?? null,
      processing_status: r.processing_status || null,
      team: r.team || null,
      last_synced_at: new Date().toISOString(),
    }))

    const { error } = await supabase
      .from('playhub_veo_recordings_cache')
      .insert(batch)
    if (error)
      throw new Error(`Failed to insert recordings batch: ${error.message}`)
  }
}

// ============================================================================
// Auth tokens: store bearer+csrf for direct HTTP calls from Next.js
// ============================================================================

export async function storeAuthTokens(
  bearer: string,
  csrf: string
): Promise<void> {
  const supabase = getSupabase()

  const { error } = await supabase.from('playhub_veo_auth_tokens').insert({
    bearer_token: bearer,
    csrf_token: csrf,
    captured_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
    created_by: 'lambda',
  })

  if (error) {
    // Non-critical — log but don't throw
    console.warn(`Failed to store auth tokens: ${error.message}`)
  } else {
    console.log('Stored Veo auth tokens for direct API access')
  }
}

// ============================================================================
// Status: update sync status (syncing / error)
// ============================================================================

export async function setSyncStatus(
  clubSlug: string,
  veoClubSlug: string,
  status: 'syncing' | 'error',
  error?: string
): Promise<void> {
  const supabase = getSupabase()

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
