// Cleanup of "entry-without-content" share-copies for the LYL Veo sync.
//
// Finds empty away-folder share-copies (via audit.ts), deletes them in Veo,
// and re-arms the originating assignment so the next cron run re-shares once
// the source is content-ready (the orchestrator gate enforces readiness).
//
// Reused by:
//   - the standalone sweep script (scripts/audit-lyl-empty-copies.ts), and
//   - the Lambda 'cleanup' action (infrastructure/lambda/lyl-sync).
//
// Infra constraints (per cloud-infrastructure-optimizer review 2026-05-31):
//   - The delete sweep issues N sequential Veo mutations through one cached
//     Playwright session. A wall-clock DEADLINE guard stops the sweep before
//     the Lambda's 600s wall so a long sweep reports cleanly instead of
//     crashing with no summary.
//   - Each delete is isolated in its own try/catch so one failed/403/404
//     delete can't abort the remaining cleanups.

import type { SupabaseClient } from '@supabase/supabase-js'
import { auditRecordingContent, type AuditResult } from './audit'
import { listAssignments, resetAwayAssignment } from './db'
import type { VeoClientSurface } from './orchestrator'

/** Subset of the Veo client surface the cleanup needs. */
export type CleanupVeo = Pick<
  VeoClientSurface,
  'listRecordings' | 'deleteRecording' | 'getRecordingContent'
>

export interface CleanupInput {
  leagueClubSlug: string
  /** Veo's club slug (e.g. 'london-youth-league') — share-copies are
   *  prefixed with it. Defaults to leagueClubSlug. */
  veoClubSlug?: string
  /** When false (default), report only — do not delete or reset anything. */
  apply?: boolean
  /** Wall-clock budget for the delete sweep in ms. The sweep stops issuing
   *  deletes once exceeded and reports the rest as skipped. Defaults to 7min
   *  — under the Lambda 600s wall with margin for one in-flight delete +
   *  Chromium teardown (per cloud-infra review). */
  deadlineMs?: number
  /** Minimum age (ms) a copy's away-share must have before it's eligible for
   *  deletion. Guards against deleting a freshly-created healthy copy whose
   *  thumbnail is still rendering (a transient empty-thumbnail). Defaults to
   *  2h. Copies with no recorded away_assigned_at (orphans) are only eligible
   *  when minAgeMs is 0 (explicit operator override). */
  minAgeMs?: number
  /** Refuse to delete if the audit flags MORE than this many empty copies —
   *  a circuit breaker against a misfiring audit (e.g. a Veo outage returning
   *  empty thumbnails for everything) triggering mass deletion. Defaults to 25. */
  maxDeletes?: number
  /** Scope the delete to a single copy slug (endpoint-validation / surgical
   *  fix). When set, only that copy is considered and the maxDeletes circuit
   *  breaker is bypassed (the scope is already one). */
  onlyCopySlug?: string
  /** Also probe ORIGINALS for missing footage (report-only — never deleted).
   *  Expensive (one probe per original), so off by default; the standalone
   *  audit script turns it on. */
  probeOriginals?: boolean
  /** Injectable clock for tests/determinism. Defaults to Date.now. */
  now?: () => number
}

export interface CleanupDeps {
  supabase: SupabaseClient
  veo: CleanupVeo
}

export interface CleanupResult {
  audit: AuditResult
  /** Empty copies successfully deleted + reset. */
  cleaned: Array<{ copySlug: string; originalRecordingSlug: string | null }>
  /** Empty copies that errored (left in place for the next sweep). */
  failed: Array<{ copySlug: string; error: string }>
  /** Empty copies not attempted because the deadline was hit. */
  skippedDueToDeadline: string[]
  /** Empty copies skipped because they're too new (within the grace window)
   *  or orphaned with no recorded age — not eligible for destructive delete. */
  skippedNotEligible: Array<{ copySlug: string; reason: string }>
  /** True when the sweep refused to run because emptyShareCopies exceeded
   *  maxDeletes — nothing was deleted; a human must investigate. */
  abortedTooMany: boolean
  applied: boolean
}

export async function runContentCleanup(
  input: CleanupInput,
  deps: CleanupDeps
): Promise<CleanupResult> {
  const veoClubSlug = input.veoClubSlug ?? input.leagueClubSlug
  const apply = input.apply ?? false
  const deadlineMs = input.deadlineMs ?? 7 * 60 * 1000
  const minAgeMs = input.minAgeMs ?? 2 * 60 * 60 * 1000
  const maxDeletes = input.maxDeletes ?? 25
  const now = input.now ?? (() => Date.now())
  const start = now()

  const recordings = await deps.veo.listRecordings(input.leagueClubSlug)
  const assignments = await listAssignments(deps.supabase, input.leagueClubSlug)
  const audit = await auditRecordingContent(
    recordings,
    veoClubSlug,
    assignments,
    deps.veo.getRecordingContent,
    { probeOriginals: input.probeOriginals }
  )

  const cleaned: CleanupResult['cleaned'] = []
  const failed: CleanupResult['failed'] = []
  const skippedDueToDeadline: string[] = []
  const skippedNotEligible: CleanupResult['skippedNotEligible'] = []
  let abortedTooMany = false

  // Targets for the delete sweep — full set, or a single scoped copy.
  const targets = input.onlyCopySlug
    ? audit.emptyShareCopies.filter((c) => c.copySlug === input.onlyCopySlug)
    : audit.emptyShareCopies

  if (apply) {
    // Circuit breaker: a misfiring audit (e.g. a Veo outage returning empty
    // thumbnails for everything) must not trigger mass deletion. Refuse the
    // whole sweep and surface it for a human. Bypassed when a single copy is
    // explicitly scoped (the scope is already one).
    if (!input.onlyCopySlug && targets.length > maxDeletes) {
      abortedTooMany = true
      return {
        audit,
        cleaned,
        failed,
        skippedDueToDeadline,
        skippedNotEligible,
        abortedTooMany,
        applied: apply,
      }
    }

    for (const copy of targets) {
      // Deadline guard — stop before the Lambda wall; report the remainder.
      if (now() - start > deadlineMs) {
        skippedDueToDeadline.push(copy.copySlug)
        continue
      }
      // Grace window — never delete a copy that was just created; its
      // thumbnail may still be rendering (a transient empty state, not a
      // permanently-broken copy). Orphans (no recorded age) are only
      // eligible under an explicit minAgeMs=0 operator override.
      if (!isEligibleForDelete(copy.originalAwayAssignedAt, minAgeMs, now())) {
        skippedNotEligible.push({
          copySlug: copy.copySlug,
          reason: copy.originalAwayAssignedAt
            ? `within ${Math.round(minAgeMs / 60000)}min grace window`
            : 'orphan copy (no recorded age) — needs operator override (minAgeMs=0)',
        })
        continue
      }
      // Per-item isolation — one bad delete must not abort the sweep.
      try {
        await deps.veo.deleteRecording(copy.copySlug)
        // Re-arm the originating assignment so the next cron re-shares once
        // the source is ready. Skip when we couldn't tie the copy to an
        // original (orphan) — there's nothing to reset.
        if (copy.originalRecordingSlug) {
          await resetAwayAssignment(
            deps.supabase,
            input.leagueClubSlug,
            copy.originalRecordingSlug
          )
        }
        cleaned.push({
          copySlug: copy.copySlug,
          originalRecordingSlug: copy.originalRecordingSlug,
        })
      } catch (err) {
        failed.push({
          copySlug: copy.copySlug,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  return {
    audit,
    cleaned,
    failed,
    skippedDueToDeadline,
    skippedNotEligible,
    abortedTooMany,
    applied: apply,
  }
}

/** A copy is eligible for destructive delete only when its away-share is older
 *  than the grace window. Orphans (no recorded away_assigned_at) are eligible
 *  only when the operator explicitly drops the window to 0. */
function isEligibleForDelete(
  awayAssignedAt: string | null,
  minAgeMs: number,
  nowMs: number
): boolean {
  if (minAgeMs <= 0) return true
  if (!awayAssignedAt) return false
  const t = Date.parse(awayAssignedAt)
  if (Number.isNaN(t)) return false
  return nowMs - t >= minAgeMs
}
