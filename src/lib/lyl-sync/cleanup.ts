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
  | 'listRecordings'
  | 'deleteRecording'
  | 'getRecordingContent'
  | 'getRecordingCamera'
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
  /** Empty copies whose DELETE errored (left in place — safe to retry). */
  failed: Array<{ copySlug: string; error: string }>
  /** Copies that WERE deleted in Veo but whose originating row could not be
   *  re-armed (resetAwayAssignment threw). The away folder is now empty and
   *  the row still reads fully_assigned, so the cron WON'T re-share — a human
   *  must re-arm it. Surfaced loudly + distinctly from `failed` (which is
   *  retry-safe) because this state does NOT self-heal. */
  deletedButNotReset: Array<{
    copySlug: string
    originalRecordingSlug: string | null
    error: string
  }>
  /** Copies the final live camera-check refused to delete because a camera was
   *  set (it's an ORIGINAL, or we couldn't confirm it isn't). Hard safety stop:
   *  we NEVER delete a recording with a camera. Should be empty in practice
   *  (the audit already excludes camera-bearing recordings) — a non-empty list
   *  means something upstream misclassified and is worth investigating. */
  refusedHasCamera: string[]
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
  const deletedButNotReset: CleanupResult['deletedButNotReset'] = []
  const refusedHasCamera: string[] = []
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
        deletedButNotReset,
        refusedHasCamera,
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
      // FINAL SAFETY GUARD (authoritative, live): never delete a recording
      // that has a camera set — that's an ORIGINAL / master footage. The audit
      // already excludes camera-bearing recordings, but we re-read it fresh
      // right before the irreversible delete. If the camera is set, OR we
      // can't confirm it's unset (probe error → throws), REFUSE.
      try {
        const camera = await deps.veo.getRecordingCamera(copy.copySlug)
        if (camera) {
          refusedHasCamera.push(copy.copySlug)
          continue
        }
      } catch {
        // Couldn't confirm camera is unset → fail safe, do not delete.
        refusedHasCamera.push(copy.copySlug)
        continue
      }
      // Per-item isolation — one bad delete must not abort the sweep.
      // Delete first, then re-arm. These are NOT atomic, so split the two
      // failure modes: a failed DELETE is retry-safe (copy still there); a
      // delete that SUCCEEDS but whose reset throws strands the row (copy gone,
      // row still fully_assigned → cron never re-shares) and needs a human.
      try {
        await deps.veo.deleteRecording(copy.copySlug)
      } catch (err) {
        failed.push({
          copySlug: copy.copySlug,
          error: err instanceof Error ? err.message : String(err),
        })
        continue
      }
      // Delete succeeded. Re-arm the originating assignment so the next cron
      // re-shares once the source is ready. Orphans (no tied original) have
      // nothing to reset.
      if (copy.originalRecordingSlug) {
        try {
          await resetAwayAssignment(
            deps.supabase,
            input.leagueClubSlug,
            copy.originalRecordingSlug
          )
        } catch (err) {
          deletedButNotReset.push({
            copySlug: copy.copySlug,
            originalRecordingSlug: copy.originalRecordingSlug,
            error: err instanceof Error ? err.message : String(err),
          })
          continue
        }
      }
      cleaned.push({
        copySlug: copy.copySlug,
        originalRecordingSlug: copy.originalRecordingSlug,
      })
    }
  }

  return {
    audit,
    cleaned,
    failed,
    deletedButNotReset,
    refusedHasCamera,
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
