import { describe, it, expect } from 'vitest'
import {
  parseReviewBody,
  resolveEventStamp,
  nextPrimaryEventId,
  parseClockInput,
  EVENT_OFFSET_S,
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
      parsed: { action: 'add_goal', timestampSeconds: 1353 },
    })
  })

  it('accepts timestamp 0 (goal at the very start of the match)', () => {
    expect(
      parseReviewBody({ action: 'add_goal', timestampSeconds: 0 })
    ).toEqual({ ok: true, parsed: { action: 'add_goal', timestampSeconds: 0 } })
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
