// PATCH /api/academy/[clubSlug]/portrait-renders/[renderId]
//
// Review actions on a system-generated portrait render: mark a draft "good enough"
// (approve), undo that, reject, or restore a rejected one. Approving judges QUALITY
// only — it does not distribute anything. Same two-tier club gate as the listing
// route; the render's own club_slug must match the URL club (IDOR guard).
//
// approve/reject also write a training label (see LABEL_FOR).

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { getClubBySlug } from '@/lib/academy/config'
import { isSameOrigin } from '@/lib/tiktok/route-helpers'
import { insertPortraitFeedback } from '@/lib/academy/portrait-feedback'
import {
  resolveTransition,
  labelForAction,
} from '@/lib/academy/portrait-transitions'
import type { CropKeyframe } from '@/lib/editor/types'

export const dynamic = 'force-dynamic'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  const transition = resolveTransition(action)
  if (!transition) {
    return NextResponse.json(
      {
        error: 'action must be approve, unapprove, reject or restore',
        code: 'bad_request',
      },
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

  // "Good enough" means the auto-detection needed no fixing — that is the whole
  // basis of the label ("as soon as I edit anything, the detection is NOT good
  // enough"). But the editor never writes its result back to the render row, so
  // approving a clip that was corrected would stamp `accepted` onto the ORIGINAL,
  // uncorrected geometry: a positive training label on framing a human rejected.
  // Refuse it. The clip is still rejectable, and re-correctable.
  const service = createServiceClient()
  if (transition.to === 'approved') {
    const { data: corrected, error: corrErr } = await service
      .from('playhub_portrait_render_feedback')
      .select('created_at')
      .eq('render_id', renderId)
      .eq('club_slug', clubSlug)
      .eq('action', 'edited')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (corrErr) {
      // Fail CLOSED here, unlike the listing's advisory marker: a missed check
      // writes a permanently wrong label into an append-only corpus.
      console.error('[portrait-renders] correction check failed:', corrErr.message)
      return NextResponse.json(
        { error: 'Update failed', code: 'update_failed' },
        { status: 500 }
      )
    }
    if (corrected) {
      return NextResponse.json(
        {
          error:
            'This draft was corrected in the editor, so it cannot be marked good enough',
          code: 'corrected',
          details: { correctedAt: corrected.created_at },
        },
        { status: 409 }
      )
    }
  }

  // Atomic guarded update: the club filter is the IDOR guard, the status
  // filter makes the transition race-safe (count-CAS, no .select() — the
  // PostgREST or=/representation 400 lesson).
  const now = new Date().toISOString()
  const { count, error } = await service
    .from('playhub_portrait_renders')
    .update(
      {
        // Per-transition fields FIRST so the fixed keys below can never be
        // overwritten by a future `extra` that happens to name one of them.
        ...(transition.extra?.(user.id, now) ?? {}),
        status: transition.to,
        updated_at: now,
      },
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
      .select('status, approved_at')
      .eq('id', renderId)
      .eq('club_slug', clubSlug)
      .maybeSingle()
    if (current?.status === transition.to) {
      // Already in the requested state — a double-click, not a conflict. 409 here
      // would show a red "not in a state that allows this action" for an action
      // that actually succeeded. No label is written (that is gated on the CAS),
      // so this stays a true no-op.
      return NextResponse.json({
        status: current.status,
        approvedAt: current.approved_at ?? null,
      })
    }
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
  // The verdict IS a label: approve = the auto-detection passed (a "good enough" draft
  // is unedited by definition), reject = it failed. Best-effort — a lost training row
  // must never fail an admin's decision, so this is logged and swallowed.
  const label = labelForAction(action)
  if (label) {
    try {
      const { data: row } = await service
        .from('playhub_portrait_renders')
        .select('provider_event_id, keyframes')
        .eq('id', renderId)
        .eq('club_slug', clubSlug)
        .maybeSingle()
      // One verdict per (render, reviewer, verdict). The transition itself is
      // toggleable (approve → unapprove → approve), and this table is append-only
      // with no DELETE path, so without this guard a few clicks skew the label
      // distribution for a single clip arbitrarily. The sibling feedback route
      // caps rows for the same reason; this path had no cap at all. Deliberately
      // fails OPEN (a broken count writes the label): a duplicate is removable at
      // read time, a dropped first verdict is gone for good.
      const { count: existing } = await service
        .from('playhub_portrait_render_feedback')
        .select('id', { count: 'exact', head: true })
        .eq('render_id', renderId)
        .eq('user_id', user.id)
        .eq('action', label)
      if (row && !existing) {
        const baseline = (row.keyframes ?? null) as CropKeyframe[] | null
        await insertPortraitFeedback(service, {
          renderId,
          providerEventId: row.provider_event_id as string,
          clubSlug,
          userId: user.id,
          action: label,
          keyframesBefore: baseline,
          keyframesAfter: null,
          baselineOrigin: baseline ? 'render_row' : 'none',
        })
      }
    } catch (err) {
      console.error('[portrait-renders] label write failed:', err)
    }
  }

  // Return the row the caller just mutated, so the client can patch local state
  // instead of refetching the list (which re-signs every preview URL in the match).
  return NextResponse.json({
    status: transition.to,
    approvedAt: transition.to === 'approved' ? now : null,
  })
}
