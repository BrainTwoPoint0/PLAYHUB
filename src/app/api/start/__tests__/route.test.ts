import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Hoisted mocks ───────────────────────────────────────────────────
const { mockFetch, mockPaymentIntentsCreate, mockServiceFrom } = vi.hoisted(
  () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_xxx'
    return {
      mockFetch: vi.fn(),
      mockPaymentIntentsCreate: vi.fn(),
      mockServiceFrom: vi.fn(),
    }
  }
)

// ── Mock: Stripe ────────────────────────────────────────────────────
vi.mock('stripe', () => {
  const MockStripe = function () {
    return {
      paymentIntents: {
        create: (...args: any[]) => mockPaymentIntentsCreate(...args),
      },
    }
  }
  return { default: MockStripe }
})

// ── Mock: Supabase service client ───────────────────────────────────
function supaChain(resolvedValue: { data: any; error: any }) {
  const c: any = {}
  c.from = vi.fn().mockReturnValue(c)
  c.select = vi.fn().mockReturnValue(c)
  c.eq = vi.fn().mockReturnValue(c)
  c.single = vi.fn().mockResolvedValue(resolvedValue)
  c.maybeSingle = vi.fn().mockResolvedValue(resolvedValue)
  return c
}

// Build per-table mocks
const mappingChain = supaChain({
  data: { organization_id: 'venue-1', scene_name: 'Pitch A' },
  error: null,
})

const venueChain = supaChain({
  data: { id: 'venue-1', name: 'Test Venue' },
  error: null,
})

const billingChain = supaChain({
  data: {
    default_billable_amount: 2,
    currency: 'KWD',
    booking_durations: [60, 90],
    booking_enabled: true,
  },
  error: null,
})

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    const client: any = {
      from: (...args: any[]) => mockServiceFrom(...args),
    }
    return client
  },
}))

import { GET, POST } from '@/app/api/start/[cameraId]/route'

// ── Helpers ─────────────────────────────────────────────────────────

function makeRouteContext(cameraId = 'cam-1') {
  return { params: Promise.resolve({ cameraId }) }
}

function makeRequest(method: string, body?: any) {
  const url = 'http://localhost:3001/api/start/cam-1'
  if (method === 'GET') {
    return new NextRequest(url, { method })
  }
  return new NextRequest(url, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── Setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()

  // Default: FX API returns known rates
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockResolvedValue({
    json: () =>
      Promise.resolve({
        result: 'success',
        rates: { GBP: 2.5, EUR: 3.0 },
      }),
  })

  // Default table routing
  mockServiceFrom.mockImplementation((table: string) => {
    if (table === 'playhub_scene_venue_mapping') return mappingChain
    if (table === 'organizations') return venueChain
    if (table === 'playhub_venue_billing_config') return billingChain
    return supaChain({ data: null, error: null })
  })

  // Reset chain resolvers
  mappingChain.maybeSingle.mockResolvedValue({
    data: { organization_id: 'venue-1', scene_name: 'Pitch A' },
    error: null,
  })
  venueChain.single.mockResolvedValue({
    data: { id: 'venue-1', name: 'Test Venue' },
    error: null,
  })
  billingChain.maybeSingle.mockResolvedValue({
    data: {
      default_billable_amount: 2,
      currency: 'KWD',
      booking_durations: [60, 90],
      booking_enabled: true,
    },
    error: null,
  })

  mockPaymentIntentsCreate.mockResolvedValue({
    client_secret: 'pi_secret_123',
  })
})

// ── GET tests ───────────────────────────────────────────────────────

describe('GET /api/start/[cameraId]', () => {
  it('falls back to 2.35 when FX API is down and no cache', async () => {
    // Run this first — before any successful FX fetch populates the cache
    mockFetch.mockRejectedValue(new Error('Network error'))

    const res = await GET(makeRequest('GET'), makeRouteContext())
    const json = await res.json()

    // Fallback rate when FX API is down
    expect(json.kwdToGbpRate).toBe(2.35)
    expect(json.currency).toBe('KWD')
  })

  it('returns KWD price with GBP conversion rate', async () => {
    const res = await GET(makeRequest('GET'), makeRouteContext())
    const json = await res.json()

    expect(json.currency).toBe('KWD')
    expect(json.pricePerHour).toBe(2)
    expect(json.kwdToGbpRate).toBe(2.5)
  })

  it('uses cached rate within TTL', async () => {
    // The previous test cached rate=2.5. Even if fetch would return something else,
    // the cached rate should be used since TTL hasn't expired.
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({ result: 'success', rates: { GBP: 999, EUR: 999 } }),
    })

    const res = await GET(makeRequest('GET'), makeRouteContext())
    const json = await res.json()

    // Still uses cached 2.5, not 999
    expect(json.kwdToGbpRate).toBe(2.5)
  })

  it('returns same currency when venue is GBP (no conversion)', async () => {
    billingChain.maybeSingle.mockResolvedValue({
      data: {
        default_billable_amount: 10,
        currency: 'GBP',
        booking_durations: [60],
        booking_enabled: true,
      },
      error: null,
    })

    const res = await GET(makeRequest('GET'), makeRouteContext())
    const json = await res.json()

    expect(json.pricePerHour).toBe(10)
    expect(json.currency).toBe('GBP')
    expect(json.kwdToGbpRate).toBeUndefined()
  })

  it('returns 404 when camera not found', async () => {
    mappingChain.maybeSingle.mockResolvedValue({ data: null, error: null })

    const res = await GET(makeRequest('GET'), makeRouteContext())
    expect(res.status).toBe(404)
  })

  it('returns 404 when booking not enabled', async () => {
    billingChain.maybeSingle.mockResolvedValue({
      data: {
        default_billable_amount: 2,
        currency: 'KWD',
        booking_durations: [60],
        booking_enabled: false,
      },
      error: null,
    })

    const res = await GET(makeRequest('GET'), makeRouteContext())
    expect(res.status).toBe(404)
  })
})

// ── POST tests ──────────────────────────────────────────────────────

describe('POST /api/start/[cameraId]', () => {
  it('creates PaymentIntent in GBP with correct converted amount', async () => {
    const res = await POST(
      makeRequest('POST', { durationMinutes: 60, email: 'test@example.com' }),
      makeRouteContext()
    )
    const json = await res.json()

    expect(json.clientSecret).toBe('pi_secret_123')
    expect(mockPaymentIntentsCreate).toHaveBeenCalledOnce()

    const args = mockPaymentIntentsCreate.mock.calls[0][0]
    // 2 KWD * 2.5 rate * 100 = 500 pence
    expect(args.amount).toBe(500)
    expect(args.currency).toBe('gbp')
    expect(args.metadata.type).toBe('camera_booking')
  })

  it('normalizes email (trim + lowercase)', async () => {
    const res = await POST(
      makeRequest('POST', {
        durationMinutes: 60,
        email: '  Test@EXAMPLE.com  ',
      }),
      makeRouteContext()
    )

    expect(res.status).toBe(200)
    const args = mockPaymentIntentsCreate.mock.calls[0][0]
    expect(args.metadata.email).toBe('test@example.com')
    expect(args.receipt_email).toBe('test@example.com')
  })

  it('validates duration against allowed list', async () => {
    const res = await POST(
      makeRequest('POST', { durationMinutes: 45, email: 'test@example.com' }),
      makeRouteContext()
    )

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toContain('Duration must be one of')
  })

  it('returns 400 for missing fields', async () => {
    const res = await POST(makeRequest('POST', {}), makeRouteContext())

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toContain('required')
  })

  it('returns 400 for invalid email', async () => {
    const res = await POST(
      makeRequest('POST', { durationMinutes: 60, email: 'not-an-email' }),
      makeRouteContext()
    )

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toContain('Invalid email')
  })

  it('returns 404 for unknown camera', async () => {
    mappingChain.maybeSingle.mockResolvedValue({ data: null, error: null })

    const res = await POST(
      makeRequest('POST', { durationMinutes: 60, email: 'test@example.com' }),
      makeRouteContext()
    )

    expect(res.status).toBe(404)
  })
})
