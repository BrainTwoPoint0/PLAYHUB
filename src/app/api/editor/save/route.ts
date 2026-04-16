/**
 * POST /api/editor/save
 *
 * Atomic save of a portrait-crop job: upserts the job row, replaces keyframes,
 * and optionally appends a feedback audit entry — all inside a single plpgsql
 * function so a partial failure never leaves the job with zero keyframes.
 *
 * Auth is strict (round-trip to Supabase Auth) because save mutates state;
 * revoked sessions MUST stop writing immediately, not at JWT expiry.
 *
 * Returns: { jobId, status, updatedAt }
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  createClient,
  getAuthUserStrict,
} from '@/lib/supabase/server'
import {
  validateSavePayload,
  requirePortraitCropEnabled,
  ValidationError,
} from '@/lib/editor/validation'
import type { CropClient } from '@/lib/editor/db-types'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const { user } = await getAuthUserStrict()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // getAuthUserStrict returns a Supabase auth client but not the typed DB
    // client — rebuild a fresh SSR client for the DB queries. This keeps the
    // JWT freshness check on auth without compromising the DB connection.
    const supabase = await createClient()
    // Cast to the narrower crop-schema client. Generated Database types don't
    // include the Phase 3 tables until regen is run; see db-types.ts.
    const sb = supabase as unknown as CropClient

    await requirePortraitCropEnabled(supabase)

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = validateSavePayload(body)

    // ── Atomic save via RPC ──
    // save_crop_job wraps job upsert + keyframe delete/insert + feedback
    // append in a single transaction. RLS applies per-caller, so a user
    // cannot touch another user's job even via this RPC.
    const { data, error } = await sb.rpc('save_crop_job' as never, {
      p_job_id: null,
      p_recording_id: payload.recording_id,
      p_video_url: payload.video_url,
      p_status: payload.status,
      p_scene_changes: payload.scene_changes,
      p_codec_fingerprint: payload.codec_fingerprint,
      p_modal_inference_ms: payload.modal_inference_ms,
      p_modal_app_version: payload.modal_app_version,
      p_keyframes: payload.keyframes,
      p_feedback: payload.feedback,
    } as never)

    if (error) {
      // 42501 = not-owned / RLS denial. 28000 = unauthenticated.
      if (error.code === '42501') {
        return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
      }
      console.error('[editor/save] RPC error:', error.code, error.message)
      return NextResponse.json({ error: 'Save failed' }, { status: 500 })
    }

    const result = data as
      | { jobId: string; status: string; updatedAt: string }
      | null
    if (!result) {
      return NextResponse.json({ error: 'Save returned no result' }, {
        status: 500,
      })
    }
    return NextResponse.json(result)
  } catch (err: unknown) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('Save route error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Save failed' }, { status: 500 })
  }
}
