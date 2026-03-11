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

async function deleteOutput(outputId: string): Promise<void> {
  await spiideoFetch(`/v1/outputs/${outputId}`, { method: 'DELETE' })
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

    // Send emails via Resend
    for (const email of allEmails) {
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
            html: `
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
            `,
          }),
        })

        if (!response.ok) {
          const text = await response.text()
          console.error(`Resend API error for ${email}: ${response.status} ${text}`)
        }
      } catch (emailErr) {
        console.error(`Failed to send recording ready email to ${email}:`, emailErr)
      }
    }

    console.log(`Sent recording ready emails to ${allEmails.length} users for game ${spiideoGameId}`)
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
      .select('id, title, match_date, pitch_name, organization_id, spiideo_game_id, last_sync_error')
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
      await sendSyncAlertEmail(
        `⚠️ Stale booking: ${recording.title}`,
        {
          gameId: recording.spiideo_game_id || recording.id,
          title: recording.title || 'Untitled',
          matchDate: recording.match_date,
          pitchName: recording.pitch_name,
          attempts: 0,
          lastError: 'Recording stuck in "scheduled" status — never started or synced',
          isRetryExhausted: true,
        }
      )

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

    // Wait for download to be ready (up to 10 minutes)
    const maxWaitMs = 10 * 60 * 1000
    const pollIntervalMs = 5000
    const startTime = Date.now()
    let lastProgress = 0

    while (Date.now() - startTime < maxWaitMs) {
      const progress = await getOutputProgress(downloadOutput.id)
      lastProgress = progress.progress

      if (progress.progress >= 100) {
        break
      }

      if (Date.now() - startTime + pollIntervalMs >= maxWaitMs) {
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
    await sendRecordingReadyEmails(game.id, title, game.scheduledStartTime, organizationId)

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
      // Still check for stale bookings even when nothing to sync
      await detectStaleBookings()

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

    // Detect stale bookings (runs every invocation, lightweight query)
    await detectStaleBookings()

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
