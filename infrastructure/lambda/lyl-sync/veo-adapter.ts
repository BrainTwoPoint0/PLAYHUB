// Veo client adapter for the lyl-sync Lambda.
//
// Wraps the existing PLAYHUB src/lib/veo/client.ts surface into the
// VeoClientSurface the orchestrator expects. Lives in the Lambda
// directory so esbuild bundles it without leaking server-only deps
// into the PLAYHUB Next.js client bundle.
//
// All Veo API calls go through the cached Playwright session in
// src/lib/veo/auth.ts — single browser per Lambda invocation,
// reused across the (potentially) hundreds of API calls per run.

import {
  listClubsAndTeams,
  listRecordings,
  getMatchDetails,
  createTeam,
  assignRecordingToTeam,
  createShareInvitation,
  acceptShareInvitation,
  deleteRecording,
  getRecordingContentCounts,
} from '../../../src/lib/veo/client'
import { shutdownVeoSession } from '../../../src/lib/veo/auth'
import type { VeoClientSurface } from '../../../src/lib/lyl-sync/orchestrator'

// The orchestrator passes our DB-side league slug (e.g. 'lyl') to every
// Veo call. Veo's actual club slug is different ('london-youth-league').
// We translate at the adapter boundary using VEO_CLUB_SLUG env var so
// the orchestrator stays slug-agnostic. If unset, fall through to whatever
// the orchestrator passed (matches earlier behaviour for any future
// orchestrator that happens to pass Veo slugs directly).
const VEO_CLUB_SLUG_OVERRIDE = process.env.VEO_CLUB_SLUG || ''
function toVeoSlug(orchSlug: string): string {
  return VEO_CLUB_SLUG_OVERRIDE || orchSlug
}

/** Adapter mapping the rich PLAYHUB Veo client onto the narrower surface
 *  the orchestrator uses. Errors from the underlying client are passed
 *  through (caller catches per-recording). */
export const veoAdapter: VeoClientSurface = {
  listClubTeams: async (clubSlug) => {
    const veoSlug = toVeoSlug(clubSlug)
    const r = await listClubsAndTeams()
    if (!r.success) throw new Error(`listClubsAndTeams: ${r.message}`)
    const club = r.data!.clubs.find((c) => c.slug === veoSlug)
    if (!club)
      throw new Error(
        `Club ${veoSlug} not found in Veo (league slug "${clubSlug}" translated via VEO_CLUB_SLUG env)`
      )
    return club.teams.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
    }))
  },

  listRecordings: async (clubSlug) => {
    const r = await listRecordings(toVeoSlug(clubSlug))
    if (!r.success) throw new Error(`listRecordings: ${r.message}`)
    // Veo returns `team` as a string (team NAME) — see Veo client docs.
    // Pass through; orchestrator's auto-correct compares names.
    return r.data!.recordings.map((rec) => ({
      slug: rec.slug,
      title: rec.title,
      duration: rec.duration,
      team: rec.team ?? null,
      match_date: rec.match_date,
      // Content-readiness signals: the orchestrator gates the away-share on
      // these so it never creates an empty copy of a still-processing source.
      processing_status: rec.processing_status ?? null,
      thumbnail: rec.thumbnail ?? null,
    }))
  },

  getRecordingUUID: async (recordingSlug) => {
    const r = await getMatchDetails(recordingSlug)
    if (!r.success || !r.data) {
      throw new Error(`getMatchDetails(${recordingSlug}): ${r.message}`)
    }
    const data = r.data as {
      id?: string
      start?: string
      end?: string
      title?: string
    }
    if (!data.id || !data.start || !data.end) {
      throw new Error(`getMatchDetails(${recordingSlug}) missing id/start/end`)
    }
    return {
      id: data.id,
      start: data.start,
      end: data.end,
      title: data.title ?? recordingSlug,
    }
  },

  createTeam: async (input) => {
    const r = await createTeam({
      ...input,
      clubSlug: toVeoSlug(input.clubSlug),
    })
    if (!r.success || !r.data) throw new Error(`createTeam: ${r.message}`)
    return { id: r.data.team.id, slug: r.data.team.slug }
  },

  assignRecordingToTeam: async (recordingUUID, teamUUID) => {
    const r = await assignRecordingToTeam(recordingUUID, teamUUID)
    if (!r.success) throw new Error(`assignRecordingToTeam: ${r.message}`)
  },

  deleteRecording: async (recordingSlug) => {
    const r = await deleteRecording(recordingSlug)
    if (!r.success) throw new Error(`deleteRecording: ${r.message}`)
  },

  getRecordingContent: async (recordingSlug) => {
    const r = await getRecordingContentCounts(recordingSlug)
    if (!r.success || !r.data)
      throw new Error(`getRecordingContentCounts: ${r.message}`)
    return r.data
  },

  createShareInvitation: async (recordingSlug, email) => {
    const r = await createShareInvitation({ recordingSlug, email })
    if (!r.success || !r.data)
      throw new Error(`createShareInvitation: ${r.message}`)
    return { key: r.data.invitation.key }
  },

  acceptShareInvitation: async (input) => {
    const r = await acceptShareInvitation({
      ...input,
      ownClubSlug: toVeoSlug(input.ownClubSlug),
    })
    if (!r.success || !r.data)
      throw new Error(`acceptShareInvitation: ${r.message}`)
    return { slug: r.data.match.slug }
  },
}

/** Tear down the cached Playwright session at end of run. Lambda's
 *  process lives for warm-pool reuse, but the browser should die between
 *  invocations to avoid token-expiry on a stale session. */
export const shutdownVeo = shutdownVeoSession
