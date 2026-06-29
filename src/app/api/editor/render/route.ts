/**
 * POST /api/editor/render
 *
 * Renders the portrait MP4 via the Modal `render_portrait` endpoint, uploads the
 * result to Supabase Storage, and returns a short-lived signed download URL.
 *
 * Two modes:
 *   { jobId }                                  → render a SAVED crop job (loads
 *                                                keyframes from the DB, updates the
 *                                                job row to 'rendered').
 *   { videoUrl, keyframes, sceneChanges?, highlightId? }
 *                                              → DIRECT render of the current edit
 *                                                (academy flow, which has no saved
 *                                                job because it has no recordingId).
 *
 * Returns: { signedUrl, expiresAt, storagePath }
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  createClient,
  createServiceClient,
  getAuthUserStrict,
} from '@/lib/supabase/server'
import {
  requirePortraitCropEnabled,
  validateVideoUrl,
  ValidationError,
  SOURCE_WIDTH,
  MAX_KEYFRAMES_PER_JOB,
} from '@/lib/editor/validation'
import type { CropClient } from '@/lib/editor/db-types'

export const dynamic = 'force-dynamic'
// Render can be slow on long clips — A10G render of a 30s clip ≈ 20-40s and the
// Modal roundtrip adds Netlify-side overhead. Lift the per-route budget to 5m.
export const maxDuration = 300

const STORAGE_BUCKET = 'portrait-crops'
const SIGNED_URL_TTL_SECONDS = 60 * 60 // 1 hour
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_SOURCE_BYTES = 750 * 1024 * 1024 // cap the in-memory source fetch (OOM guard)

type ModalKeyframe = { time_seconds: number; x_pixels: number }

/**
 * SSRF-guard the source URL, fetch it, render via Modal, and return the MP4
 * bytes. Shared by both modes so the security-critical fetch/render path has a
 * single implementation. Throws ValidationError (422) on a bad/disallowed URL.
 */
async function renderViaModal(
  sourceUrl: string,
  keyframes: ModalKeyframe[],
  sceneChanges: number[]
): Promise<ArrayBuffer> {
  // SSRF guard — single source of truth (same allowlist/policy as the save path;
  // returns the validated https URL or throws ValidationError 403).
  const safeUrl = validateVideoUrl(sourceUrl)

  const modalUrl = process.env.NEXT_PUBLIC_MODAL_RENDER_URL
  const modalSecret = process.env.MODAL_SHARED_SECRET
  if (!modalUrl || !modalSecret) {
    throw new ValidationError('Render endpoint not configured', 500)
  }

  const srcRes = await fetch(safeUrl, {
    redirect: 'error', // refuse redirects — closes the allowlist-bypass vector
    headers: { 'User-Agent': 'PLAYHUB/render' },
  })
  if (!srcRes.ok) {
    throw new ValidationError(`Failed to fetch source (${srcRes.status})`, 502)
  }
  // Bound the in-memory buffer — the allowlist constrains host, not object size.
  const advertised = Number(srcRes.headers.get('content-length') ?? 0)
  if (advertised > MAX_SOURCE_BYTES) {
    throw new ValidationError('Source video too large', 413)
  }
  const srcBuffer = await srcRes.arrayBuffer()
  if (srcBuffer.byteLength > MAX_SOURCE_BYTES) {
    throw new ValidationError('Source video too large', 413)
  }

  const form = new FormData()
  form.append(
    'video',
    new Blob([srcBuffer], { type: 'video/mp4' }),
    'source.mp4'
  )
  form.append('keyframes', JSON.stringify(keyframes))
  form.append('scene_changes', JSON.stringify(sceneChanges ?? []))

  const modalRes = await fetch(modalUrl, {
    method: 'POST',
    body: form,
    headers: { 'X-Modal-Auth': modalSecret },
  })
  if (!modalRes.ok) {
    const detail = await modalRes.text().catch(() => '')
    console.error(
      '[editor/render] modal error',
      modalRes.status,
      detail.slice(0, 200)
    )
    throw new ValidationError('Render failed', 502)
  }
  const rendered = await modalRes.arrayBuffer()
  if (rendered.byteLength < 100 * 1024) {
    // Sanity — a successful render should be larger than a thumbnail.
    throw new ValidationError('Render produced an unusably small output', 502)
  }
  return rendered
}

/** Upload the rendered MP4 (service-role — the bucket has no authenticated
 *  INSERT policy) and mint a short-lived signed download URL. */
async function uploadAndSign(buffer: ArrayBuffer, storagePath: string) {
  const service = createServiceClient()
  const { error: upErr } = await service.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, { contentType: 'video/mp4', upsert: true })
  if (upErr) {
    console.error('[editor/render] upload error:', upErr.message)
    throw new ValidationError('Upload failed', 500)
  }
  const { data: signed, error: signErr } = await service.storage
    .from(STORAGE_BUCKET)
    // download:true sets Content-Disposition: attachment so a cross-origin click
    // downloads the MP4 instead of navigating to it.
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS, { download: true })
  if (signErr || !signed) {
    console.error('[editor/render] sign error:', signErr?.message)
    throw new ValidationError('Could not create download URL', 500)
  }
  return {
    signedUrl: signed.signedUrl,
    storagePath,
    expiresAt: new Date(
      Date.now() + SIGNED_URL_TTL_SECONDS * 1000
    ).toISOString(),
  }
}

/** Validate a user-supplied keyframe list into the Modal shape. */
function parseDirectKeyframes(raw: unknown): ModalKeyframe[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError('keyframes required', 422)
  }
  if (raw.length > MAX_KEYFRAMES_PER_JOB) {
    throw new ValidationError('too many keyframes', 422)
  }
  const parsed = raw.map((kf, i) => {
    const t = (kf as { time_seconds?: unknown }).time_seconds
    const x = (kf as { x_pixels?: unknown }).x_pixels
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
      throw new ValidationError(`keyframes[${i}].time_seconds invalid`, 422)
    }
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new ValidationError(`keyframes[${i}].x_pixels invalid`, 422)
    }
    // Clamp x into the source frame, matching the save path's bounds.
    return {
      time_seconds: t,
      x_pixels: Math.min(SOURCE_WIDTH, Math.max(0, Math.round(x))),
    }
  })
  // Modal interpolation assumes ascending time (the save path enforces this).
  parsed.sort((a, b) => a.time_seconds - b.time_seconds)
  return parsed
}

export async function POST(request: NextRequest) {
  try {
    const { user } = await getAuthUserStrict()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = await createClient()
    await requirePortraitCropEnabled(supabase)
    const sb = supabase as unknown as CropClient

    let body: {
      jobId?: unknown
      videoUrl?: unknown
      keyframes?: unknown
      sceneChanges?: unknown
      highlightId?: unknown
    }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    // Require exactly one mode selector (mirrors the save route's XOR).
    if (body.jobId == null && body.videoUrl == null) {
      return NextResponse.json(
        {
          error: 'Provide either jobId (saved job) or videoUrl (direct render)',
        },
        { status: 400 }
      )
    }

    // ───── Direct mode: render the current edit (academy flow, no saved job).
    //       jobId takes precedence if both are somehow sent. ─────
    if (body.jobId == null && typeof body.videoUrl === 'string') {
      const keyframes = parseDirectKeyframes(body.keyframes)
      const sceneChanges = Array.isArray(body.sceneChanges)
        ? (body.sceneChanges.filter((n) => typeof n === 'number') as number[])
        : []
      const hid =
        typeof body.highlightId === 'string' &&
        body.highlightId.trim().length > 0 &&
        body.highlightId.length <= 200
          ? body.highlightId.trim().replace(/[^a-zA-Z0-9_-]/g, '')
          : null
      const rendered = await renderViaModal(
        body.videoUrl,
        keyframes,
        sceneChanges
      )
      // Key by highlight when known (re-renders overwrite in place); else a unique
      // per-render path so a live signed URL can't serve a later render's bytes.
      const storagePath = `${user.id}/adhoc-${hid ?? crypto.randomUUID()}.mp4`
      const result = await uploadAndSign(rendered, storagePath)
      return NextResponse.json(result)
    }

    // ───── Saved-job mode: render a persisted crop job ─────
    if (typeof body.jobId !== 'string' || !UUID_RE.test(body.jobId)) {
      return NextResponse.json({ error: 'Invalid jobId' }, { status: 400 })
    }
    const jobId = body.jobId

    // 1. Load job + keyframes (RLS scopes to caller's own rows).
    const { data: job, error: jobErr } = await sb
      .from('playhub_crop_jobs')
      .select('id, recording_id, video_url, user_id, scene_changes, status')
      .eq('id', jobId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (jobErr) {
      console.error('[editor/render] job fetch error:', jobErr.message)
      return NextResponse.json({ error: 'Render failed' }, { status: 500 })
    }
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const { data: keyframes, error: kfErr } = await sb
      .from('playhub_crop_keyframes')
      .select('time_seconds, x_pixels')
      .eq('job_id', job.id)
      .order('time_seconds', { ascending: true })
    if (kfErr) {
      console.error('[editor/render] keyframes fetch error:', kfErr.message)
      return NextResponse.json({ error: 'Render failed' }, { status: 500 })
    }
    if (!keyframes || keyframes.length === 0) {
      return NextResponse.json(
        { error: 'Job has no keyframes to render' },
        { status: 422 }
      )
    }

    // 2. Resolve the source video URL (recording-linked or ad-hoc).
    let sourceUrl: string | null = job.video_url
    if (job.recording_id) {
      const { data: recording, error: recErr } = await sb
        .from('playhub_match_recordings' as never)
        .select('video_url')
        .eq('id', job.recording_id)
        .maybeSingle()
      if (recErr || !recording) {
        console.error('[editor/render] recording fetch error:', recErr?.message)
        return NextResponse.json(
          { error: 'Source recording not accessible' },
          { status: 403 }
        )
      }
      sourceUrl = (recording as { video_url?: string | null }).video_url ?? null
    }
    if (!sourceUrl) {
      return NextResponse.json(
        { error: 'Job has no resolvable video URL' },
        { status: 422 }
      )
    }

    // 3. Render (SSRF guard + Modal) + upload + sign.
    const rendered = await renderViaModal(
      sourceUrl,
      keyframes.map((kf) => ({
        time_seconds: kf.time_seconds,
        x_pixels: kf.x_pixels,
      })),
      (job.scene_changes as number[]) ?? []
    )
    const result = await uploadAndSign(rendered, `${user.id}/${job.id}.mp4`)

    // 4. Update job row (rendered status + path). Log-only on failure.
    const { error: updErr } = await sb
      .from('playhub_crop_jobs')
      .update({ status: 'rendered', output_storage_path: result.storagePath })
      .eq('id', job.id)
      .eq('user_id', user.id)
    if (updErr) {
      console.warn('[editor/render] job status update failed:', updErr.message)
    }

    const { error: fbErr } = await sb.from('playhub_crop_feedback').insert({
      job_id: job.id,
      user_id: user.id,
      action: 'exported',
      note: null,
    })
    if (fbErr) {
      console.warn('[editor/render] feedback insert failed:', fbErr.message)
    }

    return NextResponse.json(result)
  } catch (err: unknown) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error(
      'Render route error:',
      err instanceof Error ? err.message : err
    )
    return NextResponse.json({ error: 'Render failed' }, { status: 500 })
  }
}
