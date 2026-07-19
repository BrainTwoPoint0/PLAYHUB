// Shared guards for the recording signed-URL routes (playback-url, panorama-source).
// The access predicate is the LOAD-BEARING security invariant — it must stay
// bit-identical across every route that mints a signed URL, so it lives here as
// one source of truth (drift between copies is the "check access on A, serve B"
// bug class). Each route still runs its own SELECT (different columns) and passes
// the fetched row + token + user in.

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { checkRecordingAccess } from '@/lib/recordings/access-control'

export const RECORDING_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function sameOriginOk(request: NextRequest): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true // same-origin navigations may omit Origin
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

export function noStore(json: unknown, status = 200): NextResponse {
  const res = NextResponse.json(json, { status })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

/**
 * The recording access invariant, shared so it cannot drift between routes:
 * `published && (timing-safe share-token match || checkRecordingAccess grant)`.
 * Returns false for a missing/unpublished row too, so callers collapse
 * not-found and no-access into one 404 (no existence oracle). `user` is passed
 * in (the caller fetches it once and may reuse it, e.g. for a capability split).
 */
export async function hasRecordingAccess(
  rec: { status?: string | null; share_token?: string | null } | null,
  recordingId: string,
  token: string | null,
  user: { id: string } | null
): Promise<boolean> {
  if (!rec || rec.status !== 'published') return false
  if (
    token &&
    rec.share_token &&
    timingSafeStrEqual(String(token), String(rec.share_token))
  )
    return true
  if (!user) return false
  return (await checkRecordingAccess(recordingId, user.id)).hasAccess
}
