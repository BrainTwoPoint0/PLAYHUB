// Lambda function to sync Clutch (padel camera) recordings to S3.
// Polls every 15 minutes via EventBridge. Driven entirely by
// playhub_match_recordings rows created by PLAYHUB scheduling — Clutch has
// no list-videos endpoint, so rows we didn't create can never appear here.

import { createClient } from '@supabase/supabase-js'
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { Readable } from 'stream'
import {
  decideSyncAction,
  generateClutchS3Keys,
  type RecordingRow,
} from './state-machine'
import { planHighlightMirror, planPlayerCropMirror, runTasks } from './manifest'
import { extractMatchStats } from './match-stats'
import { getVideoStatus, getVideoResults } from './clutch-client'

const S3_BUCKET = process.env.S3_BUCKET!
const S3_REGION = process.env.S3_REGION || 'eu-west-2'
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const ALERT_EMAIL = process.env.ALERT_EMAIL || ''
const APP_URL = process.env.APP_URL || 'https://playhub.playbacksports.ai'

// Public Supabase Storage bucket for permanent thumbnail URLs (the S3/
// CloudFront path requires signed URLs that expire).
const THUMBNAIL_BUCKET = 'recording-thumbnails'

// Alert threshold for recordings stuck past their expected window. Must sit
// above Clutch's worst-case COMPLETED→OK lag (~2h) to avoid false alarms.
const STALE_AFTER_MS = 3 * 60 * 60 * 1000

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
const s3Client = new S3Client({ region: S3_REGION })

// Per-run asset failure count for the EMF AssetErrors metric — published
// rows leave the queue, so without this a systematic clip-CDN failure would
// be invisible to alarms.
let runAssetErrors = 0

// ── helpers ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Returns ContentLength in bytes, or null if the object does not exist.
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

// Download URLs come from the Clutch API response — require https so a
// compromised/malformed response can't aim the Lambda's fetch at internal
// endpoints.
function assertHttps(url: string): void {
  if (new URL(url).protocol !== 'https:') {
    throw new Error(`Refusing non-https download URL`)
  }
}

async function uploadToS3(
  downloadUrl: string,
  s3Key: string,
  contentType: string
): Promise<{ size: number }> {
  assertHttps(downloadUrl)
  // Generous budget: the signal also bounds the streaming body read, and
  // full match videos take minutes. Clips finish in seconds.
  const response = await fetch(downloadUrl, {
    signal: AbortSignal.timeout(10 * 60 * 1000),
  })
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status}`)
  }

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
      ContentType: contentType,
    },
    partSize: 10 * 1024 * 1024,
    queueSize: 4,
  })

  await upload.done()
  // content-length is absent on chunked signed-URL responses — HeadObject
  // after upload is the authoritative size.
  const size = await s3KeySize(s3Key)
  return { size: size ?? 0 }
}

// Idempotent: skips the download when the object already exists (overlapping
// runs — the function has no reserved concurrency).
async function mirrorToS3(
  downloadUrl: string | undefined,
  s3Key: string,
  contentType: string
): Promise<number | null> {
  if (!downloadUrl) return null
  const existing = await s3KeySize(s3Key)
  if (existing !== null) return existing
  const { size } = await uploadToS3(downloadUrl, s3Key, contentType)
  return size
}

async function fetchJson(url: string): Promise<unknown> {
  assertHttps(url)
  // Node fetch has no default timeout — a hung connection would pin a
  // worker until the Lambda timeout.
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) {
    throw new Error(`Failed to download JSON: ${response.status}`)
  }
  return response.json()
}

async function putJsonToS3(s3Key: string, doc: unknown): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: JSON.stringify(doc),
      ContentType: 'application/json',
    })
  )
}

// Thumbnails live in a PUBLIC Supabase Storage bucket so thumbnail_url is a
// permanent URL (matches the graphic-packages pattern). Best-effort.
async function uploadThumbnail(
  thumbnailUrl: string | undefined,
  videoId: string
): Promise<string | null> {
  if (!thumbnailUrl) return null
  try {
    assertHttps(thumbnailUrl)
    const response = await fetch(thumbnailUrl)
    if (!response.ok) return null
    const bytes = Buffer.from(await response.arrayBuffer())

    const path = `clutch/${videoId}.jpg`
    const { error } = await supabase.storage
      .from(THUMBNAIL_BUCKET)
      .upload(path, bytes, { contentType: 'image/jpeg', upsert: true })
    if (error) {
      console.error(`Thumbnail upload failed for ${videoId}:`, error.message)
      return null
    }

    const { data } = supabase.storage.from(THUMBNAIL_BUCKET).getPublicUrl(path)
    return data.publicUrl
  } catch (err) {
    console.error(`Thumbnail mirror failed for ${videoId}:`, err)
    return null
  }
}

// ── emails ──────────────────────────────────────────────────────────

async function sendAlertEmail(subject: string, body: string): Promise<void> {
  if (!RESEND_API_KEY || !ALERT_EMAIL) return
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'PLAYHUB <admin@playbacksports.ai>',
        to: [ALERT_EMAIL],
        subject,
        html: `<pre style="font-family: monospace">${escapeHtml(body)}</pre>`,
      }),
    })
  } catch (err) {
    console.error('Failed to send alert email:', err)
  }
}

async function sendRecordingReadyEmails(
  recordingId: string,
  recordingTitle: string,
  matchDate: string,
  organizationId: string | null
): Promise<void> {
  if (!RESEND_API_KEY) return

  try {
    let venueName: string | undefined
    if (organizationId) {
      const { data: venue } = await supabase
        .from('organizations')
        .select('name')
        .eq('id', organizationId)
        .single()
      venueName = (venue as any)?.name
    }

    const { data: accessRights } = await supabase
      .from('playhub_access_rights')
      .select('user_id, invited_email')
      .eq('match_recording_id', recordingId)
      .eq('is_active', true)

    if (!accessRights || accessRights.length === 0) return

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

    // Parallel fan-out with per-email timeout — one slow recipient must not
    // block the rest of the sync run.
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
        console.error(`Failed to send ready email to ${email}:`, emailErr)
      } finally {
        clearTimeout(timer)
      }
    }

    await Promise.allSettled(allEmails.map(sendOne))
    console.log(
      `Sent recording ready emails to ${allEmails.length} users for recording ${recordingId}`
    )
  } catch (error) {
    console.error('Failed to send recording ready emails:', error)
  }
}

// ── core sync ───────────────────────────────────────────────────────

interface SyncableRow extends RecordingRow {
  title: string
  organization_id: string | null
  venue_organization_id: string | null
  billable_amount: number | null
}

type SyncOutcome =
  'published' | 'status_updated' | 'unchanged' | 'failed' | 'error'

async function getSyncableRecordings(): Promise<SyncableRow[]> {
  const { data, error } = await supabase
    .from('playhub_match_recordings')
    .select(
      'id, clutch_video_id, clutch_device_id, title, match_date, duration_seconds, organization_id, venue_organization_id, status, sync_attempts, last_sync_error, billable_amount'
    )
    .not('clutch_video_id', 'is', null)
    .in('status', ['scheduled', 'recording', 'processing'])
    .is('s3_key', null)
    // PostgREST's db-max-rows caps responses at 1000 regardless of a higher
    // .limit(). The in-flight set stays tiny (rows leave it on publish/fail),
    // so 1000 is comfortably above any realistic backlog.
    .limit(1000)

  if (error) {
    throw new Error(`Failed to query recordings: ${error.message}`)
  }
  return (data || []) as unknown as SyncableRow[]
}

async function publishRecording(
  row: SyncableRow,
  includeHighlights: boolean
): Promise<SyncOutcome> {
  // Results URLs are 12h-signed — always fetched fresh, never persisted.
  const results = await getVideoResults(row.clutch_video_id)
  if (!results) {
    // Clutch says OK but results still 202 — retry next run.
    console.log(`${row.clutch_video_id}: OK but results not ready, will retry`)
    return 'unchanged'
  }

  const keys = generateClutchS3Keys(row.clutch_video_id, row.match_date)

  if (!results.video) {
    // No full video despite OK/OK_EMPTY_COURT — nothing to publish. Throwing
    // would loop forever; the sync_attempts threshold alert in the handler
    // surfaces it, and this error message explains the state.
    throw new Error(
      `Clutch results missing the full video output (status implies it should exist)`
    )
  }

  // Full video is the published asset — it must succeed.
  const videoSize = await mirrorToS3(results.video, keys.video, 'video/mp4')

  // Highlights + stats are best-effort: a failure is logged but never blocks
  // publishing the match video.
  const assetErrors: string[] = []
  let clutchMatchStats: Record<string, number> | null = null
  if (includeHighlights) {
    const sideAssets: Array<[string | undefined, string, string]> = [
      [results['highlight-landscape'], keys.highlight, 'video/mp4'],
      [
        results['highlight_urls.json'],
        keys.highlightManifest,
        'application/json',
      ],
      // Raw shot events + player crops (absent keys skip silently)
      [results['detected_shots_v3.csv'], keys.shotsCsv, 'text/csv'],
      [results['player_crop_urls.json'], keys.playerCrops, 'application/json'],
    ]
    for (const [url, key, contentType] of sideAssets) {
      try {
        await mirrorToS3(url, key, contentType)
      } catch (err) {
        const message = `${key}: ${err instanceof Error ? err.message : err}`
        console.error(`Best-effort asset failed — ${message}`)
        assetErrors.push(message)
      }
    }

    // match.json is fetched ONCE: mirrored to S3 from memory (KB-sized,
    // deterministic — overwrite is idempotent) and the headline stats are
    // extracted for the recording row so venue aggregates stay in Postgres.
    if (results['match.json']) {
      try {
        const matchJson = await fetchJson(results['match.json'])
        await putJsonToS3(keys.matchJson, matchJson)
        clutchMatchStats = extractMatchStats(matchJson)
      } catch (err) {
        const message = `match.json: ${err instanceof Error ? err.message : err}`
        console.error(message)
        assetErrors.push(message)
      }
    }

    // Mirror every highlight clip + player crop and write rewritten index
    // docs (S3 keys, never the expiring Clutch URLs). Best-effort: failures
    // shrink the index and land in assetErrors, never block publish.
    const nowIso = new Date().toISOString()

    if (results['highlight_urls.json']) {
      try {
        const manifest = await fetchJson(results['highlight_urls.json'])
        const { tasks, buildIndex } = planHighlightMirror(
          manifest,
          keys.prefix,
          nowIso
        )
        const succeeded = await runTasks(tasks, mirrorToS3, assetErrors)
        await putJsonToS3(keys.highlightsIndex, buildIndex(succeeded))
        console.log(
          `${row.clutch_video_id}: mirrored ${succeeded.size}/${tasks.length} highlight assets`
        )
      } catch (err) {
        const message = `highlights index: ${err instanceof Error ? err.message : err}`
        console.error(message)
        assetErrors.push(message)
      }
    }

    if (results['player_crop_urls.json']) {
      try {
        const manifest = await fetchJson(results['player_crop_urls.json'])
        const { tasks, buildIndex } = planPlayerCropMirror(
          manifest,
          keys.prefix,
          nowIso
        )
        const succeeded = await runTasks(tasks, mirrorToS3, assetErrors)
        await putJsonToS3(keys.playersIndex, buildIndex(succeeded))
      } catch (err) {
        const message = `players index: ${err instanceof Error ? err.message : err}`
        console.error(message)
        assetErrors.push(message)
      }
    }
  }

  runAssetErrors += assetErrors.length

  const thumbnailUrl = await uploadThumbnail(
    results['match-thumbnail'],
    row.clutch_video_id
  )

  // Compare-and-swap publish: the `.is('s3_key', null)` condition means only
  // ONE of two overlapping runs can win the update, and the ready email is
  // gated on actually having won — exactly-once even across overlap.
  const { data: updated, error } = await supabase
    .from('playhub_match_recordings')
    .update({
      status: 'published',
      published_at: new Date().toISOString(),
      s3_bucket: S3_BUCKET,
      s3_key: keys.video,
      file_size_bytes: videoSize || null,
      ...(thumbnailUrl && { thumbnail_url: thumbnailUrl }),
      transferred_at: new Date().toISOString(),
      ...(row.billable_amount != null && { is_billable: true }),
      ...(clutchMatchStats && { clutch_match_stats: clutchMatchStats }),
      last_sync_error: assetErrors.length
        ? `published; side assets failed: ${assetErrors.join('; ').slice(0, 500)}`
        : null,
      updated_at: new Date().toISOString(),
    } as any)
    .eq('id', row.id)
    .is('s3_key', null)
    .select('id')

  if (error) {
    throw new Error(`Failed to publish recording ${row.id}: ${error.message}`)
  }
  if (!updated || updated.length === 0) {
    // A concurrent run already published this row.
    return 'unchanged'
  }

  await sendRecordingReadyEmails(
    row.id,
    row.title,
    row.match_date,
    row.venue_organization_id || row.organization_id
  )

  return 'published'
}

async function syncRecording(row: SyncableRow): Promise<SyncOutcome> {
  const clutchStatus = await getVideoStatus(row.clutch_video_id)
  const action = decideSyncAction(clutchStatus, row, Date.now())

  if (action.kind === 'publish') {
    return publishRecording(row, action.includeHighlights)
  }

  if (action.kind === 'fail') {
    // CAS on status so only one of two overlapping runs sends the alert.
    const { data: failed } = await supabase
      .from('playhub_match_recordings')
      .update({
        status: 'failed',
        last_sync_error: action.reason,
        sync_attempts: (row.sync_attempts ?? 0) + 1,
        updated_at: new Date().toISOString(),
      } as any)
      .eq('id', row.id)
      .neq('status', 'failed')
      .select('id')

    if (action.alert && failed && failed.length > 0) {
      await sendAlertEmail(
        `Clutch recording failed: ${row.title}`,
        `Recording: ${row.title} (${row.id})\nClutch video: ${row.clutch_video_id}\nReason: ${action.reason}`
      )
    }
    return 'failed'
  }

  // set_status — alert at most once per row (deduped via last_sync_error marker)
  const STUCK_MARKER = 'FAILED >24h (alerted)'
  const shouldAlert =
    action.alert && !(row.last_sync_error || '').includes(STUCK_MARKER)

  if (
    action.status !== row.status ||
    shouldAlert ||
    clutchStatus === 'FAILED'
  ) {
    await supabase
      .from('playhub_match_recordings')
      .update({
        status: action.status,
        ...(clutchStatus === 'FAILED' && {
          sync_attempts: (row.sync_attempts ?? 0) + 1,
          last_sync_error: action.alert
            ? STUCK_MARKER
            : 'Clutch FAILED — awaiting auto-reprocess',
        }),
        updated_at: new Date().toISOString(),
      } as any)
      .eq('id', row.id)

    if (shouldAlert) {
      await sendAlertEmail(
        `Clutch recording stuck >24h: ${row.title}`,
        `Recording: ${row.title} (${row.id})\nClutch video: ${row.clutch_video_id}\nClutch status: ${clutchStatus}\nStill within the 48h auto-reprocess window — no action needed yet.`
      )
    }
    return 'status_updated'
  }

  return 'unchanged'
}

// Alert on rows still scheduled/recording long after the match should have
// ended (camera offline, Clutch silently never started, etc).
async function detectStaleBookings(): Promise<void> {
  if (!RESEND_API_KEY || !ALERT_EMAIL) return

  try {
    const { data } = await supabase
      .from('playhub_match_recordings')
      .select(
        'id, title, match_date, duration_seconds, status, last_sync_error'
      )
      .not('clutch_video_id', 'is', null)
      .in('status', ['scheduled', 'recording', 'processing'])
      .is('s3_key', null)
      .lt('match_date', new Date(Date.now() - STALE_AFTER_MS).toISOString())

    const STALE_MARKER = 'stale-alerted'
    const stale = (data || []).filter((r: any) => {
      const endMs =
        new Date(r.match_date).getTime() + (r.duration_seconds ?? 0) * 1000
      return (
        Date.now() - endMs > STALE_AFTER_MS &&
        !(r.last_sync_error || '').includes(STALE_MARKER)
      )
    })

    for (const r of stale as any[]) {
      await sendAlertEmail(
        `Clutch recording stale: ${r.title}`,
        `Recording ${r.id} is still '${r.status}' more than 3h after its expected end.\nMatch date: ${r.match_date}\nLikely causes: camera offline, recording never started.`
      )
      await supabase
        .from('playhub_match_recordings')
        .update({ last_sync_error: STALE_MARKER } as any)
        .eq('id', r.id)
    }
  } catch (err) {
    console.error('Stale booking detection failed:', err)
  }
}

// CloudWatch EMF metrics
function emitSyncMetrics(
  counts: Record<SyncOutcome, number>,
  assetErrorCount: number
): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'PLAYHUB/ClutchSync',
            Dimensions: [[]],
            Metrics: [
              { Name: 'Published', Unit: 'Count' },
              { Name: 'Failed', Unit: 'Count' },
              { Name: 'Errors', Unit: 'Count' },
              { Name: 'AssetErrors', Unit: 'Count' },
            ],
          },
        ],
      },
      Published: counts.published,
      Failed: counts.failed,
      Errors: counts.error,
      AssetErrors: assetErrorCount,
    })
  )
}

// ── handler ─────────────────────────────────────────────────────────

export const handler = async (): Promise<{
  statusCode: number
  body: string
}> => {
  console.log('Starting Clutch sync run')
  runAssetErrors = 0

  const rows = await getSyncableRecordings()
  console.log(`Found ${rows.length} Clutch recordings to check`)

  const counts: Record<SyncOutcome, number> = {
    published: 0,
    status_updated: 0,
    unchanged: 0,
    failed: 0,
    error: 0,
  }

  // Sequential: per-run volume is small (one venue in v1) and serial calls
  // keep us friendly to an API with no published rate limits.
  for (const row of rows) {
    try {
      const outcome = await syncRecording(row)
      counts[outcome]++
      console.log(`${row.clutch_video_id}: ${outcome}`)
    } catch (err) {
      counts.error++
      const message = err instanceof Error ? err.message : String(err)
      console.error(`${row.clutch_video_id}: error — ${message}`)
      try {
        const attempts = (row.sync_attempts ?? 0) + 1
        await supabase
          .from('playhub_match_recordings')
          .update({
            sync_attempts: attempts,
            last_sync_error: message.slice(0, 500),
            updated_at: new Date().toISOString(),
          } as any)
          .eq('id', row.id)

        // Per-row errors are swallowed here, so the Lambda Errors alarm
        // never sees them. Alert once when a row has errored persistently
        // (~2.5h of 15-min runs).
        if (attempts === 10) {
          await sendAlertEmail(
            `Clutch recording erroring persistently: ${row.title}`,
            `Recording: ${row.title} (${row.id})\nClutch video: ${row.clutch_video_id}\nAttempts: ${attempts}\nLatest error: ${message.slice(0, 500)}`
          )
        }
      } catch (updateErr) {
        // Never let bookkeeping failure abort the remaining rows.
        console.error(
          `${row.clutch_video_id}: failed to record error:`,
          updateErr
        )
      }
    }
  }

  await detectStaleBookings()
  emitSyncMetrics(counts, runAssetErrors)

  console.log('Clutch sync run complete', counts)
  return {
    statusCode: 200,
    body: JSON.stringify(counts),
  }
}
