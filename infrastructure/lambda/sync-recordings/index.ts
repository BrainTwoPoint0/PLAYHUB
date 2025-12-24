// Lambda function to sync Spiideo recordings to S3
// Uses shared Spiideo account, maps scenes to venues
// Triggered by EventBridge every 15 minutes

import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { Readable } from 'stream'
import { createClient } from '@supabase/supabase-js'

// Environment variables
const S3_BUCKET = process.env.S3_BUCKET!
const S3_REGION = process.env.S3_REGION || 'eu-west-2'
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!

// Spiideo credentials (shared account for all venues)
const SPIIDEO_CLIENT_ID = process.env.SPIIDEO_CLIENT_ID!
const SPIIDEO_CLIENT_SECRET = process.env.SPIIDEO_CLIENT_SECRET!
const SPIIDEO_ACCOUNT_ID = process.env.SPIIDEO_ACCOUNT_ID!
const SPIIDEO_USER_ID = process.env.SPIIDEO_USER_ID!

const SPIIDEO_API_BASE = 'https://api-public.spiideo.com'
const SPIIDEO_TOKEN_URL = 'https://auth-play.spiideo.net/oauth2/token'

// Token cache
let tokenCache: { token: string; expiresAt: number } | null = null

// Initialize clients
const s3Client = new S3Client({ region: S3_REGION })
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// Types
interface Game {
  id: string
  title?: string
  description?: string
  state: string
  scheduledStartTime: string
  sceneId?: string
}

interface Production {
  id: string
  type: string
}

interface Output {
  id: string
  outputType: string
}

interface SceneMapping {
  scene_id: string
  organization_id: string
  scene_name: string | null
}

interface SyncResult {
  gameId: string
  title: string
  status: 'transferred' | 'already_synced' | 'processing' | 'error'
  message: string
  s3Key?: string
  sceneId?: string
  organizationId?: string
}

// OAuth2 token helper
async function getAccessToken(): Promise<string> {
  // Check cache (5 min buffer before expiry)
  if (tokenCache && Date.now() < tokenCache.expiresAt - 300000) {
    return tokenCache.token
  }

  const basicAuth = Buffer.from(
    `${SPIIDEO_CLIENT_ID}:${SPIIDEO_CLIENT_SECRET}`
  ).toString('base64')

  const response = await fetch(SPIIDEO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to get Spiideo token: ${response.status}`)
  }

  const data = await response.json()
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }

  return data.access_token
}

// Spiideo API helpers
async function spiideoFetch(endpoint: string, options: RequestInit = {}) {
  const token = await getAccessToken()

  const response = await fetch(`${SPIIDEO_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Spiideo-Api-User': SPIIDEO_USER_ID,
      ...options.headers,
    },
  })

  if (!response.ok) {
    throw new Error(`Spiideo API error: ${response.status}`)
  }

  return response.json()
}

async function getFinishedGames(): Promise<Game[]> {
  const data = await spiideoFetch(`/v1/games?accountId=${SPIIDEO_ACCOUNT_ID}`)
  return data.content.filter((g: Game) => g.state === 'finished')
}

async function getProductions(gameId: string): Promise<Production[]> {
  const data = await spiideoFetch(`/v1/games/${gameId}/productions`)
  return data.content
}

async function getOutputs(productionId: string): Promise<Output[]> {
  const data = await spiideoFetch(`/v1/productions/${productionId}/outputs`)
  return data.content
}

async function createDownloadOutput(productionId: string): Promise<Output> {
  return spiideoFetch(`/v1/productions/${productionId}/outputs`, {
    method: 'POST',
    body: JSON.stringify({ outputType: 'download' }),
  })
}

async function getOutputProgress(
  outputId: string
): Promise<{ progress: number }> {
  const progress = await spiideoFetch(`/v1/outputs/${outputId}/progress`)
  return {
    progress: typeof progress === 'number' ? progress : progress.progress,
  }
}

async function getDownloadUri(outputId: string): Promise<string> {
  return spiideoFetch(`/v1/outputs/${outputId}/download-uri`)
}

// Get all scenes for scene name lookup
async function getScenes(): Promise<Array<{ id: string; name: string }>> {
  try {
    const data = await spiideoFetch(
      `/v1/scenes?accountId=${SPIIDEO_ACCOUNT_ID}`
    )
    return data.content || []
  } catch {
    return []
  }
}

// S3 helpers
function generateS3Key(
  gameId: string,
  productionId: string,
  matchDate: string
): string {
  const date = new Date(matchDate).toISOString().split('T')[0]
  return `recordings/${date}/${gameId}/${productionId}.mp4`
}

async function s3KeyExists(key: string): Promise<boolean> {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}

async function uploadToS3(
  downloadUrl: string,
  s3Key: string
): Promise<{ size: number }> {
  const response = await fetch(downloadUrl)
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status}`)
  }

  const contentLength = parseInt(
    response.headers.get('content-length') || '0',
    10
  )
  console.log(
    `Downloading ${Math.round(contentLength / 1024 / 1024)}MB video...`
  )

  const webStream = response.body
  if (!webStream) {
    throw new Error('No response body')
  }

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: Readable.fromWeb(webStream as any),
      ContentType: 'video/mp4',
    },
    partSize: 10 * 1024 * 1024,
    queueSize: 4,
  })

  await upload.done()
  return { size: contentLength }
}

// Database helpers
async function getExistingGameIds(): Promise<Set<string>> {
  // Only consider games as "existing" if already synced to S3
  // This allows scheduled games to be picked up once finished
  const { data } = await supabase
    .from('playhub_match_recordings')
    .select('spiideo_game_id')
    .not('spiideo_game_id', 'is', null)
    .not('s3_key', 'is', null)

  return new Set(data?.map((r) => r.spiideo_game_id) || [])
}

async function getSceneMappings(): Promise<Map<string, SceneMapping>> {
  const { data } = await supabase
    .from('playhub_scene_venue_mapping')
    .select('scene_id, organization_id, scene_name')

  const map = new Map<string, SceneMapping>()
  data?.forEach((m) => map.set(m.scene_id, m))
  return map
}

async function saveRecording(
  game: Game,
  productionId: string,
  s3Key: string,
  fileSize: number,
  organizationId: string | null,
  pitchName: string | null
): Promise<void> {
  const { error } = await supabase.from('playhub_match_recordings').upsert(
    {
      spiideo_game_id: game.id,
      spiideo_production_id: productionId,
      organization_id: organizationId,
      title: game.title || game.description || 'Untitled',
      description: game.description,
      match_date: game.scheduledStartTime,
      home_team: 'Home',
      away_team: 'Away',
      pitch_name: pitchName,
      s3_bucket: S3_BUCKET,
      s3_key: s3Key,
      file_size_bytes: fileSize,
      status: 'published',
      access_type: 'private_link',
      transferred_at: new Date().toISOString(),
    },
    { onConflict: 'spiideo_game_id' }
  )

  if (error) {
    throw new Error(`Database error: ${error.message}`)
  }
}

// Main sync logic for a single game
async function syncGame(
  game: Game,
  sceneMappings: Map<string, SceneMapping>,
  scenes: Array<{ id: string; name: string }>
): Promise<SyncResult> {
  const title = game.title || game.description || 'Unknown'

  try {
    // Get live production
    const productions = await getProductions(game.id)
    const production = productions.find((p) => p.type === 'live')

    if (!production) {
      return {
        gameId: game.id,
        title,
        status: 'error',
        message: 'No live production found',
      }
    }

    // Get organization from scene mapping
    const sceneMapping = game.sceneId ? sceneMappings.get(game.sceneId) : null
    const organizationId = sceneMapping?.organization_id || null

    // Get pitch name from scene mapping or Spiideo scenes
    let pitchName = sceneMapping?.scene_name || null
    if (!pitchName && game.sceneId) {
      const scene = scenes.find((s) => s.id === game.sceneId)
      pitchName = scene?.name || null
    }

    // Check if already in S3
    const s3Key = generateS3Key(game.id, production.id, game.scheduledStartTime)
    if (await s3KeyExists(s3Key)) {
      await saveRecording(
        game,
        production.id,
        s3Key,
        0,
        organizationId,
        pitchName
      )
      return {
        gameId: game.id,
        title,
        status: 'already_synced',
        message: 'Already in S3',
        s3Key,
        sceneId: game.sceneId,
        organizationId: organizationId || undefined,
      }
    }

    // Get or create download output
    const outputs = await getOutputs(production.id)
    let downloadOutput = outputs.find((o) => o.outputType === 'download')

    if (!downloadOutput) {
      downloadOutput = await createDownloadOutput(production.id)
    }

    // Wait for download to be ready (up to 10 minutes)
    const maxWaitMs = 10 * 60 * 1000
    const pollIntervalMs = 5000
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      const progress = await getOutputProgress(downloadOutput.id)

      if (progress.progress >= 100) {
        break
      }

      if (Date.now() - startTime + pollIntervalMs >= maxWaitMs) {
        return {
          gameId: game.id,
          title,
          status: 'processing',
          message: `Download processing (${progress.progress}%). Will retry next run.`,
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    // Download and upload to S3
    const downloadUri = await getDownloadUri(downloadOutput.id)
    console.log(`Transferring ${title} to S3...`)
    const { size } = await uploadToS3(downloadUri, s3Key)

    // Save to Supabase
    await saveRecording(
      game,
      production.id,
      s3Key,
      size,
      organizationId,
      pitchName
    )

    return {
      gameId: game.id,
      title,
      status: 'transferred',
      message: `Transferred ${Math.round(size / 1024 / 1024)}MB`,
      s3Key,
      sceneId: game.sceneId,
      organizationId: organizationId || undefined,
    }
  } catch (error) {
    return {
      gameId: game.id,
      title,
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

// Lambda handler
export const handler = async (): Promise<{
  statusCode: number
  body: string
}> => {
  console.log('Starting recording sync...')

  try {
    // Load scene mappings and scenes
    const [sceneMappings, scenes, existingGameIds] = await Promise.all([
      getSceneMappings(),
      getScenes(),
      getExistingGameIds(),
    ])

    console.log(
      `Loaded ${sceneMappings.size} scene mappings, ${scenes.length} scenes`
    )
    console.log(`Found ${existingGameIds.size} existing recordings`)

    // Get finished games
    const finishedGames = await getFinishedGames()
    console.log(`Found ${finishedGames.length} finished games`)

    // Find games that need syncing
    const gamesToSync = finishedGames.filter((g) => !existingGameIds.has(g.id))
    console.log(`${gamesToSync.length} games need syncing`)

    if (gamesToSync.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'No games to sync',
          gamesFound: finishedGames.length,
          existingRecordings: existingGameIds.size,
        }),
      }
    }

    // Sync the oldest unsynced game first (one per run to avoid timeout)
    const gameToSync = gamesToSync[gamesToSync.length - 1]
    console.log(
      `Syncing: ${gameToSync.title || gameToSync.description} (scene: ${gameToSync.sceneId})`
    )

    const result = await syncGame(gameToSync, sceneMappings, scenes)
    console.log(`Result: ${result.status} - ${result.message}`)

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Sync completed',
        gamesFound: finishedGames.length,
        needsSync: gamesToSync.length,
        result,
      }),
    }
  } catch (error) {
    console.error('Sync error:', error)
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
    }
  }
}
