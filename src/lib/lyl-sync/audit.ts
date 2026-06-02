// Content audit for the LYL Veo recording-sync.
//
// Detects "entry-without-content" share-copies — away-folder copies that have
// no playable footage (created before the source finished uploading; they stay
// broken even after the source later processes, because the copy is a stale
// snapshot).
//
// GROUND TRUTH (confirmed empirically 2026-05-31): a recording's metadata
// (processing_status / thumbnail / duration / is_accessible) all read "ready"
// even for a broken copy — a share-copy inherits them from the parent. The ONLY
// reliable signal is whether the recording has real video segments + periods:
// healthy ≈ {videos:3, periods:2}; broken = {videos:0, periods:0}. So the audit
// probes content per share-copy via an injected async checker.

import type { VeoRecording } from './orchestrator'
import { hasNoContent } from './orchestrator'
import type { AssignmentRow } from './db'

/** A Veo share-copy entry that has no playable footage. These are the broken
 *  away-folder copies to clean up (delete in Veo + re-arm the away-share). */
export interface EmptyShareCopy {
  /** The share-copy's own slug (Veo prefixes it with the club's Veo slug). */
  copySlug: string
  title: string
  /** Real content counts that classified it empty (both 0). */
  videos: number
  periods: number
  /** The originating assignment row, matched via away_accepted_recording_uuid,
   *  if we can tie the copy back to one. null when we can't (orphan copy). */
  originalRecordingSlug: string | null
  /** When the away-share was recorded on the originating assignment. Drives the
   *  cleanup grace window. null for orphans / unrecorded. */
  originalAwayAssignedAt: string | null
}

/** A home_assigned row with no completed away-share yet — either deferred
 *  (source still has no footage, the gate is holding) or genuinely stuck.
 *  Derived from DB state only (no probe). */
export interface AwayPending {
  recordingSlug: string
  title: string
}

/** An ORIGINAL recording (not a share-copy) that has no footage — the camera
 *  upload failed or never completed. REPORT-ONLY: originals are master
 *  recordings and must NEVER be auto-deleted (the upload may still be pending
 *  or recoverable). Surfaced so a human can investigate. */
export interface EmptyOriginal {
  recordingSlug: string
  title: string
}

export interface AuditResult {
  emptyShareCopies: EmptyShareCopy[]
  awayPending: AwayPending[]
  /** Populated only when the caller opts in (probeOriginals) — probing every
   *  original is expensive, so the lean cron path skips it. */
  emptyOriginals: EmptyOriginal[]
}

/** Content checker — counts real video segments + periods for a recording. */
export type ContentChecker = (
  slug: string
) => Promise<{ videos: number; periods: number }>

/** True for Veo recordings that are themselves share-accepted copies (Veo
 *  prefixes the copy's slug with the recipient club's Veo slug). Kept local to
 *  keep this module free of orchestrator runtime imports. */
function isShareAcceptedCopy(slug: string, veoClubSlug: string): boolean {
  return slug.startsWith(`${veoClubSlug}-`)
}

/** True if the recording has a camera assigned — i.e. it's an ORIGINAL.
 *  Never a delete candidate. Veo reports "NOT SET" as null/empty. */
function hasCamera(r: VeoRecording): boolean {
  return typeof r.camera === 'string' && r.camera.length > 0
}

/**
 * Classify the current Veo recordings + our assignment rows.
 *
 * @param recordings   every recording Veo returned for the league.
 * @param veoClubSlug  Veo's club slug (e.g. 'london-youth-league').
 * @param assignments  our assignment rows for the league.
 * @param getContent    async probe → real {videos, periods} counts for a slug.
 *                      Only invoked for candidate share-copies (bounded cost).
 */
export async function auditRecordingContent(
  recordings: VeoRecording[],
  veoClubSlug: string,
  assignments: AssignmentRow[],
  getContent: ContentChecker,
  opts: { probeOriginals?: boolean; probeCopies?: boolean } = {}
): Promise<AuditResult> {
  // probeCopies defaults true (the on-demand cleanup/script path). The weekly
  // cron sets it false to skip ~1 probe-pair per share-copy — empty-copy
  // detection is an on-demand concern, and the gate already prevents new ones.
  const probeCopies = opts.probeCopies !== false
  // Tie a share-copy slug back to its originating assignment (+ away_assigned_at).
  const originalByCopySlug = new Map<
    string,
    { recordingSlug: string; awayAssignedAt: string | null }
  >()
  for (const a of assignments) {
    if (a.away_accepted_recording_uuid) {
      originalByCopySlug.set(a.away_accepted_recording_uuid, {
        recordingSlug: a.recording_slug,
        awayAssignedAt: a.away_assigned_at,
      })
    }
  }
  // Never treat a known ORIGINAL as a copy (guards a prefix collision).
  const originalSlugs = new Set(assignments.map((a) => a.recording_slug))

  // Candidate copies: prefixed slug, NOT a known original, AND no camera set.
  // The camera guard is the load-bearing safety rule — an ORIGINAL always has
  // a camera; a share-copy never does. We never classify a camera-bearing
  // recording as a deletable copy, no matter what its slug looks like. (The
  // cleanup re-verifies camera live right before deleting, too.)
  const candidates = recordings.filter(
    (r) =>
      isShareAcceptedCopy(r.slug, veoClubSlug) &&
      !originalSlugs.has(r.slug) &&
      !hasCamera(r)
  )
  const emptyShareCopies: EmptyShareCopy[] = []
  if (probeCopies) {
    for (const r of candidates) {
      let counts: { videos: number; periods: number }
      try {
        counts = await getContent(r.slug)
      } catch {
        // Probe failed (transient Veo error / 404). Fail SAFE: do NOT classify
        // as empty — never make a delete target out of an unverifiable probe.
        continue
      }
      if (!hasNoContent(counts)) continue
      const orig = originalByCopySlug.get(r.slug)
      emptyShareCopies.push({
        copySlug: r.slug,
        title: r.title,
        videos: counts.videos,
        periods: counts.periods,
        originalRecordingSlug: orig?.recordingSlug ?? null,
        originalAwayAssignedAt: orig?.awayAssignedAt ?? null,
      })
    }
  }

  // Away-share pending: home filed, no completed away-share. DB-derived only.
  const awayPending: AwayPending[] = assignments
    .filter(
      (a) => a.status === 'home_assigned' && !a.away_accepted_recording_uuid
    )
    .map((a) => ({ recordingSlug: a.recording_slug, title: a.recording_title }))

  // Empty originals (opt-in): non-copy recordings with no footage — failed/
  // pending camera uploads. REPORT-ONLY; never returned as a delete target.
  const emptyOriginals: EmptyOriginal[] = []
  if (opts.probeOriginals) {
    const originals = recordings.filter(
      (r) => !isShareAcceptedCopy(r.slug, veoClubSlug)
    )
    for (const r of originals) {
      let counts: { videos: number; periods: number }
      try {
        counts = await getContent(r.slug)
      } catch {
        continue // probe failed — skip (report-only bucket; never acted on)
      }
      if (hasNoContent(counts)) {
        emptyOriginals.push({ recordingSlug: r.slug, title: r.title })
      }
    }
  }

  return { emptyShareCopies, awayPending, emptyOriginals }
}
