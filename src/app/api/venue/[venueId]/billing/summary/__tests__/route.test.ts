import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Hoisted mocks ───────────────────────────────────────────────────
const {
  mockGetUser,
  mockIsVenueAdmin,
  mockIsPlatformAdmin,
  mockServiceFrom,
  mockGetKwdToEurRate,
  mockGetEurToAedRate,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockIsVenueAdmin: vi.fn(),
  mockIsPlatformAdmin: vi.fn(),
  mockServiceFrom: vi.fn(),
  mockGetKwdToEurRate: vi.fn(),
  mockGetEurToAedRate: vi.fn(),
}))

// ── Module mocks ────────────────────────────────────────────────────

vi.mock('@/lib/supabase/server', () => ({
  getAuthUser: vi.fn().mockImplementation(async () => {
    const result = await mockGetUser()
    return { user: result?.data?.user ?? null, supabase: {} }
  }),
  createServiceClient: vi.fn().mockReturnValue({
    from: (...args: any[]) => mockServiceFrom(...args),
  }),
}))

vi.mock('@/lib/recordings/access-control', () => ({
  isVenueAdmin: (...args: any[]) => mockIsVenueAdmin(...args),
}))

vi.mock('@/lib/admin/auth', () => ({
  isPlatformAdmin: (...args: any[]) => mockIsPlatformAdmin(...args),
}))

vi.mock('@/lib/fx/rates', () => ({
  getKwdToEurRate: () => mockGetKwdToEurRate(),
  getEurToAedRate: () => mockGetEurToAedRate(),
}))

// ── Import after mocks ──────────────────────────────────────────────
import { GET } from '@/app/api/venue/[venueId]/billing/summary/route'

// ── Chainable Supabase mock ─────────────────────────────────────────
function supaChain(resolvedValue: { data: any; error: any }) {
  const c: any = {}
  c.from = vi.fn().mockReturnValue(c)
  c.select = vi.fn().mockReturnValue(c)
  c.eq = vi.fn().mockReturnValue(c)
  c.gte = vi.fn().mockReturnValue(c)
  c.lte = vi.fn().mockReturnValue(c)
  c.maybeSingle = vi.fn().mockResolvedValue(resolvedValue)
  // For queries that return arrays (no .maybeSingle), resolve via the last .lte
  return c
}

const billingConfigChain = supaChain({
  data: {
    default_billable_amount: 5,
    currency: 'KWD',
    daily_recording_target: 3,
    fixed_cost_eur: 9.71,
    ambassador_pct: 10,
    venue_profit_share_pct: 25,
  },
  error: null,
})

// For recordings queries we need array results (no .maybeSingle)
const monthRecordingsChain = supaChain({ data: null, error: null })
const todayRecordingsChain = supaChain({ data: null, error: null })

// ── Helpers ─────────────────────────────────────────────────────────

function makeRequest() {
  return new NextRequest(
    'http://localhost:3001/api/venue/venue-1/billing/summary'
  )
}

function makeRouteContext(venueId = 'venue-1') {
  return { params: Promise.resolve({ venueId }) }
}

function makeRecording(overrides: any = {}) {
  return {
    id: overrides.id || 'rec-1',
    billable_amount: overrides.billable_amount ?? 5,
    collected_by: overrides.collected_by || 'venue',
    created_at: overrides.created_at || new Date().toISOString(),
    // Default 1 hour so per-hour cost math matches legacy expectations
    duration_seconds: overrides.duration_seconds ?? 3600,
  }
}

// ── Setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()

  // Authenticated venue admin by default
  mockGetUser.mockResolvedValue({
    data: { user: { id: 'user-1' } },
    error: null,
  })
  mockIsVenueAdmin.mockResolvedValue(true)
  mockIsPlatformAdmin.mockResolvedValue(false)

  // FX rate: 1 KWD = 2.77 EUR (so 9.71 EUR = 9.71/2.77 ≈ 3.505 KWD)
  mockGetKwdToEurRate.mockResolvedValue(2.77)
  // FX rate: 1 EUR = 4.0 AED (so 8.85 EUR = 35.4 AED per hour)
  mockGetEurToAedRate.mockResolvedValue(4.0)

  // Default table routing
  let recordingsCallCount = 0
  mockServiceFrom.mockImplementation((table: string) => {
    if (table === 'playhub_venue_billing_config') return billingConfigChain
    if (table === 'playhub_match_recordings') {
      recordingsCallCount++
      // First call = month recordings, second = today recordings
      return recordingsCallCount === 1
        ? monthRecordingsChain
        : todayRecordingsChain
    }
    return supaChain({ data: null, error: null })
  })

  // Reset billing config
  billingConfigChain.maybeSingle.mockResolvedValue({
    data: {
      default_billable_amount: 5,
      currency: 'KWD',
      daily_recording_target: 3,
      fixed_cost_eur: 9.71,
      ambassador_pct: 10,
      venue_profit_share_pct: 25,
    },
    error: null,
  })

  // Default: no recordings
  monthRecordingsChain.lte.mockResolvedValue({ data: [], error: null })
  todayRecordingsChain.lte.mockResolvedValue({ data: [], error: null })
})

// ── Auth tests ──────────────────────────────────────────────────────

describe('GET /api/venue/[venueId]/billing/summary', () => {
  it('returns 401 for unauthenticated user', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'No session' },
    })

    const res = await GET(makeRequest(), makeRouteContext())
    expect(res.status).toBe(401)
  })

  it('returns 403 for non-admin user', async () => {
    mockIsVenueAdmin.mockResolvedValue(false)
    mockIsPlatformAdmin.mockResolvedValue(false)

    const res = await GET(makeRequest(), makeRouteContext())
    expect(res.status).toBe(403)
  })

  it('allows platform admin access', async () => {
    mockIsVenueAdmin.mockResolvedValue(false)
    mockIsPlatformAdmin.mockResolvedValue(true)

    const res = await GET(makeRequest(), makeRouteContext())
    expect(res.status).toBe(200)
  })

  // ── Profit share calculation tests ──────────────────────────────

  it('returns zero totals when no recordings exist', async () => {
    const res = await GET(makeRequest(), makeRouteContext())
    const json = await res.json()

    expect(json.count).toBe(0)
    expect(json.totalRevenue).toBe(0)
    expect(json.venueTotalProfit).toBe(0)
    expect(json.netBalance).toBe(0)
    expect(json.currency).toBe('KWD')
  })

  it('calculates venue-collected profit share correctly', async () => {
    // 2 venue-collected recordings at 5 KWD each
    monthRecordingsChain.lte.mockResolvedValueOnce({
      data: [
        makeRecording({ id: 'r1', collected_by: 'venue' }),
        makeRecording({ id: 'r2', collected_by: 'venue' }),
      ],
      error: null,
    })

    const res = await GET(makeRequest(), makeRouteContext())
    const json = await res.json()

    // cost per recording = 9.71/2.77 + 10%*5 = 3.5054 + 0.5 = 4.0054
    // profit per recording = 5 - 4.0054 = 0.9946
    // venue keeps 25% = 0.2487 per recording
    // 2 recordings: venueKeeps = 0.497
    const costPerRec = 9.71 / 2.77 + 0.5
    const profitPerRec = 5 - costPerRec
    const expectedVenueKeeps = Number((profitPerRec * 0.25 * 2).toFixed(3))

    expect(json.count).toBe(2)
    expect(json.totalRevenue).toBe(10)
    expect(json.venueCollectedCount).toBe(2)
    expect(json.venueCollectedRevenue).toBe(10)
    expect(json.venueKeeps).toBe(expectedVenueKeeps)
    expect(json.venueOwesPlayhub).toBe(
      Number((10 - expectedVenueKeeps).toFixed(3))
    )
  })

  it('calculates playhub-collected profit share correctly', async () => {
    // 1 online recording at 5 KWD
    monthRecordingsChain.lte.mockResolvedValueOnce({
      data: [makeRecording({ id: 'r1', collected_by: 'playhub' })],
      error: null,
    })

    const res = await GET(makeRequest(), makeRouteContext())
    const json = await res.json()

    const costPerRec = 9.71 / 2.77 + 0.5
    const profitPerRec = 5 - costPerRec
    const expectedPlayhubOwesVenue = Number((profitPerRec * 0.25).toFixed(3))

    expect(json.playhubCollectedCount).toBe(1)
    expect(json.playhubCollectedRevenue).toBe(5)
    expect(json.playhubOwesVenue).toBe(expectedPlayhubOwesVenue)
    // Net is negative (PLAYHUB owes venue)
    expect(json.netBalance).toBe(Number((-expectedPlayhubOwesVenue).toFixed(3)))
  })

  it('calculates mixed venue + playhub recordings correctly', async () => {
    // 3 venue + 1 playhub
    monthRecordingsChain.lte.mockResolvedValueOnce({
      data: [
        makeRecording({ id: 'r1', collected_by: 'venue' }),
        makeRecording({ id: 'r2', collected_by: 'venue' }),
        makeRecording({ id: 'r3', collected_by: 'venue' }),
        makeRecording({ id: 'r4', collected_by: 'playhub' }),
      ],
      error: null,
    })

    const res = await GET(makeRequest(), makeRouteContext())
    const json = await res.json()

    const costPerRec = 9.71 / 2.77 + 0.5
    const profitPerRec = 5 - costPerRec
    const venueKeeps = Number((profitPerRec * 0.25 * 3).toFixed(3))
    const playhubOwesVenue = Number((profitPerRec * 0.25).toFixed(3))

    expect(json.count).toBe(4)
    expect(json.totalRevenue).toBe(20)
    expect(json.venueCollectedCount).toBe(3)
    expect(json.playhubCollectedCount).toBe(1)
    expect(json.venueTotalProfit).toBe(
      Number((venueKeeps + playhubOwesVenue).toFixed(3))
    )
  })

  it('uses FX rate to convert EUR fixed cost to KWD', async () => {
    // Change FX rate — higher rate means cheaper fixed cost in KWD
    mockGetKwdToEurRate.mockResolvedValue(3.0)

    monthRecordingsChain.lte.mockResolvedValueOnce({
      data: [makeRecording({ id: 'r1', collected_by: 'venue' })],
      error: null,
    })

    const res = await GET(makeRequest(), makeRouteContext())
    const json = await res.json()

    // cost = 9.71/3.0 + 0.5 = 3.2367 + 0.5 = 3.7367
    // profit = 5 - 3.7367 = 1.2633
    // venue keeps 25% = 0.3158
    const costPerRec = 9.71 / 3.0 + 0.5
    const profitPerRec = 5 - costPerRec
    const expectedVenueKeeps = Number((profitPerRec * 0.25).toFixed(3))

    expect(json.venueKeeps).toBe(expectedVenueKeeps)
    expect(json.fxRate).toBe(3.0)
  })

  it('returns fxRate in response for transparency', async () => {
    const res = await GET(makeRequest(), makeRouteContext())
    const json = await res.json()

    expect(json.fxRate).toBe(2.77)
    expect(json.fixedCostEur).toBe(9.71)
    expect(json.ambassadorPct).toBe(10)
    expect(json.venueProfitSharePct).toBe(25)
  })

  it('handles zero fixed cost and zero ambassador pct', async () => {
    billingConfigChain.maybeSingle.mockResolvedValueOnce({
      data: {
        default_billable_amount: 5,
        currency: 'KWD',
        daily_recording_target: 0,
        fixed_cost_eur: 0,
        ambassador_pct: 0,
        venue_profit_share_pct: 25,
      },
      error: null,
    })

    monthRecordingsChain.lte.mockResolvedValueOnce({
      data: [makeRecording({ id: 'r1', collected_by: 'venue' })],
      error: null,
    })

    const res = await GET(makeRequest(), makeRouteContext())
    const json = await res.json()

    // No costs: profit = full 5 KWD, venue keeps 25% = 1.25
    expect(json.venueKeeps).toBe(1.25)
    expect(json.venueOwesPlayhub).toBe(3.75)
  })

  it('clamps profit to zero when costs exceed revenue', async () => {
    // Very high fixed cost
    billingConfigChain.maybeSingle.mockResolvedValueOnce({
      data: {
        default_billable_amount: 5,
        currency: 'KWD',
        daily_recording_target: 0,
        fixed_cost_eur: 50,
        ambassador_pct: 10,
        venue_profit_share_pct: 25,
      },
      error: null,
    })

    monthRecordingsChain.lte.mockResolvedValueOnce({
      data: [makeRecording({ id: 'r1', collected_by: 'venue' })],
      error: null,
    })

    const res = await GET(makeRequest(), makeRouteContext())
    const json = await res.json()

    // 50/2.77 = 18.05 KWD fixed + 0.5 ambassador = 18.55 > 5 KWD revenue
    // Profit clamped to 0, venue keeps nothing
    expect(json.venueKeeps).toBe(0)
    // Venue owes full revenue to PLAYBACK
    expect(json.venueOwesPlayhub).toBe(5)
  })

  it('uses default billable amount when recording has none', async () => {
    monthRecordingsChain.lte.mockResolvedValueOnce({
      data: [
        makeRecording({
          id: 'r1',
          billable_amount: null,
          collected_by: 'venue',
        }),
      ],
      error: null,
    })

    const res = await GET(makeRequest(), makeRouteContext())
    const json = await res.json()

    // Should use default_billable_amount (5 KWD)
    expect(json.totalRevenue).toBe(5)
    expect(json.venueCollectedRevenue).toBe(5)
  })

  it('scales fixed cost by recording duration', async () => {
    // 1 venue-collected recording priced at 7.5 KWD (90-min booking at 5 KWD/hr)
    // 90 minutes => 1.5x the per-hour fixed cost
    monthRecordingsChain.lte.mockResolvedValueOnce({
      data: [
        makeRecording({
          id: 'r1',
          collected_by: 'venue',
          billable_amount: 7.5,
          duration_seconds: 5400, // 90 minutes
        }),
      ],
      error: null,
    })

    const res = await GET(makeRequest(), makeRouteContext())
    const json = await res.json()

    // Per-hour fixed cost in KWD = 9.71 / 2.77 = 3.5054
    // 90 min => 1.5 hours => fixed = 5.2581
    // ambassador 10% of 7.5 = 0.75
    // cost = 5.2581 + 0.75 = 6.0081
    // profit = 7.5 - 6.0081 = 1.4919
    // venue keeps 25% = 0.3730
    const perHourKwd = 9.71 / 2.77
    const fixed = perHourKwd * 1.5
    const ambassador = 7.5 * 0.1
    const profit = 7.5 - (fixed + ambassador)
    const expectedVenueKeeps = Number((profit * 0.25).toFixed(3))

    expect(json.venueKeeps).toBe(expectedVenueKeeps)
  })

  it('falls back to 1 hour when duration_seconds is missing', async () => {
    // Legacy recordings have no duration_seconds — treat them as 1 hour
    monthRecordingsChain.lte.mockResolvedValueOnce({
      data: [
        makeRecording({
          id: 'r1',
          collected_by: 'venue',
          duration_seconds: null,
        }),
      ],
      error: null,
    })

    const res = await GET(makeRequest(), makeRouteContext())
    const json = await res.json()

    // Same math as the original 1-hour test
    const costPerRec = 9.71 / 2.77 + 0.5
    const profitPerRec = 5 - costPerRec
    const expectedVenueKeeps = Number((profitPerRec * 0.25).toFixed(3))

    expect(json.venueKeeps).toBe(expectedVenueKeeps)
  })

  it('uses EUR→AED FX path when venue currency is AED', async () => {
    // HCT-style config: AED venue, 8.85 EUR/hr fixed cost, no profit share
    billingConfigChain.maybeSingle.mockResolvedValueOnce({
      data: {
        default_billable_amount: 100,
        currency: 'AED',
        daily_recording_target: 2,
        fixed_cost_eur: 8.85,
        ambassador_pct: 0,
        venue_profit_share_pct: 0,
      },
      error: null,
    })

    monthRecordingsChain.lte.mockResolvedValueOnce({
      data: [
        makeRecording({
          id: 'r1',
          collected_by: 'playhub',
          billable_amount: 100,
          duration_seconds: 3600,
        }),
      ],
      error: null,
    })

    const res = await GET(makeRequest(), makeRouteContext())
    const json = await res.json()

    // Per-hour fixed cost in AED = 8.85 * 4.0 = 35.4
    // No ambassador, no venue share
    // playhubCosts = 35.4, playhubProfit = 100 - 35.4 = 64.6
    // playhubOwesVenue = 64.6 * 0% = 0
    expect(json.currency).toBe('AED')
    expect(json.fxRate).toBe(4)
    expect(json.playhubOwesVenue).toBe(0)
    expect(json.venueKeeps).toBe(0)
    // Net should be zero — venue collects nothing, owes nothing
    expect(json.netBalance).toBe(0)
  })
})
