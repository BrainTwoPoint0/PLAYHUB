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
 * Body: { storagePath }  — a path inside the `portrait-crops` bucket produced by
 * the editor render. Downloads the MP4 (service role) and uploads it to the
 * connected TikTok account's inbox as a draft (video.upload).
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

  let body: { storagePath?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const storagePath = body.storagePath
  if (typeof storagePath !== 'string' || storagePath.length === 0) {
    return NextResponse.json({ error: 'storagePath required' }, { status: 400 })
  }
  // Authorization: renders are stored under `${user.id}/…`. A caller may only
  // publish their own render — reject traversal and cross-user paths.
  if (
    storagePath.includes('..') ||
    !storagePath.startsWith(`${user.id}/`)
  ) {
    return NextResponse.json({ error: 'Forbidden path' }, { status: 403 })
  }

  const service = createServiceClient()
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
