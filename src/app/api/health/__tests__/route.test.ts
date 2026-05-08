import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Stub all env vars
vi.hoisted(() => {
  process.env.PLAYHUB_AWS_REGION = 'eu-west-2'
  process.env.PLAYHUB_AWS_ACCESS_KEY_ID = 'fake'
  process.env.PLAYHUB_AWS_SECRET_ACCESS_KEY = 'fake'
  process.env.S3_RECORDINGS_BUCKET = 'test-bucket'
  process.env.SPIIDEO_CLIENT_ID = 'test-id'
  process.env.SPIIDEO_CLIENT_SECRET = 'test-secret'
  process.env.SPIIDEO_PLAYBACK_ADMIN_USER_ID = 'admin'
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
  process.env.RESEND_API_KEY = 'rk_test_fake'
})

// Shared mock functions we can reconfigure per test
const mockSend = vi.fn()
const mockStripeBalanceRetrieve = vi.fn()

vi.mock('@/lib/spiideo/client', () => ({
  testConnection: vi.fn(),
}))

vi.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: class {
      send = mockSend
    },
    HeadObjectCommand: vi.fn(),
  }
})

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

vi.mock('stripe', () => ({
  default: class MockStripe {
    balance = { retrieve: mockStripeBalanceRetrieve }
  },
}))

import { GET } from '@/app/api/health/route'
import { _resetHealthResponseCache } from '@/app/api/health/response-cache'
import { spiideoHealthCache } from '@/app/api/health/spiideo-cache'
import { testConnection } from '@/lib/spiideo/client'
import { createServiceClient } from '@/lib/supabase/server'

function mockAllHealthy() {
  vi.mocked(testConnection).mockResolvedValue({
    success: true,
    message: 'OK',
  })

  // S3: 404 NotFound = healthy (bucket accessible, key just doesn't exist)
  mockSend.mockRejectedValue(
    Object.assign(new Error('NotFound'), { name: 'NotFound' })
  )

  vi.mocked(createServiceClient).mockReturnValue({
    from: () => ({
      select: () => ({
        limit: () => ({
          abortSignal: () => Promise.resolve({ error: null }),
        }),
      }),
    }),
  } as any)

  mockStripeBalanceRetrieve.mockResolvedValue({ available: [] })
}

function req(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/health', { headers })
}

async function parseResponse(response: Response) {
  return { status: response.status, body: await response.json() }
}

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RESEND_API_KEY = 'rk_test_fake'
    delete process.env.HEALTH_CHECK_TOKEN
    spiideoHealthCache.reset()
    _resetHealthResponseCache()
  })

  it('returns 200 and healthy when all services are up', async () => {
    mockAllHealthy()
    const { status, body } = await parseResponse(await GET(req()))

    expect(status).toBe(200)
    expect(body.status).toBe('healthy')
    expect(body.services).toHaveLength(5)
    expect(body.timestamp).toBeDefined()
    expect(body.instanceUptime).toBeGreaterThanOrEqual(0)
  })

  it('returns 200 degraded when spiideo is down (non-critical)', async () => {
    mockAllHealthy()
    vi.mocked(testConnection).mockResolvedValue({
      success: false,
      message: 'Failed',
      error: 'Auth failed',
    })

    const { status, body } = await parseResponse(await GET(req()))

    expect(status).toBe(200)
    expect(body.status).toBe('degraded')
    const spiideo = body.services.find((s: any) => s.name === 'spiideo')
    expect(spiideo.status).toBe('unhealthy')
  })

  it('returns 200 degraded when only non-critical (resend) is down', async () => {
    mockAllHealthy()
    delete process.env.RESEND_API_KEY

    const { status, body } = await parseResponse(await GET(req()))

    expect(status).toBe(200)
    expect(body.status).toBe('degraded')
    const resend = body.services.find((s: any) => s.name === 'resend')
    expect(resend.status).toBe('unhealthy')
  })

  it('returns 200 degraded when only stripe is down', async () => {
    mockAllHealthy()
    mockStripeBalanceRetrieve.mockRejectedValue(new Error('Invalid key'))

    const { status, body } = await parseResponse(await GET(req()))

    expect(status).toBe(200)
    expect(body.status).toBe('degraded')
  })

  it('returns 503 unhealthy when a critical service (S3) fails', async () => {
    mockAllHealthy()
    // Override the S3 mock with a real failure (not NotFound).
    mockSend.mockRejectedValue(
      Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' })
    )

    const { status, body } = await parseResponse(await GET(req()))

    expect(status).toBe(503)
    expect(body.status).toBe('unhealthy')
    const s3 = body.services.find((s: any) => s.name === 's3')
    expect(s3.status).toBe('unhealthy')
    expect(s3.error).toBe('auth_failed')
  })

  it('returns all five service names', async () => {
    mockAllHealthy()
    const { body } = await parseResponse(await GET(req()))

    const names = body.services.map((s: any) => s.name)
    expect(names).toContain('spiideo')
    expect(names).toContain('s3')
    expect(names).toContain('supabase')
    expect(names).toContain('stripe')
    expect(names).toContain('resend')
  })

  it('does not echo raw SDK error messages — emits a fixed enum code instead', async () => {
    mockAllHealthy()
    // Inject an error whose .message would leak the bucket ARN/region.
    mockStripeBalanceRetrieve.mockRejectedValue(
      new Error('Invalid API key: sk_live_*** request_id=req_abcdef')
    )

    const { body } = await parseResponse(await GET(req()))
    const stripe = body.services.find((s: any) => s.name === 'stripe')

    expect(stripe.status).toBe('unhealthy')
    expect(stripe.error).toBe('auth_failed')
    // Belt-and-braces: nothing in the response carries the raw secret.
    expect(JSON.stringify(body)).not.toContain('sk_live_')
    expect(JSON.stringify(body)).not.toContain('req_abcdef')
  })

  it('emits "misconfigured" for resend when the env var is missing', async () => {
    mockAllHealthy()
    delete process.env.RESEND_API_KEY

    const { body } = await parseResponse(await GET(req()))
    const resend = body.services.find((s: any) => s.name === 'resend')

    expect(resend.error).toBe('misconfigured')
  })

  it('sets Cache-Control: no-store on the 200 response', async () => {
    mockAllHealthy()
    const response = await GET(req())
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  describe('aggregate response cache', () => {
    it('returns the cached response on a second call within TTL', async () => {
      mockAllHealthy()
      const first = await parseResponse(await GET(req()))
      const firstTimestamp = first.body.timestamp

      // Re-mock so the second call WOULD see a different state if it ran fresh.
      vi.mocked(testConnection).mockResolvedValue({
        success: false,
        message: 'down',
        error: 'connection_failed',
      })

      const second = await parseResponse(await GET(req()))
      // Same timestamp = cache hit (response generated once, served twice).
      expect(second.body.timestamp).toBe(firstTimestamp)
      expect(second.body.status).toBe('healthy')
      // Each check ran exactly once (the cache short-circuited the second call).
      expect(testConnection).toHaveBeenCalledTimes(1)
      expect(mockStripeBalanceRetrieve).toHaveBeenCalledTimes(1)
    })

    describe('with mocked system clock', () => {
      // setSystemTime is what actually advances Date.now() under vitest;
      // advanceTimersByTime only steps registered timers (which the
      // module-scope cache doesn't use — it compares Date.now() to a
      // stored expiresAt).
      let baseTime: number
      beforeEach(() => {
        baseTime = Date.now()
        vi.useFakeTimers({ now: baseTime, shouldAdvanceTime: false })
      })

      afterEach(() => {
        vi.useRealTimers()
      })

      it('refreshes after the healthy TTL (30s) expires', async () => {
        mockAllHealthy()
        await GET(req())

        // Advance just past the 30s healthy TTL.
        vi.setSystemTime(baseTime + 30_001)

        await GET(req())
        // Stripe has no per-service cache, so this is the cleanest signal
        // that the response cache actually expired and the checks re-ran.
        // (testConnection has its own 5-minute Spiideo cache.)
        expect(mockStripeBalanceRetrieve).toHaveBeenCalledTimes(2)
      })

      it('refreshes after the shorter unhealthy TTL (5s) when status is degraded', async () => {
        mockAllHealthy()
        mockStripeBalanceRetrieve.mockRejectedValue(new Error('Stripe down'))
        await GET(req()) // first call → degraded → cached for 5s

        // 6s later — past the 5s unhealthy TTL but still well within the
        // 30s healthy window, so this exercises the shorter branch.
        vi.setSystemTime(baseTime + 6_000)

        await GET(req())
        // Underlying check ran twice — the shorter TTL allowed earlier recompute.
        expect(mockStripeBalanceRetrieve).toHaveBeenCalledTimes(2)
      })
    })
  })

  describe('with HEALTH_CHECK_TOKEN set', () => {
    beforeEach(() => {
      process.env.HEALTH_CHECK_TOKEN = 'super-secret'
    })

    it('returns 401 when the token header is missing', async () => {
      mockAllHealthy()
      const response = await GET(req())
      expect(response.status).toBe(401)
    })

    it('returns 401 when the token header is wrong', async () => {
      mockAllHealthy()
      const response = await GET(req({ 'x-health-token': 'wrong' }))
      expect(response.status).toBe(401)
    })

    it('returns 200 when the correct token is provided', async () => {
      mockAllHealthy()
      const response = await GET(req({ 'x-health-token': 'super-secret' }))
      expect(response.status).toBe(200)
    })

    it('sets Cache-Control: no-store on 401 responses too', async () => {
      mockAllHealthy()
      const response = await GET(req())
      expect(response.status).toBe(401)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
    })

    it('does not serve the cache to an unauthorized caller', async () => {
      // Populate the cache with an authorized call first.
      mockAllHealthy()
      const authorized = await GET(req({ 'x-health-token': 'super-secret' }))
      expect(authorized.status).toBe(200)

      // Unauthorized follow-up: must hit 401, not the cached 200.
      const unauthorized = await GET(req())
      expect(unauthorized.status).toBe(401)
    })
  })
})
