// Lambda function for Veo Clubhouse operations
// Routes between two actions based on EventBridge event payload:
//   - "cache-sync"   → Scrape Veo directly via Playwright and write to Supabase
//   - "cleanup-sync" → Remove canceled subscribers from Veo (calls PLAYHUB API)

import {
  getVeoSession,
  listClubTeamsWithMembers,
  listClubRecordings,
  setMatchPrivacy,
} from './veo-scraper'
import { writeCachedClubData, setSyncStatus } from './cache-writer'
import { CLUB_VEO_SLUGS, PUBLIC_RECORDING_TEAMS } from './config'

const PLAYHUB_URL = process.env.PLAYHUB_URL!
const SYNC_API_KEY = process.env.SYNC_API_KEY!
const CLUB_SLUGS = (process.env.CLUB_SLUGS || 'cfa,sefa')
  .split(',')
  .map((s) => s.trim())
const SYNC_MODE = (process.env.SYNC_MODE || 'dry-run') as 'dry-run' | 'execute'

interface EventPayload {
  action?: 'cache-sync' | 'cleanup-sync' | 'privacy-sync'
  clubSlug?: string // Optional: sync only this club (for manual triggers)
}

// Lambda Function URL events have requestContext; EventBridge events don't
interface FunctionUrlEvent {
  requestContext?: { http?: { method: string } }
  headers?: Record<string, string>
  body?: string
  isBase64Encoded?: boolean
}

interface ClubResult {
  clubSlug: string
  action: string
  status: 'success' | 'error'
  mode?: string
  removableCount?: number
  executedCount?: number
  succeededCount?: number
  failedCount?: number
  exceptedCount?: number
  teams?: number
  members?: number
  elapsed?: string
  error?: string
}

// ============================================================================
// Cache Sync — scrape Veo directly via Playwright and write to Supabase
// ============================================================================

async function runCacheSync(
  onlyClub?: string
): Promise<ClubResult[]> {
  const results: ClubResult[] = []
  const slugs = onlyClub ? [onlyClub] : CLUB_SLUGS

  for (const clubSlug of slugs) {
    const veoClubSlug = CLUB_VEO_SLUGS[clubSlug]
    if (!veoClubSlug) {
      results.push({
        clubSlug,
        action: 'cache-sync',
        status: 'error',
        error: `No Veo slug configured for club "${clubSlug}"`,
      })
      continue
    }

    let session: Awaited<ReturnType<typeof getVeoSession>> | null = null
    try {
      const start = Date.now()
      console.log(`Cache sync: ${clubSlug} (veo: ${veoClubSlug})...`)

      // Mark as syncing
      await setSyncStatus(clubSlug, veoClubSlug, 'syncing')

      // Open browser session and scrape
      session = await getVeoSession()
      const data = await listClubTeamsWithMembers(session, veoClubSlug)

      // Write to Supabase
      await writeCachedClubData(clubSlug, veoClubSlug, data)

      const totalMembers = data.teams.reduce(
        (sum, t) => sum + t.members.length,
        0
      )
      const elapsed = `${((Date.now() - start) / 1000).toFixed(1)}s`

      results.push({
        clubSlug,
        action: 'cache-sync',
        status: 'success',
        teams: data.teams.length,
        members: totalMembers,
        elapsed,
      })

      console.log(
        `${clubSlug} cache-sync: ${data.teams.length} teams, ${totalMembers} members (${elapsed})`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      console.error(`${clubSlug} cache-sync error:`, message)

      // Mark as error in Supabase
      await setSyncStatus(clubSlug, veoClubSlug, 'error', message).catch(
        () => {}
      )

      results.push({
        clubSlug,
        action: 'cache-sync',
        status: 'error',
        error: message,
      })
    } finally {
      await session?.close().catch(() => {})
    }
  }

  return results
}

// ============================================================================
// Cleanup Sync — remove canceled subscribers from Veo (existing logic)
// ============================================================================

async function runCleanupSync(): Promise<ClubResult[]> {
  const results: ClubResult[] = []

  for (const clubSlug of CLUB_SLUGS) {
    try {
      console.log(`Cleanup sync: ${clubSlug}...`)

      const response = await fetch(
        `${PLAYHUB_URL}/api/academy/${clubSlug}/veo/sync`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': SYNC_API_KEY,
          },
          body: JSON.stringify({ mode: SYNC_MODE }),
        }
      )

      if (!response.ok) {
        const text = await response.text()
        results.push({
          clubSlug,
          action: 'cleanup-sync',
          status: 'error',
          mode: SYNC_MODE,
          error: `HTTP ${response.status}: ${text}`,
        })
        continue
      }

      const data = await response.json()

      if (SYNC_MODE === 'execute') {
        results.push({
          clubSlug,
          action: 'cleanup-sync',
          status: 'success',
          mode: data.mode,
          executedCount: data.stats?.attempted ?? 0,
          succeededCount: data.stats?.succeeded ?? 0,
          failedCount: data.stats?.failed ?? 0,
          exceptedCount: data.stats?.exceptedCount ?? 0,
        })
      } else {
        results.push({
          clubSlug,
          action: 'cleanup-sync',
          status: 'success',
          mode: data.mode,
          removableCount: data.stats?.removableCount ?? 0,
          exceptedCount: data.stats?.exceptedCount ?? 0,
        })
      }

      console.log(`${clubSlug} cleanup: ${JSON.stringify(data.stats)}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      console.error(`${clubSlug} cleanup error:`, message)
      results.push({
        clubSlug,
        action: 'cleanup-sync',
        status: 'error',
        mode: SYNC_MODE,
        error: message,
      })
    }
  }

  return results
}

// ============================================================================
// Privacy Sync — set all recordings to private (except excepted teams)
// ============================================================================

async function runPrivacySync(
  onlyClub?: string
): Promise<ClubResult[]> {
  const results: ClubResult[] = []
  const slugs = onlyClub ? [onlyClub] : CLUB_SLUGS

  for (const clubSlug of slugs) {
    const veoClubSlug = CLUB_VEO_SLUGS[clubSlug]
    if (!veoClubSlug) {
      results.push({
        clubSlug,
        action: 'privacy-sync',
        status: 'error',
        error: `No Veo slug configured for club "${clubSlug}"`,
      })
      continue
    }

    let session: Awaited<ReturnType<typeof getVeoSession>> | null = null
    try {
      const start = Date.now()
      console.log(`Privacy sync: ${clubSlug} (veo: ${veoClubSlug})...`)

      session = await getVeoSession()

      const recordings = await listClubRecordings(session, veoClubSlug)
      const exceptedTeams = PUBLIC_RECORDING_TEAMS[veoClubSlug] || []

      let totalSetPrivate = 0
      let totalAlreadyPrivate = 0
      let totalSkipped = 0
      let totalErrors = 0

      for (const rec of recordings) {
        // Skip recordings belonging to excepted teams
        if (rec.team && exceptedTeams.includes(rec.team)) {
          totalSkipped++
          continue
        }

        if (rec.privacy === 'private') {
          totalAlreadyPrivate++
          continue
        }

        const res = await setMatchPrivacy(session, rec.slug, 'private')
        if (res.status === 200) {
          totalSetPrivate++
          console.log(
            `  Set private: ${rec.title} (${rec.slug}) [team: ${rec.team || 'none'}] [was: ${rec.privacy}]`
          )
        } else {
          totalErrors++
          console.error(
            `  Failed to set private: ${rec.title} (${rec.slug}) — HTTP ${res.status}`
          )
        }
        // Rate limit: wait 1s between PATCH calls
        await new Promise((r) => setTimeout(r, 1000))
      }

      const elapsed = `${((Date.now() - start) / 1000).toFixed(1)}s`

      results.push({
        clubSlug,
        action: 'privacy-sync',
        status: totalErrors > 0 ? 'error' : 'success',
        executedCount: totalSetPrivate,
        exceptedCount: totalSkipped,
        elapsed,
        error:
          totalErrors > 0 ? `${totalErrors} recordings failed` : undefined,
      })

      console.log(
        `${clubSlug} privacy-sync: ${totalSetPrivate} set private, ${totalAlreadyPrivate} already private, ${totalSkipped} skipped (excepted), ${totalErrors} errors (${elapsed})`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      console.error(`${clubSlug} privacy-sync error:`, message)
      results.push({
        clubSlug,
        action: 'privacy-sync',
        status: 'error',
        error: message,
      })
    } finally {
      await session?.close().catch(() => {})
    }
  }

  return results
}

// ============================================================================
// Handler — route based on event.action
// ============================================================================

function parseEvent(raw: EventPayload | FunctionUrlEvent): EventPayload {
  // Function URL events have requestContext
  if ('requestContext' in raw && raw.requestContext) {
    const urlEvent = raw as FunctionUrlEvent
    try {
      const body = urlEvent.body
        ? JSON.parse(
            urlEvent.isBase64Encoded
              ? Buffer.from(urlEvent.body, 'base64').toString()
              : urlEvent.body
          )
        : {}

      // Verify API key for Function URL calls
      const apiKey =
        body.apiKey || urlEvent.headers?.['x-api-key'] || ''
      if (apiKey !== SYNC_API_KEY) {
        throw new Error('Unauthorized')
      }

      return {
        action: body.action || 'cache-sync',
        clubSlug: body.clubSlug,
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'Unauthorized') throw e
      return { action: 'cache-sync' }
    }
  }
  // Direct invocation (EventBridge)
  return raw as EventPayload
}

export const handler = async (
  event: EventPayload | FunctionUrlEvent = {}
): Promise<{
  statusCode: number
  headers?: Record<string, string>
  body: string
}> => {
  let payload: EventPayload
  try {
    payload = parseEvent(event)
  } catch {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unauthorized' }),
    }
  }

  const action = payload.action || 'cleanup-sync'
  const targetClub = payload.clubSlug
  console.log(
    `Veo sync Lambda invoked (action: ${action}, club: ${targetClub || 'all'}, clubs: ${CLUB_SLUGS.join(', ')})`
  )

  let results: ClubResult[]

  if (action === 'cache-sync') {
    results = await runCacheSync(targetClub)
  } else if (action === 'privacy-sync') {
    results = await runPrivacySync(targetClub)
  } else {
    results = await runCleanupSync()
  }

  const hasErrors = results.some((r) => r.status === 'error')

  return {
    statusCode: hasErrors ? 207 : 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, results }),
  }
}
