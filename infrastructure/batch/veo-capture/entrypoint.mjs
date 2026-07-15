// AWS Batch (Fargate) job: capture a Veo match's NATIVE panorama + its
// jersey-labelled player tracking into OUR private S3, before Veo archives the
// panorama to Glacier.
//
// WHY THIS EXISTS — read this before changing what it captures.
//
// We are NOT shipping Veo's AI. Veo is the free LABELLER for our own jersey
// model, which then runs on Spiideo, Veo, or a car-park camera. Production never
// calls /api/mes/v2/. This job's only job is to preserve the two things that make
// a training corpus — the pixels and the labels — while they still exist.
//
// The pixels expire. Measured 2026-07-15: the panorama is `available` at <=40d and
// Glacier'd (`InvalidObjectState`) by ~150d, while the follow-cam render never
// archives. So every week we do not capture, matches age out of reach forever —
// the same way we lost 234/268 Spiideo panoramas before capture-on-publish.
//
// WHICH render, and why the .ts (measured, YOLO player heights on one frame):
//   .ts   3840x2160 x2 lenses (native)  median player 83px, p75 151, max 309, 67% >=64px
//   mp4   2048x1024 per lens (transcode) median 54px  -- 2x downscale, loses the far side
//   standard follow-cam 1920x1080        median 58px, max 88px -- NOT zoomed; the worst
// The .ts is the only render with legible jerseys at range, and it is the one that
// archives. There is no never-archiving alternative.
//
// Auth: the API needs a Bearer (Playwright login — playhub_veo_auth_tokens is
// empty ~75% of the time, 55min TTL minted every 4h, so it is not dependable).
// The CDN is PUBLIC, so the big .ts transfer needs no token and cannot be killed
// by token expiry mid-download. All API calls happen first, then the browser is
// closed, then the bytes stream.
//
// No ephemeral disk and no ffmpeg: the .ts is a progressive HTTP object and seeks
// fine over range requests, so we stream fetch -> S3 directly rather than staging
// to /tmp like vp-materialize has to for HLS.
//
// Env: ROW_ID, MATCH_SLUG, VEO_EMAIL, VEO_PASSWORD, S3_RECORDINGS_BUCKET,
// VEO_S3_PREFIX, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AWS_REGION.

import { Readable, PassThrough } from 'node:stream'

import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright-core'

const { ROW_ID, MATCH_SLUG, VEO_EMAIL, VEO_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } =
  process.env
// Must be the SAME private bucket the app signs from — a mismatch 404s
// everything, or exposes minors' footage if pointed at a public bucket.
const S3_BUCKET = process.env.S3_RECORDINGS_BUCKET
const PREFIX = process.env.VEO_S3_PREFIX || 'veo-panoramas'
const REGION = process.env.AWS_REGION || 'eu-west-2'
const API = 'https://app.veo.co'
// The web app sends this on every call; the API 403s without it on some paths.
const VEO_AGENT = 'veo:svc:web-app'
const TRACK_PAGE_S = 30 // /player-tracking returns ~30s per call

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const s3 = new S3Client({ region: REGION })

// The password and any Bearer must never reach a log line or the DB. RLS denies
// all on playhub_veo_captures, so this is defence-in-depth rather than the only
// barrier.
//
// scrub() guards on PRESENCE. The previous `.replaceAll(VEO_PASSWORD || ' ', '***')`
// replaced every SPACE when the var was unset, garbling the exact message
// ("Veo login captured no bearer token") needed to debug the missing credential
// that caused it.
const scrub = (s, v) => (v ? s.split(v).join('***') : s)
// The bare token is handed to page.evaluate as a plain string arg, so it can
// surface WITHOUT a 'Bearer ' prefix if Playwright serialises args into an error.
// Scrub the raw value, not just the header pattern.
let bearerSeen = ''
const redact = (s) =>
  scrub(scrub(scrub(String(s), VEO_PASSWORD), VEO_EMAIL), bearerSeen).replace(
    /Bearer\s+[\w.\-]+/gi,
    'Bearer ***'
  )

async function setStatus(patch, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    const { error } = await supabase
      .from('playhub_veo_captures')
      .update(patch)
      .eq('id', ROW_ID)
    if (!error) return
    if (i === retries) throw new Error(`status write failed: ${error.message}`)
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
  }
}

async function main() {
  if (!ROW_ID || !MATCH_SLUG) throw new Error('ROW_ID + MATCH_SLUG required')
  if (!S3_BUCKET) throw new Error('S3_RECORDINGS_BUCKET required')

  // --disable-dev-shm-usage: Fargate pins /dev/shm to 64MB and does NOT support
  // linuxParameters.sharedMemorySize, so chromium must not try to use it. Without
  // this the login flakes under load.
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  })
  let bearer = ''
  let api // page-context fetch, so cookies/CSRF ride along exactly as the app does
  try {
    const page = await browser.newPage()
    page.on('request', (r) => {
      const a = r.headers()['authorization']
      if (a?.startsWith('Bearer ') && r.url().includes('app.veo.co/api/')) {
        bearer = a.slice(7)
        bearerSeen = bearer
      }
    })
    await page.goto(API, { waitUntil: 'networkidle' })
    // page.fill auto-waits; page.$ returns null if the client-rendered form has
    // not mounted yet and derefs into an opaque TypeError.
    await page.fill('input[type="email"]', VEO_EMAIL)
    await page.fill('input[type="password"]', VEO_PASSWORD)
    await page.click('button[type="submit"]')
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
    await page.waitForTimeout(2500)
    if (!bearer) throw new Error('Veo login captured no bearer token')

    api = async (path) =>
      page.evaluate(
        async ([p, b, ua]) => {
          const r = await fetch(`https://app.veo.co${p}`, {
            headers: { accept: 'application/json', authorization: `Bearer ${b}`, 'veo-agent': ua },
            credentials: 'include',
          })
          const t = await r.text()
          try {
            return { s: r.status, j: JSON.parse(t) }
          } catch {
            return { s: r.status, j: null, t: t.slice(0, 200) }
          }
        },
        [path, bearer, VEO_AGENT]
      )

    // ── 1. the renditions. The .ts is render_type=panorama + mime video/mp2t.
    const vids = await api(`/api/app/matches/${MATCH_SLUG}/videos/`)
    if (vids.s === 409)
      throw new Error('Veo ToS acceptance required — a human must log in and accept')
    if (vids.s !== 200) throw new Error(`videos/ returned ${vids.s}`)
    const list = Array.isArray(vids.j) ? vids.j : vids.j?.results || []
    const ts = list.find((v) => v.render_type === 'panorama' && v.mime_type === 'video/mp2t')
    // TRANSIENT, and it must not burn an attempt. Veo renders the panorama some
    // time after the upload, so a freshly-published match legitimately has no .ts
    // yet. Burning attempts here settled fresh matches at error/attempts=3 within
    // ~45 min (5-min cooldown x 15-min ticks) — permanently forfeiting exactly the
    // matches furthest from Glacier. The view now filters most of these out, but
    // this is the half that makes it safe: reset the counter so the sweep keeps
    // coming back until Veo renders (the 150d window bounds the retrying).
    if (!ts?.url) {
      await setStatus({
        capture_status: 'error',
        capture_error: 'panorama not rendered by Veo yet — will retry',
        capture_attempts: 0,
      })
      console.log(`veo-capture: ${MATCH_SLUG} has no .ts yet; attempt not burned`)
      return
    }
    if (ts.availability && ts.availability !== 'available')
      // Glacier. Nothing to do but record it — this match aged out before we got here.
      throw new Error(`panorama already ${ts.availability} — too late to capture`)

    // The match uuid is the first path segment of every CDN url.
    const uuid = new URL(ts.url).pathname.split('/').filter(Boolean)[0]
    if (!uuid) throw new Error('could not derive match uuid from the CDN url')

    // ── 2. the labels. step-events FIRST: `match_ongoing` gives the real periods,
    // and they are NOT a free parameter — an invented window returns 200 and
    // silently merges both halves, and teams SWAP ENDS at half time, so `side`
    // would mean a different team either side of the break.
    const se = await api(`/api/mes/v2/${uuid}/step-events`)
    const halves = (Array.isArray(se.j) ? se.j : []).filter((e) => e.name === 'match_ongoing')
    if (!halves.length) throw new Error('step-events carried no match_ongoing period')

    const qs = halves.map((h) => `periods=${Math.round(h.start)}%2C${Math.round(h.end)}`).join('&')
    const jn = await api(`/api/mes/v2/${uuid}/player-tracking/jersey-numbers?${qs}`)
    const events = await api(`/api/mes/v2/${uuid}/match-events`)

    // player-tracking is the RICHEST primitive: every object, jersey-labelled.
    // Columns: [trackId, roleTeam, xNorm, yNorm, JERSEY, ?, speedKmh, team]
    //   roleTeam: 0=left GK, 1=left outfield, 2=right GK, 3=right outfield, 6=ball
    //   metric:   x=(xNorm-0.5)*105, y=(yNorm-0.5)*68   (FIFA pitch; fitted at 100%)
    const frames = {}
    for (const h of halves) {
      for (let s = Math.floor(h.start); s < h.end; s += TRACK_PAGE_S) {
        const r = await api(`/api/mes/v2/${uuid}/player-tracking?start=${s}`)
        if (r.s !== 200 || !r.j) continue
        for (const [t, rows] of Object.entries(r.j)) {
          const tt = parseFloat(t)
          if (tt >= h.start && tt <= h.end) frames[t] = rows
        }
      }
    }
    const nFrames = Object.keys(frames).length
    if (nFrames < 100) throw new Error(`player-tracking too sparse (${nFrames} frames)`)
    console.log(`veo-capture ${MATCH_SLUG}: ${halves.length} periods, ${nFrames} tracking frames`)

    const base = `${PREFIX}/${MATCH_SLUG}`
    const putJson = (name, body) =>
      new Upload({
        client: s3,
        params: {
          Bucket: S3_BUCKET,
          Key: `${base}/${name}`,
          Body: JSON.stringify(body),
          ContentType: 'application/json',
        },
      }).done()

    await putJson('tracking.json', {
      matchSlug: MATCH_SLUG,
      matchUuid: uuid,
      capturedAt: new Date().toISOString(),
      // pitch + column semantics travel WITH the data: a bare array of numbers is
      // undecodable in six months, and this service is undocumented.
      schema: {
        pitch: { lengthM: 105, widthM: 68 },
        columns: ['trackId', 'roleTeam', 'xNorm', 'yNorm', 'jersey', 'unknown5', 'speedKmh', 'team'],
        roleTeam: { 0: 'left-GK', 1: 'left-outfield', 2: 'right-GK', 3: 'right-outfield', 6: 'ball' },
        team: { 2: 'left', 1: 'right', 0: 'ball' },
        jersey: '-1 = not read',
        metric: 'x = (xNorm - 0.5) * 105 ; y = (yNorm - 0.5) * 68',
        sampleHz: 2.5,
      },
      periods: halves.map((h) => ({ start: h.start, end: h.end })),
      stepEvents: se.j ?? null,
      jerseyNumbers: jn.j ?? null,
      frames,
    })
    await putJson('match-events.json', events.j ?? null)

    // Cheap provenance, and Phase 2 may want them: the lens calibration and the
    // per-frame follow-cam direction. Both are public CDN objects.
    for (const [name, url] of [
      ['alignment.veo', ts.render_settings],
      ['camera_directions.det', ts.camera_directions],
    ]) {
      if (!url) continue
      try {
        const r = await fetch(url)
        if (!r.ok) continue
        await new Upload({
          client: s3,
          params: { Bucket: S3_BUCKET, Key: `${base}/${name}`, Body: Buffer.from(await r.arrayBuffer()) },
        }).done()
      } catch (e) {
        console.log(`veo-capture: ${name} skipped (${redact(e?.message || e).slice(0, 80)})`)
      }
    }

    await browser.close()

    // ── 3. the pixels. Public CDN, no auth — so token expiry cannot kill this,
    // which matters because it is multi-GB and the token lives 55 min.
    //
    // DETERMINISTIC key, deliberately not a randomUUID like vp-materialize uses.
    // The upload happens before the terminal status write, so any failure after it
    // (a DB blip, a truncation check) leaves the object behind. With a random key
    // every retry mints a NEW ~6-9GB orphan that nothing references; with a fixed
    // one the retry overwrites its own partial and the object count per match
    // stays exactly 1. (Observed: the first failed run orphaned 6.3GB.)
    const key = `${base}/panorama.ts`
    const heartbeat = setInterval(() => {
      setStatus({ capture_started_at: new Date().toISOString() }).catch(() => {})
    }, 120_000)
    let bytes = 0
    try {
      const res = await fetch(ts.url)
      if (!res.ok || !res.body) throw new Error(`panorama fetch returned ${res.status}`)
      const declared = Number(res.headers.get('content-length') || 0)
      // No content-length = we cannot prove completeness, and a cleanly-closed
      // short response does not error the stream. Refuse rather than guess: this
      // corpus is unre-fetchable once Veo Glaciers it.
      if (!declared) throw new Error('panorama response carried no content-length')

      // Count INSIDE the pipeline, not with a `.on('data')` side-channel on the
      // same stream lib-storage consumes. That side-channel puts the stream in
      // flowing mode while lib-storage pulls it in paused mode, and which
      // listener wins is an ordering race in lib-storage's internals: it happens
      // to be safe today, but when it loses, the counter counts bytes S3 NEVER
      // RECEIVED — so `bytes === declared` passes and certifies a truncated
      // object as 'ready' (terminal, never retried) on a key we can't re-fetch.
      // A PassThrough is the same three lines and cannot invert.
      const counter = new PassThrough()
      counter.on('data', (c) => {
        bytes += c.length
      })
      Readable.fromWeb(res.body).pipe(counter)

      await new Upload({
        client: s3,
        params: { Bucket: S3_BUCKET, Key: key, Body: counter, ContentType: 'video/mp2t' },
        queueSize: 4,
        partSize: 32 * 1024 * 1024, // 9.5GB / 32MB ~= 300 parts, well under the 10k cap
      }).done()

      // Verify against what S3 ACTUALLY STORED, not against our own accounting.
      // This is the only check that survives a lib-storage refactor, and the only
      // one that means anything for a corpus we cannot re-fetch.
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key })
      )
      const stored = Number(head.ContentLength || 0)
      if (Math.abs(stored - declared) > 1024)
        throw new Error(`panorama truncated: S3 stored ${stored} of ${declared} bytes`)
      if (Math.abs(bytes - declared) > 1024)
        throw new Error(`panorama stream short: read ${bytes} of ${declared} bytes`)
      if (stored < 10_000_000) throw new Error(`panorama implausibly small (${stored} bytes)`)
      bytes = stored
    } finally {
      clearInterval(heartbeat)
    }

    await setStatus({
      panorama_s3_key: key,
      tracking_s3_key: `${base}/tracking.json`,
      capture_status: 'ready',
      capture_error: null,
      panorama_bytes: bytes,
    })
    console.log(`veo-capture ok match=${MATCH_SLUG} bytes=${bytes} key=${key}`)
  } finally {
    await browser.close().catch(() => {})
  }
}

main().catch(async (err) => {
  const msg = err instanceof Error ? redact(err.message).slice(0, 300) : 'capture failed (see job logs)'
  console.error(`veo-capture FAILED match=${MATCH_SLUG}: ${msg}`)
  await setStatus({ capture_status: 'error', capture_error: msg }).catch(() => {})
  process.exit(1)
})
