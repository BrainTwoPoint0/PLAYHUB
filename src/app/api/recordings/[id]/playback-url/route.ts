// GET /api/recordings/[id]/playback-url
//
// Re-sign endpoint: returns a FRESH short-TTL signed URL for a recording's
// PRODUCED match video, so the player can swap in a new URL before/when the
// current one expires — the durable fix for the expired-URL "rewinding" (a dead
// signed URL 403s on every re-buffer/seek). Read-only: it never triggers a
// capture or mutates anything, so it's a GET (unlike the sibling
// panorama-source POST, which can actuate a Spiideo capture).
//
// Security invariants (shared with panorama-source via route-guards):
//  - Access-gate PARITY with page.tsx: published && (timing-safe share-token
//    match || checkRecordingAccess) — via hasRecordingAccess (one source of
//    truth so the invariant can't drift between routes).
//  - ONE recording-row fetch drives BOTH the access decision and the key lookup
//    (closes IDOR — never "check access on A, serve key of B").
//  - The URL is per-viewer (minors' footage) → force-dynamic + no-store so no
//    proxy caches one viewer's URL and hands it to another.
//  - The share token is read from the `x-share-token` HEADER, not the query
//    string, so this repeatedly-polled endpoint doesn't leak a (non-expiring)
//    token into access logs.

import { NextRequest } from 'next/server'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { getPlaybackUrl } from '@/lib/s3/client'
import {
  RECORDING_UUID_RE,
  sameOriginOk,
  noStore,
  hasRecordingAccess,
} from '@/lib/recordings/route-guards'

export const dynamic = 'force-dynamic'

// 4h — matches getPlaybackUrl's default and the sibling routes; the re-sign
// timer refreshes well before this, but the value still bounds a leaked URL.
const SIGNED_URL_TTL = 4 * 60 * 60

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!RECORDING_UUID_RE.test(id))
    return noStore({ error: 'bad id', code: 'bad_request' }, 400)
  if (!sameOriginOk(request))
    return noStore({ error: 'forbidden', code: 'forbidden' }, 403)

  const token = request.headers.get('x-share-token') || null

  const supabase = createServiceClient() as any
  // ONE fetch drives both access and the key lookup — no A-vs-B IDOR.
  const { data: rec } = await supabase
    .from('playhub_match_recordings')
    .select('id, status, share_token, s3_key')
    .eq('id', id)
    .maybeSingle()

  // Missing / unpublished / no-access all collapse to 404 (no existence oracle).
  const { user } = await getAuthUser()
  if (!(await hasRecordingAccess(rec, id, token, user)))
    return noStore({ error: 'not found', code: 'not_found' }, 404)

  if (!rec.s3_key) return noStore({ error: 'no video', code: 'no_video' }, 404)

  try {
    const url = await getPlaybackUrl(rec.s3_key, SIGNED_URL_TTL)
    return noStore({ url })
  } catch (err) {
    console.error(
      '[playback-url] sign failed:',
      err instanceof Error ? err.message : err
    )
    return noStore({ error: 'sign failed', code: 'sign_error' }, 500)
  }
}
