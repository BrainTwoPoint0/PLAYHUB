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

export type CycleVerdict = 'goal' | 'no_goal'

export type ReviewAction =
  | { action: 'approve'; timestampSeconds: number | null }
  | { action: 'add_goal'; timestampSeconds: number; estimate: boolean }
  | { action: 'remove_event'; eventId: string }
  | { action: 'unapprove' }
  | { action: 'reject' }
  | { action: 'restore' }
  | {
      action: 'cycle_verdict'
      cycleAnchorS: number
      verdict: CycleVerdict | null
    }

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
    case 'cycle_verdict': {
      // Per-cycle yes/no review pilot: a verdict LABEL on one dead->live
      // cycle of the episode (refiner corpus). null clears a prior verdict.
      // Never touches episode review state.
      const anchor = record.cycleAnchorS
      if (!validTimestamp(anchor)) {
        return invalid(
          'cycle_verdict requires cycleAnchorS (finite number >= 0)'
        )
      }
      const verdict = record.verdict
      if (verdict !== 'goal' && verdict !== 'no_goal' && verdict !== null) {
        return invalid('verdict must be goal, no_goal, or null')
      }
      return {
        ok: true,
        parsed: { action: 'cycle_verdict', cycleAnchorS: anchor, verdict },
      }
    }
    case 'unapprove':
    case 'reject':
    case 'restore':
      return { ok: true, parsed: { action } }
    default:
      return invalid(
        'action must be approve, add_goal, remove_event, cycle_verdict, unapprove, reject, or restore'
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
  events: { stampSeconds: number | null }[],
  // Stamps from the recording's OTHER cards: overlapping 90s pre-rolls put
  // the same goal on adjacent cards (measured 8/40 duplicate markers), so a
  // marker stamped on a neighbour suppresses this card's hint too.
  crossCardStampsS: number[] = []
): number[] {
  const subs = (subAnchorsS ?? []).filter(
    (s) => Number.isFinite(s) && s >= 0 && s <= MAX_TIMESTAMP_S
  )
  if (subs.length < 2) return []
  const stamps = events
    .map((e) => e.stampSeconds)
    .concat(crossCardStampsS)
    .filter((s): s is number => s !== null && Number.isFinite(s))
  // Dedupe post-clamp: two early sub-anchors can both clamp to the same
  // estimate; one chip (and one stable React key) per distinct offer.
  return [...new Set(subs.map((s) => Math.max(0, s - EVENT_OFFSET_S)))].filter(
    (est) => !stamps.some((st) => Math.abs(st - est) <= HINT_SUPPRESS_S)
  )
}

/**
 * Cross-card ±10s stamp guard (add_goal duplicate warning): the nearest
 * existing stamp within HINT_SUPPRESS_S of the proposed timestamp, or null.
 * The strip warns (confirm-to-proceed) instead of blocking — two genuine
 * goals <10s apart exist (measured flurries down to ~7s) and the reviewer
 * decides. Callers exclude exact own-card equality first: that retry
 * converges idempotently server-side and must stay silent.
 */
export function findNearbyStamp(
  stampsS: number[],
  timestampS: number,
  radiusS: number = HINT_SUPPRESS_S
): number | null {
  let best: number | null = null
  for (const s of stampsS) {
    if (!Number.isFinite(s)) continue
    const d = Math.abs(s - timestampS)
    if (d <= radiusS && (best === null || d < Math.abs(best - timestampS))) {
      best = s
    }
  }
  return best
}

export interface RecordingStamp {
  candId: string
  ts: number
}

export type AddGoalGuardDecision =
  | { kind: 'proceed' }
  | { kind: 'warn'; conflictTs: number }

/**
 * Warn-then-confirm decision for an add_goal (the full cross-card ±10s
 * guard state machine, pure so the staleness rules are unit-testable):
 *
 * - exact own-card equality proceeds silently (the server converges that
 *   retry idempotently — no duplicate risk);
 * - any other stamp within the radius warns, UNLESS a pending warn for the
 *   SAME card within the radius exists — that repeat is the confirmation
 *   (matching is by card + radius, not exact ts, because the playhead keeps
 *   moving between the warn click and the confirm click).
 *
 * The caller owns pending-state lifetime: it must CLEAR pending on any
 * other action or refresh, so a stale armed confirm can never bypass a
 * warning about a conflict that did not exist when the warn fired
 * (senior review H1).
 */
export function resolveAddGoalGuard(
  stamps: RecordingStamp[],
  pending: { candId: string; ts: number } | null,
  candId: string,
  ts: number,
  radiusS: number = HINT_SUPPRESS_S
): AddGoalGuardDecision {
  const guardStamps = stamps
    .filter((s) => !(s.candId === candId && s.ts === ts))
    .map((s) => s.ts)
  const conflict = findNearbyStamp(guardStamps, ts, radiusS)
  if (conflict === null) return { kind: 'proceed' }
  const confirmed =
    pending !== null &&
    pending.candId === candId &&
    Math.abs(pending.ts - ts) <= radiusS
  return confirmed
    ? { kind: 'proceed' }
    : { kind: 'warn', conflictTs: conflict }
}

/**
 * Resolve a client-sent cycle anchor against the row's stored sub-anchor
 * list (cycle identity for the per-cycle verdict store). Returns the STORED
 * value (the canonical key) or null. Tolerance covers numeric->JS float
 * round-tripping only (the job writes 2dp) — anything looser would let two
 * distinct cycles alias.
 */
export function matchCycleAnchor(
  subAnchorsS: number[] | null | undefined,
  value: number
): number | null {
  for (const s of subAnchorsS ?? []) {
    if (Number.isFinite(s) && Math.abs(s - value) <= 0.005) return s
  }
  return null
}

// Clip-window mirror of the batch producer (clip_plan.py) — keep in
// lockstep. LEGACY_CLIP_MAX_S is the fixed cap every pre-adaptive clip was
// cut at; rows carrying clip_span_s know their exact span.
export const CLIP_PRE_S = 90
export const CLIP_POST_S = 8
export const LEGACY_CLIP_MAX_S = 300

/**
 * Whether the review clip ends before the episode does (the 300s cap once
 * ended 1.6s before a mega-episode's 3rd goal — the reviewer needs to know
 * the tail is cut and stamp later goals by typed match time). Returns the
 * clip's end on the match clock, or null when the clip covers the episode.
 * clipSpanS null = pre-adaptive row: its clip was cut at the legacy fixed
 * cap, so the legacy formula reproduces its span exactly. 0.5s tolerance
 * absorbs the producer's 0.1s duration rounding.
 */
export function clipTruncation(cand: {
  t0S: number
  t1S: number
  clipSpanS: number | null
}): { clipEndS: number } | null {
  const start = Math.max(0, cand.t0S - CLIP_PRE_S)
  const windowS = cand.t1S - start + CLIP_POST_S
  const span = cand.clipSpanS ?? Math.min(windowS, LEGACY_CLIP_MAX_S)
  if (span + 0.5 >= windowS) return null
  return { clipEndS: start + span }
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
