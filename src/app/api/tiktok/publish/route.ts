import { NextResponse } from 'next/server'
import { getAuthUserStrict, createServiceClient } from '@/lib/supabase/server'
import { uploadVideoToInbox } from '@/lib/tiktok/publish'
import { isSameOrigin, tiktokErrorResponse } from '@/lib/tiktok/route-helpers'

export const dynamic = 'force-dynamic'
// Download + chunk upload can take a while on a cold Modal/Storage path.
export const maxDuration = 300

const PORTRAIT_BUCKET = 'portrait-crops'
/**
 * POST /api/tiktok/publish
 * Body: { storagePath } — a path inside `portrait-crops` produced by the user's
 * OWN editor render; only the owner (`${user.id}/…` prefix) may publish it.
 * Downloads the MP4 (service role) and uploads it to the connected TikTok
 * account's inbox as a draft (video.upload).
 *
 * Academy/system renders are NOT publishable here: club review ends at "good
 * enough", which distributes nothing (2026-07-22).
 */
export async function POST(request: Request) {
  // CSRF defence: reject cross-origin submissions (this route parses JSON
  // regardless of Content-Type, so a cross-site text/plain form could reach it).
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { user } = await getAuthUserStrict()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { storagePath?: unknown; renderId?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const service = createServiceClient()

  // NOTE: the `renderId` branch (publishing a system-generated academy render
  // straight to TikTok) was REMOVED on 2026-07-22. Club review now ends at
  // "good enough" — a quality judgement that distributes nothing. Deleting the
  // branch rather than hiding its button is the point: an endpoint that still
  // accepts a renderId is still a live path from a club's system render of
  // minors' footage to an external platform. Zero rows had ever been published,
  // so nothing was lost. Anything worth posting is downloaded and posted by hand.
  //
  // What remains is the individual-creator flow: a user publishing their OWN
  // editor render, stored under `${user.id}/…`.
  const raw = body.storagePath
  if (typeof raw !== 'string' || raw.length === 0) {
    return NextResponse.json({ error: 'storagePath required' }, { status: 400 })
  }
  // Authorization: editor renders are stored under `${user.id}/…`. A caller may
  // only publish their own render — reject traversal and cross-user paths.
  // system/ paths are now unreachable here by construction.
  if (raw.includes('..') || !raw.startsWith(`${user.id}/`)) {
    return NextResponse.json({ error: 'Forbidden path' }, { status: 403 })
  }
  const storagePath: string = raw

  const { data: blob, error: dlErr } = await service.storage
    .from(PORTRAIT_BUCKET)
    .download(storagePath)
  if (dlErr || !blob) {
    return NextResponse.json({ error: 'Render not found' }, { status: 404 })
  }

  try {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const result = await uploadVideoToInbox(user.id, bytes)
    // SEND_TO_USER_INBOX = the creator finishes the post in the TikTok app.
    return NextResponse.json({
      publishId: result.publishId,
      status: result.status,
    })
  } catch (err) {
    // TikTokAuthError → 409 (reconnect); TikTokUploadError → 413/422; else 502.
    return tiktokErrorResponse(err)
  }
}
