// Pure decision logic for the multi-goal review actions on a goal-detect
// candidate (merged episodes hold flurries: 7.6% of recovered goals lose
// their marker to episode collapse — one candidate must be able to carry N
// approved goal events). The PATCH route owns the DB sequencing; everything
// that can be unit-tested without a database lives here.

// Veo-measured median goal->kickoff latency: the default event timestamp is
// the detected kickoff anchor minus this (landed 1s from the true goal on
// the pilot E2E).
export const EVENT_OFFSET_S = 20

// Sanity ceiling for a human stamp (security L2): match clocks top out
// well under a day; a fat-fingered 1e300 must not ship as a public marker.
export const MAX_TIMESTAMP_S = 86_400

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type StampSource = 'anchor_offset' | 'human_scrub'

export type ReviewAction =
  | { action: 'approve'; timestampSeconds: number | null }
  | { action: 'add_goal'; timestampSeconds: number; estimate: boolean }
  | { action: 'remove_event'; eventId: string }
  | { action: 'unapprove' }
  | { action: 'reject' }
  | { action: 'restore' }

export type ParsedReviewBody =
  { ok: true; parsed: ReviewAction } | { ok: false; error: string }

function invalid(error: string): ParsedReviewBody {
  return { ok: false, error }
}

function validTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_TIMESTAMP_S
  )
}

export function parseReviewBody(body: unknown): ParsedReviewBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return invalid('Body must be a JSON object with an action')
  }
  const record = body as Record<string, unknown>
  const action = record.action
  switch (action) {
    case 'approve': {
      const ts = record.timestampSeconds
      if (ts === undefined || ts === null) {
        return {
          ok: true,
          parsed: { action: 'approve', timestampSeconds: null },
        }
      }
      if (!validTimestamp(ts)) {
        return invalid('timestampSeconds must be a finite number >= 0')
      }
      return { ok: true, parsed: { action: 'approve', timestampSeconds: ts } }
    }
    case 'add_goal': {
      const ts = record.timestampSeconds
      if (!validTimestamp(ts)) {
        return invalid(
          'add_goal requires timestampSeconds (finite number >= 0)'
        )
      }
      // estimate: true marks a machine-derived stamp (sub-anchor hint chip)
      // so it records as 'anchor_offset', keeping 'human_scrub' an honest
      // human-precise label (the timing corpus) and letting a later genuine
      // scrub beat it in the repair-restamp path.
      const est = record.estimate
      if (est !== undefined && typeof est !== 'boolean') {
        return invalid('estimate must be a boolean when present')
      }
      return {
        ok: true,
        parsed: {
          action: 'add_goal',
          timestampSeconds: ts,
          estimate: est === true,
        },
      }
    }
    case 'remove_event': {
      const eventId = record.eventId
      if (typeof eventId !== 'string' || !UUID_RE.test(eventId)) {
        return invalid('remove_event requires a UUID eventId')
      }
      return { ok: true, parsed: { action: 'remove_event', eventId } }
    }
    case 'unapprove':
    case 'reject':
    case 'restore':
      return { ok: true, parsed: { action } }
    default:
      return invalid(
        'action must be approve, add_goal, remove_event, unapprove, reject, or restore'
      )
  }
}

/**
 * The event timestamp + provenance for a new goal marker: an explicit stamp
 * is used verbatim; absent one, fall back to anchor - EVENT_OFFSET_S
 * (clamped at 0). A human stamp of 0 is a real stamp. `estimate` marks an
 * explicit-but-machine-derived stamp (sub-anchor hint chip): it keeps the
 * chip's timestamp but records as 'anchor_offset', so 'human_scrub' stays a
 * human-precise label and a later genuine scrub can supersede it.
 */
export function resolveEventStamp(
  anchorS: number,
  timestampSeconds: number | null,
  estimate = false
): { timestampSeconds: number; stampSource: StampSource } {
  if (timestampSeconds !== null) {
    return {
      timestampSeconds,
      stampSource: estimate ? 'anchor_offset' : 'human_scrub',
    }
  }
  return {
    timestampSeconds: Math.max(0, anchorS - EVENT_OFFSET_S),
    stampSource: 'anchor_offset',
  }
}

/**
 * Parse a reviewer-typed match-clock time ("22:33", "1:02:03", or bare
 * seconds) into seconds. Exists because the review clip is capped at 5
 * minutes while merged episodes can span 9+ — goals past the clip's end can
 * only be stamped by typing the time read off /watch. Returns null on
 * malformed or out-of-range input.
 */
export function parseClockInput(input: string): number | null {
  const s = input.trim()
  let seconds: number | null = null
  if (/^\d+$/.test(s)) {
    seconds = Number(s)
  } else {
    const m = /^(\d+):([0-5]\d)$/.exec(s)
    const h = /^(\d+):([0-5]\d):([0-5]\d)$/.exec(s)
    if (m) seconds = Number(m[1]) * 60 + Number(m[2])
    else if (h) seconds = Number(h[1]) * 3600 + Number(h[2]) * 60 + Number(h[3])
  }
  if (seconds === null || !Number.isFinite(seconds)) return null
  return seconds >= 0 && seconds <= MAX_TIMESTAMP_S ? seconds : null
}

// A sub-anchor hint is suppressed once a linked event is stamped within this
// radius of its estimate — clicking a hint stamps exactly the estimate, so
// the hint reads as "done" and the remaining cycles stay offered.
// Deliberate v1 trade-offs at 10s (half of EVENT_OFFSET_S): a human scrub
// landing >10s from the estimate leaves that hint offered (removable
// duplicate if clicked), and two genuine goals stamped <10s apart would
// mutually suppress — both acceptable; the reviewer always has the typed
// time field.
export const HINT_SUPPRESS_S = 10

/**
 * One-click stamp offers for a candidate's sub-anchors (the first kickoff
 * peak of each dead->live cycle inside the merged episode — the hybrid from
 * the episode-split measurement). HINTS ONLY: each value is a proposed
 * add_goal timestamp (sub_anchor - EVENT_OFFSET_S, clamped at 0) that the
 * reviewer explicitly clicks; nothing auto-approves.
 *
 * Single-cycle cards (the median) return [] so they look exactly like
 * today — the card's existing "goal ~m:ss" hint already covers the anchor.
 */
export function subAnchorHints(
  subAnchorsS: number[] | null | undefined,
  events: { stampSeconds: number | null }[]
): number[] {
  const subs = (subAnchorsS ?? []).filter(
    (s) => Number.isFinite(s) && s >= 0 && s <= MAX_TIMESTAMP_S
  )
  if (subs.length < 2) return []
  const stamps = events
    .map((e) => e.stampSeconds)
    .filter((s): s is number => s !== null && Number.isFinite(s))
  // Dedupe post-clamp: two early sub-anchors can both clamp to the same
  // estimate; one chip (and one stable React key) per distinct offer.
  return [...new Set(subs.map((s) => Math.max(0, s - EVENT_OFFSET_S)))]
    .filter((est) => !stamps.some((st) => Math.abs(st - est) <= HINT_SUPPRESS_S))
}

export interface CandidateEventLink {
  eventId: string
  createdAt: string
}

/**
 * approved_event_id after removing one linked event. Invariant: while the
 * candidate stays approved, approved_event_id must point at a LIVE linked
 * event (a dangling or NULL primary reads as the mid-flight repair state
 * and would let a re-approve mint a duplicate marker).
 *
 * - no links remain      -> null (caller flips the candidate to draft)
 * - primary still linked -> keep it
 * - otherwise            -> earliest remaining link (created_at, then
 *                           eventId for determinism on ties)
 */
export function nextPrimaryEventId(
  remaining: CandidateEventLink[],
  currentPrimary: string | null,
  removedEventId: string
): string | null {
  if (remaining.length === 0) return null
  if (
    currentPrimary !== null &&
    currentPrimary !== removedEventId &&
    remaining.some((l) => l.eventId === currentPrimary)
  ) {
    return currentPrimary
  }
  const sorted = remaining
    .slice()
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        a.eventId.localeCompare(b.eventId)
    )
  return sorted[0].eventId
}
