// AWS Batch (Fargate) job: materialize a recording's RAW VirtualPanorama and copy
// it into OUR private S3, so the watch-page de-warp free-look plays from a signed
// URL (never Spiideo's JWT-bearing playlist — see the A2 security review).
//
// Runs on Batch (not Lambda) because the raw VP is a full-match, multi-GB 4K VOD:
// too big for a 15-min Lambda / its /tmp. Fargate gives ample time + ephemeral
// disk. It only REMUXES (-c copy, fast/IO-bound) — never re-encodes.
//
// Invoked by POST /api/recordings/[id]/panorama-source via Batch SubmitJob, which
// already won the atomic idle→pending claim and set panorama_capture_status.
// This job owns the terminal state: it writes panorama_s3_key + 'ready', or a
// redacted 'error'. gameId comes from our DB row (passed by the route), never a
// client — SSRF-safe.
//
// Env: RECORDING_ID, GAME_ID, SPIIDEO_PLAY_EMAIL/PASSWORD, SPIIDEO_ACCOUNT_ID,
// S3_BUCKET, VP_S3_PREFIX, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AWS_REGION.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { createReadStream } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const execFileP = promisify(execFile)
const B = 'https://api.spiideo.com'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const {
  RECORDING_ID, GAME_ID, SPIIDEO_PLAY_EMAIL, SPIIDEO_PLAY_PASSWORD,
  SPIIDEO_ACCOUNT_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
} = process.env
// Must be the SAME private bucket the app signs from (getPlaybackUrl reads
// S3_RECORDINGS_BUCKET) — a mismatch 404s every panorama URL, or worse exposes
// minors' footage if pointed at a public bucket.
const S3_BUCKET = process.env.S3_RECORDINGS_BUCKET
const VP_S3_PREFIX = process.env.VP_S3_PREFIX || 'panoramas'
const REGION = process.env.AWS_REGION || 'eu-west-2'
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
// Content cap (-t). Kept BELOW the ffmpeg wall-timeout + the Batch attempt timeout
// so a long match can't be killed mid-remux (which would loop via the error path).
const MAX_SECONDS = Number(process.env.VP_MAX_SECONDS || 5400) // 90 min covers ~all matches
const FFMPEG_TIMEOUT_MS = Number(process.env.VP_FFMPEG_TIMEOUT_MS || 50 * 60_000) // < Batch 1h cap

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const s3 = new S3Client({ region: REGION })

// Strip any bearer token an upstream error/URL might carry before it reaches logs
// or the DB (the tentative playlist URL embeds the Spiideo JWT).
const redact = (s) =>
  String(s)
    .replace(/authorization=bearer\+\S+/gi, 'authorization=bearer+[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')

async function setStatus(fields) {
  const { error } = await supabase
    .from('playhub_match_recordings')
    .update(fields)
    .eq('id', RECORDING_ID)
  if (error) console.error('setStatus failed:', error.message)
}

async function signIn() {
  const res = await fetch(`${B}/v1/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: SPIIDEO_PLAY_EMAIL,
      password: SPIIDEO_PLAY_PASSWORD,
      rolesToAssume: ['ROLE_USER'],
    }),
  })
  if (!res.ok) throw new Error(`sign-in HTTP ${res.status}`)
  const { jwt } = await res.json()
  if (!jwt) throw new Error('sign-in missing jwt')
  return jwt
}

async function triggerGameVP(jwt) {
  const res = await fetch(`${B}/v2/games/${GAME_ID}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'updateGame',
      performTentativeStreams: { action: 'replace', value: 'requested' },
    }),
  })
  if (!res.ok) throw new Error(`trigger VP → HTTP ${res.status}`)
}

async function waitForPlaylist(jwt, { tries = 40, intervalMs = 3000 } = {}) {
  for (let i = 0; i < tries; i++) {
    await sleep(intervalMs)
    let content = []
    try {
      const r = await fetch(
        `${B}/v1/streams?gameId=${GAME_ID}&type=aggregated&type=intermediate`,
        { headers: { authorization: `Bearer ${jwt}` } }
      )
      const t = await r.text()
      content = (t ? JSON.parse(t) : {})?.content ?? []
    } catch {
      continue
    }
    const agg = content.find((s) => s.type === 'aggregated')
    if (!agg) continue
    const playlist = `${B}/v2/streams/${agg.id}/playlist?accountId=${encodeURIComponent(
      SPIIDEO_ACCOUNT_ID
    )}&authorization=bearer+${jwt}`
    const head = await fetch(playlist, { method: 'HEAD', redirect: 'manual' }).catch(() => null)
    if (head && head.status >= 200 && head.status < 400) return playlist
  }
  return null
}

async function main() {
  const out = `/tmp/${GAME_ID}.mp4`
  try {
    if (!RECORDING_ID || !GAME_ID) throw new Error('RECORDING_ID + GAME_ID required')
    const jwt = await signIn()
    await triggerGameVP(jwt)
    const playlist = await waitForPlaylist(jwt)
    if (!playlist) throw new Error('VP stream did not become ready in time')

    // Heartbeat: refresh panorama_capture_started_at while the (multi-GB, possibly
    // >10-min) remux runs, so the route's stuck-capture detector never re-triggers
    // a SECOND Batch job for a still-running one (the sequential double-spend).
    const heartbeat = setInterval(() => {
      setStatus({ panorama_capture_started_at: new Date().toISOString() }).catch(() => {})
    }, 120_000)
    try {
      // Remux HLS → mp4, NO re-encode. -protocol_whitelist is HTTPS-only (NO
      // file/http) so a manipulated playlist can't read file:// or hit the Fargate
      // task-role metadata endpoint and mux stolen creds into the output;
      // -allowed_extensions ALL is needed for Spiideo's extensionless segments;
      // -t is a hard safety cap; +faststart makes it progressively playable. The
      // playlist carries the JWT, so ffmpeg error output must never propagate —
      // rethrow a fixed, redacted message.
      await execFileP(
        FFMPEG,
        [
          '-y', '-loglevel', 'error',
          '-protocol_whitelist', 'https,tls,tcp,crypto',
          '-allowed_extensions', 'ALL',
          '-extension_picky', '0',
          '-i', playlist,
          '-t', String(MAX_SECONDS),
          '-c', 'copy',
          '-movflags', '+faststart',
          out,
        ],
        { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1 << 20 }
      )
    } catch (e) {
      throw new Error(`ffmpeg remux failed (${redact(e?.message || e).slice(0, 120)})`)
    } finally {
      clearInterval(heartbeat)
    }

    const { size } = await stat(out)
    if (size < 100_000) throw new Error(`remuxed file too small (${size} bytes)`)

    const key = `${VP_S3_PREFIX}/${GAME_ID}/${randomUUID()}.mp4`
    await new Upload({
      client: s3,
      params: {
        Bucket: S3_BUCKET,
        Key: key,
        Body: createReadStream(out),
        ContentType: 'video/mp4',
      },
      queueSize: 4,
      partSize: 16 * 1024 * 1024,
    }).done()

    await setStatus({
      panorama_s3_key: key,
      panorama_capture_status: 'ready',
      panorama_capture_error: null,
    })
    console.log(`vp-materialize ok recording=${RECORDING_ID} bytes=${size} key=${key}`)
  } catch (err) {
    const message = redact(err?.message || err).slice(0, 300)
    console.error(`vp-materialize failed recording=${RECORDING_ID}:`, message)
    await setStatus({ panorama_capture_status: 'error', panorama_capture_error: message })
    process.exitCode = 1
  } finally {
    await rm(out, { force: true }).catch(() => {})
  }
}

main().catch((e) => {
  console.error('vp-materialize fatal:', redact(e?.message || e).slice(0, 200))
  process.exitCode = 1
})
