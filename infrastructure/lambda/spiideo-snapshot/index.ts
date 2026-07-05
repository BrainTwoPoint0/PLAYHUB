// Lambda: on-demand raw-panorama snapshot of a Spiideo scene's camera.
//
// Invoked asynchronously via its Function URL by the PLAYHUB admin API
// (X-Amz-Invocation-Type: Event). It spins up a short live session on the
// camera, waits for the tentative HLS to come online (~40s), grabs one frame
// with ffmpeg (from the attached layer, /opt/bin/ffmpeg), uploads it to the
// public scene-snapshots bucket, and stamps the result on the scene's health
// row (which the admin UI polls). See docs/decisions/2026-07-01-spiideo-scene-health.md.

import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import {
  signIn,
  startLiveSession,
  waitForPlaylist,
  deleteGame,
} from './spiideo-snapshot-client'

const execFileP = promisify(execFile)

const SPIIDEO_EMAIL = process.env.SPIIDEO_PLAY_EMAIL!
const SPIIDEO_PASSWORD = process.env.SPIIDEO_PLAY_PASSWORD!
const ACCOUNT_ID = process.env.SPIIDEO_ACCOUNT_ID!
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const SNAPSHOT_API_KEY = process.env.SNAPSHOT_API_KEY || ''
const FFMPEG = process.env.FFMPEG_PATH || '/opt/bin/ffmpeg'
const BUCKET = 'scene-snapshots'
const HEALTH_TABLE = 'playhub_spiideo_scene_health'

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Strip any bearer token that might ride inside an upstream error/URL before it
// reaches logs, the DB, or the API response.
function redact(s: string): string {
  return s
    .replace(/authorization=bearer\+\S+/gi, 'authorization=bearer+[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
}

function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

async function setStatus(
  sceneId: string,
  fields: {
    last_snapshot_status: string
    last_snapshot_at?: string
    last_snapshot_error?: string | null
  }
): Promise<void> {
  const { error } = await supabase
    .from(HEALTH_TABLE)
    .update(fields as never)
    .eq('scene_id', sceneId)
  if (error) console.error(`setStatus failed scene=${sceneId}:`, error.message)
}

// Function URL event (payload format 2.0).
interface FnUrlEvent {
  headers?: Record<string, string>
  body?: string
  isBase64Encoded?: boolean
}

export const handler = async (event: FnUrlEvent) => {
  // Auth: shared secret from the calling API route (constant-time compare).
  const key = event.headers?.['x-api-key'] || event.headers?.['X-Api-Key'] || ''
  if (!SNAPSHOT_API_KEY || !timingSafeStrEqual(key, SNAPSHOT_API_KEY)) {
    return { statusCode: 401, body: 'unauthorized' }
  }

  let sceneId: string | undefined
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString()
      : event.body
    sceneId = raw ? (JSON.parse(raw).sceneId as string) : undefined
  } catch {
    return { statusCode: 400, body: 'bad body' }
  }
  // sceneId is used as an fs path + storage key — assert UUID shape so path
  // safety never depends solely on the DB lookup.
  if (!sceneId || !UUID_RE.test(sceneId))
    return { statusCode: 400, body: 'sceneId required' }

  // Confirm we track this scene (defense-in-depth; the API route also checks).
  const { data: scene } = await supabase
    .from(HEALTH_TABLE)
    .select('scene_id, scene_name')
    .eq('scene_id', sceneId)
    .maybeSingle()
  if (!scene) return { statusCode: 404, body: 'unknown scene' }

  await setStatus(sceneId, {
    last_snapshot_status: 'pending',
    last_snapshot_error: null,
  })

  const framePath = `/tmp/${sceneId}.jpg`
  let jwt: string | null = null
  let gameId: string | null = null
  try {
    jwt = await signIn(SPIIDEO_EMAIL, SPIIDEO_PASSWORD)
    gameId = await startLiveSession(
      jwt,
      ACCOUNT_ID,
      sceneId,
      (scene as any).scene_name ?? sceneId
    )

    const playlist = await waitForPlaylist(jwt, ACCOUNT_ID, gameId)
    if (!playlist) throw new Error('live stream did not become ready in time')

    // Grab a single frame. -allowed_extensions ALL is required — Spiideo's HLS
    // segments are extensionless (item-00000000). -protocol_whitelist restricts
    // ffmpeg to HTTPS so a manipulated playlist can't make it read file:// or
    // hit link-local metadata. The playlist URL carries a bearer token, so its
    // error output must never propagate: rethrow a fixed message on failure.
    try {
      await execFileP(
        FFMPEG,
        [
          '-y',
          '-loglevel',
          'error',
          '-protocol_whitelist',
          'https,tls,tcp,crypto',
          '-allowed_extensions',
          'ALL',
          '-extension_picky',
          '0',
          '-i',
          playlist,
          '-frames:v',
          '1',
          '-q:v',
          '3',
          framePath,
        ],
        { timeout: 30_000 }
      )
    } catch {
      throw new Error('ffmpeg frame capture failed')
    }

    const buf = await readFile(framePath)
    if (buf.length < 1000) throw new Error('captured frame is empty')

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(`${sceneId}.jpg`, buf, {
        contentType: 'image/jpeg',
        upsert: true,
      })
    if (upErr) throw new Error(`upload failed: ${upErr.message}`)

    await setStatus(sceneId, {
      last_snapshot_status: 'ready',
      last_snapshot_at: new Date().toISOString(),
      last_snapshot_error: null,
    })
    console.log(`snapshot ok scene=${sceneId} bytes=${buf.length}`)
    return { statusCode: 200, body: 'ok' }
  } catch (err) {
    // Redact any bearer token an upstream error might carry before it reaches
    // logs / the DB / the admin API.
    const message = redact(err instanceof Error ? err.message : String(err))
    console.error(`snapshot failed scene=${sceneId}:`, message)
    await setStatus(sceneId, {
      last_snapshot_status: 'error',
      last_snapshot_error: message.slice(0, 300),
    })
    return { statusCode: 200, body: 'error recorded' }
  } finally {
    if (jwt && gameId) await deleteGame(jwt, gameId)
    await rm(framePath, { force: true }).catch(() => {})
  }
}
