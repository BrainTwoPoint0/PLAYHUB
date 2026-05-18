// Title parser for LYL recording titles.
//
// Two-stage:
//   1. Rules-first — fast, deterministic, free. Handles ~25 of 26
//      observed LYL titles (substring-matching against a known subclub
//      table + extracting U\d+ age groups, with per-side overrides).
//   2. Anthropic Haiku fallback — invoked only when rules fail. Produces
//      structured JSON via tool-use; capped at 4KB reasoning, [0,1]
//      confidence. Aborts to 'unparseable' if confidence < threshold.
//
// All external deps (Anthropic, clock) are dependency-injected so unit
// tests run pure — no API keys, no network. Defaults wire to the real
// Anthropic SDK + Date.now().
//
// Title-format conventions observed:
//   "Forza Skillz U8 VS Barnes Eagles U8"
//   "Roehampton Elite (Green) vs London Thames U7"
//   "NSFC (silver) vs National Harrow (blue) - U7"
//   "Storm Elite (purple) vs JSFC (U10)"
//   "Roehampton Elite (U10) vs ELA (U11)"          ← mixed age, per-side
//   "The A Academy  U9 vs. Roehampton elite"       ← uses "vs."
//   "Match 10 May - Barnes Eagles (red) vs Champs FC"  ← date-prefixed
//
// The rules layer is a port of scripts/plan-lyl-team-assignment.ts so
// behaviour is unchanged for everything that already worked.

import Anthropic from '@anthropic-ai/sdk'
import type { ParseOutcome, ParsedMatch, SubclubRef, LlmCost } from './types'

// =============================================================================
// Constants
// =============================================================================

const LONG_RECORDING_SECONDS = 60 * 60 // 60min
/** Below this LLM confidence we treat the parse as unparseable. */
const LLM_CONFIDENCE_THRESHOLD = 0.6
/** Reasoning text length cap before persistence (defence-in-depth against
 *  malicious title prompt-injection echo + runaway-completion bloat). */
export const REASONING_MAX_BYTES = 4096

// Anthropic Haiku 4.5 pricing as of 2026-05. Bumps here have no behavioural
// impact — only affect the cost field surfaced in the post-run email.
const HAIKU_INPUT_PER_MTOK = 1.0 // $/1M input tokens
const HAIKU_OUTPUT_PER_MTOK = 5.0

// =============================================================================
// Rules-layer helpers
// =============================================================================

/** Drop date prefixes like "Match 10 May 2026 -", "10/05 -", "Match 17 May". */
function stripPrefix(title: string): string {
  return title
    .replace(/^\s*Match\s+\d{1,2}\s+\w+\s+\d{4}\s*[-:–]\s*/i, '')
    .replace(/^\s*\d{1,2}\/\d{1,2}\s*[-:–]?\s*/, '')
}

/** Strip parenthetical kit colours / age qualifiers from a team mention. */
function cleanTeamSide(side: string): string {
  return side
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/U\s*\d+\s*['’]?s?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** First U\d+ in `text`, bounded to U5..U21. */
function findAgeIn(text: string): string | null {
  const m = text.replace(/[‘’]/g, "'").match(/\bU\s*(\d{1,2})\b/i)
  if (!m) return null
  const n = parseInt(m[1], 10)
  if (n < 5 || n > 21) return null
  return `u${n}`
}

/** Longest-first substring match against a subclub's aliases. */
function findSubclubInSide(side: string, subclubs: SubclubRef[]): string | null {
  const lower = side.toLowerCase()
  const candidates = subclubs
    .flatMap((sc) => sc.aliases.map((a) => ({ alias: a.toLowerCase(), slug: sc.slug })))
    .sort((a, b) => b.alias.length - a.alias.length)
  for (const c of candidates) {
    if (lower.includes(c.alias)) return c.slug
  }
  return null
}

/** Pure rules-only attempt. Returns null when the rules layer can't
 *  fully resolve (caller falls back to LLM). */
function tryRules(
  title: string,
  subclubs: SubclubRef[]
): ParsedMatch | null {
  const cleaned = stripPrefix(title)
  // Tolerate "vs ", "v ", "vs." — the period variant comes from LYL
  // admins typing prose-style titles.
  const parts = cleaned.split(/\s+vs?\.?\s+/i)
  if (parts.length !== 2) return null

  const [homeRaw, awayRaw] = parts
  const homeSide = cleanTeamSide(homeRaw)
  const awaySide = cleanTeamSide(awayRaw)
  const homeSlug = findSubclubInSide(homeSide, subclubs)
  const awaySlug = findSubclubInSide(awaySide, subclubs)

  // Per-side age extraction. Search the SIDE's raw text (still has its
  // kit-colour parens + trailing age qualifier), then fall back to the
  // other side's age, then to the title-overall age — handles
  // "X vs Y (U10)" (both sides U10) AND "X (U10) vs Y (U11)" (mixed age).
  const homeAgeExplicit = findAgeIn(homeRaw)
  const awayAgeExplicit = findAgeIn(awayRaw)
  const titleAge = findAgeIn(title)
  const homeAge = homeAgeExplicit ?? awayAgeExplicit ?? titleAge
  const awayAge = awayAgeExplicit ?? homeAgeExplicit ?? titleAge

  // Need ALL four pieces resolved for the rules layer to claim a hit.
  if (!homeSlug || !awaySlug || !homeAge || !awayAge) return null

  return {
    home: { subclubSlug: homeSlug, ageGroup: homeAge },
    away: { subclubSlug: awaySlug, ageGroup: awayAge },
    method: 'rules',
    confidence: null,
    reasoning: null,
    llmAttemptedAt: null,
  }
}

// =============================================================================
// LLM-fallback layer
// =============================================================================

export interface ParserDeps {
  /** Anthropic SDK message-creator. Real impl: anthropic.messages.create. */
  anthropicCreate: (
    request: Anthropic.Messages.MessageCreateParamsNonStreaming
  ) => Promise<Anthropic.Messages.Message>
  /** Test seam for the LLM-attempted-at stamp. Defaults to Date.now wall-clock. */
  now: () => Date
  /** Anthropic model id. Default 'claude-haiku-4-5-20251001' (cheapest reliable). */
  model: string
}

let cachedAnthropic: Anthropic | null = null
function defaultAnthropicCreate(
  request: Anthropic.Messages.MessageCreateParamsNonStreaming
): Promise<Anthropic.Messages.Message> {
  if (!cachedAnthropic) {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key) {
      throw new Error('ANTHROPIC_API_KEY not set — lyl-sync parser cannot LLM-fallback')
    }
    cachedAnthropic = new Anthropic({ apiKey: key })
  }
  return cachedAnthropic.messages.create(request)
}

export function buildDefaultDeps(): ParserDeps {
  return {
    anthropicCreate: defaultAnthropicCreate,
    now: () => new Date(),
    model: 'claude-haiku-4-5-20251001',
  }
}

/** Cap reasoning to REASONING_MAX_BYTES — defence in depth against
 *  prompt-injection echo + runaway completions. Counts BYTES, not chars,
 *  because the storage column is bounded in bytes by the orchestrator's
 *  convention. */
function capReasoning(s: string | null | undefined): string | null {
  if (!s) return null
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= REASONING_MAX_BYTES) return s
  // Slice on a byte boundary that's also a valid UTF-8 boundary — for
  // safety we go to the byte limit then trim back to a valid codepoint.
  return buf.subarray(0, REASONING_MAX_BYTES).toString('utf8') + '…[truncated]'
}

interface LlmCallResult {
  parsed: ParsedMatch | null
  cost: LlmCost
}

async function callLlm(
  title: string,
  subclubs: SubclubRef[],
  deps: ParserDeps
): Promise<LlmCallResult> {
  // Build the subclub catalog the model picks from. Includes the
  // canonical slug + display name so the model can match by either.
  // Listing aliases adds noise that Haiku doesn't need — slug + name
  // is enough for matching.
  const catalog = subclubs
    .slice()
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((sc) => `  - slug: "${sc.slug}", name: "${sc.displayName}"`)
    .join('\n')

  const systemPrompt = `You are a sports-match-title parser for the London Youth League. Given a recording title, extract the home team subclub, away team subclub, and age group for each side.

ALLOWED subclubs (use the slug exactly as given):
${catalog}

ALLOWED age groups: u5, u6, u7, u8, u9, u10, u11, u12, u13, u14, u15, u16, u17, u18, u19, u20, u21.

Rules:
- Format is typically "<Home Team> vs <Away Team>" with optional date prefix and kit-colour parens like "(red)" or "(blue)".
- Age group may be on each side independently ("(U10) vs (U11)" = mixed age) OR shared at the end ("- U7").
- Ignore kit colours.
- If a team name doesn't match ANY subclub in the allowlist, set the slug to null.
- If the age group can't be determined for a side, set it to null.
- Confidence: 1.0 = exact slug + age match for both sides; 0.6 = both teams matched but age inferred; below 0.6 = guesswork.
- Keep reasoning concise (under 300 chars). Plain text only.`

  const userPrompt = `Title: "${title}"

Return the parsed result via the parse_match_title tool.`

  const response = await deps.anthropicCreate({
    model: deps.model,
    max_tokens: 512,
    temperature: 0.2,
    system: systemPrompt,
    tools: [
      {
        name: 'parse_match_title',
        description: 'Return the parsed home + away (subclub, age) and your confidence.',
        input_schema: {
          type: 'object',
          properties: {
            home_subclub_slug: { type: ['string', 'null'] },
            home_age_group: { type: ['string', 'null'] },
            away_subclub_slug: { type: ['string', 'null'] },
            away_age_group: { type: ['string', 'null'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reasoning: { type: 'string', maxLength: 300 },
          },
          required: [
            'home_subclub_slug',
            'home_age_group',
            'away_subclub_slug',
            'away_age_group',
            'confidence',
            'reasoning',
          ],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'parse_match_title' },
    messages: [{ role: 'user', content: userPrompt }],
  })

  const cost: LlmCost = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    costUsd:
      (response.usage.input_tokens / 1_000_000) * HAIKU_INPUT_PER_MTOK +
      (response.usage.output_tokens / 1_000_000) * HAIKU_OUTPUT_PER_MTOK,
  }

  // Extract the tool_use block — Claude returns it in `content` alongside
  // any text. tool_choice forces it to be present.
  const toolUse = response.content.find((b): b is Anthropic.Messages.ToolUseBlock =>
    b.type === 'tool_use'
  )
  if (!toolUse || toolUse.name !== 'parse_match_title') {
    return { parsed: null, cost }
  }
  const args = toolUse.input as {
    home_subclub_slug: string | null
    home_age_group: string | null
    away_subclub_slug: string | null
    away_age_group: string | null
    confidence: number
    reasoning: string
  }

  // Validate the model didn't hallucinate slug/age values outside the
  // allowlist. If it did, fail the parse (downgrade to unparseable
  // rather than persist bad data).
  const validSubclubSlugs = new Set(subclubs.map((s) => s.slug))
  const validAges = new Set([
    'u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'u11', 'u12', 'u13', 'u14',
    'u15', 'u16', 'u17', 'u18', 'u19', 'u20', 'u21',
  ])
  const homeSlugOk = !args.home_subclub_slug || validSubclubSlugs.has(args.home_subclub_slug)
  const awaySlugOk = !args.away_subclub_slug || validSubclubSlugs.has(args.away_subclub_slug)
  const homeAgeOk = !args.home_age_group || validAges.has(args.home_age_group)
  const awayAgeOk = !args.away_age_group || validAges.has(args.away_age_group)
  if (!homeSlugOk || !awaySlugOk || !homeAgeOk || !awayAgeOk) {
    return { parsed: null, cost }
  }
  if (args.confidence < LLM_CONFIDENCE_THRESHOLD) {
    return { parsed: null, cost }
  }
  if (!args.home_subclub_slug || !args.away_subclub_slug || !args.home_age_group || !args.away_age_group) {
    return { parsed: null, cost }
  }

  return {
    parsed: {
      home: { subclubSlug: args.home_subclub_slug, ageGroup: args.home_age_group },
      away: { subclubSlug: args.away_subclub_slug, ageGroup: args.away_age_group },
      method: 'llm',
      confidence: args.confidence,
      reasoning: capReasoning(args.reasoning),
      llmAttemptedAt: deps.now(),
    },
    cost,
  }
}

// =============================================================================
// Main entry point
// =============================================================================

export interface ParseRecordingInput {
  title: string
  durationSeconds: number
  /** Whether to invoke the LLM when rules fail. Default true. Set false
   *  for re-runs that should respect a previous llm_attempted_at without
   *  re-billing. */
  allowLlmFallback?: boolean
}

export interface ParseRecordingResult {
  outcome: ParseOutcome
  /** Set ONLY when the LLM was actually invoked. Aggregated into the
   *  sync_run's total cost. */
  llmCost: LlmCost | null
}

export async function parseRecording(
  input: ParseRecordingInput,
  subclubs: SubclubRef[],
  deps: ParserDeps = buildDefaultDeps()
): Promise<ParseRecordingResult> {
  // 1. Too-long bypass (>60min == multi-match dump, per user policy).
  if (input.durationSeconds > LONG_RECORDING_SECONDS) {
    return {
      outcome: { kind: 'too_long', durationSeconds: input.durationSeconds },
      llmCost: null,
    }
  }

  // 2. Rules-first.
  const ruleHit = tryRules(input.title, subclubs)
  if (ruleHit) {
    // Intra-team check happens AFTER parse (handles ELA U11 C vs ELA
    // U11 B style scrimmages). When home === away (slug + age both
    // match) we surface as intra_team — orchestrator skips the share+accept.
    const intra =
      ruleHit.home!.subclubSlug === ruleHit.away!.subclubSlug &&
      ruleHit.home!.ageGroup === ruleHit.away!.ageGroup
    return {
      outcome: intra
        ? { kind: 'intra_team', parsed: ruleHit }
        : { kind: 'eligible', parsed: ruleHit },
      llmCost: null,
    }
  }

  // 3. LLM fallback (unless caller opted out).
  if (input.allowLlmFallback === false) {
    return {
      outcome: { kind: 'unparseable', reason: 'rules failed; LLM fallback disabled' },
      llmCost: null,
    }
  }

  let llmResult: LlmCallResult
  try {
    llmResult = await callLlm(input.title, subclubs, deps)
  } catch (err) {
    return {
      outcome: {
        kind: 'unparseable',
        reason: `LLM call threw: ${err instanceof Error ? err.message : String(err)}`,
      },
      llmCost: null,
    }
  }
  if (!llmResult.parsed) {
    return {
      outcome: {
        kind: 'unparseable',
        reason: `LLM returned no usable parse (confidence threshold or slug allowlist failed)`,
      },
      llmCost: llmResult.cost,
    }
  }

  const intra =
    llmResult.parsed.home!.subclubSlug === llmResult.parsed.away!.subclubSlug &&
    llmResult.parsed.home!.ageGroup === llmResult.parsed.away!.ageGroup
  return {
    outcome: intra
      ? { kind: 'intra_team', parsed: llmResult.parsed }
      : { kind: 'eligible', parsed: llmResult.parsed },
    llmCost: llmResult.cost,
  }
}
