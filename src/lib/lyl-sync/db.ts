// Supabase persistence helpers for the LYL recording-sync pipeline.
//
// Thin wrappers over the service-role Supabase client. All read+write
// happens via the service role — RLS denies anon/authenticated by design.
//
// Caps applied here (defence-in-depth against runaway LLM/Veo responses
// reaching the DB):
//   - parse_reasoning: 4 KB (mirrors the parser's REASONING_MAX_BYTES)
//   - last_error: 2 KB per row
//   - errors_jsonb error strings: 2 KB each
//
// Idempotency:
//   - Assignments are upserted on (league_club_slug, recording_slug).
//   - Sync runs are insert-only (one row per run, status flips in-place
//     until terminal).

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  AssignmentStatus,
  FailureStage,
  ParsedMatch,
  RunStatus,
  TriggerSource,
} from './types'

const PARSE_REASONING_MAX = 4096
const ERROR_MAX = 2048

function truncate(s: string | null | undefined, max: number): string | null {
  if (!s) return null
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= max) return s
  return buf.subarray(0, max).toString('utf8') + '…[truncated]'
}

/** Mirror of the playhub_recording_assignments row shape. */
export interface AssignmentRow {
  id: string
  league_club_slug: string
  recording_slug: string
  recording_uuid: string
  recording_title: string
  match_date: string | null
  duration_seconds: number | null

  parsed_home_subclub_slug: string | null
  parsed_away_subclub_slug: string | null
  parsed_home_age_group: string | null
  parsed_away_age_group: string | null
  parse_method: 'rules' | 'llm' | 'manual' | null
  parse_confidence: number | null
  parse_reasoning: string | null
  llm_attempted_at: string | null

  home_team_uuid: string | null
  home_team_slug: string | null
  home_assigned_at: string | null
  away_team_uuid: string | null
  away_team_slug: string | null
  away_assigned_at: string | null
  away_share_key: string | null
  away_accepted_recording_uuid: string | null

  status: AssignmentStatus
  failure_stage: FailureStage | null
  last_error: string | null
  last_processed_at: string | null
  last_sync_run_id: string | null

  created_at: string
  updated_at: string
}

/** Fields callers populate on the discovery / parse phase. */
export interface UpsertAssignmentInput {
  league_club_slug: string
  recording_slug: string
  recording_uuid: string
  recording_title: string
  match_date: string | null
  duration_seconds: number
  status: AssignmentStatus
  parsed?: ParsedMatch | null
  failure_stage?: FailureStage | null
  last_error?: string | null
  last_sync_run_id?: string
  /** Optional Veo-side assignment fields to merge in (set after a
   *  successful PATCH / accept). Caller passes only the side that changed. */
  home_team_uuid?: string | null
  home_team_slug?: string | null
  home_assigned_at?: string | null
  away_team_uuid?: string | null
  away_team_slug?: string | null
  away_assigned_at?: string | null
  away_share_key?: string | null
  away_accepted_recording_uuid?: string | null
}

/** Get the existing assignment row for (league, recording_slug), or null. */
export async function getAssignment(
  supabase: SupabaseClient,
  leagueClubSlug: string,
  recordingSlug: string
): Promise<AssignmentRow | null> {
  const { data, error } = await supabase
    .from('playhub_recording_assignments')
    .select('*')
    .eq('league_club_slug', leagueClubSlug)
    .eq('recording_slug', recordingSlug)
    .maybeSingle()
  if (error) throw new Error(`getAssignment failed: ${error.message}`)
  return (data as AssignmentRow | null) ?? null
}

/** Upsert. On insert, fills all fields; on update, merges supplied fields
 *  (Supabase's upsert with ignoreDuplicates:false is "update on conflict
 *  with provided columns"). Caps free-text before write. */
export async function upsertAssignment(
  supabase: SupabaseClient,
  input: UpsertAssignmentInput
): Promise<AssignmentRow> {
  const row: Partial<AssignmentRow> = {
    league_club_slug: input.league_club_slug,
    recording_slug: input.recording_slug,
    recording_uuid: input.recording_uuid,
    recording_title: input.recording_title,
    match_date: input.match_date,
    // Veo returns durations as float seconds (e.g. 2427.641044); our
    // column is INTEGER. Round at the boundary so Postgres doesn't
    // reject the upsert with "invalid input syntax for type integer".
    duration_seconds: Math.round(input.duration_seconds),
    status: input.status,
    failure_stage: input.failure_stage ?? null,
    last_error: truncate(input.last_error ?? null, ERROR_MAX),
    last_processed_at: new Date().toISOString(),
    last_sync_run_id: input.last_sync_run_id ?? null,
  }

  if (input.parsed) {
    row.parsed_home_subclub_slug = input.parsed.home?.subclubSlug ?? null
    row.parsed_home_age_group = input.parsed.home?.ageGroup ?? null
    row.parsed_away_subclub_slug = input.parsed.away?.subclubSlug ?? null
    row.parsed_away_age_group = input.parsed.away?.ageGroup ?? null
    row.parse_method = input.parsed.method
    row.parse_confidence = input.parsed.confidence
    row.parse_reasoning = truncate(input.parsed.reasoning, PARSE_REASONING_MAX)
    row.llm_attempted_at = input.parsed.llmAttemptedAt?.toISOString() ?? null
  }
  // Merge Veo-side assignment columns only when explicitly supplied —
  // a partial update (e.g. just patched home) shouldn't clobber the
  // away_* fields written by an earlier phase.
  if ('home_team_uuid' in input) row.home_team_uuid = input.home_team_uuid ?? null
  if ('home_team_slug' in input) row.home_team_slug = input.home_team_slug ?? null
  if ('home_assigned_at' in input) row.home_assigned_at = input.home_assigned_at ?? null
  if ('away_team_uuid' in input) row.away_team_uuid = input.away_team_uuid ?? null
  if ('away_team_slug' in input) row.away_team_slug = input.away_team_slug ?? null
  if ('away_assigned_at' in input) row.away_assigned_at = input.away_assigned_at ?? null
  if ('away_share_key' in input) row.away_share_key = input.away_share_key ?? null
  if ('away_accepted_recording_uuid' in input)
    row.away_accepted_recording_uuid = input.away_accepted_recording_uuid ?? null

  // defaultToNull: false → on conflict, columns NOT in `row` keep their
  // existing values (vs being clobbered to null). Critical for our
  // partial-update flow: the parse-phase upsert writes parse_method +
  // parsed_*, then home-patch/share-accept upserts only write
  // status + home/away_* fields. Without this flag, those subsequent
  // upserts would null out parse_method and trigger
  // chk_parse_method_when_parsed (status != pending requires non-null
  // parse_method). Bit us in prod 2026-05-17 smoke run.
  //
  // Note: defaultToNull is only typed on the array overload of upsert,
  // so we wrap as [row] + read back data[0]. Runtime behaviour is
  // identical to passing a bare object.
  const { data, error } = await supabase
    .from('playhub_recording_assignments')
    .upsert([row], {
      onConflict: 'league_club_slug,recording_slug',
      defaultToNull: false,
    })
    .select('*')
  if (error) throw new Error(`upsertAssignment failed: ${error.message}`)
  const persisted = (data as AssignmentRow[] | null)?.[0]
  if (!persisted) throw new Error('upsertAssignment returned no row')
  return persisted
}

/** List recent runs (admin UI history view). */
export interface SyncRunRow {
  id: string
  league_club_slug: string
  trigger_source: TriggerSource
  started_at: string
  completed_at: string | null
  status: RunStatus
  veo_recordings_seen: number | null
  new_recordings: number | null
  rules_parsed: number | null
  llm_parsed: number | null
  unparseable: number | null
  home_assignments: number | null
  share_accepts: number | null
  auto_corrections: number | null
  failures: number | null
  llm_total_input_tokens: number | null
  llm_total_output_tokens: number | null
  llm_cost_usd: number | null
  errors_jsonb: unknown
  created_by: string | null
}

export async function listSyncRuns(
  supabase: SupabaseClient,
  leagueClubSlug: string,
  limit = 50
): Promise<SyncRunRow[]> {
  const { data, error } = await supabase
    .from('playhub_recording_sync_runs')
    .select('*')
    .eq('league_club_slug', leagueClubSlug)
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`listSyncRuns failed: ${error.message}`)
  return (data as SyncRunRow[] | null) ?? []
}

/** Create a run row in status='running'. Returns the row's id. */
export async function createSyncRun(
  supabase: SupabaseClient,
  input: {
    league_club_slug: string
    trigger_source: TriggerSource
    created_by?: string | null
  }
): Promise<string> {
  const { data, error } = await supabase
    .from('playhub_recording_sync_runs')
    .insert({
      league_club_slug: input.league_club_slug,
      trigger_source: input.trigger_source,
      created_by: input.created_by ?? null,
      status: 'running',
    })
    .select('id')
    .single()
  if (error) throw new Error(`createSyncRun failed: ${error.message}`)
  return (data as { id: string }).id
}

/** Final-state update. Caps error strings inside errors_jsonb before write. */
export interface UpdateSyncRunInput {
  status: RunStatus
  veo_recordings_seen: number
  new_recordings: number
  rules_parsed: number
  llm_parsed: number
  unparseable: number
  home_assignments: number
  share_accepts: number
  auto_corrections: number
  failures: number
  llm_total_input_tokens: number
  llm_total_output_tokens: number
  llm_cost_usd: number
  errors: Array<{
    recording_slug: string
    recording_title: string
    stage: FailureStage | 'unparseable'
    error: string
  }>
}

export async function completeSyncRun(
  supabase: SupabaseClient,
  runId: string,
  input: UpdateSyncRunInput
): Promise<void> {
  // Cap each error message — bounded jsonb size + protects against
  // a single huge Veo response burning the column.
  const cappedErrors = input.errors.map((e) => ({
    ...e,
    error: truncate(e.error, ERROR_MAX),
  }))
  const { error } = await supabase
    .from('playhub_recording_sync_runs')
    .update({
      status: input.status,
      completed_at: new Date().toISOString(),
      veo_recordings_seen: input.veo_recordings_seen,
      new_recordings: input.new_recordings,
      rules_parsed: input.rules_parsed,
      llm_parsed: input.llm_parsed,
      unparseable: input.unparseable,
      home_assignments: input.home_assignments,
      share_accepts: input.share_accepts,
      auto_corrections: input.auto_corrections,
      failures: input.failures,
      llm_total_input_tokens: input.llm_total_input_tokens,
      llm_total_output_tokens: input.llm_total_output_tokens,
      llm_cost_usd: input.llm_cost_usd,
      errors_jsonb: cappedErrors,
    })
    .eq('id', runId)
  if (error) throw new Error(`completeSyncRun failed: ${error.message}`)
}

/** Subclub fetch — used by both orchestrator (parser deps) + admin UI
 *  (dropdown options on overrides). */
export interface SubclubRow {
  subclub_slug: string
  display_name: string
}

export async function listSubclubs(
  supabase: SupabaseClient,
  leagueClubSlug: string
): Promise<SubclubRow[]> {
  const { data, error } = await supabase
    .from('playhub_academy_subclubs')
    .select('subclub_slug, display_name')
    .eq('club_slug', leagueClubSlug)
    .eq('is_active', true)
  if (error) throw new Error(`listSubclubs failed: ${error.message}`)
  return (data as SubclubRow[] | null) ?? []
}
