// PATCH /api/academy/[clubSlug]/portrait-renders/[renderId]
//
// Review actions on a system-generated portrait render: reject a draft, or
// restore a rejected one back to draft. Published rows are immutable here
// (publishing is owned by /api/tiktok/publish; there is no unpublish).
// Same two-tier club gate as the listing route; the render's own club_slug
// must match the URL club (IDOR guard).

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { getClubBySlug } from '@/lib/academy/config'
import { isSameOrigin } from '@/lib/tiktok/route-helpers'

export const dynamic = 'force-dynamic'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Error rows are already terminal (the sweep owns their retry budget), so
// only drafts are rejectable — this keeps restore's target unambiguous (a
// restored row always has a storage object behind it).
const TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  reject: { from: ['draft'], to: 'rejected' },
  restore: { from: ['rejected'], to: 'draft' },
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ clubSlug: string; renderId: string }> }
) {
  // Defense-in-depth: PATCH is preflight-protected by CORS semantics, but the
  // same-origin guard keeps this resilient to a future CORS misconfig.
  if (!isSameOrigin(request)) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'forbidden' },
      { status: 403 }
    )
  }
  const { user } = await getAuthUser()
  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'unauthorized' },
      { status: 401 }
    )
  }

  const { clubSlug, renderId } = await params
  if (!UUID_RE.test(renderId)) {
    return NextResponse.json(
      { error: 'Bad render id', code: 'bad_request' },
      { status: 400 }
    )
  }

  let action: unknown
  try {
    action = ((await request.json()) as { action?: unknown })?.action
  } catch {
    return NextResponse.json(
      { error: 'Bad body', code: 'bad_request' },
      { status: 400 }
    )
  }
  const transition = TRANSITIONS[String(action)]
  if (!transition) {
    return NextResponse.json(
      { error: 'action must be reject or restore', code: 'bad_request' },
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

  // Atomic guarded update: the club filter is the IDOR guard, the status
  // filter makes the transition race-safe (count-CAS, no .select() — the
  // PostgREST or=/representation 400 lesson).
  const service = createServiceClient()
  const { count, error } = await service
    .from('playhub_portrait_renders')
    .update(
      { status: transition.to, updated_at: new Date().toISOString() },
      { count: 'exact' }
    )
    .eq('id', renderId)
    .eq('club_slug', clubSlug)
    .in('status', transition.from)
  if (error) {
    console.error('[portrait-renders] transition failed:', error.message)
    return NextResponse.json(
      { error: 'Update failed', code: 'update_failed' },
      { status: 500 }
    )
  }
  if (!count) {
    // The caller already passed the club gate, so distinguishing "stale
    // state" from "gone" leaks nothing to authorized admins and lets the UI
    // show the right affordance (refresh vs removed). Wrong-club/unknown-id
    // still collapses to a uniform 404.
    const { data: current } = await service
      .from('playhub_portrait_renders')
      .select('status')
      .eq('id', renderId)
      .eq('club_slug', clubSlug)
      .maybeSingle()
    if (current) {
      return NextResponse.json(
        {
          error: 'Render is not in a state that allows this action',
          code: 'invalid_state',
          details: { status: current.status },
        },
        { status: 409 }
      )
    }
    return NextResponse.json(
      { error: 'Not found', code: 'not_found' },
      { status: 404 }
    )
  }
  return NextResponse.json({ status: transition.to })
}
