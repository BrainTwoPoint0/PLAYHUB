import { describe, it, expect } from 'vitest'
import {
  TRANSITIONS,
  LABEL_FOR,
  resolveTransition,
  labelForAction,
} from '../portrait-transitions'

/** The status CHECK constraint's vocabulary, mirrored from the migration. */
const STATUSES = ['draft', 'approved', 'rejected', 'error', 'published']

describe('portrait review transitions', () => {
  it('only targets statuses the DB CHECK allows', () => {
    // A target outside this set is rejected by Postgres at write time — i.e. a
    // 500 on an admin's click, discovered in production.
    for (const [action, t] of Object.entries(TRANSITIONS)) {
      expect(STATUSES, `${action} → ${t.to}`).toContain(t.to)
      for (const from of t.from) expect(STATUSES, `${action} from`).toContain(from)
    }
  })

  it('clears the approval stamp on EVERY transition that is not an approval', () => {
    // The bug this pins: reject and restore originally carried no `extra`, so
    // approve → reject left approved_at/approved_by on a row its reviewer threw
    // out, and approve → reject → restore produced a re-renderable draft still
    // claiming an approver. The DB pairing constraint would now reject that write.
    for (const [action, t] of Object.entries(TRANSITIONS)) {
      if (t.to === 'approved') continue
      const written = t.extra?.('user-1', '2026-07-22T00:00:00.000Z') ?? {}
      expect(written, `${action} must null approved_at`).toMatchObject({
        approved_at: null,
        approved_by: null,
      })
    }
  })

  it('approve stamps both columns from the caller-supplied clock', () => {
    const now = '2026-07-22T00:00:00.000Z'
    expect(TRANSITIONS.approve.extra?.('user-1', now)).toEqual({
      approved_at: now,
      approved_by: 'user-1',
    })
  })

  it('never writes status or updated_at from a transition', () => {
    // The route spreads `extra` BEFORE the fixed keys so these can't be shadowed;
    // this asserts the table never tries, so the ordering stays a belt not a brace.
    for (const [action, t] of Object.entries(TRANSITIONS)) {
      const written = t.extra?.('user-1', 'now') ?? {}
      expect(Object.keys(written), action).not.toContain('status')
      expect(Object.keys(written), action).not.toContain('updated_at')
    }
  })

  it('a transition never returns a shared mutable object', () => {
    // Two calls must not hand back the same reference — a caller mutating the
    // update payload would otherwise poison every later transition in the process.
    const a = TRANSITIONS.reject.extra?.('u', 'n')
    const b = TRANSITIONS.reject.extra?.('u', 'n')
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })

  it('error rows are not reviewable from any action', () => {
    // Terminal by design (the sweep owns the retry budget). The strip must not
    // offer Reject on an error row — the route would always 409.
    for (const [action, t] of Object.entries(TRANSITIONS)) {
      expect(t.from, `${action} must not accept error`).not.toContain('error')
    }
  })

  it('does not resolve inherited Object properties as actions', () => {
    // `TRANSITIONS[String(action)]` would return a function for these, pass a
    // truthiness guard, and throw on `.from` — a 500 from any authenticated caller.
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(resolveTransition(key), key).toBeUndefined()
      expect(labelForAction(key), key).toBeUndefined()
    }
    expect(resolveTransition('approve')).toBe(TRANSITIONS.approve)
    expect(resolveTransition(undefined)).toBeUndefined()
  })

  it('every labelled action is a real transition', () => {
    // A label with no transition would write a training row for a verdict the
    // state machine cannot reach.
    for (const action of Object.keys(LABEL_FOR)) {
      expect(TRANSITIONS, action).toHaveProperty(action)
    }
    expect(labelForAction('approve')).toBe('accepted')
    expect(labelForAction('reject')).toBe('rejected')
    // Undoing a verdict must NOT write one — the corpus is append-only, so a
    // label written here could never be retracted.
    expect(labelForAction('unapprove')).toBeUndefined()
    expect(labelForAction('restore')).toBeUndefined()
  })

  it('the reachable state graph has no dead end besides error', () => {
    // Every non-terminal status a transition can produce must have a way out,
    // or an admin can strand a clip in a state with no affordance.
    const targets = new Set(Object.values(TRANSITIONS).map((t) => t.to))
    for (const status of targets) {
      const escapes = Object.values(TRANSITIONS).filter((t) =>
        t.from.includes(status)
      )
      expect(escapes.length, `${status} has no exit`).toBeGreaterThan(0)
    }
  })
})
