// Unit tests for the LYL recording title parser.
//
// All external deps (Anthropic SDK, clock) are dependency-injected so
// these tests never hit the network or burn tokens. Real Anthropic
// integration is validated via a one-shot script the orchestrator's
// smoke test will run during Stage D.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseRecording, REASONING_MAX_BYTES, type ParserDeps } from '../parser'
import type { SubclubRef, ParseOutcome } from '../types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Mirrors what the orchestrator loads from playhub_academy_subclubs.
// Aliases match the actual title spellings observed in LYL Veo.
const SUBCLUBS: SubclubRef[] = [
  {
    slug: 'taa',
    displayName: 'TAA',
    aliases: [
      'The A Academy',
      'The A academy',
      'A Academy',
      'A academy',
      'TAA',
    ],
  },
  { slug: 'ela', displayName: 'ELA', aliases: ['ELA'] },
  { slug: 'lfs', displayName: 'LFS', aliases: ['LFS'] },
  {
    slug: 'rpt',
    displayName: 'RPT',
    aliases: ['Rugby Portobello Trust', 'RPT'],
  },
  { slug: 'nsfc', displayName: 'N.S.F.C', aliases: ['N.S.F.C', 'NSFC'] },
  { slug: 'jsfc', displayName: 'JSFC', aliases: ['JSFC'] },
  {
    slug: 'barnes-eagles',
    displayName: 'Barnes Eagles',
    aliases: ['Barnes Eagles'],
  },
  {
    slug: 'champs-fc',
    displayName: 'Champs FC',
    aliases: ['Champs FC', 'Champs'],
  },
  {
    slug: 'chosen-one',
    displayName: 'Chosen One',
    aliases: ['Chosen one FC', 'Chosen One'],
  },
  {
    slug: 'london-thames',
    displayName: 'London Thames',
    aliases: ['London Thames'],
  },
  {
    slug: 'national-harrow',
    displayName: 'National Harrow',
    aliases: ['National Harrow'],
  },
  {
    slug: 'roehampton-elite',
    displayName: 'Roehampton Elite',
    aliases: ['Roehampton Elite', 'Roehampton'],
  },
  { slug: 'storm-elite', displayName: 'Storm Elite', aliases: ['Storm Elite'] },
  {
    slug: 'forzaskillz',
    displayName: 'Forzaskillz',
    aliases: ['Forzaskillz', 'Forza skillz', 'Forza Skillz'],
  },
  {
    slug: 'rockslane-chiswick',
    displayName: 'Rockslane Chiswick',
    aliases: ['Rockslane Chiswick'],
  },
  {
    slug: 'elite-london-academy',
    displayName: 'Elite London Academy',
    aliases: ['Elite London Academy', 'Elite London academy'],
  },
]

const FROZEN_NOW = new Date('2026-05-17T12:00:00Z')

function makeDeps(overrides: Partial<ParserDeps> = {}): ParserDeps {
  return {
    // Default mock: returns a tool-use response the test customises per
    // case via overrides. Tests that DON'T expect the LLM to be called
    // should leave this unmocked — its `vi.fn` rejects with a marker
    // string if invoked, which the test then asserts on.
    anthropicCreate: vi.fn(async () => {
      throw new Error('LLM should not have been called for this case')
    }),
    now: () => FROZEN_NOW,
    model: 'claude-haiku-4-5-test',
    ...overrides,
  }
}

function expectEligible(
  o: ParseOutcome
): Extract<ParseOutcome, { kind: 'eligible' }> {
  expect(o.kind).toBe('eligible')
  return o as Extract<ParseOutcome, { kind: 'eligible' }>
}
function expectIntra(o: ParseOutcome) {
  expect(o.kind).toBe('intra_team')
  return o as Extract<ParseOutcome, { kind: 'intra_team' }>
}
function expectUnparseable(o: ParseOutcome) {
  expect(o.kind).toBe('unparseable')
  return o as Extract<ParseOutcome, { kind: 'unparseable' }>
}

/** Build a fake Anthropic tool-use response for parser tests. */
function makeToolUseResponse(args: {
  home_subclub_slug: string | null
  home_age_group: string | null
  away_subclub_slug: string | null
  away_age_group: string | null
  confidence: number
  reasoning?: string
  inputTokens?: number
  outputTokens?: number
}) {
  return {
    id: 'msg_test',
    type: 'message' as const,
    role: 'assistant' as const,
    model: 'claude-haiku-4-5-test',
    stop_reason: 'tool_use' as const,
    stop_sequence: null,
    usage: {
      input_tokens: args.inputTokens ?? 100,
      output_tokens: args.outputTokens ?? 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    content: [
      {
        type: 'tool_use' as const,
        id: 'toolu_test',
        name: 'parse_match_title',
        input: {
          home_subclub_slug: args.home_subclub_slug,
          home_age_group: args.home_age_group,
          away_subclub_slug: args.away_subclub_slug,
          away_age_group: args.away_age_group,
          confidence: args.confidence,
          reasoning: args.reasoning ?? '',
        },
      },
    ],
  } as any
}

// ---------------------------------------------------------------------------
// Rules-layer tests (no LLM expected)
// ---------------------------------------------------------------------------

describe('parseRecording — rules layer', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([
    // Each case is a real LYL title from the production probe.
    {
      title: 'Forza Skillz U8 VS Barnes Eagles U8',
      home: 'forzaskillz',
      away: 'barnes-eagles',
      ageHome: 'u8',
      ageAway: 'u8',
    },
    {
      title: 'NSFC (silver) vs National Harrow (blue) - U7',
      home: 'nsfc',
      away: 'national-harrow',
      ageHome: 'u7',
      ageAway: 'u7',
    },
    {
      title: 'Storm Elite (purple) vs JSFC (U10)',
      home: 'storm-elite',
      away: 'jsfc',
      ageHome: 'u10',
      ageAway: 'u10',
    },
    {
      title: 'The A Academy (Red) vs Rockslane Chiswick - U7',
      home: 'taa',
      away: 'rockslane-chiswick',
      ageHome: 'u7',
      ageAway: 'u7',
    },
    {
      title: 'LFS (Yellow) vs Rugby Portobello Trust (U8)',
      home: 'lfs',
      away: 'rpt',
      ageHome: 'u8',
      ageAway: 'u8',
    },
    {
      title: 'Chosen one FC (BLUE) vs Forzaskillz (U11)',
      home: 'chosen-one',
      away: 'forzaskillz',
      ageHome: 'u11',
      ageAway: 'u11',
    },
  ])(
    'parses common title shape: "$title"',
    async ({ title, home, away, ageHome, ageAway }) => {
      const deps = makeDeps()
      const r = await parseRecording(
        { title, durationSeconds: 2700 },
        SUBCLUBS,
        deps
      )
      const ok = expectEligible(r.outcome)
      expect(ok.parsed.home).toEqual({ subclubSlug: home, ageGroup: ageHome })
      expect(ok.parsed.away).toEqual({ subclubSlug: away, ageGroup: ageAway })
      expect(ok.parsed.method).toBe('rules')
      expect(ok.parsed.confidence).toBeNull()
      expect(ok.parsed.llmAttemptedAt).toBeNull()
      expect(r.llmCost).toBeNull()
      // CRITICAL: rules-resolved titles must NOT call the LLM.
      expect(deps.anthropicCreate).not.toHaveBeenCalled()
    }
  )

  it('handles mixed-age fixture: "Roehampton Elite (U10) vs ELA (U11)" → distinct per-side ages', async () => {
    const deps = makeDeps()
    const r = await parseRecording(
      { title: 'Roehampton Elite (U10) vs ELA (U11)', durationSeconds: 2700 },
      SUBCLUBS,
      deps
    )
    const ok = expectEligible(r.outcome)
    expect(ok.parsed.home).toEqual({
      subclubSlug: 'roehampton-elite',
      ageGroup: 'u10',
    })
    expect(ok.parsed.away).toEqual({ subclubSlug: 'ela', ageGroup: 'u11' })
  })

  it('tolerates "vs." (with period)', async () => {
    const deps = makeDeps()
    const r = await parseRecording(
      { title: 'The A Academy U9 vs. Roehampton elite', durationSeconds: 2700 },
      SUBCLUBS,
      deps
    )
    const ok = expectEligible(r.outcome)
    expect(ok.parsed.home!.subclubSlug).toBe('taa')
    expect(ok.parsed.away!.subclubSlug).toBe('roehampton-elite')
    // Age propagated from home side to away side (away had no explicit age).
    expect(ok.parsed.home!.ageGroup).toBe('u9')
    expect(ok.parsed.away!.ageGroup).toBe('u9')
  })

  it('strips Match-date prefix: "Match 10 May 2026 - Barnes Eagles vs Champs FC U8"', async () => {
    const deps = makeDeps()
    const r = await parseRecording(
      {
        title: 'Match 10 May 2026 - Barnes Eagles vs Champs FC U8',
        durationSeconds: 2700,
      },
      SUBCLUBS,
      deps
    )
    const ok = expectEligible(r.outcome)
    expect(ok.parsed.home!.subclubSlug).toBe('barnes-eagles')
    expect(ok.parsed.away!.subclubSlug).toBe('champs-fc')
  })

  it('strips YEAR-LESS Match-date prefix: "Match 10 May - Barnes Eagles vs Champs FC U8"', async () => {
    const deps = makeDeps()
    const r = await parseRecording(
      {
        title: 'Match 10 May - Barnes Eagles vs Champs FC U8',
        durationSeconds: 2700,
      },
      SUBCLUBS,
      deps
    )
    const ok = expectEligible(r.outcome)
    expect(ok.parsed.home!.subclubSlug).toBe('barnes-eagles')
    expect(ok.parsed.away!.subclubSlug).toBe('champs-fc')
    expect(deps.anthropicCreate).not.toHaveBeenCalled()
  })

  it('matches "A Academy" to taa (operator drops the leading "The"): "RPT U8 VS A Academy U8"', async () => {
    const deps = makeDeps()
    const r = await parseRecording(
      { title: 'RPT U8 VS A Academy U8', durationSeconds: 2700 },
      SUBCLUBS,
      deps
    )
    const ok = expectEligible(r.outcome)
    expect(ok.parsed.home).toEqual({ subclubSlug: 'rpt', ageGroup: 'u8' })
    expect(ok.parsed.away).toEqual({ subclubSlug: 'taa', ageGroup: 'u8' })
    expect(deps.anthropicCreate).not.toHaveBeenCalled()
  })

  it('recovers a MISSING age from the current Veo folder (teamHint): "Forza skillz vs Barnes Eagles" filed under "Barnes Eagles U8"', async () => {
    const deps = makeDeps()
    const r = await parseRecording(
      {
        title: '10/05 Forza skillz vs Barnes Eagles',
        durationSeconds: 2700,
        teamHint: 'Barnes Eagles U8',
      },
      SUBCLUBS,
      deps
    )
    const ok = expectEligible(r.outcome)
    // Age comes from the folder; both youth sides share it.
    expect(ok.parsed.home).toEqual({
      subclubSlug: 'forzaskillz',
      ageGroup: 'u8',
    })
    expect(ok.parsed.away).toEqual({
      subclubSlug: 'barnes-eagles',
      ageGroup: 'u8',
    })
    expect(ok.parsed.method).toBe('rules')
    expect(deps.anthropicCreate).not.toHaveBeenCalled()
  })

  it('an EXPLICIT title age still wins over the folder hint', async () => {
    const deps = makeDeps()
    const r = await parseRecording(
      {
        title: 'Barnes Eagles U10 vs Champs FC U10',
        durationSeconds: 2700,
        teamHint: 'Barnes Eagles U8', // stale/wrong folder must not override
      },
      SUBCLUBS,
      deps
    )
    const ok = expectEligible(r.outcome)
    expect(ok.parsed.home!.ageGroup).toBe('u10')
    expect(ok.parsed.away!.ageGroup).toBe('u10')
  })

  it('an age-less title with NO folder hint stays unparseable (never invents an age)', async () => {
    // Without a hint the rules layer must NOT guess — it falls through to the
    // LLM (mocked here to also decline), landing unparseable.
    const deps = makeDeps({
      anthropicCreate: vi.fn(async () =>
        makeToolUseResponse({
          home_subclub_slug: 'barnes-eagles',
          home_age_group: null,
          away_subclub_slug: 'champs-fc',
          away_age_group: null,
          confidence: 0.5,
        })
      ),
    })
    const r = await parseRecording(
      { title: 'Barnes Eagles vs Champs FC', durationSeconds: 2700 },
      SUBCLUBS,
      deps
    )
    expectUnparseable(r.outcome)
  })

  it('detects intra-team scrimmage: "ELA U11 C vs ELA U11 B"', async () => {
    const deps = makeDeps()
    const r = await parseRecording(
      { title: 'ELA U11 C vs ELA U11 B', durationSeconds: 2700 },
      SUBCLUBS,
      deps
    )
    const intra = expectIntra(r.outcome)
    expect(intra.parsed.home!.subclubSlug).toBe('ela')
    expect(intra.parsed.away!.subclubSlug).toBe('ela')
    expect(intra.parsed.home!.ageGroup).toBe('u11')
    // Rules-layer should still resolve without LLM for the intra case.
    expect(deps.anthropicCreate).not.toHaveBeenCalled()
  })

  it('classifies >60min recordings as too_long BEFORE parsing', async () => {
    const deps = makeDeps()
    const r = await parseRecording(
      { title: 'Match 25 Apr 2026', durationSeconds: 60 * 90 }, // 90 min
      SUBCLUBS,
      deps
    )
    expect(r.outcome.kind).toBe('too_long')
    if (r.outcome.kind === 'too_long') {
      expect(r.outcome.durationSeconds).toBe(60 * 90)
    }
    // Should not even attempt parse (LLM stays untouched).
    expect(deps.anthropicCreate).not.toHaveBeenCalled()
  })

  it('preserves the longer alias when both could match — "The A Academy" beats "TAA"', async () => {
    const deps = makeDeps()
    const r = await parseRecording(
      { title: 'The A Academy vs JSFC U9', durationSeconds: 2700 },
      SUBCLUBS,
      deps
    )
    const ok = expectEligible(r.outcome)
    expect(ok.parsed.home!.subclubSlug).toBe('taa')
    expect(ok.parsed.away!.subclubSlug).toBe('jsfc')
  })
})

// ---------------------------------------------------------------------------
// LLM-fallback layer
// ---------------------------------------------------------------------------

describe('parseRecording — LLM fallback', () => {
  beforeEach(() => vi.clearAllMocks())

  it('invokes LLM when rules fail + accepts high-confidence response', async () => {
    const anthropicCreate = vi.fn(async () =>
      makeToolUseResponse({
        home_subclub_slug: 'taa',
        home_age_group: 'u9',
        away_subclub_slug: 'roehampton-elite',
        away_age_group: 'u9',
        confidence: 0.95,
        reasoning: 'Matched via aliasing — title used a colloquial spelling.',
        inputTokens: 1200,
        outputTokens: 80,
      })
    )
    const deps = makeDeps({ anthropicCreate })
    const r = await parseRecording(
      { title: 'Weird format — TAA9 ~~~ Roehampton9', durationSeconds: 2700 },
      SUBCLUBS,
      deps
    )
    const ok = expectEligible(r.outcome)
    expect(ok.parsed.method).toBe('llm')
    expect(ok.parsed.confidence).toBe(0.95)
    expect(ok.parsed.reasoning).toContain('aliasing')
    expect(ok.parsed.llmAttemptedAt).toEqual(FROZEN_NOW)
    expect(r.llmCost?.inputTokens).toBe(1200)
    expect(r.llmCost?.outputTokens).toBe(80)
    // Haiku 4.5 pricing: $1/M in + $5/M out → 1200/1M*1 + 80/1M*5 = 0.0016
    // Use toBeCloseTo to absorb IEEE-754 noise (raw math gives e.g.
    // 0.00159999...). 7-digit precision is well within budget for cost
    // reporting and immune to floating-point drift on different platforms.
    expect(r.llmCost?.costUsd).toBeCloseTo(0.0016, 7)
    expect(anthropicCreate).toHaveBeenCalledOnce()
  })

  it('rejects below-confidence-threshold LLM response → unparseable', async () => {
    const anthropicCreate = vi.fn(async () =>
      makeToolUseResponse({
        home_subclub_slug: 'taa',
        home_age_group: 'u9',
        away_subclub_slug: 'roehampton-elite',
        away_age_group: 'u9',
        confidence: 0.3, // below 0.6 threshold
        reasoning: 'Just guessing here',
      })
    )
    const deps = makeDeps({ anthropicCreate })
    const r = await parseRecording(
      { title: 'random garbage no team names', durationSeconds: 2700 },
      SUBCLUBS,
      deps
    )
    const fail = expectUnparseable(r.outcome)
    expect(fail.reason).toMatch(/threshold/i)
    // Cost is still recorded — we paid for the call even though we discarded the parse.
    expect(r.llmCost).not.toBeNull()
  })

  it('rejects LLM hallucinations of unknown subclub slugs', async () => {
    const anthropicCreate = vi.fn(async () =>
      makeToolUseResponse({
        home_subclub_slug: 'made-up-team', // NOT in subclubs allowlist
        home_age_group: 'u9',
        away_subclub_slug: 'taa',
        away_age_group: 'u9',
        confidence: 0.95,
        reasoning: 'Confident but wrong slug',
      })
    )
    const deps = makeDeps({ anthropicCreate })
    const r = await parseRecording(
      { title: 'Made Up Team vs The A Academy U9', durationSeconds: 2700 },
      SUBCLUBS,
      deps
    )
    expectUnparseable(r.outcome)
  })

  it('rejects LLM hallucinations of invalid age groups', async () => {
    const anthropicCreate = vi.fn(async () =>
      makeToolUseResponse({
        home_subclub_slug: 'taa',
        home_age_group: 'u99', // out of bounds (5..21)
        away_subclub_slug: 'jsfc',
        away_age_group: 'u9',
        confidence: 0.95,
        reasoning: '',
      })
    )
    const deps = makeDeps({ anthropicCreate })
    const r = await parseRecording(
      { title: 'TAA vs JSFC', durationSeconds: 2700 },
      SUBCLUBS,
      deps
    )
    expectUnparseable(r.outcome)
  })

  it('rejects LLM responses missing one side', async () => {
    const anthropicCreate = vi.fn(async () =>
      makeToolUseResponse({
        home_subclub_slug: 'taa',
        home_age_group: 'u9',
        away_subclub_slug: null,
        away_age_group: null,
        confidence: 0.9,
        reasoning: 'Only one team recognisable',
      })
    )
    const deps = makeDeps({ anthropicCreate })
    const r = await parseRecording(
      { title: 'TAA vs ???', durationSeconds: 2700 },
      SUBCLUBS,
      deps
    )
    expectUnparseable(r.outcome)
  })

  it('caps reasoning text at REASONING_MAX_BYTES', async () => {
    // Simulate a Claude response that returns a very long reasoning string
    // (e.g. prompt-injection echo back). The parser must truncate.
    const longReasoning = 'A'.repeat(REASONING_MAX_BYTES + 5000)
    const anthropicCreate = vi.fn(async () =>
      makeToolUseResponse({
        home_subclub_slug: 'taa',
        home_age_group: 'u9',
        away_subclub_slug: 'jsfc',
        away_age_group: 'u9',
        confidence: 0.95,
        reasoning: longReasoning,
      })
    )
    const deps = makeDeps({ anthropicCreate })
    const r = await parseRecording(
      { title: 'TAA vs JSFC', durationSeconds: 2700 },
      SUBCLUBS,
      deps
    )
    const ok = expectEligible(r.outcome)
    expect(ok.parsed.reasoning).toBeDefined()
    expect(Buffer.byteLength(ok.parsed.reasoning!, 'utf8')).toBeLessThanOrEqual(
      REASONING_MAX_BYTES + 100 // small margin for the "…[truncated]" suffix
    )
    expect(ok.parsed.reasoning).toMatch(/\[truncated\]$/)
  })

  it('returns unparseable + null cost when LLM throws', async () => {
    const anthropicCreate = vi.fn(async () => {
      throw new Error('Anthropic API rate limit exceeded')
    })
    const deps = makeDeps({ anthropicCreate })
    const r = await parseRecording(
      { title: 'something weird', durationSeconds: 2700 },
      SUBCLUBS,
      deps
    )
    const fail = expectUnparseable(r.outcome)
    expect(fail.reason).toMatch(/rate limit/i)
    expect(r.llmCost).toBeNull()
  })

  it('opt-out: allowLlmFallback=false skips LLM call entirely', async () => {
    const anthropicCreate = vi.fn()
    const deps = makeDeps({ anthropicCreate })
    const r = await parseRecording(
      {
        title: 'weird unparseable thing',
        durationSeconds: 2700,
        allowLlmFallback: false,
      },
      SUBCLUBS,
      deps
    )
    expectUnparseable(r.outcome)
    expect(anthropicCreate).not.toHaveBeenCalled()
  })
})
