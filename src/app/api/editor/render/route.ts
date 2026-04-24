/**
 * POST /api/editor/render
 *
 * Renders the portrait MP4 for a saved crop job via the Modal `render_portrait`
 * endpoint, uploads the result to Supabase Storage, updates the job row, and
 * returns a short-lived signed URL the client can use to download.
 *
 * Body: { jobId }
 * Returns: { signedUrl, expiresAt, storagePath }
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  createClient,
  createServiceClient,
  getAuthUserStrict,
} from '@/lib/supabase/server'
import {
  VIDEO_URL_ALLOWED_HOSTS,
  requirePortraitCropEnabled,
  ValidationError,
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

export async function POST(request: NextRequest) {
  try {
    const { user } = await getAuthUserStrict()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = await createClient()
    await requirePortraitCropEnabled(supabase)

    let body: { jobId?: unknown }
    try {
      body = (await request.json()) as { jobId?: unknown }
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (typeof body.jobId !== 'string' || !UUID_RE.test(body.jobId)) {
      return NextResponse.json({ error: 'Invalid jobId' }, { status: 400 })
    }
    const jobId = body.jobId

    const sb = supabase as unknown as CropClient

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

    // 2. Resolve the source video URL. Recording-linked jobs pull from
    // playhub_match_recordings (RLS gated by org membership); ad-hoc jobs
    // use the stored video_url.
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

    // 3. SSRF guard on source URL — must match the same allowlist the route
    // validator applied at save time, and must be https on the default port.
    let parsed: URL
    try {
      parsed = new URL(sourceUrl)
    } catch {
      return NextResponse.json(
        { error: 'Source URL is invalid' },
        { status: 422 }
      )
    }
    if (parsed.protocol !== 'https:') {
      return NextResponse.json(
        { error: 'Source URL must be https' },
        { status: 422 }
      )
    }
    if (parsed.port && parsed.port !== '443') {
      return NextResponse.json(
        { error: 'Source URL port not allowed' },
        { status: 422 }
      )
    }
    if (!VIDEO_URL_ALLOWED_HOSTS.includes(parsed.hostname)) {
      return NextResponse.json(
        { error: `Source URL host not allowed: ${parsed.hostname}` },
        { status: 422 }
      )
    }

    // 4. Download source → POST to Modal render → receive MP4.
    const modalUrl = process.env.NEXT_PUBLIC_MODAL_RENDER_URL
    const modalSecret = process.env.MODAL_SHARED_SECRET
    if (!modalUrl || !modalSecret) {
      return NextResponse.json(
        { error: 'Render endpoint not configured' },
        { status: 500 }
      )
    }

    const srcRes = await fetch(parsed.toString(), {
      redirect: 'error', // refuse redirects — closes the allowlist-bypass vector
      headers: { 'User-Agent': 'PLAYHUB/render' },
    })
    if (!srcRes.ok) {
      return NextResponse.json(
        { error: `Failed to fetch source (${srcRes.status})` },
        { status: 502 }
      )
    }
    const srcBuffer = await srcRes.arrayBuffer()

    const form = new FormData()
    form.append(
      'video',
      new Blob([srcBuffer], { type: 'video/mp4' }),
      'source.mp4'
    )
    form.append(
      'keyframes',
      JSON.stringify(
        keyframes.map((kf) => ({
          time_seconds: kf.time_seconds,
          x_pixels: kf.x_pixels,
        }))
      )
    )
    form.append('scene_changes', JSON.stringify(job.scene_changes ?? []))

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
      return NextResponse.json({ error: 'Render failed' }, { status: 502 })
    }
    const renderedBuffer = await modalRes.arrayBuffer()
    if (renderedBuffer.byteLength < 100 * 1024) {
      // Sanity — a successful render should be larger than a thumbnail.
      return NextResponse.json(
        { error: 'Render produced an unusably small output' },
        { status: 502 }
      )
    }

    // 5. Upload to Supabase Storage. Service-role because no INSERT policy
    //    exists for authenticated on the portrait-crops bucket (writes are
    //    intentionally server-mediated to keep signed-URL lifetimes short).
    const storagePath = `${user.id}/${job.id}.mp4`
    const service = createServiceClient()
    const { error: upErr } = await service.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, renderedBuffer, {
        contentType: 'video/mp4',
        upsert: true,
      })
    if (upErr) {
      console.error('[editor/render] upload error:', upErr.message)
      return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
    }

    // 6. Short-lived signed URL for the client to download.
    const { data: signed, error: signErr } = await service.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)
    if (signErr || !signed) {
      console.error('[editor/render] sign error:', signErr?.message)
      return NextResponse.json(
        { error: 'Could not create download URL' },
        { status: 500 }
      )
    }

    // 7. Update job row (rendered status + path). Caller's own session — RLS
    //    guarantees only the creator can flip their own job. If this fails
    //    the storage upload still succeeded; the client-side `storagePath`
    //    in the response is the authoritative pointer so the job row drift
    //    is recoverable on the next save/load round-trip.
    const { error: updErr } = await sb
      .from('playhub_crop_jobs')
      .update({ status: 'rendered', output_storage_path: storagePath })
      .eq('id', job.id)
      .eq('user_id', user.id)
    if (updErr) {
      console.warn('[editor/render] job status update failed:', updErr.message)
    }

    // 8. Feedback audit: exported action, no keyframes snapshot (that already
    //    exists on the last save). Failures here are log-only.
    const { error: fbErr } = await sb.from('playhub_crop_feedback').insert({
      job_id: job.id,
      user_id: user.id,
      action: 'exported',
      note: null,
    })
    if (fbErr) {
      console.warn('[editor/render] feedback insert failed:', fbErr.message)
    }

    return NextResponse.json({
      signedUrl: signed.signedUrl,
      storagePath,
      expiresAt: new Date(
        Date.now() + SIGNED_URL_TTL_SECONDS * 1000
      ).toISOString(),
    })
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
