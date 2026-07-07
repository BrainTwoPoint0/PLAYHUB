// Lambda function to sync Spiideo recordings to S3
// Uses shared Spiideo account, maps scenes to venues
// Triggered by EventBridge every 15 minutes

import {
  S3Client,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { Readable } from 'stream'
import { createClient } from '@supabase/supabase-js'
import {
  findZombieRecordings,
  sweepZombie,
  type ZombieCandidate,
} from './zombies'

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

const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const ALERT_EMAIL = process.env.ALERT_EMAIL || ''
const APP_URL = process.env.APP_URL || 'https://playhub.playbacksports.ai'

// Simple HTML escaping for email templates
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const SPIIDEO_API_BASE = 'https://api-public.spiideo.com'
const SPIIDEO_TOKEN_URL = 'https://auth-play.spiideo.net/oauth2/token'

// Stuck recording thresholds (at 15-min intervals)
const RETRY_THRESHOLD = 12 // ~3 hours: delete stuck output + recreate
const GIVE_UP_THRESHOLD = 24 // ~3 more hours after retry: stop retrying

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
  const doFetch = async (token: string) =>
    fetch(`${SPIIDEO_API_BASE}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Spiideo-Api-User': SPIIDEO_USER_ID,
        ...options.headers,
      },
    })

  let response = await doFetch(await getAccessToken())

  // On 401/403, force-refresh the cached token once. Prevents a single
  // expired/rotated token from stalling the entire sync run.
  if (response.status === 401 || response.status === 403) {
    tokenCache = null
    response = await doFetch(await getAccessToken())
  }

  if (!response.ok) {
    throw new Error(`Spiideo API error: ${response.status}`)
  }

  // Some endpoints return 202/204 with an empty body (notably the
  // create-output POST and the delete-output DELETE). Calling
  // response.json() on an empty body throws "Unexpected end of JSON
  // input", which silently broke the stuck-output auto-recovery. Tolerate
  // empty/non-JSON bodies by returning null.
  const text = await response.text()
  return text ? JSON.parse(text) : null
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
  await spiideoFetch(`/v1/productions/${productionId}/outputs`, {
    method: 'POST',
    body: JSON.stringify({ outputType: 'download' }),
  })
  // The POST returns 202 Accepted with an empty body and creates the
  // output asynchronously, so re-fetch the outputs list to resolve the new
  // object (callers rely on its `id` for the progress poll). Retry briefly
  // to absorb read-after-write lag. The POST side-effect persists
  // regardless — a later cron run will still discover the output via
  // getOutputs (assumes a single download output per production).
  for (let attempt = 0; attempt < 3; attempt++) {
    const outputs = await getOutputs(productionId)
    const created = outputs.find((o) => o.outputType === 'download')
    if (created) return created
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error(
    `Created download output not found for production ${productionId}`
  )
}

async function deleteOutput(outputId: string): Promise<void> {
  await spiideoFetch(`/v1/outputs/${outputId}`, { method: 'DELETE' })
}

async function getOutputProgress(
  outputId: string
): Promise<{ progress: number }> {
  const progress = await spiideoFetch(`/v1/outputs/${outputId}/progress`)
  if (typeof progress === 'number') {
    return { progress }
  }
  // Treat a null/empty or unexpected body as 0% rather than throwing. This
  // poll runs inside the retry ladder — a flaky progress response must stay
  // in the attempt-counting loop (so the game advances toward GIVE_UP)
  // instead of escaping to syncGame's catch, which would leave it stuck
  // without ever incrementing sync_attempts.
  return { progress: progress?.progress ?? 0 }
}

async function getDownloadUri(outputId: string): Promise<string> {
  const uri = await spiideoFetch(`/v1/outputs/${outputId}/download-uri`)
  if (!uri || typeof uri !== 'string') {
    throw new Error(`Empty download-uri response for output ${outputId}`)
  }
  return uri
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

// Returns ContentLength in bytes, or null if the object does not exist.
// Replaces a prior `s3KeyExists(): boolean` helper — the extra byte-count
// is free (HEAD returns it) and lets callers persist real file sizes on
// the "already synced" recovery path instead of overwriting with zero.
async function s3KeySize(key: string): Promise<number | null> {
  try {
    const head = await s3Client.send(
      new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key })
    )
    return typeof head.ContentLength === 'number' ? head.ContentLength : null
  } catch {
    return null
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
interface ZombieRow extends ZombieCandidate {
  sync_attempts: number | null
}

async function getExistingGameIds(): Promise<{
  excluded: Set<string>
  zombies: ZombieRow[]
}> {
  // A game is excluded from the sync queue if:
  //   - already synced to S3 (s3_key not null), OR
  //   - permanently given up on (sync_attempts >= GIVE_UP_THRESHOLD), OR
  //   - explicitly marked failed (e.g. orphan game with no live production), OR
  //   - tombstoned by a user-initiated PLAYHUB delete (Spiideo's DELETE only
  //     unschedules; without this the orphan branch re-creates the row).
  // This guarantees a broken game can never stall the queue across runs.
  // PostgREST caps .select() at 1000 rows by default — raise the ceiling
  // so we never silently truncate the exclusion set at scale (a truncated
  // set would re-admit already-synced or permanently-failed games into
  // the queue on every run).
  const EXCLUSION_CAP = 49999
  const [recordingsResult, tombstonesResult] = await Promise.all([
    supabase
      .from('playhub_match_recordings')
      .select('id, spiideo_game_id, s3_key, s3_bucket, sync_attempts, status')
      .not('spiideo_game_id', 'is', null)
      .range(0, EXCLUSION_CAP),
    supabase
      .from('playhub_deleted_spiideo_games')
      .select('spiideo_game_id')
      .range(0, EXCLUSION_CAP),
  ])

  // Fail loudly on either query error. A swallowed error would leave the
  // excluded set incomplete and the orphan branch would re-create rows for
  // already-synced or tombstoned games — exactly the failure mode the
  // tombstone table exists to prevent.
  if (recordingsResult.error) {
    throw new Error(
      `getExistingGameIds: recordings query failed: ${recordingsResult.error.message}`
    )
  }
  if (tombstonesResult.error) {
    throw new Error(
      `getExistingGameIds: tombstones query failed: ${tombstonesResult.error.message}`
    )
  }

  // Hard-stop if either query hits the 50K cap. Silent truncation here
  // re-admits already-synced games into the sync queue and burns S3/Spiideo
  // bandwidth on redundant transfers. When this fires, switch to keyset
  // pagination (or aggressive cleanup) rather than just raising the cap.
  const recordings = recordingsResult.data || []
  const tombstones = tombstonesResult.data || []
  if (recordings.length > EXCLUSION_CAP) {
    throw new Error(
      `getExistingGameIds: recordings query hit ${EXCLUSION_CAP + 1}-row cap — paginate before more rows are silently excluded`
    )
  }
  if (tombstones.length > EXCLUSION_CAP) {
    throw new Error(
      `getExistingGameIds: tombstones query hit ${EXCLUSION_CAP + 1}-row cap — paginate before more rows are silently excluded`
    )
  }

  const excluded = new Set<string>()
  for (const r of recordings) {
    const synced = r.s3_key !== null
    const givenUp = (r.sync_attempts ?? 0) >= GIVE_UP_THRESHOLD
    const failed = r.status === 'failed'
    if (synced || givenUp || failed) {
      excluded.add(r.spiideo_game_id)
    }
  }
  const tombstonedGameIds = new Set<string>()
  for (const t of tombstones) {
    excluded.add(t.spiideo_game_id)
    tombstonedGameIds.add(t.spiideo_game_id)
  }

  // A surviving row whose game is tombstoned means the app's DELETE flow
  // died between the tombstone write and the row delete — hand these to
  // the handler so the sweep can finish the deletion.
  const zombies = findZombieRecordings(
    recordings as ZombieRow[],
    tombstonedGameIds
  )

  return { excluded, zombies }
}

// Finish deletions the app's DELETE endpoint started but never completed
// (tombstone written, row still present). Per zombie: stop the game if it
// is somehow still recording, delete it on Spiideo, remove the S3 object,
// then the row (orchestration + gating rules live in zombies.ts). The
// tombstone stays — it is the permanent exclusion marker.
async function sweepZombieRecordings(zombies: ZombieRow[]): Promise<number> {
  let swept = 0
  for (const zombie of zombies) {
    try {
      const result = await sweepZombie(zombie, {
        getGameState: async (gameId) => {
          const game = await spiideoFetch(`/v1/games/${gameId}`)
          return game?.state ?? 'unknown'
        },
        stopGame: async (gameId) => {
          // Spiideo requires the stop time to be in the future.
          const stopTime = new Date(Date.now() + 60 * 1000).toISOString()
          await spiideoFetch(`/v1/games/${gameId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              action: 'updateGame',
              scheduledStopTime: { action: 'replace', value: stopTime },
            }),
          })
        },
        deleteGame: async (gameId) => {
          await spiideoFetch(`/v1/games/${gameId}`, { method: 'DELETE' })
        },
        deleteS3Object: async (bucket, key) => {
          // The IAM policy only covers our recordings bucket — a row
          // pointing anywhere else would AccessDeny and silently orphan.
          if (bucket !== S3_BUCKET) {
            throw new Error(
              `refusing S3 delete: row bucket '${bucket}' is not the recordings bucket '${S3_BUCKET}'`
            )
          }
          await s3Client.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: key })
          )
        },
        deleteRow: async (id) => {
          const { error } = await supabase
            .from('playhub_match_recordings')
            .delete()
            .eq('id', id)
          if (error) throw new Error(error.message)
        },
      })
      if (result === 'swept') swept++
    } catch (err) {
      console.error(`Zombie sweep: unexpected error for ${zombie.id}:`, err)
    }
  }
  return swept
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
      venue_organization_id: organizationId,
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

  // Mark as billable now that video exists (only for pre-booked recordings with billing config)
  await supabase
    .from('playhub_match_recordings')
    .update({ is_billable: true })
    .eq('spiideo_game_id', game.id)
    .not('billable_amount', 'is', null)
}

// Sync attempt tracking
async function getSyncAttempts(
  gameId: string
): Promise<{ attempts: number; recordingExists: boolean }> {
  const { data } = await supabase
    .from('playhub_match_recordings')
    .select('sync_attempts')
    .eq('spiideo_game_id', gameId)
    .single()

  if (!data) return { attempts: 0, recordingExists: false }
  return { attempts: data.sync_attempts || 0, recordingExists: true }
}

async function updateSyncAttempts(
  gameId: string,
  attempts: number,
  lastError: string | null
): Promise<void> {
  const { error } = await supabase
    .from('playhub_match_recordings')
    .update({ sync_attempts: attempts, last_sync_error: lastError })
    .eq('spiideo_game_id', gameId)

  if (error) {
    console.error(
      `Failed to update sync_attempts for ${gameId}:`,
      error.message
    )
  }
}

async function upsertFailedRecording(
  game: Game,
  organizationId: string | null,
  pitchName: string | null,
  lastError: string
): Promise<void> {
  // Throws on DB error so callers can skip the alert when persistence
  // failed — otherwise we'd send the alert without the skip marker
  // getting saved, which means the next run re-alerts. Forever.
  const { error } = await supabase.from('playhub_match_recordings').upsert(
    {
      spiideo_game_id: game.id,
      organization_id: organizationId,
      venue_organization_id: organizationId,
      title: game.title || game.description || 'Untitled',
      description: game.description,
      match_date: game.scheduledStartTime,
      home_team: 'Home',
      away_team: 'Away',
      pitch_name: pitchName,
      status: 'failed',
      access_type: 'private_link',
      sync_attempts: GIVE_UP_THRESHOLD,
      last_sync_error: lastError,
    },
    { onConflict: 'spiideo_game_id' }
  )

  if (error) {
    throw new Error(
      `Failed to upsert failed recording for ${game.id}: ${error.message}`
    )
  }
}

async function upsertProcessingRecording(
  game: Game,
  productionId: string,
  organizationId: string | null,
  pitchName: string | null,
  attempts: number,
  lastError: string
): Promise<void> {
  const { error } = await supabase.from('playhub_match_recordings').upsert(
    {
      spiideo_game_id: game.id,
      spiideo_production_id: productionId,
      organization_id: organizationId,
      venue_organization_id: organizationId,
      title: game.title || game.description || 'Untitled',
      description: game.description,
      match_date: game.scheduledStartTime,
      home_team: 'Home',
      away_team: 'Away',
      pitch_name: pitchName,
      status: 'processing',
      access_type: 'private_link',
      sync_attempts: attempts,
      last_sync_error: lastError,
    },
    { onConflict: 'spiideo_game_id' }
  )

  if (error) {
    console.error(
      `Failed to upsert processing recording for ${game.id}:`,
      error.message
    )
  }
}

// Alert email via Resend
async function sendSyncAlertEmail(
  subject: string,
  details: {
    gameId: string
    title: string
    matchDate: string
    pitchName: string | null
    attempts: number
    lastError: string
    isRetryExhausted: boolean
  }
): Promise<void> {
  if (!RESEND_API_KEY || !ALERT_EMAIL) {
    console.warn('RESEND_API_KEY or ALERT_EMAIL not set, skipping alert email')
    return
  }

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: ${details.isRetryExhausted ? '#dc2626' : '#f59e0b'};">
        ${details.isRetryExhausted ? '🚨 Recording Sync Failed' : '⚠️ Recording Stuck — Retrying'}
      </h2>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px; font-weight: bold;">Title</td><td style="padding: 8px;">${details.title}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Game ID</td><td style="padding: 8px; font-family: monospace;">${details.gameId}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Match Date</td><td style="padding: 8px;">${details.matchDate}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Pitch</td><td style="padding: 8px;">${details.pitchName || 'Unknown'}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Sync Attempts</td><td style="padding: 8px;">${details.attempts}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Last Status</td><td style="padding: 8px;">${details.lastError}</td></tr>
      </table>
      <p style="margin-top: 16px; color: #6b7280;">
        ${
          details.isRetryExhausted
            ? 'The download output was recreated after the first 8 attempts, but the retry also failed. Manual investigation required.'
            : 'The stuck download output has been deleted and a fresh one created. The Lambda will continue retrying automatically.'
        }
      </p>
    </div>
  `

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'PLAYHUB Alerts <admin@playbacksports.ai>',
        to: [ALERT_EMAIL],
        subject,
        html,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      console.error(`Resend API error: ${response.status} ${text}`)
    } else {
      console.log(`Alert email sent to ${ALERT_EMAIL}`)
    }
  } catch (error) {
    console.error('Failed to send alert email:', error)
  }
}

// Send "recording ready" emails to all users with access to a recording
async function sendRecordingReadyEmails(
  spiideoGameId: string,
  recordingTitle: string,
  matchDate: string,
  organizationId: string | null
): Promise<void> {
  if (!RESEND_API_KEY) return

  try {
    // Get the recording ID from the game ID
    const { data: recording } = await supabase
      .from('playhub_match_recordings')
      .select('id')
      .eq('spiideo_game_id', spiideoGameId)
      .single()

    if (!recording) return

    // Get venue name
    let venueName: string | undefined
    if (organizationId) {
      const { data: venue } = await supabase
        .from('organizations')
        .select('name')
        .eq('id', organizationId)
        .single()
      venueName = venue?.name
    }

    // Get all users with access to this recording
    const { data: accessRights } = await supabase
      .from('playhub_access_rights')
      .select('user_id, invited_email')
      .eq('match_recording_id', recording.id)
      .eq('is_active', true)

    if (!accessRights || accessRights.length === 0) return

    // Get emails for users with user_id
    const userIds = accessRights
      .map((a: any) => a.user_id)
      .filter((id: string | null) => id !== null)

    let userEmails: string[] = []
    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('email')
        .in('user_id', userIds)

      userEmails = profiles?.map((p: any) => p.email).filter(Boolean) || []
    }

    // Also include invited emails
    const invitedEmails = accessRights
      .map((a: any) => a.invited_email)
      .filter((email: string | null) => email !== null)

    const allEmails = Array.from(new Set([...userEmails, ...invitedEmails]))
    if (allEmails.length === 0) return

    const formattedDate = new Date(matchDate).toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })

    const safeTitle = escapeHtml(recordingTitle)
    const safeVenueName = venueName ? escapeHtml(venueName) : undefined

    const emailHtml = `
              <!DOCTYPE html>
              <html>
              <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
              <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0a100d; color: #d6d5c9; padding: 40px 20px; margin: 0;">
                <div style="max-width: 500px; margin: 0 auto;">
                  <h1 style="color: #d6d5c9; font-size: 24px; margin-bottom: 24px;">PLAYHUB</h1>
                  <p style="font-size: 16px; line-height: 1.6; margin-bottom: 16px;">Great news! Your recording is now ready to watch:</p>
                  <div style="background-color: #1a1f1c; padding: 16px; border-radius: 8px; margin-bottom: 24px;">
                    <p style="font-size: 18px; font-weight: 500; margin: 0 0 4px 0;">${safeTitle}</p>
                    ${safeVenueName ? `<p style="font-size: 14px; color: #b9baa3; margin: 0;">${safeVenueName}</p>` : ''}
                    <p style="font-size: 14px; color: #b9baa3; margin: 4px 0 0 0;">${formattedDate}</p>
                  </div>
                  <a href="${APP_URL}/recordings" style="display: inline-block; background-color: #d6d5c9; color: #0a100d; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500;">Watch now</a>
                  <hr style="border: none; border-top: 1px solid #333; margin: 32px 0;">
                  <p style="font-size: 12px; color: #b9baa3;">This email was sent by PLAYHUB.</p>
                </div>
              </body>
              </html>
            `

    // Fan out in parallel with Promise.allSettled + per-email 10s
    // AbortController timeout. A hung Resend request on one recipient
    // used to block every subsequent email serially, which in turn
    // delayed the Lambda's remaining sync work (and risked Lambda
    // timeout). Now one slow/failed email has zero blast radius on
    // the others or on the overall sync run.
    const EMAIL_TIMEOUT_MS = 10_000
    const sendOne = async (email: string) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS)
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'PLAYHUB <admin@playbacksports.ai>',
            to: [email],
            subject: `Your recording is ready: "${recordingTitle}"`,
            html: emailHtml,
          }),
          signal: controller.signal,
        })
        if (!response.ok) {
          const text = await response.text()
          console.error(
            `Resend API error for ${email}: ${response.status} ${text}`
          )
        }
      } catch (emailErr) {
        console.error(
          `Failed to send recording ready email to ${email}:`,
          emailErr
        )
      } finally {
        clearTimeout(timer)
      }
    }

    const outcomes = await Promise.allSettled(allEmails.map(sendOne))
    const failed = outcomes.filter((o) => o.status === 'rejected').length
    console.log(
      `Sent recording ready emails to ${allEmails.length} users for game ${spiideoGameId} (${failed} failed)`
    )
  } catch (error) {
    console.error('Failed to send recording ready emails:', error)
  }
}

// Detect stale bookings: recordings stuck in "scheduled" status long after expected finish
async function detectStaleBookings(): Promise<void> {
  if (!RESEND_API_KEY || !ALERT_EMAIL) return

  try {
    // Find recordings where:
    // - status is 'scheduled'
    // - match_date + assumed max duration (3 hours) is more than 2 hours ago
    // - no s3_key (never synced)
    // - last_sync_error does not contain 'stale_alerted' (not already alerted)
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()

    const { data: staleRecordings } = await supabase
      .from('playhub_match_recordings')
      .select(
        'id, title, match_date, pitch_name, organization_id, spiideo_game_id, last_sync_error'
      )
      .eq('status', 'scheduled')
      .is('s3_key', null)
      .lt('match_date', fiveHoursAgo)

    if (!staleRecordings || staleRecordings.length === 0) return

    // Filter out already-alerted recordings
    const toAlert = staleRecordings.filter(
      (r) => !r.last_sync_error?.includes('stale_alerted')
    )

    if (toAlert.length === 0) return

    console.log(`Found ${toAlert.length} stale bookings`)

    for (const recording of toAlert) {
      await sendSyncAlertEmail(`⚠️ Stale booking: ${recording.title}`, {
        gameId: recording.spiideo_game_id || recording.id,
        title: recording.title || 'Untitled',
        matchDate: recording.match_date,
        pitchName: recording.pitch_name,
        attempts: 0,
        lastError:
          'Recording stuck in "scheduled" status — never started or synced',
        isRetryExhausted: true,
      })

      // Mark as alerted to avoid duplicate alerts
      const existingError = recording.last_sync_error || ''
      await supabase
        .from('playhub_match_recordings')
        .update({
          last_sync_error: existingError
            ? `${existingError}; stale_alerted`
            : 'stale_alerted',
        })
        .eq('id', recording.id)
    }

    console.log(`Sent stale booking alerts for ${toAlert.length} recordings`)
  } catch (error) {
    console.error('Failed to detect stale bookings:', error)
  }
}

// Main sync logic for a single game.
//
// `deadlineMs` is an absolute epoch-ms at which this call must return.
// Individual internal waits (notably the download-readiness poll loop)
// clamp themselves to this so we never run past the Lambda timeout.
async function syncGame(
  game: Game,
  sceneMappings: Map<string, SceneMapping>,
  scenes: Array<{ id: string; name: string }>,
  deadlineMs: number = Date.now() + 13 * 60 * 1000
): Promise<SyncResult> {
  const title = game.title || game.description || 'Unknown'

  try {
    // Resolve org + pitch up-front so we can annotate errors with context
    const sceneMapping = game.sceneId ? sceneMappings.get(game.sceneId) : null
    const organizationId = sceneMapping?.organization_id || null

    let pitchName = sceneMapping?.scene_name || null
    if (!pitchName && game.sceneId) {
      const scene = scenes.find((s) => s.id === game.sceneId)
      pitchName = scene?.name || null
    }

    // Get live production
    const productions = await getProductions(game.id)
    const production = productions.find((p) => p.type === 'live')

    if (!production) {
      // Terminal failure: a finished game must have a live production.
      // Persist a 'failed' row so the queue excludes it on future runs,
      // and alert once (the upsert is keyed on spiideo_game_id, so
      // subsequent orphan detections for the same game just no-op here
      // because getExistingGameIds filters it out before we get here).
      const reason =
        productions.length === 0
          ? 'No productions found — game exists in Spiideo but was never recorded (orphan). Auto-skipped.'
          : `Live production missing. Available: ${productions.map((p) => p.type).join(', ')}. Auto-skipped.`

      // Persist the skip marker FIRST. If this throws (Supabase outage),
      // we deliberately skip the alert: otherwise every 15-min run would
      // re-detect the orphan and re-send the alert forever. Next run
      // will try to persist again cleanly.
      try {
        await upsertFailedRecording(
          game,
          organizationId,
          pitchName,
          'orphan_no_production'
        )
      } catch (persistErr) {
        console.error(
          `Could not persist orphan marker for ${game.id} — skipping alert, will retry next run:`,
          persistErr
        )
        return {
          gameId: game.id,
          title,
          status: 'error',
          message: 'Orphan detected but persistence failed',
        }
      }

      await sendSyncAlertEmail(`⚠️ Orphan game skipped: ${title}`, {
        gameId: game.id,
        title,
        matchDate: game.scheduledStartTime,
        pitchName,
        attempts: GIVE_UP_THRESHOLD,
        lastError: reason,
        isRetryExhausted: true,
      })

      return {
        gameId: game.id,
        title,
        status: 'error',
        message: 'No live production found (auto-skipped)',
      }
    }

    // Check if already in S3. Recovering the real ContentLength here
    // matters: `saveRecording` upserts `file_size_bytes`, and writing 0
    // would blow away a correct size previously persisted on the initial
    // transfer (e.g. this branch fires when a prior run uploaded to S3
    // but the DB write failed and we're re-linking on a later run).
    const s3Key = generateS3Key(game.id, production.id, game.scheduledStartTime)
    const existingSize = await s3KeySize(s3Key)
    if (existingSize !== null) {
      await saveRecording(
        game,
        production.id,
        s3Key,
        existingSize,
        organizationId,
        pitchName
      )
      // Send "recording ready" emails (may have been missed if DB record was created without S3)
      await sendRecordingReadyEmails(
        game.id,
        title,
        game.scheduledStartTime,
        organizationId
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

    // Check existing sync attempts from DB
    const { attempts: prevAttempts } = await getSyncAttempts(game.id)

    // If we've given up after retry, skip this game
    if (prevAttempts >= GIVE_UP_THRESHOLD) {
      return {
        gameId: game.id,
        title,
        status: 'error',
        message: `Gave up after ${prevAttempts} attempts. Manual intervention required.`,
      }
    }

    // Get or create download output
    const outputs = await getOutputs(production.id)
    let downloadOutput = outputs.find((o) => o.outputType === 'download')

    if (!downloadOutput) {
      downloadOutput = await createDownloadOutput(production.id)
    }

    // Wait for download to be ready, bounded by BOTH a fixed max wait
    // AND the shared Lambda-run deadline. Whichever comes first wins —
    // we must never out-wait the Lambda timeout, even if this game was
    // picked up with plenty of budget (a previous game burned more than
    // expected). We also leave 30s of margin so the Lambda can still
    // return a response + run detectStaleBookings before SIGKILL.
    const maxWaitMs = 10 * 60 * 1000
    const pollIntervalMs = 5000
    const startTime = Date.now()
    const hardDeadline = Math.min(startTime + maxWaitMs, deadlineMs - 30_000)
    let lastProgress = 0

    while (Date.now() < hardDeadline) {
      const progress = await getOutputProgress(downloadOutput.id)
      lastProgress = progress.progress

      if (progress.progress >= 100) {
        break
      }

      if (Date.now() + pollIntervalMs >= hardDeadline) {
        // Download still not ready — track the attempt
        const newAttempts = prevAttempts + 1
        const errorMsg = `Download stuck at ${progress.progress}% (attempt ${newAttempts})`
        console.log(errorMsg)

        // Upsert so the recording row exists to track attempts
        await upsertProcessingRecording(
          game,
          production.id,
          organizationId,
          pitchName,
          newAttempts,
          errorMsg
        )

        if (newAttempts === RETRY_THRESHOLD) {
          // ~2 hours stuck: delete output, recreate, send alert
          console.log(
            `Attempt ${newAttempts}: deleting stuck output ${downloadOutput.id} and recreating...`
          )
          try {
            await deleteOutput(downloadOutput.id)
            await createDownloadOutput(production.id)
            // Reset counter so the retry gets a fresh 8-attempt window
            await updateSyncAttempts(
              game.id,
              RETRY_THRESHOLD,
              `Recreated download output at attempt ${newAttempts}`
            )
          } catch (retryError) {
            console.error('Failed to recreate download output:', retryError)
          }

          await sendSyncAlertEmail(`⚠️ Stuck recording: ${title}`, {
            gameId: game.id,
            title,
            matchDate: game.scheduledStartTime,
            pitchName,
            attempts: newAttempts,
            lastError: errorMsg,
            isRetryExhausted: false,
          })
        } else if (newAttempts >= GIVE_UP_THRESHOLD) {
          // ~4 hours after retry: give up + send final alert
          console.log(`Attempt ${newAttempts}: giving up on ${game.id}`)

          await sendSyncAlertEmail(`🚨 Recording sync failed: ${title}`, {
            gameId: game.id,
            title,
            matchDate: game.scheduledStartTime,
            pitchName,
            attempts: newAttempts,
            lastError: `Still stuck after output recreation. ${errorMsg}`,
            isRetryExhausted: true,
          })
        }

        return {
          gameId: game.id,
          title,
          status: 'processing',
          message: errorMsg,
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    // Download and upload to S3
    const downloadUri = await getDownloadUri(downloadOutput.id)
    console.log(`Transferring ${title} to S3...`)
    const { size } = await uploadToS3(downloadUri, s3Key)

    // Save to Supabase (reset sync_attempts on success)
    await saveRecording(
      game,
      production.id,
      s3Key,
      size,
      organizationId,
      pitchName
    )

    // Clear sync tracking on success
    if (prevAttempts > 0) {
      await updateSyncAttempts(game.id, 0, null)
    }

    // Send "recording ready" emails to users with access
    await sendRecordingReadyEmails(
      game.id,
      title,
      game.scheduledStartTime,
      organizationId
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

// CloudWatch Embedded Metric Format emitter. One JSON line per run →
// CloudWatch Logs auto-extracts the custom metrics into the
// PLAYHUB/SyncRecordings namespace. No agent, no Terraform metric
// filters required for the metrics themselves (alarms still reference
// them by namespace + metric name).
//
// Called on every terminal path of the handler — including the "no
// games to sync" early-return — so dashboards see a healthy heartbeat
// rather than a gap. Zero-invocation alarms depend on this discipline.
interface SyncMetrics {
  backlogSize: number
  orphansSkipped: number
  syncSuccessCount: number
  syncErrorCount: number
  syncLagSeconds: number
  // Interrupted app-side deletions this run finished. A non-zero trend
  // means the app's DELETE endpoint is dying mid-flow (Netlify 26s cap).
  zombiesSwept: number
}

function emitSyncMetrics(m: SyncMetrics): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'PLAYHUB/SyncRecordings',
            Dimensions: [[]],
            Metrics: [
              { Name: 'BacklogSize', Unit: 'Count' },
              { Name: 'OrphansSkipped', Unit: 'Count' },
              { Name: 'SyncSuccessCount', Unit: 'Count' },
              { Name: 'SyncErrorCount', Unit: 'Count' },
              { Name: 'SyncLagSeconds', Unit: 'Seconds' },
              { Name: 'ZombiesSwept', Unit: 'Count' },
            ],
          },
        ],
      },
      BacklogSize: m.backlogSize,
      OrphansSkipped: m.orphansSkipped,
      SyncSuccessCount: m.syncSuccessCount,
      SyncErrorCount: m.syncErrorCount,
      SyncLagSeconds: m.syncLagSeconds,
      ZombiesSwept: m.zombiesSwept,
      message: 'sync_metrics',
    })
  )
}

// Lambda handler
export const handler = async (): Promise<{
  statusCode: number
  body: string
}> => {
  console.log('Starting recording sync...')

  try {
    // Load scene mappings and scenes
    const [sceneMappings, scenes, { excluded: existingGameIds, zombies }] =
      await Promise.all([getSceneMappings(), getScenes(), getExistingGameIds()])

    console.log(
      `Loaded ${sceneMappings.size} scene mappings, ${scenes.length} scenes`
    )
    console.log(`Found ${existingGameIds.size} existing recordings`)

    // Finish interrupted deletions before syncing (and before
    // detectStaleBookings, so zombies can't fire spurious stale alerts).
    let zombiesSwept = 0
    if (zombies.length > 0) {
      console.log(`Sweeping ${zombies.length} zombie recording(s)...`)
      zombiesSwept = await sweepZombieRecordings(zombies)
    }

    // Get finished games
    const finishedGames = await getFinishedGames()
    console.log(`Found ${finishedGames.length} finished games`)

    // Find games that need syncing. Order newest-first by match_date so a
    // parent who paid for today's game isn't stuck behind a 3-day-old
    // backlog. Games marked `sync_attempts >= RETRY_THRESHOLD` drop to
    // the tail because they've already taken their turn; we still try
    // them this run but only after fresh work is drained.
    const gamesToSync = finishedGames
      .filter((g) => !existingGameIds.has(g.id))
      .sort(
        (a, b) =>
          new Date(b.scheduledStartTime).getTime() -
          new Date(a.scheduledStartTime).getTime()
      )
    console.log(`${gamesToSync.length} games need syncing`)

    if (gamesToSync.length === 0) {
      // Still check for stale bookings even when nothing to sync
      await detectStaleBookings()

      // Emit zero-valued metrics so dashboards see a healthy heartbeat
      // (zero backlog, zero errors) rather than a gap. Zero-invocations
      // alarms depend on these being emitted every run, not just when
      // work happened.
      emitSyncMetrics({
        backlogSize: 0,
        orphansSkipped: 0,
        syncSuccessCount: 0,
        syncErrorCount: 0,
        syncLagSeconds: 0,
        zombiesSwept,
      })

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'No games to sync',
          gamesFound: finishedGames.length,
          existingRecordings: existingGameIds.size,
        }),
      }
    }

    // Process every game in the backlog against a shared absolute
    // deadline. Individual operations (download poll, etc.) clamp
    // themselves to this deadline so no single game can run past the
    // Lambda timeout. Lambda is 900s; we leave 90s headroom so the
    // response, detectStaleBookings, and CloudWatch flush still run.
    const LAMBDA_TIMEOUT_MS = 900_000
    const HEADROOM_MS = 90_000
    const runStart = Date.now()
    const deadlineMs = runStart + LAMBDA_TIMEOUT_MS - HEADROOM_MS
    const results: SyncResult[] = []

    for (const game of gamesToSync) {
      // Leave enough runway for at least one meaningful operation plus
      // shutdown; if we can't, defer the rest to the next cron tick.
      if (Date.now() > deadlineMs - 60_000) {
        console.log(
          `Deadline approaching after ${results.length}/${gamesToSync.length} games — deferring rest to next run`
        )
        break
      }

      console.log(
        `Syncing: ${game.title || game.description} (scene: ${game.sceneId})`
      )

      let result: SyncResult
      try {
        result = await syncGame(game, sceneMappings, scenes, deadlineMs)
      } catch (err) {
        // syncGame already catches its own errors, but belt-and-braces:
        // an uncaught throw here must not stall the rest of the backlog.
        result = {
          gameId: game.id,
          title: game.title || game.description || 'Unknown',
          status: 'error',
          message: err instanceof Error ? err.message : 'Uncaught error',
        }
      }
      console.log(`Result: ${result.status} - ${result.message}`)
      results.push(result)
    }

    // Detect stale bookings (runs every invocation, lightweight query)
    await detectStaleBookings()

    const summary = {
      transferred: results.filter((r) => r.status === 'transferred').length,
      already_synced: results.filter((r) => r.status === 'already_synced')
        .length,
      processing: results.filter((r) => r.status === 'processing').length,
      errors: results.filter((r) => r.status === 'error').length,
    }

    const now = Date.now()
    const orphansSkipped = results.filter((r) =>
      r.message?.includes('auto-skipped')
    ).length
    const syncErrors = results.filter(
      (r) => r.status === 'error' && !r.message?.includes('auto-skipped')
    ).length
    const syncSuccesses = summary.transferred + summary.already_synced
    // Max wait for any game still unsynced after this run. If we
    // transferred everything, lag = 0. Computed against the pre-loop
    // backlog so the metric reflects queue age at the top of the run.
    const maxLagSec = gamesToSync.reduce((acc, g) => {
      const lag = (now - new Date(g.scheduledStartTime).getTime()) / 1000
      return lag > acc ? lag : acc
    }, 0)

    emitSyncMetrics({
      backlogSize: gamesToSync.length,
      orphansSkipped,
      syncSuccessCount: syncSuccesses,
      syncErrorCount: syncErrors,
      syncLagSeconds: Math.round(maxLagSec),
      zombiesSwept,
    })

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Sync completed',
        gamesFound: finishedGames.length,
        needsSync: gamesToSync.length,
        processed: results.length,
        summary,
        results,
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
