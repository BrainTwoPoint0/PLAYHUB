// PATCH /api/recordings/[id]/goal-candidates/[candidateId]
//
// Review actions on a goal-detect candidate (platform admin only, pilot).
// One candidate can carry N goal events (merged episodes hold multi-goal
// flurries): candidate <-> event links live in playhub_goal_candidate_events.
//
//   approve:      draft -> approved + first goal event. Optional
//                 timestampSeconds (human scrub stamp); default anchor-20s.
//   add_goal:     append another goal event while approved (requires
//                 timestampSeconds). From draft it IS the approve path.
//   remove_event: delete ONE linked event; removing the last one flips the
//                 candidate back to draft (unapprove semantics).
//   unapprove:    approved -> draft, deleting ALL linked goal events FIRST.
//   reject:       draft -> rejected
//   restore:      rejected -> draft
//
// Ordering invariants (public /watch markers are the stakes):
//
// * MARKER NEVER OUTLIVES APPROVED - every event delete runs before the
//   status flip that would strand it, and is guarded by provider='spiideo'
//   AND source='ai_detected' AND match_recording_id, so it can only ever
//   remove this pipeline's own AI events - never a manual or Veo event.
//
// * LINK BEFORE EVENT - approve/add_goal write the link row FIRST, then the
//   event with id = provider_event_id = the link's event_id. A mid-flight
//   failure leaves a link with no event (no public marker, discoverable for
//   repair) - never a public marker no unapprove could find. event_id is
//   client-generated (crypto.randomUUID) precisely so the link can exist
//   before the event does.
//
// * approved_event_id stays the PRIMARY/first stamp (repair-state compat):
//   `approved AND approved_event_id IS NULL` is the repair state - a second
//   approve skips the claim and re-runs discovery (legacy pair lookup, then
//   pending link) before minting anything new. While approved with N>0
//   events it always points at a live linked event (remove_event repoints).
//
// Approve ordering is claim-first, link-second, event-third, stamp-fourth.
// The event insert is idempotent via its explicit id (unique PK + the
// partial unique (provider, provider_event_id) as concurrency backstops).
// Legacy events (pre-multi-goal) carry provider_event_id = candidate id;
// new events carry provider_event_id = their own id so the partial unique
// stays one-row-per-marker at N>1.

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { isSameOrigin } from '@/lib/tiktok/route-helpers'
import {
  parseReviewBody,
  resolveEventStamp,
  nextPrimaryEventId,
  type StampSource,
} from '@/lib/goal-review/multi-goal'

export const dynamic = 'force-dynamic'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Service = ReturnType<typeof createServiceClient>

function jsonError(
  status: number,
  error: string,
  code: string,
  details?: Record<string, unknown>
) {
  return NextResponse.json(
    details ? { error, code, details } : { error, code },
    { status }
  )
}

// Factory, NOT a module-level const: a NextResponse body is a one-shot
// stream, and a cached instance returned from a second request in a warm
// server would ship a disturbed body — on exactly the retry paths this
// response exists for (senior review H1).
function approveRetry() {
  return jsonError(
    502,
    'Approved, but the goal event failed to write — approve again to finish',
    'event_write_failed'
  )
}

/**
 * Ensure the goal event for `eventId` exists (insert with explicit id;
 * converge on 23505 — our own prior insert or a concurrent double).
 */
async function ensureGoalEvent(
  service: Service,
  args: {
    recordingId: string
    gameId: string
    eventId: string
    timestampSeconds: number
    userId: string
  }
): Promise<boolean> {
  const { error: insErr } = await service
    .from('playhub_recording_events')
    .insert({
      id: args.eventId,
      match_recording_id: args.recordingId,
      event_type: 'goal',
      timestamp_seconds: args.timestampSeconds,
      team: null,
      label: null,
      // v1 call (Karim): public is required for /watch markers without a
      // watch read-path change (private only shows to created_by).
      visibility: 'public',
      source: 'ai_detected',
      confidence_score: null,
      created_by: args.userId,
      provider: 'spiideo',
      provider_recording_id: args.gameId,
      provider_event_id: args.eventId,
    })
  if (insErr && insErr.code !== '23505') {
    console.error('[goal-candidates] event insert failed:', insErr.message)
    return false
  }
  return true
}

/**
 * The recording's Spiideo game id. MUST be non-null before any event write:
 * the triple unique backstop is NULLS DISTINCT, and a missing game id is
 * always abnormal (the sweep gates on it) — retryable, never NULL.
 */
async function requireGameId(
  service: Service,
  recordingId: string
): Promise<string | null> {
  const { data: rec } = await service
    .from('playhub_match_recordings')
    .select('spiideo_game_id')
    .eq('id', recordingId)
    .maybeSingle()
  return rec?.spiideo_game_id ?? null
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; candidateId: string }> }
) {
  if (!isSameOrigin(request)) {
    return jsonError(403, 'Forbidden', 'forbidden')
  }
  const { user } = await getAuthUser()
  if (!user) {
    return jsonError(401, 'Unauthorized', 'unauthorized')
  }
  const { id, candidateId } = await params
  if (!UUID_RE.test(id) || !UUID_RE.test(candidateId)) {
    return jsonError(400, 'Bad id', 'bad_request')
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError(400, 'Bad body', 'bad_request')
  }
  const parsed = parseReviewBody(body)
  if (!parsed.ok) {
    return jsonError(400, parsed.error, 'bad_request')
  }
  const action = parsed.parsed
  if (!(await isPlatformAdmin(user.id))) {
    return jsonError(403, 'Forbidden', 'forbidden')
  }

  const service = createServiceClient()

  // ---- approve / add_goal ------------------------------------------------

  if (action.action === 'approve' || action.action === 'add_goal') {
    const { data: cand, error: candErr } = await service
      .from('playhub_goal_candidates')
      .select('id, anchor_s, status, approved_event_id')
      .eq('id', candidateId)
      .eq('match_recording_id', id) // IDOR guard
      .maybeSingle()
    if (candErr) {
      console.error(
        '[goal-candidates] candidate fetch failed:',
        candErr.message
      )
      return jsonError(500, 'Query failed', 'query_failed')
    }
    if (!cand) {
      return jsonError(404, 'Not found', 'not_found')
    }

    const fullyApproved = cand.status === 'approved' && !!cand.approved_event_id
    const repairing = cand.status === 'approved' && !cand.approved_event_id

    // Fully-approved retry of approve (double-click, stale tab): idempotent.
    if (action.action === 'approve' && fullyApproved) {
      return NextResponse.json({
        status: 'approved',
        eventId: cand.approved_event_id,
      })
    }

    // add_goal onto a fully-approved candidate = APPEND another marker.
    if (action.action === 'add_goal' && fullyApproved) {
      const gameId = await requireGameId(service, id)
      if (!gameId) {
        return jsonError(
          502,
          'The goal marker failed to save — try again',
          'goal_add_failed'
        )
      }
      // Same-timestamp convergence (API review): an identical-ts add_goal
      // (stale-tab hint chip, double-submit, or a retry after
      // goal_add_failed) adopts the existing link instead of minting a
      // duplicate public marker — and re-ensures its event, so a retry
      // COMPLETES a link-without-marker state rather than duplicating it.
      // Exact equality only: two genuine goals never share a second, and
      // chips post the same rounded value every time.
      const { data: sameTs, error: sameTsErr } = await service
        .from('playhub_goal_candidate_events')
        .select('event_id, stamp_source')
        .eq('candidate_id', candidateId)
        .eq('stamp_seconds', action.timestampSeconds)
        // Deterministic adoption if pre-fix duplicate same-ts links exist:
        // retries always converge on the same (earliest) marker.
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (sameTsErr) {
        console.error(
          '[goal-candidates] link dedupe lookup failed:',
          sameTsErr.message
        )
        return jsonError(
          502,
          'The goal marker failed to save — try again',
          'goal_add_failed'
        )
      }
      const stampSource: StampSource = action.estimate
        ? 'anchor_offset'
        : 'human_scrub'
      let eventId: string
      let achievedSource: StampSource = stampSource
      if (sameTs) {
        eventId = sameTs.event_id
        achievedSource =
          sameTs.stamp_source === 'human_scrub' ? 'human_scrub' : 'anchor_offset'
        if (!action.estimate && achievedSource !== 'human_scrub') {
          // A genuine scrub confirming the exact second of a prior chip
          // estimate is the strongest human label there is — upgrade the
          // link's provenance (API review). Best-effort: on failure keep
          // reporting the stored source; the marker itself is unaffected.
          const { error: upgradeErr } = await service
            .from('playhub_goal_candidate_events')
            .update({ stamp_source: 'human_scrub' satisfies StampSource })
            .eq('candidate_id', candidateId)
            .eq('event_id', eventId)
          if (upgradeErr) {
            console.error(
              '[goal-candidates] provenance upgrade failed:',
              upgradeErr.message
            )
          } else {
            achievedSource = 'human_scrub'
          }
        }
      } else {
        eventId = randomUUID()
        const { error: linkErr } = await service
          .from('playhub_goal_candidate_events')
          .insert({
            candidate_id: candidateId,
            event_id: eventId,
            stamp_source: stampSource,
            stamp_seconds: action.timestampSeconds,
            created_by: user.id,
          })
        if (linkErr) {
          console.error(
            '[goal-candidates] link insert failed:',
            linkErr.message
          )
          return jsonError(
            502,
            'The goal marker failed to save — try again',
            'goal_add_failed'
          )
        }
      }
      const eventOk = await ensureGoalEvent(service, {
        recordingId: id,
        gameId,
        eventId,
        timestampSeconds: action.timestampSeconds,
        userId: user.id,
      })
      if (!eventOk) {
        // Do NOT compensate by deleting the link: an insert error can be
        // AMBIGUOUS (committed server-side, response lost), and dropping the
        // link then strands a live public marker no unapprove could find
        // (senior review C1). A surviving link with no event is just a chip
        // with no marker — removable, and harmless in both truth states.
        return jsonError(
          502,
          'The goal marker failed to save — try again',
          'goal_add_failed'
        )
      }
      return NextResponse.json({
        status: 'approved',
        eventId,
        timestampSeconds: action.timestampSeconds,
        stampSource: achievedSource,
      })
    }

    // From here: the approve path (approve from draft, add_goal from draft,
    // or either action repairing a mid-flight failure).
    if (cand.status !== 'draft' && !repairing) {
      return jsonError(
        409,
        `Candidate is not in a state that allows ${action.action}`,
        'invalid_state',
        { status: cand.status }
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
        return jsonError(500, 'Update failed', 'update_failed')
      }
      if (!count) {
        return jsonError(
          409,
          'Candidate was reviewed concurrently',
          'invalid_state',
          {
            status: 'unknown',
          }
        )
      }
    }

    const gameId = await requireGameId(service, id)
    if (!gameId) {
      return approveRetry()
    }

    // 2. Resolve the event id — repair discovery before minting anything:
    //    (a) legacy event keyed by the old provider_event_id = candidate id
    //        (pre-multi-goal approves, including pre-migration repair rows);
    //    (b) a pending link from a prior attempt (link-before-event order);
    //    (c) otherwise mint a new id and write the link FIRST.
    let eventId: string
    let eventTs: number
    let eventStampSource: StampSource
    let needsEvent = true
    const { data: legacy, error: legacyErr } = await service
      .from('playhub_recording_events')
      .select('id, timestamp_seconds')
      .eq('provider', 'spiideo')
      .eq('provider_event_id', candidateId)
      // Recording + source scoping is defense-in-depth (security L1): a
      // stray spiideo event elsewhere carrying this uuid must never be
      // adopted — the unapprove delete is recording-scoped and could then
      // never remove it. limit(1) keeps a future index change from turning
      // maybeSingle into a 502 loop.
      .eq('match_recording_id', id)
      .eq('source', 'ai_detected')
      .limit(1)
      .maybeSingle()
    if (legacyErr) {
      console.error('[goal-candidates] event lookup failed:', legacyErr.message)
      return approveRetry()
    }
    if (legacy) {
      eventId = legacy.id
      eventTs = Number(legacy.timestamp_seconds)
      eventStampSource = 'anchor_offset'
      needsEvent = false
      const { error: linkErr } = await service
        .from('playhub_goal_candidate_events')
        .upsert(
          {
            candidate_id: candidateId,
            event_id: eventId,
            stamp_source: 'anchor_offset' satisfies StampSource,
            stamp_seconds: eventTs,
            created_by: user.id,
          },
          { onConflict: 'candidate_id,event_id', ignoreDuplicates: true }
        )
      if (linkErr) {
        console.error('[goal-candidates] link upsert failed:', linkErr.message)
        return approveRetry()
      }
    } else {
      const { data: pending, error: pendingErr } = await service
        .from('playhub_goal_candidate_events')
        .select('event_id, stamp_source, stamp_seconds')
        .eq('candidate_id', candidateId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (pendingErr) {
        console.error(
          '[goal-candidates] link lookup failed:',
          pendingErr.message
        )
        return approveRetry()
      }
      const stamp = resolveEventStamp(
        Number(cand.anchor_s),
        action.timestampSeconds,
        action.action === 'add_goal' && action.estimate
      )
      if (pending) {
        eventId = pending.event_id
        if (
          action.timestampSeconds !== null &&
          pending.stamp_source === 'anchor_offset'
        ) {
          // An explicit stamp — human scrub OR a hint-chip estimate — beats
          // a prior attempt's estimate (API review S3): the admin picked a
          // moment; silently keeping the stale one would save a marker
          // somewhere else while the notice says "added". A prior HUMAN
          // stamp still wins (idempotency over a differing retry ts), and a
          // chip estimate records as 'anchor_offset' so a later genuine
          // scrub can still supersede it here.
          eventTs = stamp.timestampSeconds
          eventStampSource = stamp.stampSource
          const { error: restampErr } = await service
            .from('playhub_goal_candidate_events')
            .update({
              stamp_source: stamp.stampSource,
              stamp_seconds: eventTs,
            })
            .eq('candidate_id', candidateId)
            .eq('event_id', eventId)
          if (restampErr) {
            console.error(
              '[goal-candidates] link restamp failed:',
              restampErr.message
            )
            return approveRetry()
          }
        } else {
          eventTs =
            pending.stamp_seconds === null
              ? stamp.timestampSeconds
              : Number(pending.stamp_seconds)
          eventStampSource =
            pending.stamp_source === 'human_scrub'
              ? 'human_scrub'
              : 'anchor_offset'
        }
      } else {
        eventId = randomUUID()
        eventTs = stamp.timestampSeconds
        eventStampSource = stamp.stampSource
        const { error: linkErr } = await service
          .from('playhub_goal_candidate_events')
          .insert({
            candidate_id: candidateId,
            event_id: eventId,
            stamp_source: stamp.stampSource,
            stamp_seconds: eventTs,
            created_by: user.id,
          })
        if (linkErr) {
          console.error(
            '[goal-candidates] link insert failed:',
            linkErr.message
          )
          return approveRetry()
        }
      }
    }

    // 3. Ensure the event exists (skipped when a legacy event was adopted).
    if (needsEvent) {
      const eventOk = await ensureGoalEvent(service, {
        recordingId: id,
        gameId,
        eventId,
        timestampSeconds: eventTs,
        userId: user.id,
      })
      if (!eventOk) {
        // Candidate stays approved with approved_event_id NULL and a
        // pending link — the repair state; approve again retries.
        return approveRetry()
      }
    }

    // 4. Stamp the primary event id (failure lands in the repair state).
    //    CAS on status + NULL primary (security M1 / senior H2): a
    //    concurrent unapprove may have flipped the row underneath us, or a
    //    concurrent repair approve may have stamped a different event —
    //    an unconditional write would stamp a draft row or clobber the
    //    winner. Losing the CAS means OUR event must not stay public.
    const { count: stampCount, error: stampErr } = await service
      .from('playhub_goal_candidates')
      .update(
        {
          approved_event_id: eventId,
          updated_at: new Date().toISOString(),
        },
        { count: 'exact' }
      )
      .eq('id', candidateId)
      .eq('match_recording_id', id)
      .in('status', ['approved'])
      .is('approved_event_id', null)
    if (stampErr) {
      console.error('[goal-candidates] stamp failed:', stampErr.message)
      return jsonError(
        502,
        'Approved, but the link failed to write — approve again to finish',
        'event_write_failed'
      )
    }
    if (!stampCount) {
      // Lost the CAS. Re-read to tell the two cases apart.
      const { data: after } = await service
        .from('playhub_goal_candidates')
        .select('status, approved_event_id')
        .eq('id', candidateId)
        .eq('match_recording_id', id)
        .maybeSingle()
      if (after?.status === 'approved' && after.approved_event_id === eventId) {
        // A concurrent retry stamped the same adopted event — converged.
        return NextResponse.json({
          status: 'approved',
          eventId,
          timestampSeconds: eventTs,
          stampSource: eventStampSource,
        })
      }
      // Either an unapprove flipped the row (our marker must not outlive
      // it) or a concurrent repair approve stamped a DIFFERENT event (ours
      // is a duplicate mint). Roll back our own event, then our link —
      // event first so a failure never leaves an unlinked public marker.
      const { error: rollbackErr } = await service
        .from('playhub_recording_events')
        .delete()
        .eq('id', eventId)
        .eq('match_recording_id', id)
        .eq('provider', 'spiideo')
        .eq('source', 'ai_detected')
      if (rollbackErr) {
        // Event still exists but stays link-discoverable; loud log, stale
        // 409 — the next approve/unapprove on this candidate converges it.
        console.error(
          '[goal-candidates] stamp-race rollback failed:',
          rollbackErr.message
        )
      } else {
        await service
          .from('playhub_goal_candidate_events')
          .delete()
          .eq('candidate_id', candidateId)
          .eq('event_id', eventId)
      }
      if (after?.status === 'approved' && after.approved_event_id) {
        return NextResponse.json({
          status: 'approved',
          eventId: after.approved_event_id,
        })
      }
      return jsonError(
        409,
        'Candidate was reviewed concurrently',
        'invalid_state',
        { status: after?.status ?? 'unknown' }
      )
    }
    return NextResponse.json({
      status: 'approved',
      eventId,
      timestampSeconds: eventTs,
      stampSource: eventStampSource,
    })
  }

  // ---- remove_event ------------------------------------------------------

  if (action.action === 'remove_event') {
    const { data: cand, error: candErr } = await service
      .from('playhub_goal_candidates')
      .select('id, status, approved_event_id')
      .eq('id', candidateId)
      .eq('match_recording_id', id) // IDOR guard
      .maybeSingle()
    if (candErr) {
      console.error(
        '[goal-candidates] candidate fetch failed:',
        candErr.message
      )
      return jsonError(500, 'Query failed', 'query_failed')
    }
    if (!cand) {
      return jsonError(404, 'Not found', 'not_found')
    }
    const { data: links, error: linksErr } = await service
      .from('playhub_goal_candidate_events')
      .select('event_id, created_at')
      .eq('candidate_id', candidateId)
    if (linksErr) {
      console.error('[goal-candidates] link lookup failed:', linksErr.message)
      return jsonError(500, 'Query failed', 'query_failed')
    }
    const target = (links ?? []).find((l) => l.event_id === action.eventId)
    if (!target) {
      // Idempotent retry (the earlier delete finished) or a stale chip:
      // return the achieved state, not a 404 the strip renders as an error
      // for exactly the outcome the admin wanted (API review M2). 404 is
      // reserved for the candidate itself.
      return NextResponse.json({
        status: cand.status,
        removedEventId: action.eventId,
      })
    }

    // Removing the LAST marker = unapprove semantics (its robust recovery
    // paths included) — fall through to the unapprove block below.
    if ((links ?? []).length > 1) {
      // Ordering: delete event -> repoint primary -> drop link. A failure
      // at ANY step leaves the link in place, so a re-issued remove_event
      // converges instead of 404ing on a half-done removal, and the primary
      // is never left dangling on a live approved candidate (senior M1).
      // 1. Delete the event first (marker never outlives the review state).
      //    Guarded to this pipeline's own AI events; idempotent (0 rows ok).
      const { error: delErr } = await service
        .from('playhub_recording_events')
        .delete()
        .eq('id', action.eventId)
        .eq('match_recording_id', id)
        .eq('provider', 'spiideo')
        .eq('source', 'ai_detected')
      if (delErr) {
        console.error('[goal-candidates] event delete failed:', delErr.message)
        return jsonError(
          502,
          'The goal marker failed to remove — try again',
          'event_delete_failed'
        )
      }
      // 2. Keep approved_event_id pointing at a LIVE linked event.
      const remaining = (links ?? [])
        .filter((l) => l.event_id !== action.eventId)
        .map((l) => ({ eventId: l.event_id, createdAt: l.created_at }))
      const primary = nextPrimaryEventId(
        remaining,
        cand.approved_event_id,
        action.eventId
      )
      if (primary !== cand.approved_event_id) {
        const { error: repointErr } = await service
          .from('playhub_goal_candidates')
          .update({
            approved_event_id: primary,
            updated_at: new Date().toISOString(),
          })
          .eq('id', candidateId)
          .eq('match_recording_id', id)
        if (repointErr) {
          console.error('[goal-candidates] repoint failed:', repointErr.message)
          return jsonError(
            502,
            'The goal marker failed to remove — try again',
            'event_delete_failed'
          )
        }
      }
      // 3. Drop the link last (retry re-runs 1-2 as idempotent no-ops).
      const { error: linkDelErr } = await service
        .from('playhub_goal_candidate_events')
        .delete()
        .eq('candidate_id', candidateId)
        .eq('event_id', action.eventId)
      if (linkDelErr) {
        console.error(
          '[goal-candidates] link delete failed:',
          linkDelErr.message
        )
        return jsonError(
          502,
          'The goal marker failed to remove — try again',
          'event_delete_failed'
        )
      }
      return NextResponse.json({
        status: 'approved',
        removedEventId: action.eventId,
      })
    }
    // links.length === 1 → fall through to unapprove.
  }

  // ---- unapprove (and remove_event on the last marker) --------------------

  if (action.action === 'unapprove' || action.action === 'remove_event') {
    const { data: cand, error: candErr } = await service
      .from('playhub_goal_candidates')
      .select('id, status, approved_event_id')
      .eq('id', candidateId)
      .eq('match_recording_id', id) // IDOR guard
      .maybeSingle()
    if (candErr) {
      console.error(
        '[goal-candidates] candidate fetch failed:',
        candErr.message
      )
      return jsonError(500, 'Query failed', 'query_failed')
    }
    if (!cand) {
      return jsonError(404, 'Not found', 'not_found')
    }
    // Idempotent double-unapprove: a retry that finds the target state gets
    // the outcome, not a 409 the strip renders as an error.
    if (cand.status === 'draft') {
      return NextResponse.json({ status: 'draft' })
    }
    if (cand.status !== 'approved') {
      return jsonError(
        409,
        'Candidate is not in a state that allows unapprove',
        'invalid_state',
        { status: cand.status }
      )
    }

    const { data: links, error: linksErr } = await service
      .from('playhub_goal_candidate_events')
      .select('event_id')
      .eq('candidate_id', candidateId)
    if (linksErr) {
      console.error('[goal-candidates] link lookup failed:', linksErr.message)
      return jsonError(500, 'Query failed', 'query_failed')
    }
    const linkedIds = (links ?? []).map((l) => l.event_id)

    // 1. Delete ALL linked events FIRST — a public /watch marker must never
    //    outlive an approved candidate. Deliberately NOT gated on
    //    approved_event_id (the repair state has a live event with a NULL
    //    stamp). Idempotent: 0 rows when nothing exists.
    if (linkedIds.length > 0) {
      const { error: delErr } = await service
        .from('playhub_recording_events')
        .delete()
        .in('id', linkedIds)
        .eq('match_recording_id', id)
        .eq('provider', 'spiideo')
        .eq('source', 'ai_detected')
      if (delErr) {
        console.error('[goal-candidates] event delete failed:', delErr.message)
        return jsonError(
          502,
          'The goal marker failed to remove — unapprove again to finish',
          'event_delete_failed'
        )
      }
    }
    // Legacy safety net: pre-multi-goal events carry provider_event_id =
    // candidate id and a pre-migration repair row may have no link.
    const { error: legacyDelErr } = await service
      .from('playhub_recording_events')
      .delete()
      .eq('match_recording_id', id)
      .eq('provider', 'spiideo')
      .eq('provider_event_id', candidateId)
      .eq('source', 'ai_detected')
    if (legacyDelErr) {
      console.error(
        '[goal-candidates] event delete failed:',
        legacyDelErr.message
      )
      return jsonError(
        502,
        'The goal marker failed to remove — unapprove again to finish',
        'event_delete_failed'
      )
    }

    // 2. Clear the links (events are gone; a failure here keeps the
    //    candidate approved so a retry re-runs the full routine).
    const { error: linkDelErr } = await service
      .from('playhub_goal_candidate_events')
      .delete()
      .eq('candidate_id', candidateId)
    if (linkDelErr) {
      console.error('[goal-candidates] link delete failed:', linkDelErr.message)
      return jsonError(
        502,
        'The goal marker failed to remove — unapprove again to finish',
        'event_delete_failed'
      )
    }

    // 3. Flip back to draft, clearing the primary in the same atomic row
    //    update (a dangling id would make a concurrent approve short-circuit
    //    onto a deleted event; single UPDATE closes that to a sub-ms window,
    //    acceptable for the single-admin pilot).
    const { count, error } = await service
      .from('playhub_goal_candidates')
      .update(
        {
          status: 'draft',
          approved_event_id: null,
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { count: 'exact' }
      )
      .eq('id', candidateId)
      .eq('match_recording_id', id)
      .in('status', ['approved'])
    if (error) {
      console.error('[goal-candidates] unapprove flip failed:', error.message)
      return jsonError(500, 'Update failed', 'update_failed')
    }
    if (!count) {
      return jsonError(
        409,
        'Candidate was reviewed concurrently',
        'invalid_state',
        {
          status: 'unknown',
        }
      )
    }
    return NextResponse.json(
      action.action === 'remove_event'
        ? { status: 'draft', removedEventId: action.eventId }
        : { status: 'draft' }
    )
  }

  // ---- reject / restore --------------------------------------------------

  // Single count-CAS (no .select() — the PostgREST or=/representation 400
  // lesson), match_recording_id is the IDOR guard.
  const transition =
    action.action === 'reject'
      ? { from: ['draft'], to: 'rejected' }
      : { from: ['rejected'], to: 'draft' }
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
    return jsonError(500, 'Update failed', 'update_failed')
  }
  if (!count) {
    const { data: current } = await service
      .from('playhub_goal_candidates')
      .select('status')
      .eq('id', candidateId)
      .eq('match_recording_id', id)
      .maybeSingle()
    if (current) {
      // Retry that finds the target state already reached: idempotent
      // success, mirroring the unapprove precedent (API review S2).
      if (current.status === transition.to) {
        return NextResponse.json({ status: transition.to })
      }
      return jsonError(
        409,
        'Candidate is not in a state that allows this action',
        'invalid_state',
        { status: current.status }
      )
    }
    return jsonError(404, 'Not found', 'not_found')
  }
  return NextResponse.json({ status: transition.to })
}
