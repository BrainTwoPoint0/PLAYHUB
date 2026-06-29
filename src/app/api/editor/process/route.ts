import { NextRequest, NextResponse } from 'next/server'
import {
  createClient,
  createServiceClient,
  getAuthUser,
} from '@/lib/supabase/server'
import { cropClient } from '@/lib/editor/db-types'
import {
  requirePortraitCropEnabled,
  ValidationError,
} from '@/lib/editor/validation'

export const dynamic = 'force-dynamic'
export const maxDuration = 180 // 3 min timeout for GPU processing

const MODAL_URL = process.env.NEXT_PUBLIC_MODAL_CROP_URL || ''
const MODAL_SHARED_SECRET = process.env.MODAL_SHARED_SECRET || ''

export async function POST(request: NextRequest) {
  try {
    const { user } = await getAuthUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Kill switch — same gate as the read path, so disabling the flag stops the
    // expensive GPU run and the cache write too, not just reads.
    await requirePortraitCropEnabled(await createClient())

    if (!MODAL_URL) {
      return NextResponse.json(
        { error: 'Processing endpoint not configured' },
        { status: 500 }
      )
    }

    const body = request.body
    if (!body) {
      return NextResponse.json({ error: 'Empty body' }, { status: 400 })
    }

    const contentLength = request.headers.get('content-length')

    if (!MODAL_SHARED_SECRET) {
      return NextResponse.json(
        { error: 'Processing endpoint not configured' },
        { status: 500 }
      )
    }

    const res = await fetch(MODAL_URL, {
      method: 'POST',
      body: body,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Modal-Auth': MODAL_SHARED_SECRET,
        ...(contentLength && { 'Content-Length': contentLength }),
      },
      // @ts-expect-error -- Node fetch supports duplex for streaming request bodies
      duplex: 'half',
    })

    if (!res.ok) {
      const text = await res.text()
      console.error('Modal error:', res.status, text.slice(0, 200))
      return NextResponse.json(
        { error: 'GPU processing failed' },
        { status: 502 }
      )
    }

    const detection = await res.json()

    // Seed the shared content cache so the next viewer of this highlight (anyone)
    // skips the ~27s Modal run. Service-role write (no client RLS path → the table
    // can't be poisoned by direct client writes) + best-effort (a cache-write
    // failure must never fail the detection the user awaits) + a shape/size guard
    // so a misbehaving detector can't bloat the shared table.
    const highlightId = request.nextUrl.searchParams.get('highlightId')?.trim()
    const blobOk =
      Array.isArray(detection?.positions) &&
      Array.isArray(detection?.scene_changes) &&
      JSON.stringify(detection).length <= 2_000_000 // ~2MB ceiling guards a detector bug
    if (highlightId && highlightId.length <= 200 && blobOk) {
      try {
        const { error: cacheErr } = await cropClient(createServiceClient())
          .from('playhub_crop_detections')
          .upsert(
            {
              veo_highlight_id: highlightId,
              detection,
              modal_inference_ms: detection?.modal_inference_ms ?? null,
              modal_app_version: detection?.modal_app_version ?? null,
            },
            { onConflict: 'veo_highlight_id' }
          )
        if (cacheErr)
          console.error(
            'detect cache write failed (non-fatal):',
            cacheErr.message
          )
      } catch (cacheErr) {
        console.error('detect cache write threw (non-fatal):', cacheErr)
      }
    }

    return NextResponse.json(detection)
  } catch (err: unknown) {
    // Kill-switch / validation failures carry their own status (e.g. 503 when off).
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    const message = err instanceof Error ? err.message : 'Processing failed'
    console.error('Portrait crop processing error:', message)
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  }
}
