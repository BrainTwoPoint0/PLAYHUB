import { NextResponse } from 'next/server'
import { getAuthUserStrict, createServiceClient } from '@/lib/supabase/server'
import { uploadVideoToInbox } from '@/lib/tiktok/publish'
import { isSameOrigin, tiktokErrorResponse } from '@/lib/tiktok/route-helpers'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { getClubBySlug } from '@/lib/academy/config'

export const dynamic = 'force-dynamic'
// Download + chunk upload can take a while on a cold Modal/Storage path.
export const maxDuration = 300

const PORTRAIT_BUCKET = 'portrait-crops'
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/tiktok/publish
 * Body: { storagePath } OR { renderId }.
 * - storagePath: a path inside `portrait-crops` produced by the editor render;
 *   only the owner (`${user.id}/…` prefix) may publish it.
 * - renderId: a system-generated playhub_portrait_renders row (the academy
 *   review flow); the caller must be a platform admin or an org admin of the
 *   render's club. On success the row is marked published.
 * Downloads the MP4 (service role) and uploads it to the connected TikTok
 * account's inbox as a draft (video.upload).
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

  if (body.renderId != null && body.storagePath != null) {
    return NextResponse.json(
      { error: 'Provide storagePath OR renderId, not both' },
      { status: 400 }
    )
  }

  let storagePath: string
  let systemRenderId: string | null = null
  if (body.renderId != null) {
    if (typeof body.renderId !== 'string' || !UUID_RE.test(body.renderId)) {
      return NextResponse.json({ error: 'Bad render id' }, { status: 400 })
    }
    const { data: render } = await service
      .from('playhub_portrait_renders')
      .select('id, club_slug, storage_path, status')
      .eq('id', body.renderId)
      .maybeSingle()
    if (!render) {
      return NextResponse.json({ error: 'Render not found' }, { status: 404 })
    }
    // Club-admin authorization (the same two-tier gate as the academy routes).
    const club = await getClubBySlug(render.club_slug)
    const allowed =
      (await isPlatformAdmin(user.id)) ||
      (club?.organizationId &&
        (await isVenueAdmin(user.id, club.organizationId)))
    if (!allowed) {
      // 404, not 403 — don't confirm the render exists to non-members.
      return NextResponse.json({ error: 'Render not found' }, { status: 404 })
    }
    if (render.status !== 'draft' && render.status !== 'published') {
      return NextResponse.json(
        { error: 'Render is not publishable' },
        { status: 409 }
      )
    }
    storagePath = render.storage_path
    systemRenderId = render.id
  } else {
    const raw = body.storagePath
    if (typeof raw !== 'string' || raw.length === 0) {
      return NextResponse.json(
        { error: 'storagePath or renderId required' },
        { status: 400 }
      )
    }
    // Authorization: editor renders are stored under `${user.id}/…`. A caller
    // may only publish their own render — reject traversal and cross-user
    // paths (system/ paths are only reachable via the renderId branch above).
    if (raw.includes('..') || !raw.startsWith(`${user.id}/`)) {
      return NextResponse.json({ error: 'Forbidden path' }, { status: 403 })
    }
    storagePath = raw
  }
  const { data: blob, error: dlErr } = await service.storage
    .from(PORTRAIT_BUCKET)
    .download(storagePath)
  if (dlErr || !blob) {
    return NextResponse.json({ error: 'Render not found' }, { status: 404 })
  }

  try {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const result = await uploadVideoToInbox(user.id, bytes)
    if (systemRenderId) {
      // Audit line BEFORE the best-effort status flip: outbound content must
      // always have a who-sent-what record even if the DB update fails.
      console.log(
        `[tiktok/publish] render ${systemRenderId} published by ${user.id} (publishId ${result.publishId})`
      )
      // Best-effort status flip — a failure here must not fail the publish
      // the user already awaits (re-publishing a 'published' row is allowed).
      // Status guard: an admin reject landing during the (up to 300s) upload
      // must not be silently overwritten — the flip only applies to rows
      // still draft/published.
      const { count, error: pubErr } = await service
        .from('playhub_portrait_renders')
        .update(
          {
            status: 'published',
            published_at: new Date().toISOString(),
            published_by: user.id,
            updated_at: new Date().toISOString(),
          },
          { count: 'exact' }
        )
        .eq('id', systemRenderId)
        .in('status', ['draft', 'published'])
      if (pubErr)
        console.error(
          '[tiktok/publish] render status update failed (non-fatal):',
          pubErr.message
        )
      else if (!count)
        console.log(
          `[tiktok/publish] render ${systemRenderId} status changed mid-publish; flip skipped`
        )
    }
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
