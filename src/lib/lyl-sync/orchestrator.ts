// Orchestrator for the weekly LYL Veo recording-sync job.
//
// Coordinates: discover recordings → parse (rules → LLM fallback) →
// upsert assignment state → assign home team in Veo → share + accept
// into away team → record run summary.
//
// Three modes (controlled by trigger_source on the run):
//   - cron    : EventBridge → Lambda. allowLlmFallback=true.
//   - manual  : admin clicks "Run sync now" in UI. allowLlmFallback=true.
//   - api     : programmatic single-recording re-trigger. allowLlmFallback=true.
//
// Auto-correct policy: when an existing recording's CURRENT Veo team
// doesn't match what we'd assign (e.g. an operator misfiled it before
// the cron caught up), PATCH-move it to the parsed home team — unless
// the local DB row is status='operator_locked'.
//
// Dependency injection at every external boundary (Veo client, Supabase,
// parser, clock). Unit tests inject all four; the default factory wires
// to real impls.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createSyncRun,
  completeSyncRun,
  getAssignment,
  upsertAssignment,
  listSubclubs,
  type AssignmentRow,
  type SubclubRow,
} from './db'
import { parseRecording, buildDefaultDeps as buildParserDeps } from './parser'
import type {
  FailureStage,
  ParsedMatch,
  SubclubRef,
  TriggerSource,
} from './types'

// ---------------------------------------------------------------------------
// Veo client surface the orchestrator depends on
// ---------------------------------------------------------------------------

export interface VeoTeam {
  id: string
  slug: string
  name: string
  age_group?: string
}

export interface VeoRecording {
  slug: string
  title: string
  duration: number
  team?: string | null // Veo returns the TEAM NAME here (not UUID — see Veo client tests)
  // Veo may omit (undefined) or explicitly null this field; mirror both.
  match_date?: string | null
}

export interface VeoClientSurface {
  listClubTeams: (clubSlug: string) => Promise<VeoTeam[]>
  listRecordings: (clubSlug: string) => Promise<VeoRecording[]>
  /** UUID resolver — listRecordings doesn't return UUIDs reliably. */
  getRecordingUUID: (recordingSlug: string) => Promise<{
    id: string
    start: string
    end: string
    title: string
  }>
  createTeam: (input: {
    clubSlug: string
    name: string
    ageGroup: string
    gender: 'male' | 'female' | 'mixed'
    shortName: string
  }) => Promise<{ id: string; slug: string }>
  assignRecordingToTeam: (recordingUUID: string, teamUUID: string) => Promise<void>
  createShareInvitation: (recordingSlug: string, email: string) => Promise<{ key: string }>
  acceptShareInvitation: (input: {
    shareKey: string
    ownClubSlug: string
    teamUUID: string
    title: string
    start: string
    end: string
    opponentClubName: string
  }) => Promise<{ slug: string }>
}

// ---------------------------------------------------------------------------
// Run input / output
// ---------------------------------------------------------------------------

export interface RunSyncInput {
  leagueClubSlug: string
  /** Veo's club slug for this league (e.g. 'london-youth-league' for LYL).
   *  Used for share-accepted-copy detection — Veo prefixes share-copy
   *  slugs with the recipient club's Veo slug, not our internal league
   *  slug. Defaults to leagueClubSlug if not provided. */
  veoClubSlug?: string
  trigger: TriggerSource
  /** Required when trigger is 'manual' or 'api'. */
  createdBy?: string
  /** Limit to a single recording (admin re-trigger). When set, the
   *  discovery step is bypassed and the orchestrator processes only
   *  this recording. */
  onlyRecordingSlug?: string
  /** Email recipient for share-with-opponent invites. Defaults to the
   *  LYL Veo admin's email. */
  shareRecipientEmail: string
  /** Pulled from Veo to map team slug → UUID. The orchestrator
   *  loads this once at startup; passes to phase 2 + 3. */
}

export interface RunSyncResult {
  runId: string
  status: 'succeeded' | 'partial' | 'failed'
  counts: {
    veoRecordingsSeen: number
    newRecordings: number
    rulesParsed: number
    llmParsed: number
    unparseable: number
    homeAssignments: number
    shareAccepts: number
    autoCorrections: number
    failures: number
  }
  llm: {
    inputTokens: number
    outputTokens: number
    costUsd: number
  }
  errors: Array<{
    recording_slug: string
    recording_title: string
    stage: FailureStage | 'unparseable'
    error: string
  }>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Per-subclub manual aliases. Use when the same real-world subclub
 *  shows up in match titles under multiple spellings (e.g. "ELA" and
 *  "Elite London Academy"). Adding the alternate spelling here maps
 *  both to the same `subclub_slug` so the cron stops creating duplicate
 *  Veo teams. Prefer this over creating two subclub rows in the DB
 *  (which silently fragments recordings across mismatched team folders).
 *
 *  Long-term: move to an `aliases TEXT[]` column on
 *  `playhub_academy_subclubs` so ops can add aliases without a code
 *  change. For now, a hand-curated map is fine — additions are rare. */
const SUBCLUB_ALIASES: Record<string, string[]> = {
  // London Youth League (LYL).
  // Most failures from the 2026-05-17 smoke run came down to title text
  // using the FULL club name while the DB stored a short code, with no
  // bridge. Add both directions of the substring relationship where
  // either form appears in real LYL titles.
  ela: ['Elite London Academy'],
  taa: ['The A Academy', 'The A academy'],
  rpt: ['Rugby Portobello Trust', 'Rugby Portobello'],
  'champs-fc': ['Champs FC', 'Champs'],
  nsfc: ['NSFC', 'N.S.F.C', 'N S F C'],
  lfs: ['LFS', 'London Football School'],
  jsfc: ['JSFC', 'JS FC'],
  forzaskillz: ['Forzaskillz', 'Forza Skillz', 'ForzaSkillz'],
  'london-thames': ['London Thames', 'London Thames FC'],
  'national-harrow': ['National Harrow', 'National Harrow FC'],
}

/** Build the SubclubRef catalog the parser uses, from DB display names.
 *  Aliases are derived from the display name itself + the manual map. */
function subclubsToParserRefs(subclubs: SubclubRow[]): SubclubRef[] {
  return subclubs.map((sc) => {
    const aliases = new Set<string>()
    aliases.add(sc.display_name)
    // Tolerate trailing/leading whitespace by adding the trimmed variant.
    aliases.add(sc.display_name.trim())
    // Pull in any hand-curated alternates for this subclub_slug.
    for (const extra of SUBCLUB_ALIASES[sc.subclub_slug] ?? []) {
      aliases.add(extra)
    }
    // Lower-case variant is automatically included by the parser's
    // case-insensitive substring match — no need to inject.
    return {
      slug: sc.subclub_slug,
      displayName: sc.display_name,
      aliases: [...aliases],
    }
  })
}

/** Veo team name → "BarnesEagles U10" pattern. Display name space-joined
 *  with the age group label (uppercase U). */
function buildVeoTeamName(displayName: string, ageGroup: string): string {
  // ageGroup is 'u10' from our DB → 'U10' for Veo.
  return `${displayName} ${ageGroup.toUpperCase()}`
}

/** Veo's short_name field is capped at 3 chars. Build initials from the
 *  display name, treating dots as word separators. Fall back to first 3
 *  alphanumerics if initials are too short. Same logic as the existing
 *  execute-lyl-team-assignment.ts. */
function buildVeoShortName(displayName: string): string {
  let initials = displayName
    .replace(/\./g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 3)
  if (initials.length < 2) {
    initials = displayName
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 3)
      .toUpperCase()
  }
  return initials
}

/** True for Veo recordings that are themselves share-accepted copies (Veo
 *  prefixes their slug with the source club slug). We never plan or store
 *  these — only the originals get an assignment row. */
function isShareAcceptedCopy(recordingSlug: string, leagueClubSlug: string): boolean {
  return recordingSlug.startsWith(`${leagueClubSlug}-`)
}

/** Tagged error so the per-recording catch can record the EXACT failure
 *  stage in failure_stage (vs the old "infer from message text" heuristic
 *  which collapsed everything into 'home_patch'). Throw this wherever the
 *  failure is known (subclub missing, Veo team create failed, etc.); the
 *  catch block reads `.stage` directly. */
class StageError extends Error {
  constructor(public readonly stage: FailureStage, message: string) {
    super(message)
    this.name = 'StageError'
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface RunSyncDeps {
  supabase: SupabaseClient
  veo: VeoClientSurface
  parserFactory: () => ReturnType<typeof buildParserDeps>
}

export async function runSync(
  input: RunSyncInput,
  deps: RunSyncDeps
): Promise<RunSyncResult> {
  // Open the run row first thing — every other failure path persists
  // to it so the admin UI sees the attempt even on infrastructure crashes.
  const runId = await createSyncRun(deps.supabase, {
    league_club_slug: input.leagueClubSlug,
    trigger_source: input.trigger,
    created_by: input.createdBy ?? null,
  })

  // Aggregators.
  let veoRecordingsSeen = 0
  let newRecordings = 0
  let rulesParsed = 0
  let llmParsed = 0
  let unparseable = 0
  let homeAssignments = 0
  let shareAccepts = 0
  let autoCorrections = 0
  let failures = 0
  let llmInputTokens = 0
  let llmOutputTokens = 0
  let llmCostUsd = 0
  const errors: RunSyncResult['errors'] = []

  let overallStatus: 'succeeded' | 'partial' | 'failed' = 'succeeded'

  try {
    // 1. Load subclubs (parser catalog) + current Veo team list (slug → UUID lookup).
    const subclubs = await listSubclubs(deps.supabase, input.leagueClubSlug)
    if (subclubs.length === 0) {
      throw new Error(`No active subclubs for league ${input.leagueClubSlug}`)
    }
    const subclubRefs = subclubsToParserRefs(subclubs)
    const subclubBySlug = new Map(subclubs.map((s) => [s.subclub_slug, s]))

    const veoTeams = await deps.veo.listClubTeams(input.leagueClubSlug)
    const veoTeamBySlug = new Map(veoTeams.map((t) => [t.slug, t]))
    const veoTeamByName = new Map(veoTeams.map((t) => [t.name, t]))

    // 2. Discover recordings.
    const allRecordings = await deps.veo.listRecordings(input.leagueClubSlug)
    veoRecordingsSeen = allRecordings.length

    // Filter to in-scope subjects: originals only (skip share-accepted
    // copies). Veo prefixes share-copy slugs with the recipient club's
    // Veo slug (e.g. `london-youth-league-...`), so the filter needs
    // the Veo slug not our internal league slug.
    const sharePrefixClubSlug = input.veoClubSlug ?? input.leagueClubSlug
    const inScope = allRecordings
      .filter((r) => !isShareAcceptedCopy(r.slug, sharePrefixClubSlug))
      .filter((r) => !input.onlyRecordingSlug || r.slug === input.onlyRecordingSlug)

    const parserDeps = deps.parserFactory()

    for (const recording of inScope) {
      try {
        // 3. Look up existing row to drive retry / idempotency / operator-lock.
        const existing = await getAssignment(
          deps.supabase,
          input.leagueClubSlug,
          recording.slug
        )

        // Operator-locked rows are off-limits to the cron. Admin UI edits
        // set this status explicitly; clearing requires a deliberate UI
        // action.
        if (existing?.status === 'operator_locked') continue

        // For idempotency, we resolve the recording UUID up front so a
        // restart after a Veo-side change doesn't re-create teams.
        const details = await deps.veo.getRecordingUUID(recording.slug)

        // 4. Parse. Skip the LLM if we've already invoked it for this row
        //    and it was unparseable last time (don't re-bill on the same
        //    unparseable title across cron runs).
        const llmAlreadyFailedThisTitle =
          existing?.status === 'unparseable' && existing.llm_attempted_at !== null
        const allowLlmFallback = !llmAlreadyFailedThisTitle

        const parseResult = await parseRecording(
          { title: recording.title, durationSeconds: recording.duration, allowLlmFallback },
          subclubRefs,
          parserDeps
        )

        if (parseResult.llmCost) {
          llmInputTokens += parseResult.llmCost.inputTokens
          llmOutputTokens += parseResult.llmCost.outputTokens
          llmCostUsd += parseResult.llmCost.costUsd
          llmParsed++
        }

        // 5. Persist parse outcome.
        if (parseResult.outcome.kind === 'too_long') {
          await upsertAssignment(deps.supabase, {
            league_club_slug: input.leagueClubSlug,
            recording_slug: recording.slug,
            recording_uuid: details.id,
            recording_title: recording.title,
            match_date: recording.match_date ?? null,
            duration_seconds: recording.duration,
            status: 'too_long',
            last_sync_run_id: runId,
          })
          if (!existing) newRecordings++
          continue
        }

        if (parseResult.outcome.kind === 'unparseable') {
          unparseable++
          await upsertAssignment(deps.supabase, {
            league_club_slug: input.leagueClubSlug,
            recording_slug: recording.slug,
            recording_uuid: details.id,
            recording_title: recording.title,
            match_date: recording.match_date ?? null,
            duration_seconds: recording.duration,
            status: 'unparseable',
            failure_stage: null,
            last_error: parseResult.outcome.reason,
            last_sync_run_id: runId,
          })
          errors.push({
            recording_slug: recording.slug,
            recording_title: recording.title,
            stage: 'unparseable',
            error: parseResult.outcome.reason,
          })
          if (!existing) newRecordings++
          continue
        }

        // From here, we have a ParsedMatch (eligible or intra_team).
        const parsed: ParsedMatch = parseResult.outcome.parsed
        if (parseResult.outcome.parsed.method === 'rules') rulesParsed++

        // 6. Resolve / create the HOME team in Veo.
        const homeSubclub = subclubBySlug.get(parsed.home!.subclubSlug)
        if (!homeSubclub) {
          throw new StageError(
            'unknown_home_subclub',
            `Unknown home subclub: ${parsed.home!.subclubSlug}`
          )
        }
        const homeName = buildVeoTeamName(homeSubclub.display_name, parsed.home!.ageGroup)
        let homeTeam = veoTeamByName.get(homeName)
        if (!homeTeam) {
          try {
            const created = await deps.veo.createTeam({
              clubSlug: input.leagueClubSlug,
              name: homeName,
              ageGroup: parsed.home!.ageGroup.toUpperCase(),
              gender: 'male',
              shortName: buildVeoShortName(homeSubclub.display_name),
            })
            homeTeam = { id: created.id, slug: created.slug, name: homeName, age_group: parsed.home!.ageGroup.toUpperCase() }
            veoTeamBySlug.set(homeTeam.slug, homeTeam)
            veoTeamByName.set(homeName, homeTeam)
          } catch (err) {
            throw new StageError(
              'team_create',
              `Failed to create home team "${homeName}": ${err instanceof Error ? err.message : String(err)}`
            )
          }
        }

        // 6a. Compare CURRENT Veo team vs intended home team. Auto-correct
        //     if mismatch (e.g. an operator misfiled it).
        const currentVeoTeamName = recording.team ?? null
        const needsHomePatch = currentVeoTeamName !== homeName
        if (needsHomePatch) {
          await deps.veo.assignRecordingToTeam(details.id, homeTeam.id)
          homeAssignments++
          // Track auto-correction separately from initial assignment.
          if (currentVeoTeamName) autoCorrections++
        }

        // 7. Intra-team: skip share+accept (single-team match already done).
        if (parseResult.outcome.kind === 'intra_team') {
          await upsertAssignment(deps.supabase, {
            league_club_slug: input.leagueClubSlug,
            recording_slug: recording.slug,
            recording_uuid: details.id,
            recording_title: recording.title,
            match_date: recording.match_date ?? null,
            duration_seconds: recording.duration,
            status: 'intra_team',
            parsed,
            home_team_uuid: homeTeam.id,
            home_team_slug: homeTeam.slug,
            home_assigned_at: new Date().toISOString(),
            last_sync_run_id: runId,
          })
          if (!existing) newRecordings++
          continue
        }

        // 8. Resolve / create the AWAY team.
        const awaySubclub = subclubBySlug.get(parsed.away!.subclubSlug)
        if (!awaySubclub) {
          throw new StageError(
            'unknown_away_subclub',
            `Unknown away subclub: ${parsed.away!.subclubSlug}`
          )
        }
        const awayName = buildVeoTeamName(awaySubclub.display_name, parsed.away!.ageGroup)
        let awayTeam = veoTeamByName.get(awayName)
        if (!awayTeam) {
          try {
            const created = await deps.veo.createTeam({
              clubSlug: input.leagueClubSlug,
              name: awayName,
              ageGroup: parsed.away!.ageGroup.toUpperCase(),
              gender: 'male',
              shortName: buildVeoShortName(awaySubclub.display_name),
            })
            awayTeam = { id: created.id, slug: created.slug, name: awayName, age_group: parsed.away!.ageGroup.toUpperCase() }
            veoTeamBySlug.set(awayTeam.slug, awayTeam)
            veoTeamByName.set(awayName, awayTeam)
          } catch (err) {
            throw new StageError(
              'team_create',
              `Failed to create away team "${awayName}": ${err instanceof Error ? err.message : String(err)}`
            )
          }
        }

        // 9. Share+accept into AWAY team — skip if we already did it for
        //    this recording (existing row tracks away_accepted_recording_uuid).
        let awayShareKey = existing?.away_share_key ?? null
        let awayAcceptedRecordingUuid = existing?.away_accepted_recording_uuid ?? null
        const alreadyAwayAssigned =
          existing?.away_team_uuid === awayTeam.id &&
          existing?.away_accepted_recording_uuid !== null
        if (!alreadyAwayAssigned) {
          let share: { key: string }
          try {
            share = await deps.veo.createShareInvitation(
              recording.slug,
              input.shareRecipientEmail
            )
          } catch (err) {
            throw new StageError(
              'share_create',
              `createShareInvitation failed: ${err instanceof Error ? err.message : String(err)}`
            )
          }
          awayShareKey = share.key
          let accepted: { slug: string }
          try {
            accepted = await deps.veo.acceptShareInvitation({
              shareKey: share.key,
              ownClubSlug: input.leagueClubSlug,
              teamUUID: awayTeam.id,
              title: details.title || recording.title,
              start: details.start,
              end: details.end,
              opponentClubName: 'London Youth League',
            })
          } catch (err) {
            throw new StageError(
              'share_accept',
              `acceptShareInvitation failed: ${err instanceof Error ? err.message : String(err)}`
            )
          }
          awayAcceptedRecordingUuid = accepted.slug // we store the slug as the marker

          // 9a. Belt-and-braces: force the share-copy into the AWAY team.
          //     Empirically observed 2026-05-18 — Veo's acceptShareInvitation
          //     `team` param doesn't always land the share in the requested
          //     team folder (the LYL Library was showing originals + share-
          //     copies BOTH bucketed under the home team for ~30 matches).
          //     A direct PATCH via assignRecordingToTeam is the canonical
          //     placement op and is idempotent — if Veo's accept honoured
          //     `teamUUID`, this is a no-op. Resolve the share-copy's UUID
          //     via getRecordingUUID since acceptShareInvitation only
          //     returns the slug.
          try {
            const acceptedDetails = await deps.veo.getRecordingUUID(accepted.slug)
            await deps.veo.assignRecordingToTeam(acceptedDetails.id, awayTeam.id)
          } catch (err) {
            throw new StageError(
              'away_force_assign',
              `Failed to force-assign share-copy ${accepted.slug} into away team: ${err instanceof Error ? err.message : String(err)}`
            )
          }
          shareAccepts++
        }

        // 10. Final upsert — fully_assigned.
        await upsertAssignment(deps.supabase, {
          league_club_slug: input.leagueClubSlug,
          recording_slug: recording.slug,
          recording_uuid: details.id,
          recording_title: recording.title,
          match_date: recording.match_date ?? null,
          duration_seconds: recording.duration,
          status: 'fully_assigned',
          parsed,
          home_team_uuid: homeTeam.id,
          home_team_slug: homeTeam.slug,
          home_assigned_at: new Date().toISOString(),
          away_team_uuid: awayTeam.id,
          away_team_slug: awayTeam.slug,
          away_assigned_at: new Date().toISOString(),
          away_share_key: awayShareKey,
          away_accepted_recording_uuid: awayAcceptedRecordingUuid,
          last_sync_run_id: runId,
        })
        if (!existing) newRecordings++
      } catch (err) {
        // Per-recording catch: log to errors[], persist failure to DB, continue.
        failures++
        overallStatus = 'partial'
        const message = err instanceof Error ? err.message : String(err)
        // Stage tagging — prefer the StageError carried by tagged throws
        // (unknown_home_subclub, team_create, share_create, etc). Untagged
        // errors fall back to the legacy message-substring inference so
        // pre-tagging code paths still classify roughly correctly.
        let stage: FailureStage = 'home_patch'
        if (err instanceof StageError) {
          stage = err.stage
        } else {
          if (message.toLowerCase().includes('share')) stage = 'share_create'
          if (message.toLowerCase().includes('accept')) stage = 'share_accept'
        }
        errors.push({
          recording_slug: recording.slug,
          recording_title: recording.title,
          stage,
          error: message,
        })
        // Persist a failed row so the admin UI surfaces it.
        try {
          // Best-effort — if this also fails we just log and move on; the
          // run summary in errors_jsonb still has the record.
          await upsertAssignment(deps.supabase, {
            league_club_slug: input.leagueClubSlug,
            recording_slug: recording.slug,
            recording_uuid: '', // empty placeholder — real UUID may not be known if getRecordingUUID failed
            recording_title: recording.title,
            match_date: recording.match_date ?? null,
            duration_seconds: recording.duration,
            status: 'failed',
            failure_stage: stage,
            last_error: message,
            last_sync_run_id: runId,
          })
        } catch {
          // Skip silently — the run summary still captures the error.
        }
      }
    }
  } catch (err) {
    overallStatus = 'failed'
    errors.push({
      recording_slug: '(orchestrator)',
      recording_title: '',
      stage: 'parse',
      error: err instanceof Error ? err.message : String(err),
    })
  }

  await completeSyncRun(deps.supabase, runId, {
    status: overallStatus,
    veo_recordings_seen: veoRecordingsSeen,
    new_recordings: newRecordings,
    rules_parsed: rulesParsed,
    llm_parsed: llmParsed,
    unparseable,
    home_assignments: homeAssignments,
    share_accepts: shareAccepts,
    auto_corrections: autoCorrections,
    failures,
    llm_total_input_tokens: llmInputTokens,
    llm_total_output_tokens: llmOutputTokens,
    llm_cost_usd: Number(llmCostUsd.toFixed(6)),
    errors,
  })

  return {
    runId,
    status: overallStatus,
    counts: {
      veoRecordingsSeen,
      newRecordings,
      rulesParsed,
      llmParsed,
      unparseable,
      homeAssignments,
      shareAccepts,
      autoCorrections,
      failures,
    },
    llm: {
      inputTokens: llmInputTokens,
      outputTokens: llmOutputTokens,
      costUsd: Number(llmCostUsd.toFixed(6)),
    },
    errors,
  }
}
