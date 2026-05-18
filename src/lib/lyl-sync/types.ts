// Shared types for the LYL recording-sync pipeline.
//
// Distinguishes parser PROVENANCE (rules / llm / manual) from STATUS
// (the lifecycle the orchestrator transitions through). Same shape as
// the columns on playhub_recording_assignments.

export type ParseMethod = 'rules' | 'llm' | 'manual'

export type AssignmentStatus =
  | 'pending'
  | 'parsed'
  | 'home_assigned'
  | 'fully_assigned'
  | 'operator_locked'
  | 'unparseable'
  | 'too_long'
  | 'intra_team'
  | 'failed'

export type FailureStage =
  | 'parse'
  | 'home_patch'
  | 'share_create'
  | 'share_accept'
  | 'cleanup'
  // Fine-grained additions (2026-05-19) so the report tells ops exactly
  // which step blew up instead of a 'home_patch' catch-all.
  | 'unknown_home_subclub'   // parser returned a subclub slug we don't have a row for
  | 'unknown_away_subclub'   // same, away side
  | 'team_create'            // Veo createTeam call failed (home OR away)
  | 'away_force_assign'      // belt-and-braces assignRecordingToTeam after acceptShareInvitation failed

export type TriggerSource = 'cron' | 'manual' | 'api'

export type RunStatus = 'running' | 'succeeded' | 'partial' | 'failed'

/** A parsed match: home + away (subclub, age group) — what the
 *  orchestrator needs to create teams + assign recordings. */
export interface ParsedMatch {
  home: { subclubSlug: string; ageGroup: string } | null
  away: { subclubSlug: string; ageGroup: string } | null
  method: ParseMethod
  /** [0,1]; populated only when method === 'llm'. */
  confidence: number | null
  /** Free-text LLM reasoning; capped to 4KB before persistence. */
  reasoning: string | null
  /** When the LLM was invoked. Used by retries to avoid double-billing
   *  on a re-run for the same recording. NULL when method !== 'llm'. */
  llmAttemptedAt: Date | null
}

/** Discriminated outcome from parseRecording — covers every status
 *  the orchestrator persists. */
export type ParseOutcome =
  | { kind: 'eligible'; parsed: ParsedMatch }   // both sides resolved
  | { kind: 'intra_team'; parsed: ParsedMatch } // home === away
  | { kind: 'unparseable'; reason: string }     // rules + LLM both failed
  | { kind: 'too_long'; durationSeconds: number }

/** Token + cost accounting for a single LLM invocation. Aggregated into
 *  the run summary so ops can see weekly Anthropic spend. */
export interface LlmCost {
  inputTokens: number
  outputTokens: number
  costUsd: number
}

/** A subclub the parser can match against. Surfaces both the canonical
 *  slug + the display name + every alias (the parser uses
 *  case-insensitive substring matching). */
export interface SubclubRef {
  slug: string         // 'taa'
  displayName: string  // 'TAA'
  /** Title-casing variants we've seen in Veo titles: 'TAA', 'The A Academy',
   *  etc. Ordered longest-first so the substring match prefers the most
   *  specific spelling. */
  aliases: string[]
}
