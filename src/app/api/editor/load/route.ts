/**
 * GET /api/editor/load?recordingId=<uuid> | ?jobId=<uuid>
 *
 * Resolves the active portrait-crop job for the caller and returns its
 * keyframes + scene changes so the editor can rehydrate state on mount.
 *
 * Lookup rules:
 *   jobId      → fetch that specific job (RLS decides visibility)
 *   recordingId→ latest non-terminal job the caller owns for that recording
 *   neither    → 400
 *
 * Returns: { job, keyframes } or 404 if no matching job exists.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'
import {
  requirePortraitCropEnabled,
  ValidationError,
} from '@/lib/editor/validation'
import type { CropClient } from '@/lib/editor/db-types'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: NextRequest) {
  try {
    const { user, supabase } = await getAuthUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    await requirePortraitCropEnabled(supabase)

    const jobIdParam = request.nextUrl.searchParams.get('jobId')
    const recordingIdParam =
      request.nextUrl.searchParams.get('recordingId')

    if (!jobIdParam && !recordingIdParam) {
      return NextResponse.json(
        { error: 'Provide jobId or recordingId' },
        { status: 400 }
      )
    }
    if (jobIdParam && !UUID_RE.test(jobIdParam)) {
      return NextResponse.json({ error: 'Invalid jobId' }, { status: 400 })
    }
    if (recordingIdParam && !UUID_RE.test(recordingIdParam)) {
      return NextResponse.json(
        { error: 'Invalid recordingId' },
        { status: 400 }
      )
    }

    // Resolve job row. When recordingId is supplied, pick the latest active
    // job the caller owns — lets them resume the in-flight edit without
    // needing to remember the jobId.
    //
    // Even when fetching by jobId we layer an explicit user_id filter on top
    // of RLS for defense-in-depth. An org-member could otherwise resolve a
    // teammate's job via RLS's read-collab path and mistakenly load their
    // state — the UI promises "resume YOUR edit", not "anyone's edit".
    // Cast to the narrower crop-schema client; see db-types.ts comment.
    const sb = supabase as unknown as CropClient
    let jobQuery = sb
      .from('playhub_crop_jobs')
      .select(
        'id, recording_id, video_url, user_id, status, codec_fingerprint, modal_inference_ms, modal_app_version, scene_changes, output_storage_path, error_code, error_message, created_at, updated_at'
      )
      .eq('user_id', user.id)
      .limit(1)

    if (jobIdParam) {
      jobQuery = jobQuery.eq('id', jobIdParam)
    } else if (recordingIdParam) {
      jobQuery = jobQuery
        .eq('recording_id', recordingIdParam)
        .in('status', ['pending', 'detected', 'edited'])
        .order('created_at', { ascending: false })
    }

    const { data: job, error: jobErr } = await jobQuery.maybeSingle()
    if (jobErr) {
      console.error('[editor/load] jobs query error:', jobErr.message)
      return NextResponse.json({ error: 'Load failed' }, { status: 500 })
    }
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const { data: keyframes, error: kfErr } = await sb
      .from('playhub_crop_keyframes')
      .select(
        'time_seconds, x_pixels, source, confidence, edited_by_user, edited_at'
      )
      .eq('job_id', job.id)
      .order('time_seconds', { ascending: true })

    if (kfErr) {
      console.error('[editor/load] keyframes query error:', kfErr.message)
      return NextResponse.json({ error: 'Load failed' }, { status: 500 })
    }

    return NextResponse.json({ job, keyframes: keyframes ?? [] })
  } catch (err: unknown) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('Load route error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Load failed' }, { status: 500 })
  }
}
