import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Hoisted mocks ───────────────────────────────────────────────────
const {
  mockGetUser,
  mockIsVenueAdmin,
  mockIsPlatformAdmin,
  mockServiceFrom,
  mockResolveGroupId,
  mockIsGroupTiered,
  mockComputeSharePct,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockIsVenueAdmin: vi.fn(),
  mockIsPlatformAdmin: vi.fn(),
  mockServiceFrom: vi.fn(),
  mockResolveGroupId: vi.fn(),
  mockIsGroupTiered: vi.fn(),
  mockComputeSharePct: vi.fn(),
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

// Tier logic is unit-tested in share-tier.test.ts; here we mock it to keep the
// route test focused on aggregation of the split.
vi.mock('@/lib/billing/share-tier', () => ({
  DEFAULT_SHARE_PCT: 5,
  DEFAULT_BILLABLE_AMOUNT: 5,
  resolveGroupId: (...a: any[]) => mockResolveGroupId(...a),
  isGroupTiered: (...a: any[]) => mockIsGroupTiered(...a),
  computeSharePct: (...a: any[]) => mockComputeSharePct(...a),
  sportForBilling: (r: any) =>
    r.spiideo_game_id ? 'football' : r.clutch_video_id ? 'padel' : null,
  grossForRecording: (amt: any, def: number) =>
    amt == null ? def : Number(amt),
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
  return c
}

const billingConfigChain = supaChain({
  data: {
    default_billable_amount: 5,
    currency: 'KWD',
    daily_recording_target: 3,
  },
  error: null,
})

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
    spiideo_game_id: overrides.spiideo_game_id ?? null,
    clutch_video_id: overrides.clutch_video_id ?? null,
  }
}

// ── Setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()

  mockGetUser.mockResolvedValue({
    data: { user: { id: 'user-1' } },
    error: null,
  })
  mockIsVenueAdmin.mockResolvedValue(true)
  mockIsPlatformAdmin.mockResolvedValue(false)

  // Default: non-tiered group → flat 5%
  mockResolveGroupId.mockResolvedValue('group-1')
  mockIsGroupTiered.mockResolvedValue(false)
  mockComputeSharePct.mockResolvedValue(5)

  let recordingsCallCount = 0
  mockServiceFrom.mockImplementation((table: string) => {
    if (table === 'playhub_venue_billing_config') return billingConfigChain
    if (table === 'playhub_match_recordings') {
      recordingsCallCount++
      return recordingsCallCount === 1
        ? monthRecordingsChain
        : todayRecordingsChain
    }
    return supaChain({ data: null, error: null })
  })

  billingConfigChain.maybeSingle.mockResolvedValue({
    data: {
      default_billable_amount: 5,
      currency: 'KWD',
      daily_recording_target: 3,
    },
    error: null,
  })

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

  // ── Share-of-gross calculation ──────────────────────────────────

  it('returns zero totals when no recordings exist', async () => {
    const res = await GET(makeRequest(), makeRouteContext())
    const json = await res.json()

    expect(json.count).toBe(0)
    expect(json.totalRevenue).toBe(0)
    expect(json.partnerShareTotal).toBe(0)
    expect(json.netBalance).toBe(0)
    expect(json.currency).toBe('KWD')
  })

  it('splits venue-collected gross at the flat default (5%)', async () => {
    monthRecordingsChain.lte.mockResolvedValueOnce({
      data: [
        makeRecording({ id: 'r1', collected_by: 'venue' }),
        makeRecording({ id: 'r2', collected_by: 'venue' }),
      ],
      error: null,
    })

    const res = await GET(makeRequest(), makeRouteContext())
    const json = await res.json()

    // gross 10, partner 5% = 0.5, playback 9.5 → venue owes PLAYBACK 9.5
    expect(json.count).toBe(2)
    expect(json.totalRevenue).toBe(10)
    expect(json.venueCollectedRevenue).toBe(10)
    expect(json.partnerShareTotal).toBe(0.5)
    expect(json.playbackShareTotal).toBe(9.5)
    expect(json.venueOwesPlayhub).toBe(9.5)
    expect(json.netBalance).toBe(9.5)
    expect(json.tiered).toBe(false)
    expect(json.partnerSharePctFootball).toBe(5)
  })

  it('splits playhub-collected gross (PLAYBACK owes the partner)', async () => {
    monthRecordingsChain.lte.mockResolvedValueOnce({
      data: [makeRecording({ id: 'r1', collected_by: 'playhub' })],
      error: null,
    })

    const res = await GET(makeRequest(), makeRouteContext())
    const json = await res.json()

    // gross 5, partner 5% = 0.25 → PLAYBACK owes venue 0.25 → net -0.25
    expect(json.playhubCollectedCount).toBe(1)
    expect(json.playhubCollectedRevenue).toBe(5)
    expect(json.playhubOwesVenue).toBe(0.25)
    expect(json.netBalance).toBe(-0.25)
  })

  it('applies the tiered football rate (15%) when the group is tiered', async () => {
    mockIsGroupTiered.mockResolvedValue(true)
    // football → 15, padel → 5
    mockComputeSharePct.mockImplementation(
      async (_c: any, _g: any, _y: any, _m: any, sport: string) =>
        sport === 'football' ? 15 : 5
    )

    monthRecordingsChain.lte.mockResolvedValueOnce({
      data: [
        makeRecording({
          id: 'r1',
          collected_by: 'venue',
          spiideo_game_id: 'g1',
        }),
      ],
      error: null,
    })

    const res = await GET(makeRequest(), makeRouteContext())
    const json = await res.json()

    // gross 5, football 15% = 0.75, playback 4.25 → venue owes 4.25
    expect(json.tiered).toBe(true)
    expect(json.partnerSharePctFootball).toBe(15)
    expect(json.partnerShareTotal).toBe(0.75)
    expect(json.venueOwesPlayhub).toBe(4.25)
  })

  it('falls back to the default billable amount when unset', async () => {
    monthRecordingsChain.lte.mockResolvedValueOnce({
      data: [
        makeRecording({ id: 'r1', billable_amount: null, collected_by: 'venue' }),
      ],
      error: null,
    })

    const res = await GET(makeRequest(), makeRouteContext())
    const json = await res.json()

    // default 5 → gross 5, partner 0.25, venue owes 4.75
    expect(json.totalRevenue).toBe(5)
    expect(json.venueOwesPlayhub).toBe(4.75)
  })
})
