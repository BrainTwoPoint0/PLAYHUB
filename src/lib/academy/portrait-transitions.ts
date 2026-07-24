// The portrait-render review state machine, as data.
//
// Extracted from the PATCH route so it can be tested directly: the route body is
// auth + CAS plumbing, but the *table* is where the invariants live, and an
// asymmetry between two rows here is invisible until it corrupts a row in prod.
//
// Statuses: draft | approved | rejected | error | published (legacy, no writer).
// `error` rows are terminal — the sweep owns their retry budget — so they are not
// reviewable, which keeps restore's target unambiguous (a restored row always has
// a storage object behind it).

/** Columns cleared whenever a row stops being approved. */
const CLEAR_APPROVAL = { approved_at: null, approved_by: null } as const

export interface Transition {
  from: string[]
  to: string
  /** Extra columns to write with the status flip. */
  extra?: (userId: string, now: string) => Record<string, unknown>
}

// "Good enough" is the terminal review action — approving judges QUALITY only and
// does NOT distribute (these are minors' clips; posting is a separate, manual act).
//
// Approving a draft also freezes it: the Batch writer only touches draft/error, so a
// later pipeline run will not silently re-render an approved clip. `unapprove` is the
// escape hatch. `approved` is reachable only from an UNEDITED draft, which is what
// makes the label honest — an admin who had to edit never approves.
//
// INVARIANT: every transition whose target is not 'approved' must clear the approval
// stamp. A row that says draft/rejected while carrying an approver is an audit lie,
// and the library index sorts NULLs first so it is not merely cosmetic. Enforced in
// the DB by playhub_portrait_renders_approval_pairing, and pinned by tests here.
export const TRANSITIONS: Record<string, Transition> = {
  approve: {
    from: ['draft'],
    to: 'approved',
    extra: (userId, now) => ({ approved_at: now, approved_by: userId }),
  },
  unapprove: {
    from: ['approved'],
    to: 'draft',
    extra: () => ({ ...CLEAR_APPROVAL }),
  },
  reject: {
    from: ['draft', 'approved'],
    to: 'rejected',
    extra: () => ({ ...CLEAR_APPROVAL }),
  },
  restore: {
    from: ['rejected'],
    to: 'draft',
    extra: () => ({ ...CLEAR_APPROVAL }),
  },
}

/**
 * Review verdicts that are also training labels. The verdict IS the label:
 * approve = the auto-detection passed (a "good enough" draft is unedited by
 * definition), reject = it failed.
 */
export const LABEL_FOR: Record<string, 'accepted' | 'rejected'> = {
  approve: 'accepted',
  reject: 'rejected',
}

/**
 * Own-property lookup. A bare index would resolve `constructor` / `toString` to an
 * inherited function, sail past a truthiness guard, and blow up downstream on
 * `transition.from`.
 */
export function resolveTransition(action: unknown): Transition | undefined {
  const key = String(action)
  return Object.hasOwn(TRANSITIONS, key) ? TRANSITIONS[key] : undefined
}

export function labelForAction(
  action: unknown
): 'accepted' | 'rejected' | undefined {
  const key = String(action)
  return Object.hasOwn(LABEL_FOR, key) ? LABEL_FOR[key] : undefined
}
