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
  const now = new Date().toISOString()

  // Upsert club record
  const { error: clubError } = await supabase.from('playhub_veo_clubs').upsert(
    {
      veo_club_slug: veoClubSlug,
      club_slug: clubSlug,
      name: data.clubName,
      team_count: data.teams.length,
      last_synced_at: now,
      sync_status: 'success',
      sync_error: null,
      updated_at: now,
    },
    { onConflict: 'club_slug' }
  )
  if (clubError) throw new Error(`Failed to upsert club: ${clubError.message}`)

  // Upsert teams (uses unique constraint: veo_club_slug, veo_team_slug)
  if (data.teams.length > 0) {
    const { error: teamsError } = await supabase
      .from('playhub_veo_teams')
      .upsert(
        data.teams.map((t) => ({
          veo_team_id: t.id,
          veo_team_slug: t.slug,
          veo_club_slug: veoClubSlug,
          name: t.name,
          member_count: t.members.length,
        })),
        { onConflict: 'veo_club_slug,veo_team_slug' }
      )
    if (teamsError)
      throw new Error(`Failed to upsert teams: ${teamsError.message}`)
  }

  // Delete stale teams no longer in Veo
  const incomingTeamSlugs = data.teams.map((t) => t.slug)
  const { data: existingTeams } = await supabase
    .from('playhub_veo_teams')
    .select('veo_team_slug')
    .eq('veo_club_slug', veoClubSlug)

  const staleTeams = (existingTeams || [])
    .map((t: any) => t.veo_team_slug)
    .filter((slug: string) => !incomingTeamSlugs.includes(slug))

  if (staleTeams.length > 0) {
    // Delete members of stale teams first
    await supabase
      .from('playhub_veo_members')
      .delete()
      .eq('veo_club_slug', veoClubSlug)
      .in('veo_team_slug', staleTeams)
    await supabase
      .from('playhub_veo_teams')
      .delete()
      .eq('veo_club_slug', veoClubSlug)
      .in('veo_team_slug', staleTeams)
  }

  // Upsert members (uses unique constraint: veo_club_slug, veo_team_slug, veo_member_id)
  const allMembers = data.teams.flatMap((t) =>
    t.members.map((m) => ({
      veo_member_id: m.id,
      veo_team_slug: t.slug,
      veo_club_slug: veoClubSlug,
      email: m.email || null,
      name: m.name || null,
      status: m.status || null,
      permission_role: m.permission_role || null,
      last_seen_at: now,
    }))
  )

  if (allMembers.length > 0) {
    const BATCH_SIZE = 100
    for (let i = 0; i < allMembers.length; i += BATCH_SIZE) {
      const batch = allMembers.slice(i, i + BATCH_SIZE)
      const { error: membersError } = await supabase
        .from('playhub_veo_members')
        .upsert(batch, {
          onConflict: 'veo_club_slug,veo_team_slug,veo_member_id',
        })
      if (membersError)
        throw new Error(`Failed to upsert members: ${membersError.message}`)
    }
  }

  // Delete stale members no longer in Veo
  const incomingMemberKeys = new Set(
    allMembers.map(
      (m) => `${m.veo_club_slug}:${m.veo_team_slug}:${m.veo_member_id}`
    )
  )
  const { data: existingMembers } = await supabase
    .from('playhub_veo_members')
    .select('id, veo_club_slug, veo_team_slug, veo_member_id')
    .eq('veo_club_slug', veoClubSlug)

  const staleMemberIds = (existingMembers || [])
    .filter(
      (m: any) =>
        !incomingMemberKeys.has(
          `${m.veo_club_slug}:${m.veo_team_slug}:${m.veo_member_id}`
        )
    )
    .map((m: any) => m.id)

  if (staleMemberIds.length > 0) {
    await supabase.from('playhub_veo_members').delete().in('id', staleMemberIds)
  }
}

// ============================================================================
// Recordings cache: delete+insert fresh recordings for a club
// ============================================================================

/** Parse date from slug, e.g. "20260307-..." or "club-name-20260307-..." → "2026-03-07T00:00:00Z" */
function parseDateFromSlug(slug: string): string | null {
  const m = slug.match(/(\d{4})(\d{2})(\d{2})-/)
  return m ? `${m[1]}-${m[2]}-${m[3]}T00:00:00Z` : null
}

export async function writeCachedRecordings(
  clubSlug: string,
  veoClubSlug: string,
  recordings: VeoRecording[]
): Promise<void> {
  const supabase = getSupabase()
  const now = new Date().toISOString()

  if (recordings.length === 0) {
    // No recordings from Veo — delete all cached for this club
    await supabase
      .from('playhub_veo_recordings_cache')
      .delete()
      .eq('veo_club_slug', veoClubSlug)
    return
  }

  // Upsert in batches of 100 (uses unique constraint: veo_club_slug, match_slug)
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
      match_date: r.match_date || parseDateFromSlug(r.slug) || null,
      home_team: r.home_team || null,
      away_team: r.away_team || null,
      home_score: r.home_score ?? null,
      away_score: r.away_score ?? null,
      processing_status: r.processing_status || null,
      team: r.team || null,
      last_synced_at: now,
    }))

    const { error } = await supabase
      .from('playhub_veo_recordings_cache')
      .upsert(batch, { onConflict: 'veo_club_slug,match_slug' })
    if (error)
      throw new Error(`Failed to upsert recordings batch: ${error.message}`)
  }

  // Delete stale recordings no longer in Veo
  const incomingSlugs = recordings.map((r) => r.slug)
  const { data: existing } = await supabase
    .from('playhub_veo_recordings_cache')
    .select('match_slug')
    .eq('veo_club_slug', veoClubSlug)

  const stale = (existing || [])
    .map((r: any) => r.match_slug)
    .filter((slug: string) => !incomingSlugs.includes(slug))

  if (stale.length > 0) {
    await supabase
      .from('playhub_veo_recordings_cache')
      .delete()
      .eq('veo_club_slug', veoClubSlug)
      .in('match_slug', stale)
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
// Content precache: read/write match content cache
// ============================================================================

/**
 * Get all match slugs already in the content cache.
 * Entries marked is_processing that are older than 24h are excluded
 * so they get re-fetched on the next run.
 */
export async function getAlreadyCachedSlugs(): Promise<Set<string>> {
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from('playhub_veo_match_content_cache')
    .select('match_slug, is_processing, last_fetched_at')
    .limit(5000)

  if (error) {
    console.warn(`Failed to read cached slugs: ${error.message}`)
    return new Set()
  }

  const now = Date.now()
  const RECHECK_MS = 24 * 60 * 60 * 1000 // 24 hours

  return new Set(
    (data || [])
      .filter((r: any) => {
        // Keep in cache set (skip) if fully cached
        if (!r.is_processing) return true
        // Re-fetch processing entries older than 24h
        const age = now - new Date(r.last_fetched_at).getTime()
        return age < RECHECK_MS
      })
      .map((r: any) => r.match_slug)
  )
}

/**
 * Get all recording slugs for the given clubs, ordered by date descending (recent first).
 */
export async function getRecordingSlugsForClubs(
  clubSlugs: string[]
): Promise<string[]> {
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from('playhub_veo_recordings_cache')
    .select('match_slug, match_date')
    .in('club_slug', clubSlugs)
    .order('match_date', { ascending: false, nullsFirst: false })
    .limit(5000)

  if (error) {
    throw new Error(`Failed to read recording slugs: ${error.message}`)
  }

  return (data || []).map((r: any) => r.match_slug)
}

/**
 * Write match content to the content cache.
 */
export async function writeMatchContentCache(
  matchSlug: string,
  content: { videos: any[]; highlights: any[]; stats: any },
  isProcessing: boolean = false
): Promise<void> {
  const supabase = getSupabase()

  const { error } = await supabase
    .from('playhub_veo_match_content_cache')
    .upsert(
      {
        match_slug: matchSlug,
        videos: content.videos,
        highlights: content.highlights,
        stats: content.stats,
        is_processing: isProcessing,
        last_fetched_at: new Date().toISOString(),
      },
      { onConflict: 'match_slug' }
    )

  if (error) {
    throw new Error(
      `Failed to write content cache for ${matchSlug}: ${error.message}`
    )
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
