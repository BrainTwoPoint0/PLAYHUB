// Shared writer for the portrait-draft correction signal.
//
// Currently the feedback route is the only caller. The reject/approve labels from the
// review PATCH route are a later phase; this helper exists so that when they land they
// share one insert shape rather than growing a second, divergent writer.
//
// INVARIANT: the insert object is built EXPLICITLY, field by field. Never spread a
// request body in here — that is what structurally keeps URLs, identity and other PII
// out of a corpus describing minors' footage. Geometry only.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/lib/supabase/types'
import type { CropKeyframe } from '@/lib/editor/types'
import { diffKeyframes, type KeyframeDiff } from '@/lib/editor/keyframe-diff'

export type PortraitFeedbackAction = 'accepted' | 'rejected' | 'edited' | 'exported'

/**
 * Provenance of `keyframes_before`.
 * - `render_row`    the FACT the draft was rendered with (trustworthy)
 * - `session_detect` re-derived by the editor from the detection cache, which drifts
 * - `none`          no baseline was resolvable
 *
 * `none` exists because stamping a missing baseline as `session_detect` would be a false
 * provenance claim, and diffing against an empty baseline fabricates a maximal-correction
 * signal indistinguishable from a genuine full manual rewrite. Corpus consumers MUST
 * filter on this column — treat it as a hard filter, not a convention.
 */
export type BaselineOrigin = 'render_row' | 'session_detect' | 'none'

/** Closed enum: free text about minors' footage is a PII vector and does not aggregate. */
export const REJECT_REASONS = [
  'bad_framing',
  'wrong_moment',
  'quality',
  'not_interesting',
  'other',
] as const
export type RejectReason = (typeof REJECT_REASONS)[number]

export const NOTE_MAX = 500

export interface PortraitFeedbackInput {
  renderId: string
  providerEventId: string
  clubSlug: string
  userId: string
  action: PortraitFeedbackAction
  keyframesBefore?: CropKeyframe[] | null
  keyframesAfter?: CropKeyframe[] | null
  baselineOrigin: BaselineOrigin
  reason?: RejectReason | null
  /** Admin-authored text. NOT accepted from the public request body — see the route. */
  note?: string | null
  sceneChanges?: number[] | null
  trim?: { start: number; end: number } | null
}

/**
 * Append one feedback row. Returns the created id and the computed diff.
 *
 * The diff is computed ONLY when both a real baseline and an "after" exist — never from
 * an empty baseline, which would fabricate signal (see BaselineOrigin).
 *
 * Best-effort by contract: callers on the review path MUST NOT fail an admin's decision
 * because the signal write failed. Errors are logged and returned as ok:false.
 */
export async function insertPortraitFeedback(
  service: SupabaseClient<Database>,
  input: PortraitFeedbackInput
): Promise<{ ok: boolean; id: string | null; diff: KeyframeDiff | null }> {
  const after = input.keyframesAfter ?? null
  const beforeRaw = input.keyframesBefore ?? null
  // Clip the baseline to the trim window BEFORE diffing. Without this, keyframes the
  // human trimmed away are reported as deletions with a deletedSourceMix — i.e. "the
  // crop was wrong here" when the truth is "that footage is not in the clip". Doing it
  // here rather than leaving it to consumers is deliberate: every consumer would have
  // to remember to filter by `trim`, and they won't.
  const before =
    beforeRaw && input.trim
      ? beforeRaw.filter(
          (k) => k.time >= input.trim!.start && k.time <= input.trim!.end
        )
      : beforeRaw
  // NOTE: `[]` is truthy, so length is the real guard — an empty baseline must not be
  // diffed (it would report every keyframe as "added" and fabricate a max correction).
  const diff =
    after && after.length > 0 && before && before.length > 0
      ? diffKeyframes(before, after)
      : null

  const { data, error } = await service
    .from('playhub_portrait_render_feedback')
    .insert({
      render_id: input.renderId,
      provider_event_id: input.providerEventId,
      club_slug: input.clubSlug,
      user_id: input.userId,
      action: input.action,
      reason: input.reason ?? null,
      note: input.note ? input.note.slice(0, NOTE_MAX) : null,
      // CropKeyframe / KeyframeDiff are plain primitive-valued objects; they are valid
      // JSON but lack the index signature Json requires structurally.
      keyframes_before: before as unknown as Json,
      keyframes_after: after as unknown as Json,
      diff: diff as unknown as Json,
      baseline_origin: input.baselineOrigin,
      scene_changes: input.sceneChanges ?? null,
      trim: input.trim ?? null,
    })
    .select('id')
    .single()

  if (error) {
    // Log only. A lost training row is never worth failing the admin's action.
    console.error('[portrait-feedback] insert failed:', error.message)
    return { ok: false, id: null, diff }
  }
  return { ok: true, id: (data as { id: string }).id, diff }
}
