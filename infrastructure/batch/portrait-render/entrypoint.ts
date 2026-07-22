// Portrait-render Batch job — turns every tagged Veo goal of ONE match into a
// 9:16 draft render for club-admin review (roadmap item 2, CFA pilot).
//
// Per goal event: clip URL from the playhub_veo_match_content_cache highlights
// JSON (NO Veo API dependency — the cache covers the corpus and the academy
// player streams these same URLs daily) → detection from the shared
// playhub_crop_detections cache, else Modal detect (A10G) → the SAME
// auto-keyframes composition the editor uses (bundled via esbuild relative
// import — parity is contract-tested) → Modal render_portrait (CPU ffmpeg) →
// portrait-crops bucket at system/{club}/{event}.mp4 → playhub_portrait_renders
// row (status draft + quality signals).
//
// Review-first by design: nothing here publishes. Idempotent: published and
// rejected rows are never touched; existing drafts are skipped unless
// RERENDER=1. Per-event failures record an error row and continue — the job
// exits non-zero only when every event failed.

import { createClient } from '@supabase/supabase-js'
import { autoKeyframesFromDetection } from '../../../src/lib/editor/auto-keyframes'
import { VIDEO_URL_ALLOWED_HOSTS } from '../../../src/lib/editor/validation'

const ID_RE = /^[A-Za-z0-9_-]+$/

const MATCH_SLUG = requiredId('MATCH_SLUG')
const CLUB_SLUG = requiredId('CLUB_SLUG')
const SUPABASE_URL = required('SUPABASE_URL')
const SERVICE_KEY = required('SUPABASE_SERVICE_ROLE_KEY')
const MODAL_CROP_URL = required('MODAL_CROP_URL')
const MODAL_RENDER_URL = required('MODAL_RENDER_URL')
const MODAL_SECRET = required('MODAL_SHARED_SECRET')
const RERENDER = process.env.RERENDER === '1'

const STORAGE_BUCKET = 'portrait-crops'
// Veo goal highlights are ~15MB 25s clips; 200MB is generous headroom while
// keeping buffer + FormData copy well inside the 2GB container.
const MAX_SOURCE_BYTES = 200 * 1024 * 1024
const MIN_RENDER_BYTES = 100 * 1024
const MAX_ATTEMPTS = 3
const FETCH_TIMEOUT_MS = 120_000
const MODAL_TIMEOUT_MS = 480_000 // detect can take ~90s + cold start
const SOURCE_WIDTH = 1920 // keyframe clamp bound, matching the render route

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing env ${name}`)
  return v
}

function requiredId(name: string): string {
  const v = required(name)
  // Interpolated into storage paths + PostgREST filters — enforce the shape.
  if (!ID_RE.test(v)) throw new Error(`env ${name} has an invalid format`)
  return v
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
})

interface HighlightVideo {
  url?: string
  width?: number
  height?: number
}
interface CachedHighlight {
  id?: string
  videos?: HighlightVideo[]
}

/** Largest rendition, mirroring mining/fetch_goal_clips.ts pickVideoUrl:
 *  keep only entries WITH a url, rank by pixel area. */
function pickVideoUrl(h: CachedHighlight | undefined): string | null {
  const withUrl = (h?.videos ?? []).filter((v) => v.url)
  if (withUrl.length === 0) return null
  withUrl.sort(
    (a, b) =>
      (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0)
  )
  return withUrl[0].url ?? null
}

/** Same allowlist policy as src/lib/editor/validation.ts validateVideoUrl. */
function assertAllowedUrl(raw: string): string {
  const parsed = new URL(raw)
  if (parsed.protocol !== 'https:')
    throw new Error(`clip URL not https: ${parsed.protocol}`)
  if (!VIDEO_URL_ALLOWED_HOSTS.includes(parsed.hostname))
    throw new Error(`clip host not allowlisted: ${parsed.hostname}`)
  return parsed.toString()
}

async function fetchClip(url: string): Promise<ArrayBuffer> {
  const safe = assertAllowedUrl(url)
  const res = await fetch(safe, {
    redirect: 'error',
    headers: { 'User-Agent': 'PLAYHUB/portrait-render' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`clip fetch ${res.status}`)
  const advertised = Number(res.headers.get('content-length') ?? 0)
  if (advertised > MAX_SOURCE_BYTES) throw new Error('clip too large')
  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_SOURCE_BYTES) throw new Error('clip too large')
  return buf
}

async function getDetection(eventId: string, clip: ArrayBuffer) {
  const { data: cached } = await supabase
    .from('playhub_crop_detections')
    .select('detection')
    .eq('veo_highlight_id', eventId)
    .maybeSingle()
  if (cached?.detection) return cached.detection as Record<string, unknown>

  const res = await fetch(MODAL_CROP_URL, {
    method: 'POST',
    body: clip,
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Modal-Auth': MODAL_SECRET,
    },
    signal: AbortSignal.timeout(MODAL_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`modal detect ${res.status}`)
  const detection = (await res.json()) as Record<string, unknown>

  // Seed the shared cache exactly like /api/editor/process (best-effort,
  // shape/size-guarded so a detector bug can't bloat the table).
  const blobOk =
    Array.isArray(detection?.positions) &&
    Array.isArray(detection?.scene_changes) &&
    JSON.stringify(detection).length <= 2_000_000
  if (blobOk) {
    const { error } = await supabase.from('playhub_crop_detections').upsert(
      {
        veo_highlight_id: eventId,
        detection,
        modal_inference_ms: (detection.modal_inference_ms as number) ?? null,
        modal_app_version: (detection.modal_app_version as string) ?? null,
      },
      { onConflict: 'veo_highlight_id' }
    )
    if (error) console.error(`detect cache write failed: ${error.message}`)
  }
  return detection
}

async function renderPortrait(
  clip: ArrayBuffer,
  keyframes: { time_seconds: number; x_pixels: number }[],
  sceneChanges: number[]
): Promise<ArrayBuffer> {
  const form = new FormData()
  form.append('video', new Blob([clip], { type: 'video/mp4' }), 'source.mp4')
  form.append('keyframes', JSON.stringify(keyframes))
  form.append('scene_changes', JSON.stringify(sceneChanges))
  const res = await fetch(MODAL_RENDER_URL, {
    method: 'POST',
    body: form,
    headers: { 'X-Modal-Auth': MODAL_SECRET },
    signal: AbortSignal.timeout(MODAL_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`modal render ${res.status}`)
  const out = await res.arrayBuffer()
  if (out.byteLength < MIN_RENDER_BYTES)
    throw new Error('render output implausibly small')
  return out
}

/**
 * Guarded write: NEVER clobber an admin decision. Jobs run ~20 min, so an
 * admin can publish/reject mid-run — a published/rejected row must survive
 * both this job and any concurrent duplicate. UPDATE with a status filter
 * (count-CAS), INSERT only when no row exists; a unique-violation on the
 * INSERT means a concurrent writer won — skip.
 */
async function writeRenderGuarded(row: {
  recording_event_id: string
  provider_event_id: string
  provider_recording_id: string
  club_slug: string
  storage_path: string
  status: string
  error: string | null
  quality?: unknown
  // The exact CropKeyframe[] this render used — the baseline human corrections are
  // diffed against. MUST be the pre-rounding autoKeyframesFromDetection output, not
  // the Modal {time_seconds,x_pixels} payload: the feedback route parses the former,
  // and the latter would fail parsing and silently fall back to a re-derived baseline
  // forever. MUST be written in the SAME statement as status/storage_path, and nulled
  // on the error path — otherwise a re-render swaps the MP4 and leaves the previous
  // run's geometry behind, which reads as `render_row` (a confident lie) rather than
  // the honest null it replaced.
  keyframes?: unknown
  scene_changes?: unknown
  attempts: number
}): Promise<boolean> {
  const now = new Date().toISOString()
  const { count, error: upErr } = await supabase
    .from('playhub_portrait_renders')
    .update(
      {
        status: row.status,
        error: row.error,
        quality: row.quality ?? null,
        keyframes: row.keyframes ?? null,
        scene_changes: row.scene_changes ?? null,
        attempts: row.attempts,
        storage_path: row.storage_path,
        updated_at: now,
      },
      { count: 'exact' }
    )
    .eq('provider_event_id', row.provider_event_id)
    .in('status', ['draft', 'error'])
  if (upErr) throw new Error(`renders update: ${upErr.message}`)
  if (count && count > 0) return true

  const { error: insErr } = await supabase
    .from('playhub_portrait_renders')
    .insert({ ...row, updated_at: now })
  if (!insErr) return true
  if (insErr.code === '23505') {
    // Row exists in a protected status (published/rejected) or a concurrent
    // writer inserted first — either way, do not overwrite.
    console.log(
      `event ${row.provider_event_id}: existing protected row, write skipped`
    )
    return false
  }
  throw new Error(`renders insert: ${insErr.message}`)
}

async function main() {
  const { data: events, error: evErr } = await supabase
    .from('playhub_recording_events')
    .select('id, provider_event_id, timestamp_seconds')
    .eq('provider', 'veo')
    .eq('event_type', 'goal')
    .eq('provider_recording_id', MATCH_SLUG)
  if (evErr) throw new Error(`events query: ${evErr.message}`)
  if (!events?.length) {
    console.log('no goal events for match — nothing to do')
    return
  }

  const { data: cacheRow, error: cacheErr } = await supabase
    .from('playhub_veo_match_content_cache')
    .select('highlights')
    .eq('match_slug', MATCH_SLUG)
    .maybeSingle()
  if (cacheErr) throw new Error(`content cache query: ${cacheErr.message}`)
  const highlights = (cacheRow?.highlights ?? []) as CachedHighlight[]
  const byId = new Map(highlights.map((h) => [h.id, h]))

  const { data: existing } = await supabase
    .from('playhub_portrait_renders')
    .select('provider_event_id, status, attempts')
    .eq('provider_recording_id', MATCH_SLUG)
  const existingByEvent = new Map(
    (existing ?? []).map((r) => [r.provider_event_id, r])
  )

  let ok = 0
  let failed = 0
  let skipped = 0
  for (const event of events) {
    const eventId = event.provider_event_id
    if (!eventId) {
      skipped++
      continue
    }
    if (!ID_RE.test(eventId)) {
      // Veo-issued ids are UUID-shaped; anything else must not reach the
      // storage-path construction.
      skipped++
      console.error(`event ${event.id}: malformed provider_event_id, skipped`)
      continue
    }
    const prior = existingByEvent.get(eventId)
    const status = prior?.status
    // published/rejected are admin decisions — never touch (the guarded
    // write enforces this too). Successful drafts regenerate only on
    // explicit RERENDER; error rows retry automatically while under the
    // attempt cap (transient Modal/CDN failures must not be permanent).
    // 'approved' included deliberately: the guarded write already refuses to
    // overwrite it, but without this the job would still detect+render+upload first
    // and throw the result away — a full GPU cycle per approved clip, every sweep.
    if (
      status === 'published' ||
      status === 'rejected' ||
      status === 'approved'
    ) {
      skipped++
      continue
    }
    if (status === 'draft' && !RERENDER) {
      skipped++
      continue
    }
    if (
      status === 'error' &&
      (prior?.attempts ?? 0) >= MAX_ATTEMPTS &&
      !RERENDER
    ) {
      skipped++
      continue
    }
    const attempts = (prior?.attempts ?? 0) + 1

    const base = {
      recording_event_id: event.id,
      provider_event_id: eventId,
      provider_recording_id: MATCH_SLUG,
      club_slug: CLUB_SLUG,
      storage_path: `system/${CLUB_SLUG}/${eventId}.mp4`,
    }
    try {
      const url = pickVideoUrl(byId.get(eventId))
      if (!url) throw new Error('no cached clip URL for event')
      const clip = await fetchClip(url)
      const detection = await getDetection(eventId, clip)
      const { keyframes, sceneChanges, quality } =
        autoKeyframesFromDetection(detection)
      if (keyframes.length === 0)
        throw new Error('no keyframes (detector found nothing)')
      const rendered = await renderPortrait(
        clip,
        // Round/clamp + ascending time — the exact validation the editor
        // render path applies before Modal (parseDirectKeyframes).
        keyframes
          .map((k) => ({
            time_seconds: k.time,
            x_pixels: Math.min(SOURCE_WIDTH, Math.max(0, Math.round(k.x))),
          }))
          .sort((a, b) => a.time_seconds - b.time_seconds),
        sceneChanges
      )
      const { error: upErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(base.storage_path, rendered, {
          contentType: 'video/mp4',
          upsert: true,
        })
      if (upErr) throw new Error(`storage upload failed`)
      const wrote = await writeRenderGuarded({
        ...base,
        status: 'draft',
        error: null,
        quality,
        // Pre-rounding CropKeyframe[] — the shape the feedback route can parse.
        keyframes,
        scene_changes: sceneChanges,
        attempts,
      })
      if (wrote) ok++
      else skipped++
      console.log(`rendered ${eventId} (${keyframes.length} keyframes)`)
    } catch (err) {
      failed++
      // Self-authored/short messages only — the column is club-readable.
      const msg =
        err instanceof Error ? err.message.slice(0, 200) : 'unknown error'
      console.error(`event ${eventId} failed: ${msg}`)
      try {
        await writeRenderGuarded({
          ...base,
          status: 'error',
          error: msg,
          // Deliberately no keyframes: writeRenderGuarded nulls them, so a failed
          // re-render cannot leave the previous run's geometry attached to a row
          // whose video no longer exists. Do not "helpfully" pass them here.
          attempts,
        })
      } catch (rowErr) {
        console.error(`could not record error row: ${rowErr}`)
      }
    }
  }

  console.log(
    `done: ${ok} rendered, ${skipped} skipped, ${failed} failed of ${events.length} events`
  )
  if (ok === 0 && failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
