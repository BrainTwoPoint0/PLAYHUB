/**
 * Gemini Flash Event Detection — Validation Script (v2: Goals Only + Chunked)
 *
 * Downloads Spiideo recordings from S3, transcodes to 720p,
 * splits into 5-minute chunks, uploads each to Gemini File API,
 * and detects GOALS ONLY with a simplified prompt.
 * Results are stored in playhub_recording_events.
 *
 * Usage: npx tsx validate.ts
 */

import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  statSync,
  writeFileSync,
  readdirSync,
} from 'fs'
import { execSync } from 'child_process'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { createClient } from '@supabase/supabase-js'
import { GoogleGenAI } from '@google/genai'
import { createWriteStream } from 'fs'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load env from PLAYHUB/.env
config({ path: resolve(__dirname, '../../.env') })

// ── Config ──────────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const AWS_REGION = process.env.PLAYHUB_AWS_REGION || 'eu-west-2'
const AWS_ACCESS_KEY_ID = process.env.PLAYHUB_AWS_ACCESS_KEY_ID
const AWS_SECRET_ACCESS_KEY = process.env.PLAYHUB_AWS_SECRET_ACCESS_KEY
const S3_BUCKET = process.env.S3_RECORDINGS_BUCKET
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ADMIN_USER_ID = process.env.SPIIDEO_PLAYBACK_ADMIN_USER_ID

const TMP_DIR = resolve(__dirname, '.tmp')
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024 // 2GB Gemini limit
const CHUNK_DURATION_SECONDS = 5 * 60 // 5 minutes per chunk

// Goals-only for v2 validation
const EVENT_TYPES = ['goal'] as const
type EventType = (typeof EVENT_TYPES)[number]

// ── Validation ──────────────────────────────────────────────────────

function checkEnv() {
  const missing: string[] = []
  if (!GEMINI_API_KEY) missing.push('GEMINI_API_KEY')
  if (!AWS_ACCESS_KEY_ID) missing.push('PLAYHUB_AWS_ACCESS_KEY_ID')
  if (!AWS_SECRET_ACCESS_KEY) missing.push('PLAYHUB_AWS_SECRET_ACCESS_KEY')
  if (!S3_BUCKET) missing.push('S3_RECORDINGS_BUCKET')
  if (!SUPABASE_URL) missing.push('SUPABASE_URL')
  if (!SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (!ADMIN_USER_ID) missing.push('SPIIDEO_PLAYBACK_ADMIN_USER_ID')

  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}`)
    console.error(
      'Add GEMINI_API_KEY to PLAYHUB/.env (get it from ai.google.dev)'
    )
    process.exit(1)
  }

  // Check FFmpeg
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' })
  } catch {
    console.error('FFmpeg not found. Install with: brew install ffmpeg')
    process.exit(1)
  }
}

// ── Clients ─────────────────────────────────────────────────────────

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID!,
    secretAccessKey: AWS_SECRET_ACCESS_KEY!,
  },
})

const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!)

const genai = new GoogleGenAI({ apiKey: GEMINI_API_KEY! })

// ── Types ───────────────────────────────────────────────────────────

interface Recording {
  id: string
  title: string
  s3_key: string
  duration_seconds: number | null
  match_date: string
  home_team: string
  away_team: string
  created_by: string | null
}

interface DetectedEvent {
  event_type: EventType
  timestamp_seconds: number
  team: 'home' | 'away' | null
  label: string | null
  confidence_score: number
}

// ── S3 Download ─────────────────────────────────────────────────────

async function downloadFromS3(s3Key: string, destPath: string): Promise<void> {
  console.log(`  Downloading s3://${S3_BUCKET}/${s3Key}...`)

  const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key })
  const response = await s3.send(command)

  if (!response.Body) throw new Error('Empty S3 response body')

  const nodeStream = response.Body as Readable
  const writeStream = createWriteStream(destPath)
  await pipeline(nodeStream, writeStream)

  const size = statSync(destPath).size
  console.log(`  Downloaded ${(size / 1024 / 1024).toFixed(0)}MB`)
}

// ── FFmpeg Transcode ────────────────────────────────────────────────

function transcode720p(inputPath: string, outputPath: string): void {
  console.log(`  Transcoding to 720p...`)
  const start = Date.now()

  execSync(
    `ffmpeg -y -i "${inputPath}" -vf scale=-2:720 -c:v libx264 -preset fast -crf 28 -c:a aac -b:a 128k "${outputPath}"`,
    { stdio: 'inherit', timeout: 30 * 60 * 1000 } // 30 min timeout
  )

  const size = statSync(outputPath).size
  const elapsed = ((Date.now() - start) / 1000).toFixed(0)
  console.log(
    `  Transcoded to ${(size / 1024 / 1024).toFixed(0)}MB in ${elapsed}s`
  )
}

// ── FFmpeg Chunking ─────────────────────────────────────────────────

interface Chunk {
  path: string
  startSeconds: number
  index: number
}

function getVideoDuration(filePath: string): number {
  const output = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
    { encoding: 'utf-8' }
  ).trim()
  return parseFloat(output)
}

function splitIntoChunks(inputPath: string, recordingId: string): Chunk[] {
  const duration = getVideoDuration(inputPath)
  const numChunks = Math.ceil(duration / CHUNK_DURATION_SECONDS)
  console.log(
    `  Splitting ${Math.round(duration)}s video into ${numChunks} chunks of ${CHUNK_DURATION_SECONDS / 60}min...`
  )

  const chunks: Chunk[] = []
  for (let i = 0; i < numChunks; i++) {
    const startSeconds = i * CHUNK_DURATION_SECONDS
    const chunkPath = resolve(TMP_DIR, `${recordingId}_chunk_${i}.mp4`)

    execSync(
      `ffmpeg -y -ss ${startSeconds} -i "${inputPath}" -t ${CHUNK_DURATION_SECONDS} -c copy "${chunkPath}"`,
      { stdio: 'pipe', timeout: 5 * 60 * 1000 }
    )

    if (existsSync(chunkPath) && statSync(chunkPath).size > 0) {
      chunks.push({ path: chunkPath, startSeconds, index: i })
    }
  }

  console.log(`  Created ${chunks.length} chunks`)
  return chunks
}

// ── Gemini Upload & Detection ───────────────────────────────────────

interface GeminiFile {
  name: string
  uri: string
}

async function uploadToGemini(filePath: string): Promise<GeminiFile> {
  console.log(`  Uploading to Gemini File API...`)
  const start = Date.now()

  const uploadResult = await genai.files.upload({
    file: filePath,
    config: { mimeType: 'video/mp4' },
  })

  const fileName = uploadResult.name!
  const fileUri = uploadResult.uri!
  console.log(
    `  Upload complete (${((Date.now() - start) / 1000).toFixed(0)}s), file: ${fileName}`
  )

  // Poll until processing is done
  console.log(`  Waiting for Gemini to process video...`)
  let file = await genai.files.get({ name: fileName })
  while (file.state === 'PROCESSING') {
    await new Promise((r) => setTimeout(r, 10_000))
    file = await genai.files.get({ name: fileName })
    process.stdout.write('.')
  }
  console.log('')

  if (file.state === 'FAILED') {
    throw new Error(
      `Gemini file processing failed: ${file.error?.message || 'unknown'}`
    )
  }

  console.log(`  File ready (state: ${file.state})`)
  return { name: fileName, uri: file.uri || fileUri }
}

function buildGoalPrompt(
  chunkIndex: number,
  chunkStartSeconds: number,
  chunkDurationSeconds: number
): string {
  const chunkStartMin = Math.floor(chunkStartSeconds / 60)
  const chunkEndMin = Math.floor(
    (chunkStartSeconds + chunkDurationSeconds) / 60
  )

  return `You are watching a 5-minute segment of a recreational 5-a-side football match. This is chunk ${chunkIndex + 1}, covering minutes ${chunkStartMin}-${chunkEndMin} of the full match.

The camera is a FIXED PANORAMIC camera covering the full pitch from above/behind one goal.

Your ONLY task: Detect GOALS scored in this video clip.

A GOAL means the ball clearly crosses the goal line into the net. Do NOT report:
- Shots that miss or hit the post
- Shots saved by the goalkeeper
- Near-misses or close calls
- Crosses, passes, or clearances
- Any other event that is not a confirmed goal

For each goal, provide:
- timestamp_seconds: The EXACT second within THIS video clip when the ball enters the goal (0 to ~300)
- side: "left" or "right" — which side of the screen the goal is scored on
- label: Brief description (e.g. "Goal from close range", "Long-range goal into top corner")
- confidence: 0.0 to 1.0 (only report goals you are very confident about, >= 0.7)

Respond ONLY with a valid JSON array. No markdown, no code fences, no explanation.

Example:
[{"timestamp_seconds": 142.5, "side": "left", "label": "Goal from close range after scramble in the box", "confidence": 0.9}]

If NO goals are scored in this clip, return: []`
}

async function callGeminiWithRetry(
  geminiFile: GeminiFile,
  prompt: string,
  maxRetries = 5
): Promise<string> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await genai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { fileData: { fileUri: geminiFile.uri, mimeType: 'video/mp4' } },
              { text: prompt },
            ],
          },
        ],
        config: {
          temperature: 0.1,
          maxOutputTokens: 8192,
        },
      })
      return response.text?.trim() || '[]'
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const isRateLimit =
        msg.includes('429') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('quota')
      if (isRateLimit && attempt < maxRetries) {
        const retryMatch = msg.match(/retry in (\d+)/i)
        const waitSec = retryMatch ? parseInt(retryMatch[1]) + 5 : 60
        console.log(
          `  Rate limited (attempt ${attempt}/${maxRetries}). Waiting ${waitSec}s...`
        )
        await new Promise((r) => setTimeout(r, waitSec * 1000))
        continue
      }
      throw err
    }
  }
  throw new Error('Max retries exceeded')
}

function parseGeminiResponse(text: string): unknown[] {
  // Strip markdown code fences if present
  let cleaned = text
    .replace(/^```json?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  try {
    const parsed = JSON.parse(cleaned)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // Try to recover truncated JSON
    const lastCompleteObj = cleaned.lastIndexOf('}')
    if (lastCompleteObj > 0) {
      const truncated = cleaned.slice(0, lastCompleteObj + 1)
      const arrayStr = truncated.startsWith('[')
        ? truncated + ']'
        : '[' + truncated + ']'
      try {
        const parsed = JSON.parse(arrayStr)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }
    return []
  }
}

async function detectGoalsInChunk(
  geminiFile: GeminiFile,
  chunk: Chunk,
  chunkDuration: number
): Promise<DetectedEvent[]> {
  const prompt = buildGoalPrompt(chunk.index, chunk.startSeconds, chunkDuration)
  const text = await callGeminiWithRetry(geminiFile, prompt)
  const parsed = parseGeminiResponse(text)

  const events: DetectedEvent[] = []
  for (const raw of parsed) {
    const r = raw as Record<string, unknown>

    const localTimestamp = Number(r.timestamp_seconds)
    if (isNaN(localTimestamp) || localTimestamp < 0) continue

    const confidence = Number(r.confidence ?? r.confidence_score ?? 0.5)
    if (confidence < 0.5) continue // Higher threshold for goals-only

    // Convert chunk-local timestamp to full-video timestamp
    const globalTimestamp = chunk.startSeconds + localTimestamp

    const side = r.side === 'left' || r.side === 'right' ? r.side : null

    events.push({
      event_type: 'goal',
      timestamp_seconds: Math.round(globalTimestamp * 100) / 100,
      team: side as 'home' | 'away' | null, // store side in team field for now
      label:
        typeof r.label === 'string'
          ? `[${side || '?'} side] ${r.label}`.slice(0, 200)
          : `[${side || '?'} side] Goal`,
      confidence_score: Math.min(1, Math.max(0, confidence)),
    })
  }

  return events
}

async function detectGoalsChunked(
  chunks: Chunk[],
  recordingId: string
): Promise<DetectedEvent[]> {
  console.log(`  Processing ${chunks.length} chunks for goal detection...`)
  const allGoals: DetectedEvent[] = []

  for (const chunk of chunks) {
    const chunkLabel = `chunk ${chunk.index + 1}/${chunks.length} (${formatTimestamp(chunk.startSeconds)})`
    console.log(`  [${chunkLabel}] Uploading...`)

    let geminiFile: GeminiFile | null = null
    try {
      geminiFile = await uploadToGemini(chunk.path)
      console.log(`  [${chunkLabel}] Detecting goals...`)
      const start = Date.now()
      const goals = await detectGoalsInChunk(
        geminiFile,
        chunk,
        CHUNK_DURATION_SECONDS
      )
      const elapsed = ((Date.now() - start) / 1000).toFixed(0)

      if (goals.length > 0) {
        console.log(
          `  [${chunkLabel}] Found ${goals.length} goal(s) in ${elapsed}s`
        )
        allGoals.push(...goals)
      } else {
        console.log(`  [${chunkLabel}] No goals (${elapsed}s)`)
      }
    } catch (err) {
      console.error(
        `  [${chunkLabel}] ERROR: ${err instanceof Error ? err.message : err}`
      )
    } finally {
      if (geminiFile) await deleteGeminiFile(geminiFile.name)
    }
  }

  return allGoals.sort((a, b) => a.timestamp_seconds - b.timestamp_seconds)
}

// ── Database Insert ─────────────────────────────────────────────────

async function insertEvents(
  recordingId: string,
  events: DetectedEvent[],
  createdBy: string
): Promise<number> {
  if (events.length === 0) return 0

  // Delete any existing ai_detected events for this recording
  await supabase
    .from('playhub_recording_events')
    .delete()
    .eq('match_recording_id', recordingId)
    .eq('source', 'ai_detected')

  const rows = events.map((e) => ({
    match_recording_id: recordingId,
    event_type: e.event_type,
    timestamp_seconds: e.timestamp_seconds,
    team: e.team,
    label: e.label,
    visibility: 'public',
    source: 'ai_detected',
    confidence_score: e.confidence_score,
    created_by: createdBy,
  }))

  const { data, error } = await supabase
    .from('playhub_recording_events')
    .insert(rows)
    .select('id')

  if (error) {
    console.error(`  DB insert error: ${error.message}`)
    return 0
  }

  return data?.length || 0
}

// ── Cleanup Gemini file ─────────────────────────────────────────────

async function deleteGeminiFile(fileName: string): Promise<void> {
  try {
    await genai.files.delete({ name: fileName })
  } catch {
    // Ignore — files auto-expire anyway
  }
}

// ── Report Formatting ───────────────────────────────────────────────

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0)
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

function printReport(
  recording: Recording,
  events: DetectedEvent[],
  insertedCount: number
) {
  const duration = recording.duration_seconds
    ? formatTimestamp(recording.duration_seconds)
    : 'unknown'

  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  ${recording.title}`)
  console.log(
    `  ${recording.home_team} vs ${recording.away_team} | Duration: ${duration}`
  )
  console.log(`${'─'.repeat(70)}`)

  if (events.length === 0) {
    console.log('  No events detected.')
  } else {
    console.log(
      `  ${events.length} events detected (${insertedCount} saved to DB)\n`
    )
    console.log('  Time      | Type          | Team | Conf | Description')
    console.log('  ' + '─'.repeat(66))
    for (const e of events) {
      const time = formatTimestamp(e.timestamp_seconds).padEnd(9)
      const type = e.event_type.padEnd(13)
      const team = (e.team || '—').padEnd(4)
      const conf = e.confidence_score.toFixed(2)
      const label = e.label || ''
      console.log(`  ${time} | ${type} | ${team} | ${conf} | ${label}`)
    }
  }

  console.log(`${'═'.repeat(70)}\n`)
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('Gemini Flash Event Detection — v2 Goals Only (5-min chunks)\n')

  checkEnv()

  // Ensure tmp dir
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true })

  // Fetch 5 published Spiideo recordings (shortest first)
  console.log('Querying recordings...')
  const { data: recordings, error } = await supabase
    .from('playhub_match_recordings')
    .select(
      'id, title, s3_key, duration_seconds, match_date, home_team, away_team, created_by'
    )
    .eq('content_type', 'hosted_video')
    .eq('status', 'published')
    .not('s3_key', 'is', null)
    .order('duration_seconds', { ascending: true, nullsFirst: false })
    .limit(5)

  if (error) {
    console.error(`DB query error: ${error.message}`)
    process.exit(1)
  }

  if (!recordings || recordings.length === 0) {
    console.error('No published recordings with S3 keys found.')
    process.exit(1)
  }

  console.log(`Found ${recordings.length} recordings to validate:\n`)
  for (const r of recordings) {
    const dur = r.duration_seconds
      ? `${Math.round(r.duration_seconds / 60)}min`
      : '?min'
    console.log(`  • ${r.title} (${dur}) — ${r.home_team} vs ${r.away_team}`)
  }
  console.log('')

  // Collect results for review JSON
  const reviewData: Array<{
    recording_id: string
    title: string
    home_team: string
    away_team: string
    duration_minutes: number | null
    recording_url: string
    events: Array<{
      event_type: string
      timestamp: string
      timestamp_seconds: number
      team: string | null
      label: string | null
      confidence_score: number
      accurate: boolean | null
      notes: string
    }>
  }> = []

  // Process each recording
  const summary = {
    totalEvents: 0,
    totalRecordings: recordings.length,
    processed: 0,
    failed: 0,
    confidenceSum: 0,
    eventsByType: {} as Record<string, number>,
  }

  for (let i = 0; i < recordings.length; i++) {
    const rec = recordings[i] as Recording
    const rawPath = resolve(TMP_DIR, `${rec.id}_raw.mp4`)
    const transcodedPath = resolve(TMP_DIR, `${rec.id}_720p.mp4`)
    let chunks: Chunk[] = []

    console.log(`\n[${i + 1}/${recordings.length}] Processing: ${rec.title}`)

    try {
      // 1. Download from S3
      await downloadFromS3(rec.s3_key, rawPath)

      // 2. Transcode to 720p
      transcode720p(rawPath, transcodedPath)

      // Remove raw file immediately to save disk space
      if (existsSync(rawPath)) unlinkSync(rawPath)

      // 3. Split into 5-minute chunks
      chunks = splitIntoChunks(transcodedPath, rec.id)

      // Remove transcoded file — we have the chunks now
      if (existsSync(transcodedPath)) unlinkSync(transcodedPath)

      // 4. Detect goals across all chunks
      const events = await detectGoalsChunked(chunks, rec.id)

      // 5. Save to DB
      const insertedCount = await insertEvents(
        rec.id,
        events,
        rec.created_by || ADMIN_USER_ID!
      )

      // 6. Collect for review JSON
      reviewData.push({
        recording_id: rec.id,
        title: rec.title,
        home_team: rec.home_team,
        away_team: rec.away_team,
        duration_minutes: rec.duration_seconds
          ? Math.round(rec.duration_seconds / 60)
          : null,
        recording_url: `https://playhub.playbacksports.ai/recordings/${rec.id}`,
        events: events.map((e) => ({
          event_type: e.event_type,
          timestamp: formatTimestamp(e.timestamp_seconds),
          timestamp_seconds: e.timestamp_seconds,
          team: e.team,
          label: e.label,
          confidence_score: e.confidence_score,
          accurate: null,
          notes: '',
        })),
      })

      // 7. Report
      printReport(rec, events, insertedCount)

      // Update summary
      summary.processed++
      summary.totalEvents += events.length
      for (const e of events) {
        summary.eventsByType[e.event_type] =
          (summary.eventsByType[e.event_type] || 0) + 1
        summary.confidenceSum += e.confidence_score
      }
    } catch (err) {
      console.error(`  ERROR: ${err instanceof Error ? err.message : err}`)
      summary.failed++
    } finally {
      // Cleanup all temp files
      if (existsSync(rawPath)) unlinkSync(rawPath)
      if (existsSync(transcodedPath)) unlinkSync(transcodedPath)
      for (const chunk of chunks) {
        if (existsSync(chunk.path)) unlinkSync(chunk.path)
      }
    }
  }

  // ── Final Summary ───────────────────────────────────────────────

  console.log('\n' + '═'.repeat(70))
  console.log('  VALIDATION SUMMARY')
  console.log('═'.repeat(70))
  console.log(
    `  Recordings processed: ${summary.processed}/${summary.totalRecordings}`
  )
  console.log(`  Recordings failed:    ${summary.failed}`)
  console.log(`  Total events:         ${summary.totalEvents}`)

  if (summary.totalEvents > 0) {
    console.log(
      `  Avg confidence:       ${(summary.confidenceSum / summary.totalEvents).toFixed(2)}`
    )
    console.log(`\n  Events by type:`)
    const sorted = Object.entries(summary.eventsByType).sort(
      (a, b) => b[1] - a[1]
    )
    for (const [type, count] of sorted) {
      console.log(`    ${type.padEnd(15)} ${count}`)
    }
  }

  console.log('═'.repeat(70))

  // Write review JSON file
  if (reviewData.length > 0) {
    const reviewPath = resolve(__dirname, 'validation-review-v2-goals.json')
    writeFileSync(reviewPath, JSON.stringify(reviewData, null, 2))
    console.log(`\nReview file written to: ${reviewPath}`)
    console.log(
      'Edit "accurate" (true/false) and "notes" fields for each event to provide feedback.'
    )
  }

  console.log(
    '\nDone. Check playhub_recording_events table for entries with source = "ai_detected".'
  )
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
