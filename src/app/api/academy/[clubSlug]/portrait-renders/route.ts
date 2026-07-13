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
      'id, recording_event_id, provider_event_id, status, quality, error, storage_path, published_at, created_at, updated_at'
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
  const paths = renders
    .filter((r) => r.status === 'draft' || r.status === 'published')
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
        publishedAt: r.published_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
