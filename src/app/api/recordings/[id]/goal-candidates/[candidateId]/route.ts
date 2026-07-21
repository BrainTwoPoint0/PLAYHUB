// PATCH /api/recordings/[id]/goal-candidates/[candidateId]
//
// Review actions on a goal-detect candidate (platform admin only, pilot):
//   approve: draft -> approved, then insert the goal event into
//            playhub_recording_events (source='ai_detected',
//            provider='spiideo', provider_event_id = candidate id) and stamp
//            approved_event_id.
//   reject:  draft -> rejected
//   restore: rejected -> draft
//
// Approve ordering is claim-first, event-second, stamp-third so a mid-flight
// failure can never leave a public orphan marker: the CAS flip wins before
// any event exists; `approved AND approved_event_id IS NULL` is a REPAIR
// state — a second approve call skips the flip and re-runs event+stamp. The
// event insert is idempotent via the exact (provider='spiideo',
// provider_event_id=candidate.id) lookup, backed by the table's unique
// (provider, provider_recording_id, provider_event_id) constraint.
// There is no unapprove in the pilot (it would require event deletion).

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { isSameOrigin } from '@/lib/tiktok/route-helpers'

export const dynamic = 'force-dynamic'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Veo-measured median goal->kickoff latency: the approved event timestamp is
// the detected kickoff anchor minus this (the goal moment estimate the
// /watch marker seeks to).
const EVENT_OFFSET_S = 20

const TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  approve: { from: ['draft'], to: 'approved' },
  reject: { from: ['draft'], to: 'rejected' },
  restore: { from: ['rejected'], to: 'draft' },
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
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
  const { id, candidateId } = await params
  if (!UUID_RE.test(id) || !UUID_RE.test(candidateId)) {
    return NextResponse.json(
      { error: 'Bad id', code: 'bad_request' },
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
  const actionKey = String(action)
  const transition = Object.hasOwn(TRANSITIONS, actionKey)
    ? TRANSITIONS[actionKey]
    : undefined
  if (!transition) {
    return NextResponse.json(
      { error: 'action must be approve, reject, or restore', code: 'bad_request' },
      { status: 400 }
    )
  }
  if (!(await isPlatformAdmin(user.id))) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'forbidden' },
      { status: 403 }
    )
  }

  const service = createServiceClient()

  if (actionKey === 'approve') {
    // Fetch the candidate first: approve needs anchor_s + the repair-state
    // check (approved with no event = a prior approve failed mid-flight).
    const { data: cand, error: candErr } = await service
      .from('playhub_goal_candidates')
      .select('id, anchor_s, status, approved_event_id')
      .eq('id', candidateId)
      .eq('match_recording_id', id)   // IDOR guard
      .maybeSingle()
    if (candErr) {
      console.error('[goal-candidates] candidate fetch failed:', candErr.message)
      return NextResponse.json(
        { error: 'Query failed', code: 'query_failed' },
        { status: 500 }
      )
    }
    if (!cand) {
      return NextResponse.json(
        { error: 'Not found', code: 'not_found' },
        { status: 404 }
      )
    }
    // Fully-approved retry (double-click, stale tab): approve is idempotent —
    // return the existing outcome instead of a 409 the strip renders as an
    // error for exactly the state the admin wanted.
    if (cand.status === 'approved' && cand.approved_event_id) {
      return NextResponse.json({
        status: 'approved',
        eventId: cand.approved_event_id,
      })
    }
    const repairing = cand.status === 'approved' && !cand.approved_event_id
    if (cand.status !== 'draft' && !repairing) {
      return NextResponse.json(
        {
          error: 'Candidate is not in a state that allows approve',
          code: 'invalid_state',
          details: { status: cand.status },
        },
        { status: 409 }
      )
    }

    // 1. Claim (skip when repairing — the flip already won earlier).
    if (!repairing) {
      const { count, error } = await service
        .from('playhub_goal_candidates')
        .update(
          {
            status: 'approved',
            reviewed_by: user.id,
            reviewed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { count: 'exact' }
        )
        .eq('id', candidateId)
        .eq('match_recording_id', id)
        .in('status', ['draft'])
      if (error) {
        console.error('[goal-candidates] approve claim failed:', error.message)
        return NextResponse.json(
          { error: 'Update failed', code: 'update_failed' },
          { status: 500 }
        )
      }
      if (!count) {
        return NextResponse.json(
          {
            error: 'Candidate was reviewed concurrently',
            code: 'invalid_state',
            details: { status: 'unknown' },
          },
          { status: 409 }
        )
      }
    }

    // 2. Insert the goal event (idempotent: exact provider-triple lookup;
    //    the unique constraint is the backstop against a concurrent double).
    //    provider_recording_id MUST be non-null: the unique triple is NULLS
    //    DISTINCT, so a NULL here would void the backstop and let racing
    //    approves insert duplicate public markers (DB review, 2026-07-22).
    //    A missing game id is always abnormal (the sweep gates on it) —
    //    treat it as retryable, never degrade to NULL.
    const { data: rec } = await service
      .from('playhub_match_recordings')
      .select('spiideo_game_id')
      .eq('id', id)
      .maybeSingle()
    if (!rec?.spiideo_game_id) {
      return NextResponse.json(
        {
          error: 'Approved, but the goal event failed to write — approve again to finish',
          code: 'event_write_failed',
        },
        { status: 502 }
      )
    }
    // Idempotency lookup: the exact (provider='spiideo', provider_event_id=
    // candidate.id) PAIR — the candidate id is globally unique, so the pair
    // identifies the event; the DB triple constraint (with the non-null
    // provider_recording_id enforced above) is the concurrency backstop.
    let eventId: string | null = null
    const { data: existing, error: lookupErr } = await service
      .from('playhub_recording_events')
      .select('id')
      .eq('provider', 'spiideo')
      .eq('provider_event_id', candidateId)
      .maybeSingle()
    if (lookupErr) {
      console.error('[goal-candidates] event lookup failed:', lookupErr.message)
      return NextResponse.json(
        {
          error: 'Approved, but the goal event failed to write — approve again to finish',
          code: 'event_write_failed',
        },
        { status: 502 }
      )
    }
    if (existing) {
      eventId = existing.id
    } else {
      const { data: inserted, error: insErr } = await service
        .from('playhub_recording_events')
        .insert({
          match_recording_id: id,
          event_type: 'goal',
          timestamp_seconds: Math.max(0, Number(cand.anchor_s) - EVENT_OFFSET_S),
          team: null,
          label: null,
          // v1 call (Karim): public is required for /watch markers without a
          // watch read-path change (private only shows to created_by).
          // Footnote: later align with the Veo events posture (private +
          // access-checked reads).
          visibility: 'public',
          source: 'ai_detected',
          confidence_score: null,
          created_by: user.id,
          provider: 'spiideo',
          provider_recording_id: rec.spiideo_game_id,
          provider_event_id: candidateId,
        })
        .select('id')
        .single()
      if (insErr || !inserted) {
        // Unique-violation = a concurrent approve won the insert — converge
        // on its event instead of bouncing the caller (API review M3a).
        if (insErr?.code === '23505') {
          const { data: winner } = await service
            .from('playhub_recording_events')
            .select('id')
            .eq('provider', 'spiideo')
            .eq('provider_event_id', candidateId)
            .maybeSingle()
          if (winner) {
            eventId = winner.id
          }
        }
        if (!eventId) {
          // Candidate stays approved with approved_event_id NULL — the
          // repair state; a second approve retries the event insert.
          console.error(
            '[goal-candidates] event insert failed:',
            insErr?.message ?? 'no row'
          )
          return NextResponse.json(
            {
              error: 'Approved, but the goal event failed to write — approve again to finish',
              code: 'event_write_failed',
            },
            { status: 502 }
          )
        }
      } else {
        eventId = inserted.id
      }
    }

    // 3. Stamp the event id (failure here also lands in the repair state).
    const { error: stampErr } = await service
      .from('playhub_goal_candidates')
      .update({
        approved_event_id: eventId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', candidateId)
      .eq('match_recording_id', id)
    if (stampErr) {
      console.error('[goal-candidates] stamp failed:', stampErr.message)
      return NextResponse.json(
        {
          error: 'Approved, but the link failed to write — approve again to finish',
          code: 'event_write_failed',
        },
        { status: 502 }
      )
    }
    return NextResponse.json({ status: 'approved', eventId })
  }

  // reject / restore: single count-CAS (no .select() — the PostgREST
  // or=/representation 400 lesson), match_recording_id is the IDOR guard.
  const { count, error } = await service
    .from('playhub_goal_candidates')
    .update(
      { status: transition.to, updated_at: new Date().toISOString() },
      { count: 'exact' }
    )
    .eq('id', candidateId)
    .eq('match_recording_id', id)
    .in('status', transition.from)
  if (error) {
    console.error('[goal-candidates] transition failed:', error.message)
    return NextResponse.json(
      { error: 'Update failed', code: 'update_failed' },
      { status: 500 }
    )
  }
  if (!count) {
    const { data: current } = await service
      .from('playhub_goal_candidates')
      .select('status')
      .eq('id', candidateId)
      .eq('match_recording_id', id)
      .maybeSingle()
    if (current) {
      return NextResponse.json(
        {
          error: 'Candidate is not in a state that allows this action',
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
