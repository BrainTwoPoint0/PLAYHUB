// Lambda function for Veo Clubhouse operations
// Routes between two actions based on EventBridge event payload:
//   - "cache-sync"   → Refresh Veo data cache in Supabase (every 4 hours)
//   - "cleanup-sync" → Remove canceled subscribers from Veo (daily)

const PLAYHUB_URL = process.env.PLAYHUB_URL!
const SYNC_API_KEY = process.env.SYNC_API_KEY!
const CLUB_SLUGS = (process.env.CLUB_SLUGS || 'cfa,sefa').split(',').map(s => s.trim())
const SYNC_MODE = (process.env.SYNC_MODE || 'dry-run') as 'dry-run' | 'execute'

interface EventPayload {
  action?: 'cache-sync' | 'cleanup-sync'
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
// Cache Sync — refresh Veo data in Supabase
// ============================================================================

async function runCacheSync(): Promise<ClubResult[]> {
  const results: ClubResult[] = []

  for (const clubSlug of CLUB_SLUGS) {
    try {
      console.log(`Cache sync: ${clubSlug}...`)

      const response = await fetch(
        `${PLAYHUB_URL}/api/academy/${clubSlug}/veo/cache-sync`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': SYNC_API_KEY,
          },
        }
      )

      if (!response.ok) {
        const text = await response.text()
        results.push({
          clubSlug,
          action: 'cache-sync',
          status: 'error',
          error: `HTTP ${response.status}: ${text}`,
        })
        continue
      }

      const data = await response.json()
      results.push({
        clubSlug,
        action: 'cache-sync',
        status: 'success',
        teams: data.stats?.teams ?? 0,
        members: data.stats?.members ?? 0,
        elapsed: data.elapsed,
      })

      console.log(`${clubSlug} cache-sync: ${JSON.stringify(data.stats)}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      console.error(`${clubSlug} cache-sync error:`, message)
      results.push({
        clubSlug,
        action: 'cache-sync',
        status: 'error',
        error: message,
      })
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
// Handler — route based on event.action
// ============================================================================

export const handler = async (event: EventPayload = {}): Promise<{
  statusCode: number
  body: string
}> => {
  const action = event.action || 'cleanup-sync'
  console.log(`Veo sync Lambda invoked (action: ${action}, clubs: ${CLUB_SLUGS.join(', ')})`)

  let results: ClubResult[]

  if (action === 'cache-sync') {
    results = await runCacheSync()
  } else {
    results = await runCleanupSync()
  }

  const hasErrors = results.some(r => r.status === 'error')

  return {
    statusCode: hasErrors ? 207 : 200,
    body: JSON.stringify({ action, results }),
  }
}
