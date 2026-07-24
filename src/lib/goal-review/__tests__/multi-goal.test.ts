import { describe, it, expect } from 'vitest'
import {
  parseReviewBody,
  resolveEventStamp,
  nextPrimaryEventId,
  parseClockInput,
  EVENT_OFFSET_S,
  subAnchorHints,
  findNearbyStamp,
  matchCycleAnchor,
  clipTruncation,
  resolveAddGoalGuard,
  resolveApproveGuard,
  HINT_SUPPRESS_S,
} from '../multi-goal'

const EVENT_A = '11111111-1111-4111-8111-111111111111'
const EVENT_B = '22222222-2222-4222-8222-222222222222'
const EVENT_C = '33333333-3333-4333-8333-333333333333'

describe('parseReviewBody', () => {
  it('accepts approve without a timestamp (legacy anchor-offset path)', () => {
    const r = parseReviewBody({ action: 'approve' })
    expect(r).toEqual({
      ok: true,
      parsed: { action: 'approve', timestampSeconds: null },
    })
  })

  it('accepts approve with a human timestamp', () => {
    const r = parseReviewBody({ action: 'approve', timestampSeconds: 1122.4 })
    expect(r).toEqual({
      ok: true,
      parsed: { action: 'approve', timestampSeconds: 1122.4 },
    })
  })

  it('rejects approve with a non-finite, negative, or absurd timestamp', () => {
    for (const bad of [NaN, Infinity, -1, 1e300, 86_401, '1122', {}, []]) {
      const r = parseReviewBody({ action: 'approve', timestampSeconds: bad })
      expect(r.ok).toBe(false)
    }
  })

  it('requires a timestamp on add_goal', () => {
    expect(parseReviewBody({ action: 'add_goal' }).ok).toBe(false)
    expect(
      parseReviewBody({ action: 'add_goal', timestampSeconds: 1353 })
    ).toEqual({
      ok: true,
      parsed: { action: 'add_goal', timestampSeconds: 1353, estimate: false },
    })
  })

  it('accepts timestamp 0 (goal at the very start of the match)', () => {
    expect(
      parseReviewBody({ action: 'add_goal', timestampSeconds: 0 })
    ).toEqual({
      ok: true,
      parsed: { action: 'add_goal', timestampSeconds: 0, estimate: false },
    })
  })

  it('requires a UUID eventId on remove_event', () => {
    expect(parseReviewBody({ action: 'remove_event' }).ok).toBe(false)
    expect(
      parseReviewBody({ action: 'remove_event', eventId: 'not-a-uuid' }).ok
    ).toBe(false)
    expect(
      parseReviewBody({ action: 'remove_event', eventId: EVENT_A })
    ).toEqual({
      ok: true,
      parsed: { action: 'remove_event', eventId: EVENT_A },
    })
  })

  it('accepts the bare transitions', () => {
    for (const action of ['unapprove', 'reject', 'restore'] as const) {
      expect(parseReviewBody({ action })).toEqual({
        ok: true,
        parsed: { action },
      })
    }
  })

  it('rejects unknown actions, prototype keys, and non-object bodies', () => {
    expect(parseReviewBody({ action: 'delete_all' }).ok).toBe(false)
    expect(parseReviewBody({ action: 'toString' }).ok).toBe(false)
    expect(parseReviewBody({ action: '__proto__' }).ok).toBe(false)
    expect(parseReviewBody(null).ok).toBe(false)
    expect(parseReviewBody('approve').ok).toBe(false)
    expect(parseReviewBody(undefined).ok).toBe(false)
  })
})

describe('resolveEventStamp', () => {
  it('defaults to anchor minus the measured goal->kickoff offset', () => {
    expect(resolveEventStamp(1134, null)).toEqual({
      timestampSeconds: 1134 - EVENT_OFFSET_S,
      stampSource: 'anchor_offset',
    })
  })

  it('clamps the anchor-offset stamp at 0 for early anchors', () => {
    expect(resolveEventStamp(5, null)).toEqual({
      timestampSeconds: 0,
      stampSource: 'anchor_offset',
    })
  })

  it('uses the human timestamp verbatim when provided', () => {
    expect(resolveEventStamp(1134, 1353.5)).toEqual({
      timestampSeconds: 1353.5,
      stampSource: 'human_scrub',
    })
  })

  it('a human stamp of 0 is a real stamp, not a missing one', () => {
    expect(resolveEventStamp(1134, 0)).toEqual({
      timestampSeconds: 0,
      stampSource: 'human_scrub',
    })
  })
})

describe('parseClockInput', () => {
  it('parses mm:ss match clock', () => {
    expect(parseClockInput('22:33')).toBe(22 * 60 + 33)
    expect(parseClockInput(' 26:46 ')).toBe(26 * 60 + 46)
    expect(parseClockInput('0:05')).toBe(5)
    expect(parseClockInput('105:07')).toBe(105 * 60 + 7)
  })

  it('parses h:mm:ss and bare seconds', () => {
    expect(parseClockInput('1:02:03')).toBe(3723)
    expect(parseClockInput('1353')).toBe(1353)
  })

  it('rejects malformed or out-of-range input', () => {
    for (const bad of [
      '',
      '22:73',
      '1:2',
      'abc',
      '-5',
      '12:',
      ':30',
      '999999',
    ]) {
      expect(parseClockInput(bad)).toBeNull()
    }
  })
})

describe('nextPrimaryEventId', () => {
  const links = (...ids: string[]) =>
    ids.map((eventId, i) => ({
      eventId,
      createdAt: `2026-07-22T10:0${i}:00Z`,
    }))

  it('returns null when no events remain (candidate flips to draft)', () => {
    expect(nextPrimaryEventId([], EVENT_A, EVENT_A)).toBeNull()
  })

  it('keeps the current primary when a sibling was removed', () => {
    expect(nextPrimaryEventId(links(EVENT_A, EVENT_C), EVENT_A, EVENT_B)).toBe(
      EVENT_A
    )
  })

  it('repoints to the earliest remaining link when the primary was removed', () => {
    expect(nextPrimaryEventId(links(EVENT_B, EVENT_C), EVENT_A, EVENT_A)).toBe(
      EVENT_B
    )
  })

  it('repairs a stale primary that is not among the remaining links', () => {
    // Repair-state compat: approved_event_id must always point at a live
    // linked event while the candidate stays approved.
    expect(nextPrimaryEventId(links(EVENT_C), EVENT_A, EVENT_B)).toBe(EVENT_C)
  })

  it('repoints deterministically on created_at ties', () => {
    const tied = [
      { eventId: EVENT_C, createdAt: '2026-07-22T10:00:00Z' },
      { eventId: EVENT_B, createdAt: '2026-07-22T10:00:00Z' },
    ]
    expect(nextPrimaryEventId(tied, EVENT_A, EVENT_A)).toBe(EVENT_B)
  })

  it('handles a null current primary (legacy repair state)', () => {
    expect(nextPrimaryEventId(links(EVENT_B), null, EVENT_A)).toBe(EVENT_B)
  })
})

describe('subAnchorHints', () => {
  const hint = (s: number) => Math.max(0, s - EVENT_OFFSET_S)

  it('returns no hints for null, empty, or single-cycle cards (single-goal cards look like today)', () => {
    expect(subAnchorHints(null, [])).toEqual([])
    expect(subAnchorHints(undefined, [])).toEqual([])
    expect(subAnchorHints([], [])).toEqual([])
    expect(subAnchorHints([1134], [])).toEqual([])
  })

  it('offers one estimate per sub-anchor on a flurry card, at sub_anchor - 20', () => {
    expect(subAnchorHints([1134, 1371, 1628], [])).toEqual([
      hint(1134),
      hint(1371),
      hint(1628),
    ])
  })

  it('clamps early estimates at 0', () => {
    expect(subAnchorHints([10, 100], [])).toEqual([0, hint(100)])
  })

  it('suppresses a hint once a linked event is stamped near it', () => {
    // reviewer clicked the 1371 hint -> event at 1351; that hint disappears,
    // the others stay offered
    expect(
      subAnchorHints([1134, 1371, 1628], [{ stampSeconds: 1351 }])
    ).toEqual([hint(1134), hint(1628)])
  })

  it('suppresses on a human stamp near the estimate, not only exact matches', () => {
    expect(
      subAnchorHints([1134, 1371, 1628], [{ stampSeconds: 1345 }])
    ).toEqual([hint(1134), hint(1628)])
  })

  it('ignores null event stamps and keeps all hints', () => {
    expect(subAnchorHints([1134, 1371], [{ stampSeconds: null }])).toEqual([
      hint(1134),
      hint(1371),
    ])
  })

  it('dedupes estimates that clamp to the same value (one chip per offer)', () => {
    expect(subAnchorHints([5, 12, 300], [])).toEqual([0, hint(300)])
  })

  it('suppresses at exactly the radius boundary and offers just past it', () => {
    // estimate 1351; stamp at 1361 (=radius) suppresses, 1361.5 does not
    expect(subAnchorHints([1134, 1371], [{ stampSeconds: 1361 }])).toEqual([
      hint(1134),
    ])
    expect(subAnchorHints([1134, 1371], [{ stampSeconds: 1361.5 }])).toEqual([
      hint(1134),
      hint(1371),
    ])
  })

  it('drops non-finite, negative, and beyond-match-clock sub-anchors defensively', () => {
    expect(subAnchorHints([Number.NaN, -5, 1e12, 1134, 1371], [])).toEqual([
      hint(1134),
      hint(1371),
    ])
  })

  it('suppresses a hint stamped from ANOTHER card of the recording (cross-card duplicate pattern)', () => {
    // Overlapping 90s pre-rolls put the same goal on adjacent cards: a
    // marker stamped on the neighbour must suppress this card's hint too.
    expect(subAnchorHints([1134, 1371, 1628], [], [1351])).toEqual([
      hint(1134),
      hint(1628),
    ])
  })

  it('cross-card stamps just past the radius do not suppress', () => {
    expect(
      subAnchorHints([1134, 1371], [], [1351 + HINT_SUPPRESS_S + 0.5])
    ).toEqual([hint(1134), hint(1371)])
  })

  it('own-card and cross-card stamps combine', () => {
    expect(
      subAnchorHints([1134, 1371, 1628], [{ stampSeconds: 1114 }], [1608])
    ).toEqual([hint(1371)])
  })
})

describe('findNearbyStamp (cross-card ±10s guard)', () => {
  it('returns null when no stamp is within the radius', () => {
    expect(findNearbyStamp([], 1000)).toBeNull()
    expect(findNearbyStamp([1011, 989], 1000.5)).toBeNull()
  })

  it('returns the nearest stamp within the radius', () => {
    expect(findNearbyStamp([980, 1004, 1009], 1000)).toBe(1004)
  })

  it('includes the radius boundary itself', () => {
    expect(findNearbyStamp([1010], 1000)).toBe(1010)
    expect(findNearbyStamp([1010.5], 1000)).toBeNull()
  })

  it('ignores non-finite stamps defensively', () => {
    expect(findNearbyStamp([Number.NaN, Infinity], 1000)).toBeNull()
  })
})

describe('resolveAddGoalGuard (warn-then-confirm state machine)', () => {
  const stamps = [
    { candId: 'A', ts: 1000 },
    { candId: 'B', ts: 2000 },
  ]

  it('proceeds when nothing is within the radius', () => {
    expect(resolveAddGoalGuard(stamps, null, 'A', 1500)).toEqual({
      kind: 'proceed',
    })
  })

  it('warns on a cross-card conflict with the conflicting stamp', () => {
    expect(resolveAddGoalGuard(stamps, null, 'A', 2005)).toEqual({
      kind: 'warn',
      conflictTs: 2000,
    })
  })

  it('warns on a near-but-not-equal OWN-card conflict', () => {
    expect(resolveAddGoalGuard(stamps, null, 'A', 1004)).toEqual({
      kind: 'warn',
      conflictTs: 1000,
    })
  })

  it('exact own-card equality proceeds silently (server converges it)', () => {
    expect(resolveAddGoalGuard(stamps, null, 'A', 1000)).toEqual({
      kind: 'proceed',
    })
  })

  it('a pending warn for the same card within the radius confirms', () => {
    expect(
      resolveAddGoalGuard(stamps, { candId: 'A', ts: 2005 }, 'A', 2008)
    ).toEqual({ kind: 'proceed' })
  })

  it('a pending warn for a DIFFERENT card does not confirm', () => {
    expect(
      resolveAddGoalGuard(stamps, { candId: 'B', ts: 2005 }, 'A', 2005)
    ).toEqual({ kind: 'warn', conflictTs: 2000 })
  })

  it('a pending warn beyond the radius re-warns instead of confirming', () => {
    expect(
      resolveAddGoalGuard(stamps, { candId: 'A', ts: 1950 }, 'A', 2005)
    ).toEqual({ kind: 'warn', conflictTs: 2000 })
  })
})

describe('resolveApproveGuard (bare-approve default marker guard)', () => {
  // Bare approve mints anchor − EVENT_OFFSET_S server-side; the guard must
  // see THAT ts, not the anchor (the measured duplicates were an overlap
  // card's default landing 0.3–1.0s from a neighbouring card's stamp).
  const stamps = [{ candId: 'A', ts: 1000 }]

  it('proceeds when the default stamp is clear of every marker', () => {
    const r = resolveApproveGuard(stamps, null, 'B', 2020)
    expect(r).toEqual({ decision: { kind: 'proceed' }, defaultTs: 2000 })
  })

  it('warns when the DEFAULT (anchor−20), not the anchor, hits a cross-card stamp', () => {
    // anchor 1020.5 → default 1000.5, 0.5s from A's marker; the anchor
    // itself is 20.5s away and would sail past an anchor-based check.
    const r = resolveApproveGuard(stamps, null, 'B', 1020.5)
    expect(r).toEqual({
      decision: { kind: 'warn', conflictTs: 1000 },
      defaultTs: 1000.5,
    })
  })

  it('a second Approve on the same card confirms (pending at the default ts)', () => {
    const r = resolveApproveGuard(
      stamps,
      { candId: 'B', ts: 1000.5 },
      'B',
      1020.5
    )
    expect(r.decision).toEqual({ kind: 'proceed' })
  })

  it('a pending warn for a different card does not confirm', () => {
    const r = resolveApproveGuard(
      stamps,
      { candId: 'C', ts: 1000.5 },
      'B',
      1020.5
    )
    expect(r.decision).toEqual({ kind: 'warn', conflictTs: 1000 })
  })

  it('clamps an early anchor to a non-negative default', () => {
    const r = resolveApproveGuard([], null, 'B', 5)
    expect(r).toEqual({ decision: { kind: 'proceed' }, defaultTs: 0 })
  })
})

describe('matchCycleAnchor', () => {
  it('matches the stored sub-anchor for a round-tripped client value', () => {
    expect(matchCycleAnchor([1134.56, 1371.02], 1134.56)).toBe(1134.56)
  })

  it('tolerates sub-centisecond float noise but nothing more', () => {
    expect(matchCycleAnchor([1134.56], 1134.5601)).toBe(1134.56)
    expect(matchCycleAnchor([1134.56], 1134.6)).toBeNull()
  })

  it('returns null on null/empty lists and non-members', () => {
    expect(matchCycleAnchor(null, 1134.56)).toBeNull()
    expect(matchCycleAnchor([], 1134.56)).toBeNull()
    expect(matchCycleAnchor([100, 200], 150)).toBeNull()
  })
})

describe('clipTruncation', () => {
  it('legacy row (null span), short episode: not truncated', () => {
    // window = 90 + (t1-t0) + 8 <= 300 — the legacy producer covered it all
    expect(clipTruncation({ t0S: 1000, t1S: 1100, clipSpanS: null })).toBeNull()
  })

  it('legacy row (null span), long episode: truncated at the fixed 300s cap', () => {
    const r = clipTruncation({ t0S: 1000, t1S: 1400, clipSpanS: null })
    // clip start 910, legacy cap 300 -> clip ends at 1210, episode runs on
    expect(r).toEqual({ clipEndS: 1210 })
  })

  it('adaptive row whose span covers the full window: not truncated', () => {
    // window = 90 + 252 + 8 = 350, extended tier covers it
    expect(clipTruncation({ t0S: 1000, t1S: 1252, clipSpanS: 350 })).toBeNull()
  })

  it('adaptive row capped at 480 on a mega-episode: truncated with the exact end', () => {
    const r = clipTruncation({ t0S: 1000, t1S: 1700, clipSpanS: 480 })
    expect(r).toEqual({ clipEndS: 910 + 480 })
  })

  it('clamps the clip start at 0 near kickoff', () => {
    // start clamps to 0 -> window = t1 + 8
    expect(clipTruncation({ t0S: 30, t1S: 290, clipSpanS: 298 })).toBeNull()
    const r = clipTruncation({ t0S: 30, t1S: 600, clipSpanS: 300 })
    expect(r).toEqual({ clipEndS: 300 })
  })

  it('tolerates sub-0.5s encode rounding without flagging', () => {
    // producer rounds dur to 0.1s — a 0.4s shortfall is rounding, not a cut
    expect(
      clipTruncation({ t0S: 1000, t1S: 1252, clipSpanS: 349.6 })
    ).toBeNull()
  })
})

describe('cycle_verdict parsing', () => {
  it('accepts goal / no_goal / null (clear) verdicts', () => {
    for (const verdict of ['goal', 'no_goal', null] as const) {
      expect(
        parseReviewBody({
          action: 'cycle_verdict',
          cycleAnchorS: 1134.56,
          verdict,
        })
      ).toEqual({
        ok: true,
        parsed: { action: 'cycle_verdict', cycleAnchorS: 1134.56, verdict },
      })
    }
  })

  it('rejects bad anchors and unknown verdicts', () => {
    for (const bad of [NaN, Infinity, -1, 1e300, '1134', undefined]) {
      expect(
        parseReviewBody({
          action: 'cycle_verdict',
          cycleAnchorS: bad,
          verdict: 'goal',
        }).ok
      ).toBe(false)
    }
    for (const bad of ['yes', true, 1, {}, undefined]) {
      expect(
        parseReviewBody({
          action: 'cycle_verdict',
          cycleAnchorS: 1134.56,
          verdict: bad,
        }).ok
      ).toBe(false)
    }
  })
})

describe('add_goal estimate flag', () => {
  it('defaults estimate to false when absent', () => {
    const r = parseReviewBody({ action: 'add_goal', timestampSeconds: 100 })
    expect(r).toEqual({
      ok: true,
      parsed: { action: 'add_goal', timestampSeconds: 100, estimate: false },
    })
  })

  it('accepts estimate: true (hint-chip stamps)', () => {
    const r = parseReviewBody({
      action: 'add_goal',
      timestampSeconds: 100,
      estimate: true,
    })
    expect(r).toEqual({
      ok: true,
      parsed: { action: 'add_goal', timestampSeconds: 100, estimate: true },
    })
  })

  it('rejects a non-boolean estimate', () => {
    const r = parseReviewBody({
      action: 'add_goal',
      timestampSeconds: 100,
      estimate: 'yes',
    })
    expect(r.ok).toBe(false)
  })

  it('resolveEventStamp records an estimate stamp as anchor_offset with the given time', () => {
    expect(resolveEventStamp(1134, 1351, true)).toEqual({
      timestampSeconds: 1351,
      stampSource: 'anchor_offset',
    })
    // human scrub unchanged
    expect(resolveEventStamp(1134, 1351, false)).toEqual({
      timestampSeconds: 1351,
      stampSource: 'human_scrub',
    })
  })
})
