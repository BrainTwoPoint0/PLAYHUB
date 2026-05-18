// Orchestrator unit tests — covers the critical paths: happy path,
// idempotency, operator-lock, intra-team, too-long, unparseable, auto-
// correct, per-recording failure isolation, run counts.
//
// Supabase + Veo + parser are all dependency-injected. We use a tiny
// in-memory Supabase fake (just enough for the orchestrator's queries +
// upserts) instead of the real client.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runSync, type RunSyncDeps, type VeoClientSurface } from '../orchestrator'
import type { ParseOutcome } from '../types'

// ---------------------------------------------------------------------------
// In-memory Supabase fake
// ---------------------------------------------------------------------------

class FakeSupabase {
  subclubs = new Map<string, { subclub_slug: string; display_name: string; is_active: boolean; club_slug: string }>()
  assignments = new Map<string, any>() // key: `${league}:${slug}`
  runs = new Map<string, any>()
  nextRunId = 1

  seedSubclub(clubSlug: string, slug: string, displayName: string) {
    this.subclubs.set(`${clubSlug}:${slug}`, {
      club_slug: clubSlug,
      subclub_slug: slug,
      display_name: displayName,
      is_active: true,
    })
  }

  /** Minimal query-builder shim that handles only the orchestrator's
   *  exact call shapes. Throws on any unknown shape so we fail loudly
   *  if a new query is added without test updates. */
  from(table: string): any {
    const self = this
    if (table === 'playhub_academy_subclubs') {
      return {
        select: () => ({
          eq: (col1: string, val1: any) => ({
            eq: (col2: string, val2: any) => ({
              async then(resolve: any) {
                if (col1 !== 'club_slug' || col2 !== 'is_active')
                  throw new Error(`unexpected subclubs query ${col1}/${col2}`)
                const rows = [...self.subclubs.values()].filter(
                  (s) => s.club_slug === val1 && s.is_active === val2
                )
                resolve({ data: rows, error: null })
              },
            }),
          }),
        }),
      }
    }
    if (table === 'playhub_recording_assignments') {
      return {
        select: () => ({
          eq: (c1: string, v1: any) => ({
            eq: (c2: string, v2: any) => ({
              maybeSingle: async () => {
                if (c1 !== 'league_club_slug' || c2 !== 'recording_slug')
                  throw new Error(`unexpected assignments query ${c1}/${c2}`)
                return { data: self.assignments.get(`${v1}:${v2}`) ?? null, error: null }
              },
            }),
          }),
        }),
        upsert: (rowOrArray: any) => ({
          // Real db.ts now wraps the row as `[row]` to access Supabase's
          // array-overload `defaultToNull: false` option; mock has to
          // tolerate either shape. Returns `.select()` thenable with an
          // array `data` payload (matching the production code path).
          select: () => {
            const row = Array.isArray(rowOrArray) ? rowOrArray[0] : rowOrArray
            const key = `${row.league_club_slug}:${row.recording_slug}`
            const existing = self.assignments.get(key) ?? {}
            const merged = { ...existing, ...row, id: existing.id ?? `as-${self.assignments.size + 1}` }
            self.assignments.set(key, merged)
            const result = { data: [merged], error: null }
            // Thenable so `await .select()` resolves; keeps `.single()`
            // for any legacy caller that still chains it.
            return {
              then: (cb: (v: typeof result) => unknown) => cb(result),
              single: async () => ({ data: merged, error: null }),
            }
          },
        }),
      }
    }
    if (table === 'playhub_recording_sync_runs') {
      return {
        insert: (row: any) => ({
          select: () => ({
            single: async () => {
              const id = `run-${self.nextRunId++}`
              self.runs.set(id, { id, ...row })
              return { data: { id }, error: null }
            },
          }),
        }),
        update: (patch: any) => ({
          eq: async (_c: string, id: string) => {
            const r = self.runs.get(id)
            if (r) self.runs.set(id, { ...r, ...patch })
            return { error: null }
          },
        }),
      }
    }
    throw new Error(`FakeSupabase: unhandled table ${table}`)
  }
}

// ---------------------------------------------------------------------------
// Veo client fake
// ---------------------------------------------------------------------------

function makeVeo(overrides: Partial<VeoClientSurface> = {}): VeoClientSurface {
  return {
    listClubTeams: vi.fn(async () => []),
    listRecordings: vi.fn(async () => []),
    getRecordingUUID: vi.fn(async (slug: string) => ({
      id: `uuid-of-${slug}`,
      start: '2026-05-10T12:00:00Z',
      end: '2026-05-10T13:00:00Z',
      title: slug,
    })),
    createTeam: vi.fn(async (input) => ({
      id: `team-id-${input.name.replace(/\s+/g, '-').toLowerCase()}`,
      slug: input.name.toLowerCase().replace(/\s+/g, '-'),
    })),
    assignRecordingToTeam: vi.fn(async () => {}),
    createShareInvitation: vi.fn(async () => ({ key: 'share-key-abc' })),
    acceptShareInvitation: vi.fn(async () => ({ slug: 'accepted-slug' })),
    ...overrides,
  }
}

// Parser factory injected into RunSyncDeps. Tests build a fake parser
// that returns canned outcomes per recording title.
function makeParserFactory(
  outcomes: Map<string, ParseOutcome>,
  llmCostByTitle: Map<string, { inputTokens: number; outputTokens: number; costUsd: number }> = new Map()
) {
  return () =>
    ({
      anthropicCreate: vi.fn(),
      now: () => new Date('2026-05-17T12:00:00Z'),
      model: 'test',
      __outcomes: outcomes,
      __costs: llmCostByTitle,
    }) as any
}

// We replace the actual parseRecording with a test-injected version by
// importing the orchestrator module fresh and overriding via vi.mock.
import { parseRecording } from '../parser'
vi.mock('../parser', async () => {
  return {
    parseRecording: vi.fn(),
    buildDefaultDeps: () => ({ anthropicCreate: vi.fn(), now: () => new Date(), model: 'test' }),
  }
})

const mockedParse = vi.mocked(parseRecording)

function setupParse(outcomes: Map<string, ParseOutcome>, costs: Map<string, any> = new Map()) {
  mockedParse.mockImplementation(async (input) => {
    const o = outcomes.get(input.title)
    if (!o) throw new Error(`no canned outcome for title "${input.title}"`)
    return { outcome: o, llmCost: costs.get(input.title) ?? null }
  })
}

function makeDeps(supabase: FakeSupabase, veo: VeoClientSurface): RunSyncDeps {
  return {
    supabase: supabase as any,
    veo,
    parserFactory: () => ({ anthropicCreate: vi.fn(), now: () => new Date(), model: 'test' }),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSync orchestrator', () => {
  beforeEach(() => vi.clearAllMocks())

  it('happy path: 1 new recording → parsed → home assigned → share-accept → fully_assigned', async () => {
    const db = new FakeSupabase()
    db.seedSubclub('lyl', 'taa', 'TAA')
    db.seedSubclub('lyl', 'jsfc', 'JSFC')

    const veo = makeVeo({
      listClubTeams: vi.fn(async () => []),
      listRecordings: vi.fn(async () => [
        { slug: 'rec-1', title: 'TAA vs JSFC', duration: 2700, match_date: '2026-05-10', team: null },
      ]),
    })

    setupParse(
      new Map([
        ['TAA vs JSFC', {
          kind: 'eligible',
          parsed: {
            home: { subclubSlug: 'taa', ageGroup: 'u9' },
            away: { subclubSlug: 'jsfc', ageGroup: 'u9' },
            method: 'rules', confidence: null, reasoning: null, llmAttemptedAt: null,
          },
        }],
      ])
    )

    const r = await runSync({
      leagueClubSlug: 'lyl', trigger: 'cron',
      shareRecipientEmail: 'admin@example.com',
    }, makeDeps(db, veo))

    expect(r.status).toBe('succeeded')
    expect(r.counts).toMatchObject({
      veoRecordingsSeen: 1, newRecordings: 1,
      rulesParsed: 1, llmParsed: 0, unparseable: 0,
      homeAssignments: 1, shareAccepts: 1, autoCorrections: 0, failures: 0,
    })
    // Verify Veo writes happened. assignRecordingToTeam is called TWICE:
    // once for the original (home-team patch in step 6a), then again as the
    // belt-and-braces explicit assign for the share-copy in step 9a
    // (Veo's acceptShareInvitation `teamUUID` is empirically unreliable, so
    // we force the placement via a direct PATCH after every accept).
    expect(veo.createTeam).toHaveBeenCalledTimes(2)
    expect(veo.assignRecordingToTeam).toHaveBeenCalledTimes(2)
    expect(veo.createShareInvitation).toHaveBeenCalledTimes(1)
    expect(veo.acceptShareInvitation).toHaveBeenCalledTimes(1)
    // Verify the assignment row reflects fully_assigned.
    const row = db.assignments.get('lyl:rec-1')
    expect(row.status).toBe('fully_assigned')
    expect(row.home_team_uuid).toMatch(/^team-id-/)
    expect(row.away_team_uuid).toMatch(/^team-id-/)
    expect(row.away_share_key).toBe('share-key-abc')
  })

  it('idempotency: existing fully_assigned row + correct Veo team → no share-accept call', async () => {
    const db = new FakeSupabase()
    db.seedSubclub('lyl', 'taa', 'TAA')
    db.seedSubclub('lyl', 'jsfc', 'JSFC')
    db.assignments.set('lyl:rec-1', {
      league_club_slug: 'lyl', recording_slug: 'rec-1', status: 'fully_assigned',
      home_team_slug: 'taa-u9', away_team_uuid: 'team-id-jsfc-u9',
      away_accepted_recording_uuid: 'accepted-slug',
      away_share_key: 'old-key',
    })
    const veo = makeVeo({
      listClubTeams: vi.fn(async () => [
        { id: 'team-id-taa-u9', slug: 'taa-u9', name: 'TAA U9' },
        { id: 'team-id-jsfc-u9', slug: 'jsfc-u9', name: 'JSFC U9' },
      ]),
      listRecordings: vi.fn(async () => [
        { slug: 'rec-1', title: 'TAA vs JSFC', duration: 2700, match_date: '2026-05-10', team: 'TAA U9' },
      ]),
    })

    setupParse(
      new Map([
        ['TAA vs JSFC', {
          kind: 'eligible',
          parsed: {
            home: { subclubSlug: 'taa', ageGroup: 'u9' },
            away: { subclubSlug: 'jsfc', ageGroup: 'u9' },
            method: 'rules', confidence: null, reasoning: null, llmAttemptedAt: null,
          },
        }],
      ])
    )

    const r = await runSync({
      leagueClubSlug: 'lyl', trigger: 'cron',
      shareRecipientEmail: 'admin@example.com',
    }, makeDeps(db, veo))

    expect(r.counts.homeAssignments).toBe(0)  // already on correct team
    expect(r.counts.shareAccepts).toBe(0)     // already away-assigned
    expect(veo.assignRecordingToTeam).not.toHaveBeenCalled()
    expect(veo.createShareInvitation).not.toHaveBeenCalled()
    expect(veo.acceptShareInvitation).not.toHaveBeenCalled()
  })

  it('operator_locked: skips the recording entirely', async () => {
    const db = new FakeSupabase()
    db.seedSubclub('lyl', 'taa', 'TAA')
    db.seedSubclub('lyl', 'jsfc', 'JSFC')
    db.assignments.set('lyl:rec-1', {
      league_club_slug: 'lyl', recording_slug: 'rec-1', status: 'operator_locked',
    })
    const veo = makeVeo({
      listClubTeams: vi.fn(async () => []),
      listRecordings: vi.fn(async () => [
        { slug: 'rec-1', title: 'TAA vs JSFC', duration: 2700, match_date: null, team: null },
      ]),
    })

    setupParse(new Map())  // should never be called

    const r = await runSync({
      leagueClubSlug: 'lyl', trigger: 'cron', shareRecipientEmail: 'admin@example.com',
    }, makeDeps(db, veo))

    expect(r.counts.homeAssignments).toBe(0)
    expect(veo.getRecordingUUID).not.toHaveBeenCalled()
    expect(mockedParse).not.toHaveBeenCalled()
  })

  it('intra-team: home === away → assigns home only, skips share-accept, status=intra_team', async () => {
    const db = new FakeSupabase()
    db.seedSubclub('lyl', 'ela', 'ELA')
    const veo = makeVeo({
      listClubTeams: vi.fn(async () => []),
      listRecordings: vi.fn(async () => [
        { slug: 'rec-1', title: 'ELA U11 C vs ELA U11 B', duration: 2700, match_date: null, team: null },
      ]),
    })

    setupParse(
      new Map([
        ['ELA U11 C vs ELA U11 B', {
          kind: 'intra_team',
          parsed: {
            home: { subclubSlug: 'ela', ageGroup: 'u11' },
            away: { subclubSlug: 'ela', ageGroup: 'u11' },
            method: 'rules', confidence: null, reasoning: null, llmAttemptedAt: null,
          },
        }],
      ])
    )

    const r = await runSync({
      leagueClubSlug: 'lyl', trigger: 'cron', shareRecipientEmail: 'admin@example.com',
    }, makeDeps(db, veo))

    expect(r.counts.homeAssignments).toBe(1)
    expect(r.counts.shareAccepts).toBe(0)
    expect(veo.acceptShareInvitation).not.toHaveBeenCalled()
    const row = db.assignments.get('lyl:rec-1')
    expect(row.status).toBe('intra_team')
  })

  it('too_long: persists as too_long, no Veo writes, no parser call beyond too-long detection', async () => {
    const db = new FakeSupabase()
    db.seedSubclub('lyl', 'taa', 'TAA')
    const veo = makeVeo({
      listClubTeams: vi.fn(async () => []),
      listRecordings: vi.fn(async () => [
        { slug: 'long-1', title: 'Match 25 Apr 2026', duration: 60 * 90, match_date: null, team: null },
      ]),
    })

    setupParse(
      new Map([
        ['Match 25 Apr 2026', { kind: 'too_long', durationSeconds: 60 * 90 }],
      ])
    )

    const r = await runSync({
      leagueClubSlug: 'lyl', trigger: 'cron', shareRecipientEmail: 'admin@example.com',
    }, makeDeps(db, veo))

    expect(r.status).toBe('succeeded')
    expect(r.counts.homeAssignments).toBe(0)
    const row = db.assignments.get('lyl:long-1')
    expect(row.status).toBe('too_long')
    expect(veo.createTeam).not.toHaveBeenCalled()
  })

  it('unparseable: persists with reason, no Veo writes', async () => {
    const db = new FakeSupabase()
    db.seedSubclub('lyl', 'taa', 'TAA')
    const veo = makeVeo({
      listClubTeams: vi.fn(async () => []),
      listRecordings: vi.fn(async () => [
        { slug: 'bad-1', title: 'Match 3 May 2026', duration: 2700, match_date: null, team: null },
      ]),
    })
    setupParse(
      new Map([
        ['Match 3 May 2026', { kind: 'unparseable', reason: 'no team names in title' }],
      ])
    )

    const r = await runSync({
      leagueClubSlug: 'lyl', trigger: 'cron', shareRecipientEmail: 'admin@example.com',
    }, makeDeps(db, veo))

    expect(r.counts.unparseable).toBe(1)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].stage).toBe('unparseable')
    const row = db.assignments.get('lyl:bad-1')
    expect(row.status).toBe('unparseable')
    expect(row.last_error).toContain('no team names')
  })

  it('auto-correct: recording on wrong Veo team → moves to parsed home + counts auto_corrections', async () => {
    const db = new FakeSupabase()
    db.seedSubclub('lyl', 'taa', 'TAA')
    db.seedSubclub('lyl', 'jsfc', 'JSFC')
    const veo = makeVeo({
      listClubTeams: vi.fn(async () => [
        { id: 'team-id-taa-u9', slug: 'taa-u9', name: 'TAA U9' },
        { id: 'team-id-jsfc-u9', slug: 'jsfc-u9', name: 'JSFC U9' },
      ]),
      listRecordings: vi.fn(async () => [
        // Currently assigned to "Wrong Team" — auto-correct should fire.
        { slug: 'rec-1', title: 'TAA vs JSFC', duration: 2700, match_date: null, team: 'Wrong Team' },
      ]),
    })
    setupParse(
      new Map([
        ['TAA vs JSFC', {
          kind: 'eligible',
          parsed: {
            home: { subclubSlug: 'taa', ageGroup: 'u9' },
            away: { subclubSlug: 'jsfc', ageGroup: 'u9' },
            method: 'rules', confidence: null, reasoning: null, llmAttemptedAt: null,
          },
        }],
      ])
    )

    const r = await runSync({
      leagueClubSlug: 'lyl', trigger: 'cron', shareRecipientEmail: 'admin@example.com',
    }, makeDeps(db, veo))

    expect(r.counts.autoCorrections).toBe(1)
    expect(r.counts.homeAssignments).toBe(1)
    expect(veo.assignRecordingToTeam).toHaveBeenCalledWith(
      'uuid-of-rec-1',
      'team-id-taa-u9'
    )
  })

  it('per-recording failure isolation: one fails, others succeed, status=partial', async () => {
    const db = new FakeSupabase()
    db.seedSubclub('lyl', 'taa', 'TAA')
    db.seedSubclub('lyl', 'jsfc', 'JSFC')
    db.seedSubclub('lyl', 'ela', 'ELA')

    // Two recordings: rec-1 succeeds, rec-2 fails in share-accept.
    const veo = makeVeo({
      listClubTeams: vi.fn(async () => []),
      listRecordings: vi.fn(async () => [
        { slug: 'rec-1', title: 'TAA vs JSFC', duration: 2700, match_date: null, team: null },
        { slug: 'rec-2', title: 'JSFC vs ELA', duration: 2700, match_date: null, team: null },
      ]),
      // The orchestrator passes details.title || recording.title into
      // input.title — our getRecordingUUID fake returns title=slug, so
      // we match by slug here.
      acceptShareInvitation: vi.fn(async (input) => {
        if (input.title === 'rec-2') throw new Error('accept failed: Veo 500')
        return { slug: 'accepted-slug' }
      }),
    })

    setupParse(
      new Map([
        ['TAA vs JSFC', {
          kind: 'eligible',
          parsed: {
            home: { subclubSlug: 'taa', ageGroup: 'u9' },
            away: { subclubSlug: 'jsfc', ageGroup: 'u9' },
            method: 'rules', confidence: null, reasoning: null, llmAttemptedAt: null,
          },
        }],
        ['JSFC vs ELA', {
          kind: 'eligible',
          parsed: {
            home: { subclubSlug: 'jsfc', ageGroup: 'u10' },
            away: { subclubSlug: 'ela', ageGroup: 'u10' },
            method: 'rules', confidence: null, reasoning: null, llmAttemptedAt: null,
          },
        }],
      ])
    )

    const r = await runSync({
      leagueClubSlug: 'lyl', trigger: 'cron', shareRecipientEmail: 'admin@example.com',
    }, makeDeps(db, veo))

    expect(r.status).toBe('partial')
    expect(r.counts.failures).toBe(1)
    expect(r.counts.shareAccepts).toBe(1)  // only rec-1 share-accepted
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].recording_slug).toBe('rec-2')
    expect(r.errors[0].stage).toBe('share_accept')
    // rec-1 row should be fully_assigned, rec-2 should be failed.
    expect(db.assignments.get('lyl:rec-1').status).toBe('fully_assigned')
    expect(db.assignments.get('lyl:rec-2').status).toBe('failed')
    expect(db.assignments.get('lyl:rec-2').failure_stage).toBe('share_accept')
  })

  it('skips share-accepted-copy recordings (slug prefix filter)', async () => {
    const db = new FakeSupabase()
    db.seedSubclub('lyl', 'taa', 'TAA')
    const veo = makeVeo({
      listClubTeams: vi.fn(async () => []),
      listRecordings: vi.fn(async () => [
        // Original + share-accepted copy of the same match. Only the
        // original should be planned.
        { slug: 'rec-1', title: 'TAA vs JSFC', duration: 2700, match_date: null, team: null },
        { slug: 'lyl-rec-1-accepted', title: 'TAA vs JSFC', duration: 2700, match_date: null, team: null },
      ]),
    })

    setupParse(
      new Map([
        ['TAA vs JSFC', {
          kind: 'eligible',
          parsed: {
            home: { subclubSlug: 'taa', ageGroup: 'u9' },
            away: { subclubSlug: 'taa', ageGroup: 'u9' }, // intra-team for brevity
            method: 'rules', confidence: null, reasoning: null, llmAttemptedAt: null,
          },
        }],
      ])
    )

    const r = await runSync({
      leagueClubSlug: 'lyl', trigger: 'cron', shareRecipientEmail: 'admin@example.com',
    }, makeDeps(db, veo))

    expect(r.counts.veoRecordingsSeen).toBe(2)
    expect(r.counts.newRecordings).toBe(1)  // only the non-prefixed one
    expect(db.assignments.size).toBe(1)
  })

  it('aggregates llm cost across recordings into run summary', async () => {
    const db = new FakeSupabase()
    db.seedSubclub('lyl', 'taa', 'TAA')
    db.seedSubclub('lyl', 'jsfc', 'JSFC')
    const veo = makeVeo({
      listClubTeams: vi.fn(async () => []),
      listRecordings: vi.fn(async () => [
        { slug: 'rec-1', title: 'weird-1', duration: 2700, match_date: null, team: null },
        { slug: 'rec-2', title: 'weird-2', duration: 2700, match_date: null, team: null },
      ]),
    })

    // Both go through LLM with different costs.
    mockedParse.mockImplementation(async (input) => {
      const cost = { inputTokens: 1000, outputTokens: 50, costUsd: 0.00125 }
      return {
        outcome: {
          kind: 'eligible',
          parsed: {
            home: { subclubSlug: 'taa', ageGroup: 'u9' },
            away: { subclubSlug: 'jsfc', ageGroup: 'u9' },
            method: 'llm', confidence: 0.9, reasoning: 'Test reasoning',
            llmAttemptedAt: new Date(),
          },
        },
        llmCost: cost,
      }
    })

    const r = await runSync({
      leagueClubSlug: 'lyl', trigger: 'cron', shareRecipientEmail: 'admin@example.com',
    }, makeDeps(db, veo))

    expect(r.counts.llmParsed).toBe(2)
    expect(r.llm.inputTokens).toBe(2000)
    expect(r.llm.outputTokens).toBe(100)
    expect(r.llm.costUsd).toBeCloseTo(0.0025, 6)
  })
})
