// GET /api/academy/[clubSlug]/portrait-renders?matchSlug=…
//
// Lists the system-generated 9:16 portrait renders for one match (the academy
// content page's review strip), with short-lived signed preview URLs.
// playhub_portrait_renders is RLS deny-all for clients — this club-gated
// route is the only read path, mirroring the content route's two-tier auth
// (platform admin OR org admin of THIS club) + IDOR guard.

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { getClubBySlug } from '@/lib/academy/config'

export const dynamic = 'force-dynamic'

const STORAGE_BUCKET = 'portrait-crops'
const SIGNED_URL_TTL_SECONDS = 3600
const SLUG_RE = /^[a-z0-9-]{1,200}$/i

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ clubSlug: string }> }
) {
  const { user } = await getAuthUser()
  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'unauthorized' },
      { status: 401 }
    )
  }

  const { clubSlug } = await params
  const matchSlug = request.nextUrl.searchParams.get('matchSlug')?.trim()
  if (!matchSlug || !SLUG_RE.test(matchSlug)) {
    return NextResponse.json(
      { error: 'matchSlug missing or invalid', code: 'bad_request' },
      { status: 400 }
    )
  }

  const club = await getClubBySlug(clubSlug)
  if (!club) {
    return NextResponse.json(
      { error: 'Club not found', code: 'not_found' },
      { status: 404 }
    )
  }
  const allowed =
    (await isPlatformAdmin(user.id)) ||
    (club.organizationId && (await isVenueAdmin(user.id, club.organizationId)))
  if (!allowed) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'forbidden' },
      { status: 403 }
    )
  }

  // The club_slug equality on the query IS the IDOR guard: rows are written
  // with the owning club, so a Club-A admin asking for Club B's match gets [].
  const service = createServiceClient()
  const { data: rows, error } = await service
    .from('playhub_portrait_renders')
    .select(
      'id, recording_event_id, provider_event_id, status, quality, error, storage_path, approved_at, created_at, updated_at'
    )
    .eq('club_slug', clubSlug)
    .eq('provider_recording_id', matchSlug)
    .order('created_at', { ascending: true })
  if (error) {
    console.error('[portrait-renders] query failed:', error.message)
    return NextResponse.json(
      { error: 'Query failed', code: 'query_failed' },
      { status: 500 }
    )
  }

  const renders = rows ?? []

  // "Corrected" marker. A fix-in-editor writes an `edited` feedback row but leaves
  // the render at `draft` — deliberately, since correcting is not a verdict (approve
  // means UNEDITED, reject means unusable). Without surfacing it, a clip you spent
  // five minutes fixing is indistinguishable from one you have never opened, so on a
  // 2k backlog you lose your place and re-fix the same clips. Only `edited` counts:
  // accepted/rejected are already visible as status.
  const correctedAt = new Map<string, string>()
  let correctionsUnavailable = false
  const ids = renders.map((r) => r.id)
  // Chunked: `.in()` becomes a query-string filter, so enumerating every id in one
  // request grows the URL ~40 bytes per render. A match has a handful of goals today,
  // but the renders query has no explicit limit — at PostgREST's 1000-row ceiling this
  // would be a ~40KB URL, a gateway 414, and (because the failure is swallowed) markers
  // that vanish silently on exactly the biggest matches.
  //
  // The chunk size is also what keeps this UNDER PostgREST's 1000-row response cap:
  // the feedback route allows up to MAX_ROWS_PER_RENDER (50) corrections per render,
  // so 20 renders is a hard ceiling of 1000 rows per request. Ordering is DESCENDING
  // and the first write per render wins — load-bearing, not style. Ascending +
  // overwrite would rely on the NEWEST rows surviving, and truncation drops exactly
  // those, silently serving a stale timestamp on the most-edited clips.
  const ID_CHUNK = 20
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data: corrections, error: corrErr } = await service
      .from('playhub_portrait_render_feedback')
      .select('render_id, created_at')
      .eq('club_slug', clubSlug)
      .eq('action', 'edited')
      .in('render_id', ids.slice(i, i + ID_CHUNK))
      .order('created_at', { ascending: false })
    if (corrErr) {
      // Non-fatal: the marker is an aid, not the data. Losing it must not blank the
      // review surface (which is what a 500 here would do). But it must not lie
      // either — an un-flagged failure renders every clip as never-corrected, which
      // reads as "the feature doesn't work" rather than "this query is erroring".
      console.error(
        '[portrait-renders] corrections query failed:',
        corrErr.message
      )
      correctionsUnavailable = true
      break
    }
    // Descending order + first-write-wins leaves the LATEST correction per render.
    for (const c of corrections ?? []) {
      if (c.render_id && !correctedAt.has(c.render_id)) {
        correctedAt.set(c.render_id, c.created_at as string)
      }
    }
  }

  const paths = renders
    // 'approved' must be here or a clip loses its preview the moment it is marked
    // good enough — the exact rows the library is built from.
    .filter(
      (r) =>
        r.status === 'draft' ||
        r.status === 'approved' ||
        r.status === 'published'
    )
    .map((r) => r.storage_path)
  const urlByPath = new Map<string, string>()
  if (paths.length > 0) {
    const { data: signed, error: signErr } = await service.storage
      .from(STORAGE_BUCKET)
      .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)
    if (signErr) {
      console.error('[portrait-renders] sign failed:', signErr.message)
    } else {
      for (const s of signed ?? []) {
        if (s.signedUrl && s.path) urlByPath.set(s.path, s.signedUrl)
      }
    }
  }

  // no-store: the payload carries signed URLs of minors' footage — no proxy
  // or browser cache may hold one viewer's URLs (the panorama-source
  // invariant applied to this data class).
  return NextResponse.json(
    {
      renders: renders.map((r) => ({
        id: r.id,
        recordingEventId: r.recording_event_id,
        providerEventId: r.provider_event_id,
        status: r.status,
        quality: r.quality,
        error: r.error,
        previewUrl: urlByPath.get(r.storage_path) ?? null,
        approvedAt: r.approved_at,
        correctedAt: correctedAt.get(r.id) ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      // Explicit degradation: without this, a failed corrections query is
      // indistinguishable from "nothing has been corrected", so the UI would
      // confidently show every clip as untouched — the exact mistake the marker
      // exists to prevent.
      ...(correctionsUnavailable ? { partial: ['corrections'] } : {}),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
