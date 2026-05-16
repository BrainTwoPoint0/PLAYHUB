// Veo cache writer for AWS Lambda
// Standalone Supabase client (no Next.js dependency)
// Adapted from src/lib/veo/cache.ts

import { createClient } from '@supabase/supabase-js'
import type { VeoTeam, VeoMember, VeoRecording } from './veo-scraper'

// ============================================================================
// Supabase client (service role — bypasses RLS)
// ============================================================================

export function getSupabase() {
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
// Stale-prune safety check — used across recordings, teams, and members.
//
// History (2026-05-16): every stale-prune branch in this file used the same
// pattern — delete rows in DB that aren't in the incoming Veo list. A partial
// Veo fetch (transient auth blip, Playwright navigation race, rate limit,
// silent filter regression) would shrink the incoming list and trigger a
// silent bulk delete of legitimate data. CFA lost ~150 recordings this way
// before diagnosis.
//
// Guard: if the incoming list is much smaller than what we already have,
// refuse to prune and log loudly. Set CACHE_FORCE_PRUNE=1 to bypass when
// you've manually confirmed a real shrink (e.g. a club genuinely deleted
// half their content).
// ============================================================================
const PRUNE_SHRINK_THRESHOLD = 0.5
const PRUNE_FLOOR_COUNT = 10

export function shouldSkipPrune(
  veoClubSlug: string,
  what: 'recordings' | 'teams' | 'members',
  incoming: number,
  existing: number
): boolean {
  if (process.env.CACHE_FORCE_PRUNE === '1') return false
  if (existing < PRUNE_FLOOR_COUNT) return false // small caches prune normally
  if (incoming / existing >= PRUNE_SHRINK_THRESHOLD) return false
  console.warn(
    `[cache] Skipping ${what} stale-prune for ${veoClubSlug}: ` +
      `incoming=${incoming}, existing=${existing} ` +
      `(below ${PRUNE_SHRINK_THRESHOLD * 100}% — looks like a partial fetch). ` +
      `Set CACHE_FORCE_PRUNE=1 to override.`
  )
  return true
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

  // Stale teams reconciliation — guarded against partial fetches.
  const incomingTeamSlugs = data.teams.map((t) => t.slug)
  const { data: existingTeams } = await supabase
    .from('playhub_veo_teams')
    .select('veo_team_slug')
    .eq('veo_club_slug', veoClubSlug)

  if (
    !shouldSkipPrune(
      veoClubSlug,
      'teams',
      data.teams.length,
      (existingTeams || []).length
    )
  ) {
    const staleTeams = (existingTeams || [])
      .map((t: { veo_team_slug: string }) => t.veo_team_slug)
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

  // Stale members reconciliation — guarded against partial fetches.
  const incomingMemberKeys = new Set(
    allMembers.map(
      (m) => `${m.veo_club_slug}:${m.veo_team_slug}:${m.veo_member_id}`
    )
  )
  const { data: existingMembers } = await supabase
    .from('playhub_veo_members')
    .select('id, veo_club_slug, veo_team_slug, veo_member_id')
    .eq('veo_club_slug', veoClubSlug)

  if (
    !shouldSkipPrune(
      veoClubSlug,
      'members',
      allMembers.length,
      (existingMembers || []).length
    )
  ) {
    const staleMemberIds = (existingMembers || [])
      .filter(
        (m: {
          veo_club_slug: string
          veo_team_slug: string
          veo_member_id: string
        }) =>
          !incomingMemberKeys.has(
            `${m.veo_club_slug}:${m.veo_team_slug}:${m.veo_member_id}`
          )
      )
      .map((m: { id: string }) => m.id)

    if (staleMemberIds.length > 0) {
      await supabase
        .from('playhub_veo_members')
        .delete()
        .in('id', staleMemberIds)
    }
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
    // Veo returned zero recordings. This historically triggered a bulk delete
    // of the club's entire cache, but transient Veo glitches (auth blips, the
    // recurring "Execution context was destroyed, most likely because of a
    // navigation" error from Playwright, rate limits) can produce a spurious
    // 0-result response and quietly wipe legitimate data. Diagnosed
    // 2026-05-16 after CFA's cache dropped from ~150 recordings to 15.
    //
    // No-op instead. Veo doesn't push per-recording deletes through this
    // path today, so the cache is effectively append-only. The cost is that
    // a recording legitimately removed from Veo (privacy flip, account
    // closure) lingers in our cache until manually pruned — acceptable
    // trade-off vs silent data loss.
    console.warn(
      `[recordings-cache] Veo returned 0 recordings for ${veoClubSlug} — leaving cache untouched (was previously a bulk-delete trigger).`
    )
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

  // Stale-recording reconciliation.
  //
  // Originally this branch deleted any cached recording whose slug wasn't
  // in the incoming Veo list. That made it the same-class hazard as the
  // empty-response wipe above: a partial Veo response (e.g. `filter=own`
  // returning 15 when the workspace truly has ~165) would silently delete
  // the missing 150. Diagnosed 2026-05-16 — this path is what actually
  // wiped CFA, not the empty-response branch.
  //
  // Guard: only run the stale-prune when the incoming list is at least
  // ~half the size of the current cache. Anything smaller is statistically
  // a partial fetch (filter regression, pagination bug, rate limit) rather
  // than a real corpus shrink. Real shrinks > 50% are rare enough that
  // catching them via manual reconciliation is acceptable.
  const incomingSlugs = recordings.map((r) => r.slug)
  const { data: existing } = await supabase
    .from('playhub_veo_recordings_cache')
    .select('match_slug')
    .eq('veo_club_slug', veoClubSlug)

  if (
    shouldSkipPrune(
      veoClubSlug,
      'recordings',
      recordings.length,
      (existing || []).length
    )
  ) {
    return
  }

  const stale = (existing || [])
    .map((r: { match_slug: string }) => r.match_slug)
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
