import { describe, it, expect } from 'vitest'
import {
  classifyRecordingSport,
  sportForBilling,
  grossForRecording,
  resolveGroupId,
  isGroupTiered,
  computeSharePct,
  TIER_HIGH_PCT,
  DEFAULT_SHARE_PCT,
} from '@/lib/billing/share-tier'

// ── Chainable Supabase mock ─────────────────────────────────────────
// Every builder method returns the same thenable object. Array queries are
// awaited at the end of the chain; single-row queries call .single()/.maybeSingle().
function chainReturning(result: { data: any; error?: any }) {
  const value = { error: null, ...result }
  const c: any = {}
  const passthrough = () => c
  c.select = passthrough
  c.eq = passthrough
  c.in = passthrough
  c.not = passthrough
  c.gte = passthrough
  c.lte = passthrough
  c.single = () => Promise.resolve(value)
  c.maybeSingle = () => Promise.resolve(value)
  // Make the chain awaitable for array queries (children, recordings).
  c.then = (onF: any, onR: any) => Promise.resolve(value).then(onF, onR)
  return c
}

// Dispatch by table name. `tables` maps a table to either a single chain or an
// array of chains consumed in call order (for tables queried more than once).
function makeSupabase(tables: Record<string, any | any[]>) {
  const counters: Record<string, number> = {}
  return {
    from(table: string) {
      const entry = tables[table]
      if (Array.isArray(entry)) {
        const i = counters[table] ?? 0
        counters[table] = i + 1
        return entry[Math.min(i, entry.length - 1)]
      }
      if (!entry) throw new Error(`Unexpected table query: ${table}`)
      return entry
    },
  }
}

const rec = (billable_amount = 5) => ({ id: 'r', billable_amount })

describe('classifyRecordingSport', () => {
  it('classifies Spiideo recordings as football', () => {
    expect(
      classifyRecordingSport({ spiideo_game_id: 'g1', clutch_video_id: null })
    ).toBe('football')
  })

  it('classifies Clutch recordings as padel', () => {
    expect(
      classifyRecordingSport({ spiideo_game_id: null, clutch_video_id: 'v1' })
    ).toBe('padel')
  })

  it('throws when a recording has both discriminators', () => {
    expect(() =>
      classifyRecordingSport({ spiideo_game_id: 'g1', clutch_video_id: 'v1' })
    ).toThrow(/both/)
  })

  it('throws when a recording has neither discriminator', () => {
    expect(() =>
      classifyRecordingSport({ spiideo_game_id: null, clutch_video_id: null })
    ).toThrow(/no sport discriminator/)
  })
})

describe('sportForBilling (non-throwing)', () => {
  it('classifies football / padel like the strict variant', () => {
    expect(
      sportForBilling({ spiideo_game_id: 'g', clutch_video_id: null })
    ).toBe('football')
    expect(
      sportForBilling({ spiideo_game_id: null, clutch_video_id: 'v' })
    ).toBe('padel')
  })

  it('returns null (no throw) for missing or ambiguous discriminators', () => {
    expect(
      sportForBilling({ spiideo_game_id: null, clutch_video_id: null })
    ).toBeNull()
    expect(
      sportForBilling({ spiideo_game_id: 'g', clutch_video_id: 'v' })
    ).toBeNull()
  })
})

describe('grossForRecording', () => {
  it('uses the explicit price, including 0 (free recording)', () => {
    expect(grossForRecording(4.5, 5)).toBe(4.5)
    expect(grossForRecording(0, 5)).toBe(0)
  })

  it('falls back to the default only for null/undefined', () => {
    expect(grossForRecording(null, 5)).toBe(5)
    expect(grossForRecording(undefined, 5)).toBe(5)
  })
})

describe('resolveGroupId', () => {
  it('returns the id itself for a group org', async () => {
    const supabase = makeSupabase({
      organizations: chainReturning({
        data: { id: 'grp', type: 'group', parent_organization_id: null },
      }),
    })
    await expect(resolveGroupId(supabase, 'grp')).resolves.toBe('grp')
  })

  it('returns the parent group for a child venue', async () => {
    const supabase = makeSupabase({
      organizations: chainReturning({
        data: { id: 'venue', type: 'venue', parent_organization_id: 'grp' },
      }),
    })
    await expect(resolveGroupId(supabase, 'venue')).resolves.toBe('grp')
  })

  it('throws for a venue with no parent group', async () => {
    const supabase = makeSupabase({
      organizations: chainReturning({
        data: { id: 'venue', type: 'venue', parent_organization_id: null },
      }),
    })
    await expect(resolveGroupId(supabase, 'venue')).rejects.toThrow(
      /no parent group/
    )
  })
})

describe('isGroupTiered', () => {
  it('is true when a tier-config row exists', async () => {
    const supabase = makeSupabase({
      playhub_group_tier_config: chainReturning({
        data: { group_organization_id: 'grp' },
      }),
    })
    await expect(isGroupTiered(supabase, 'grp')).resolves.toBe(true)
  })

  it('is false when no tier-config row exists', async () => {
    const supabase = makeSupabase({
      playhub_group_tier_config: chainReturning({ data: null }),
    })
    await expect(isGroupTiered(supabase, 'grp')).resolves.toBe(false)
  })
})

describe('computeSharePct', () => {
  // Helper: build a supabase mock for the computeSharePct query sequence
  // (tier config → children → recordings).
  function supaFor({
    tierCfg,
    children,
    recordings,
  }: {
    tierCfg: any
    children: any[]
    recordings: any[]
  }) {
    return makeSupabase({
      playhub_group_tier_config: chainReturning({ data: tierCfg }),
      organizations: chainReturning({ data: children }),
      playhub_match_recordings: chainReturning({ data: recordings }),
    })
  }

  it('returns the flat default for a non-tiered group (no config row)', async () => {
    const supabase = makeSupabase({
      playhub_group_tier_config: chainReturning({ data: null }),
    })
    await expect(
      computeSharePct(supabase, 'grp', 2026, 7, 'football')
    ).resolves.toBe(DEFAULT_SHARE_PCT)
  })

  it('returns high tier when football hits BOTH thresholds', async () => {
    // July 2026 has 31 days. 12 cameras. Need >=2.3 rec/cam/day => >=855.6 recs,
    // and >=345 KWD/cam/month => >=4140 KWD. Use 900 recs @ 5 KWD = 4500 KWD.
    const recordings = Array.from({ length: 900 }, () => rec(5))
    const supabase = supaFor({
      tierCfg: { football_camera_count: 12, padel_camera_count: 0 },
      children: [{ id: 'v1' }],
      recordings,
    })
    await expect(
      computeSharePct(supabase, 'grp', 2026, 7, 'football')
    ).resolves.toBe(TIER_HIGH_PCT)
  })

  it('returns low tier when only the recordings threshold is met', async () => {
    // 900 recs @ 1 KWD: rec/cam/day OK, but 900 KWD / 12 = 75 < 345 => low.
    const recordings = Array.from({ length: 900 }, () => rec(1))
    const supabase = supaFor({
      tierCfg: { football_camera_count: 12, padel_camera_count: 0 },
      children: [{ id: 'v1' }],
      recordings,
    })
    await expect(
      computeSharePct(supabase, 'grp', 2026, 7, 'football')
    ).resolves.toBe(DEFAULT_SHARE_PCT)
  })

  it('returns low tier when only the revenue threshold is met', async () => {
    // 100 recs @ 100 KWD: revenue 10000/12 = 833 >=345 OK, but
    // 100/12/31 = 0.27 rec/cam/day < 2.3 => low.
    const recordings = Array.from({ length: 100 }, () => rec(100))
    const supabase = supaFor({
      tierCfg: { football_camera_count: 12, padel_camera_count: 0 },
      children: [{ id: 'v1' }],
      recordings,
    })
    await expect(
      computeSharePct(supabase, 'grp', 2026, 7, 'football')
    ).resolves.toBe(DEFAULT_SHARE_PCT)
  })

  it('treats thresholds as inclusive (>=) for padel', async () => {
    // Feb 2026 (28 days), 2 cameras. Padel needs >=1.5 rec/cam/day => >=84 recs,
    // and >=135 KWD/cam/month => >=270 KWD. Use exactly 84 recs @ (270/84) KWD.
    const perRec = 270 / 84
    const recordings = Array.from({ length: 84 }, () => rec(perRec))
    const supabase = supaFor({
      tierCfg: { football_camera_count: 0, padel_camera_count: 2 },
      children: [{ id: 'v1' }],
      recordings,
    })
    await expect(
      computeSharePct(supabase, 'grp', 2026, 2, 'padel')
    ).resolves.toBe(TIER_HIGH_PCT)
  })

  it('flips on month length: same volume, 31-day month falls below the day threshold', async () => {
    // 84 padel recs, 2 cameras. 28-day Feb => 1.5 rec/cam/day (pass);
    // 31-day month => 84/2/31 = 1.35 < 1.5 (fail). Revenue kept above threshold.
    const recordings = Array.from({ length: 84 }, () => rec(4))
    const feb = supaFor({
      tierCfg: { football_camera_count: 0, padel_camera_count: 2 },
      children: [{ id: 'v1' }],
      recordings,
    })
    const jul = supaFor({
      tierCfg: { football_camera_count: 0, padel_camera_count: 2 },
      children: [{ id: 'v1' }],
      recordings,
    })
    await expect(computeSharePct(feb, 'grp', 2026, 2, 'padel')).resolves.toBe(
      TIER_HIGH_PCT
    )
    await expect(computeSharePct(jul, 'grp', 2026, 7, 'padel')).resolves.toBe(
      DEFAULT_SHARE_PCT
    )
  })

  it('throws when camera count is 0 but recordings exist (misconfigured)', async () => {
    const supabase = supaFor({
      tierCfg: { football_camera_count: 0, padel_camera_count: 0 },
      children: [{ id: 'v1' }],
      recordings: [rec(5)],
    })
    await expect(
      computeSharePct(supabase, 'grp', 2026, 7, 'football')
    ).rejects.toThrow(/No football camera count configured/)
  })

  it('returns default when camera count is 0 and there are no recordings', async () => {
    const supabase = supaFor({
      tierCfg: { football_camera_count: 0, padel_camera_count: 0 },
      children: [{ id: 'v1' }],
      recordings: [],
    })
    await expect(
      computeSharePct(supabase, 'grp', 2026, 7, 'football')
    ).resolves.toBe(DEFAULT_SHARE_PCT)
  })

  it('returns default when the group has no active child venues', async () => {
    const supabase = supaFor({
      tierCfg: { football_camera_count: 12, padel_camera_count: 0 },
      children: [],
      recordings: [],
    })
    await expect(
      computeSharePct(supabase, 'grp', 2026, 7, 'football')
    ).resolves.toBe(DEFAULT_SHARE_PCT)
  })
})
