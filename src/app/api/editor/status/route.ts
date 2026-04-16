/**
 * GET /api/editor/status
 *
 * Lightweight probe for the editor UI — returns the kill-switch state so the
 * client can hide CTAs / show a banner when the feature is disabled. Cached
 * briefly to avoid every editor mount hitting the database for the same row.
 *
 * Returns: { portraitCropEnabled: boolean }
 */

import { NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'
import type { CropClient } from '@/lib/editor/db-types'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const { user, supabase } = await getAuthUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const sb = supabase as unknown as CropClient
    const { data, error } = await sb
      .from('playhub_feature_flags')
      .select('enabled')
      .eq('key', 'portrait_crop_enabled')
      .maybeSingle()

    if (error) {
      console.error('[editor/status] feature flag error:', error.message)
      // Fail closed — conservative default while the flags table is flaky.
      return NextResponse.json(
        { portraitCropEnabled: false },
        {
          status: 200,
          headers: { 'Cache-Control': 'no-store' },
        }
      )
    }

    return NextResponse.json(
      { portraitCropEnabled: Boolean(data?.enabled) },
      {
        status: 200,
        // Kill switches must propagate immediately. Any cache here means an
        // in-flight editor session can keep saving for the cache window after
        // someone flips the flag — which defeats the point.
        headers: { 'Cache-Control': 'no-store' },
      }
    )
  } catch (err: unknown) {
    console.error('Status route error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Status check failed' }, { status: 500 })
  }
}
