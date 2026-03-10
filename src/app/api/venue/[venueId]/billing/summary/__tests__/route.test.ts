import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Hoisted mocks ───────────────────────────────────────────────────
const {
  mockGetUser,
  mockIsVenueAdmin,
  mockIsPlatformAdmin,
  mockServiceFrom,
  mockGetKwdToEurRate,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockIsVenueAdmin: vi.fn(),
  mockIsPlatformAdmin: vi.fn(),
  mockServiceFrom: vi.fn(),
  mockGetKwdToEurRate: vi.fn(),
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
})
