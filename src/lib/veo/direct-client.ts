// Direct Veo API Client — uses stored auth tokens for server-side fetch
// No Playwright/browser dependency. Tokens are stored in Supabase by the Lambda.

import { createServiceClient } from '@/lib/supabase/server'

const VEO_BASE = 'https://app.veo.co'

interface VeoApiResult {
  status: number
  body: string
}

interface StoredTokens {
  bearer: string
  csrf: string
  expiresAt: string
}

// ============================================================================
// Token storage (Supabase)
// ============================================================================

export async function getStoredTokens(): Promise<StoredTokens | null> {
  const supabase = createServiceClient() as any

  const { data, error } = await supabase
    .from('playhub_veo_auth_tokens')
    .select('bearer_token, csrf_token, expires_at')
    .gt('expires_at', new Date().toISOString())
    .order('captured_at', { ascending: false })
    .limit(1)
    .single()

  if (error || !data) return null

  return {
    bearer: data.bearer_token,
    csrf: data.csrf_token,
    expiresAt: data.expires_at,
  }
}

export async function storeTokens(
  bearer: string,
  csrf: string,
  source = 'manual'
): Promise<void> {
  const supabase = createServiceClient() as any

  await supabase.from('playhub_veo_auth_tokens').insert({
    bearer_token: bearer,
    csrf_token: csrf,
    captured_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
    created_by: source,
  })
}

// ============================================================================
// Direct API calls (no Playwright)
// ============================================================================

async function veoFetch(
  method: string,
  path: string,
  tokens: StoredTokens,
  body?: unknown
): Promise<VeoApiResult> {
  const url = `${VEO_BASE}${path}`

  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.bearer}`,
    'X-CSRFToken': tokens.csrf,
    Accept: 'application/json',
  }

  const opts: RequestInit = { method, headers }
  if (body) {
    headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }

  const res = await fetch(url, opts)
  const text = await res.text()
  return { status: res.status, body: text }
}

function parseBody(body: string): any {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

// ============================================================================
// Validation
// ============================================================================

const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/

function validateSlug(slug: string, label: string): void {
  if (!slug || !SLUG_PATTERN.test(slug)) {
    throw new Error(`Invalid ${label} format`)
  }
}

// ============================================================================
// Public API — mirrors functions from client.ts but uses direct fetch
// ============================================================================

export interface VeoRecording {
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

export interface VeoVideo {
  id: string
  url: string
  type?: string
  width?: number
  height?: number
}

export interface VeoHighlight {
  id: string
  start: number
  duration: number
  tags: string[]
  team_association?: string
  thumbnail?: string
  videos?: VeoVideo[]
  is_ai_generated?: boolean
}

export interface MatchContent {
  videos: VeoVideo[]
  highlights: VeoHighlight[]
  stats: Record<string, unknown> | null
}

/**
 * List recordings for a club using direct HTTP (no Playwright)
 * Paginates through all pages automatically.
 */
export async function listRecordingsDirect(
  clubSlug: string
): Promise<{ recordings: VeoRecording[] }> {
  validateSlug(clubSlug, 'club slug')

  const tokens = await getStoredTokens()
  if (!tokens) {
    throw new Error(
      'No valid Veo auth tokens. Use the token refresh endpoint or trigger a Lambda sync.'
    )
  }

  const PAGE_SIZE = 100
  const MAX_PAGES = 50
  const allRecordings: VeoRecording[] = []
  let page = 1

  while (page <= MAX_PAGES) {
    const res = await veoFetch(
      'GET',
      `/api/app/clubs/${clubSlug}/recordings/?filter=own&fields=privacy&fields=title&fields=slug&fields=duration&fields=thumbnail&fields=uuid&fields=match_date&fields=home_team&fields=away_team&fields=home_score&fields=away_score&fields=processing_status&page_size=${PAGE_SIZE}&page=${page}`,
      tokens
    )

    if (res.status === 401) {
      throw new Error('Veo auth tokens expired. Refresh tokens and try again.')
    }

    if (res.status !== 200) {
      throw new Error(`Veo API error: ${res.status}`)
    }

    const parsed = parseBody(res.body)
    if (!parsed) break

    // Handle paginated { count, next, results: [...] } or plain array
    const items: VeoRecording[] = Array.isArray(parsed)
      ? parsed
      : parsed?.results || []

    allRecordings.push(...items)

    // Stop if fewer than page_size results (last page)
    if (items.length < PAGE_SIZE) break

    // For paginated objects, also check the next field
    if (!Array.isArray(parsed) && !parsed?.next) break

    page++
  }

  return { recordings: allRecordings }
}

/**
 * Get videos, highlights, and stats for a single match using direct HTTP
 */
export async function getMatchContentDirect(
  matchSlug: string
): Promise<MatchContent> {
  validateSlug(matchSlug, 'match slug')

  const tokens = await getStoredTokens()
  if (!tokens) {
    throw new Error(
      'No valid Veo auth tokens. Use the token refresh endpoint or trigger a Lambda sync.'
    )
  }

  const [videosRes, highlightsRes, statsRes] = await Promise.all([
    veoFetch('GET', `/api/app/matches/${matchSlug}/videos/`, tokens),
    veoFetch(
      'GET',
      `/api/app/matches/${matchSlug}/highlights/?include_ai=true&fields=id&fields=start&fields=duration&fields=tags&fields=team_association&fields=thumbnail&fields=videos&fields=is_ai_generated`,
      tokens
    ),
    veoFetch('GET', `/api/app/matches/${matchSlug}/stats/`, tokens),
  ])

  // Check for 401 on any response
  if (
    videosRes.status === 401 ||
    highlightsRes.status === 401 ||
    statsRes.status === 401
  ) {
    throw new Error('Veo auth tokens expired. Refresh tokens and try again.')
  }

  const videos: VeoVideo[] =
    videosRes.status === 200 ? parseBody(videosRes.body) || [] : []
  const highlights: VeoHighlight[] =
    highlightsRes.status === 200 ? parseBody(highlightsRes.body) || [] : []
  const stats: Record<string, unknown> | null =
    statsRes.status === 200 ? parseBody(statsRes.body) : null

  return { videos, highlights, stats }
}
