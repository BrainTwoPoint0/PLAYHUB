// Content-keyed detection cache read. The editor calls this on open BEFORE
// fetching/uploading the video — a hit returns the cached ball detection instantly
// (no Modal round-trip); a miss (404) tells the editor to run live detection.
// Detection is video-deterministic, so the cache is shared across all users.
import { NextRequest, NextResponse } from 'next/server'
import { createClient, getAuthUser } from '@/lib/supabase/server'
import { cropClient } from '@/lib/editor/db-types'
import {
  requirePortraitCropEnabled,
  ValidationError,
} from '@/lib/editor/validation'

export const dynamic = 'force-dynamic'

// The detector version whose cached detections are still valid. A bump here (e.g.
// 10fps -> 25fps for fast-play accuracy) supersedes older cached rows: they re-detect
// on next open and re-cache. Keep in sync with modal_app.py's MODAL_APP_VERSION.
const CURRENT_DETECTION_VERSION = '2026.06.29.2'

export async function GET(request: NextRequest) {
  try {
    const { user } = await getAuthUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const highlightId = request.nextUrl.searchParams.get('highlightId')?.trim()
    if (!highlightId || highlightId.length > 200) {
      return NextResponse.json(
        { error: 'valid highlightId required' },
        { status: 400 }
      )
    }

    const supabase = await createClient()
    await requirePortraitCropEnabled(supabase)
    const sb = cropClient(supabase)

    const { data, error } = await sb
      .from('playhub_crop_detections')
      .select('detection, modal_inference_ms, modal_app_version')
      .eq('veo_highlight_id', highlightId)
      .maybeSingle()

    if (error) {
      console.error('detect-cache read error:', error.message)
      return NextResponse.json({ error: 'cache read failed' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ cached: false }, { status: 404 })
    }

    // Stale detector version → treat as a miss so the editor re-detects with the
    // current model (e.g. the 25fps accuracy pass) and re-caches.
    if (data.modal_app_version !== CURRENT_DETECTION_VERSION) {
      return NextResponse.json({ cached: false, stale: true }, { status: 404 })
    }

    // Return the stored detection as-is (same shape as the Modal response) so the
    // editor consumes a cache hit identically to a fresh detection.
    return NextResponse.json({
      ...(data.detection as Record<string, unknown>),
      cached: true,
    })
  } catch (err: unknown) {
    // requirePortraitCropEnabled throws ValidationError (status 503 when the kill
    // switch is off) — surface its real status, matching the load/save routes.
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    const message = err instanceof Error ? err.message : 'cache read failed'
    console.error('detect-cache error:', message)
    return NextResponse.json({ error: 'cache read failed' }, { status: 500 })
  }
}
