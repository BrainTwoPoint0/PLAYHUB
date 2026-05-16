// Map Veo API highlights to playhub_recording_events rows.
//
// Empirical findings (2026-05-15, n=3,884 goal highlights in
// playhub_veo_match_content_cache):
//   - tags[].slug = "goal" identifies a goal highlight
//   - tags are objects {name, slug, custom, origin}, NOT plain strings —
//     the existing VeoHighlight TS interface in src/lib/veo/client.ts is wrong
//     but no code reads .tags, so we define a local input type instead.
//   - team_association ∈ {"own","opponent",null}. "own" means the club that
//     uploaded the Veo recording scored. This does NOT map cleanly to our
//     home/away enum (depends on which side hosts the camera), so we always
//     store team=null in Phase 1a and revisit derivation in a follow-up.

import type { InsertRecordingEvent } from './event-types'

export interface VeoHighlightTag {
  slug: string
  name?: string
  custom?: boolean
  origin?: string
}

export interface VeoHighlightForMapping {
  id: string
  start: number
  tags: VeoHighlightTag[]
  team_association?: string | null
  is_ai_generated?: boolean
}

const GOAL_TAG_SLUG = 'goal'

/**
 * Map a Veo highlight to an InsertRecordingEvent identified by
 * (provider='veo', provider_recording_id=veoMatchSlug). The event is NOT
 * attached to a playhub_match_recordings row — Veo recordings live in the
 * veo cache tables and don't have marketplace rows.
 */
export function mapVeoHighlightToEvent(
  highlight: VeoHighlightForMapping,
  veoMatchSlug: string
): InsertRecordingEvent | null {
  if (!veoMatchSlug) return null
  if (!highlight?.id || typeof highlight.start !== 'number') return null
  if (!Array.isArray(highlight.tags)) return null

  const isGoal = highlight.tags.some((t) => t?.slug === GOAL_TAG_SLUG)
  if (!isGoal) return null

  // visibility='private' is the secure default for provider events: RLS
  // (visibility='public' OR created_by=auth.uid()) blocks all user reads
  // since these rows have no creator. Phase 1b will surface events through
  // a dedicated API route that runs an explicit access check before reading.
  return {
    match_recording_id: null,
    provider: 'veo',
    provider_recording_id: veoMatchSlug,
    event_type: 'goal',
    timestamp_seconds: highlight.start,
    team: null,
    label: null,
    visibility: 'private',
    source: 'ai_detected',
    confidence_score: 1.0,
    created_by: null,
    provider_event_id: highlight.id,
  }
}

export function mapVeoHighlightsToEvents(
  highlights: VeoHighlightForMapping[],
  veoMatchSlug: string
): InsertRecordingEvent[] {
  if (!Array.isArray(highlights)) return []
  const out: InsertRecordingEvent[] = []
  for (const h of highlights) {
    const mapped = mapVeoHighlightToEvent(h, veoMatchSlug)
    if (mapped) out.push(mapped)
  }
  return out
}
