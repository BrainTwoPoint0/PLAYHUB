import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub all env vars
vi.hoisted(() => {
  process.env.PLAYHUB_AWS_REGION = 'eu-west-2'
  process.env.PLAYHUB_AWS_ACCESS_KEY_ID = 'fake'
  process.env.PLAYHUB_AWS_SECRET_ACCESS_KEY = 'fake'
  process.env.S3_RECORDINGS_BUCKET = 'test-bucket'
  process.env.SPIIDEO_KUWAIT_CLIENT_ID = 'kw-id'
  process.env.SPIIDEO_KUWAIT_CLIENT_SECRET = 'kw-secret'
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
import { testConnection } from '@/lib/spiideo/client'
import { createServiceClient } from '@/lib/supabase/server'

function mockAllHealthy() {
  vi.mocked(testConnection).mockResolvedValue({
    success: true,
    message: 'OK',
    account: 'kuwait',
    accountType: 'play',
  })

  // S3: 404 NotFound = healthy (bucket accessible, key just doesn't exist)
  mockSend.mockRejectedValue(
    Object.assign(new Error('NotFound'), { name: 'NotFound' })
  )

  vi.mocked(createServiceClient).mockReturnValue({
    from: () => ({
      select: () => ({
        limit: () => Promise.resolve({ error: null }),
      }),
    }),
  } as any)

  mockStripeBalanceRetrieve.mockResolvedValue({ available: [] })
}

async function parseResponse(response: Response) {
  return { status: response.status, body: await response.json() }
}

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RESEND_API_KEY = 'rk_test_fake'
  })

  it('returns 200 and healthy when all services are up', async () => {
    mockAllHealthy()
    const { status, body } = await parseResponse(await GET())

    expect(status).toBe(200)
    expect(body.status).toBe('healthy')
    expect(body.services).toHaveLength(5)
    expect(body.timestamp).toBeDefined()
    expect(body.uptime).toBeGreaterThanOrEqual(0)
  })

  it('returns 503 when a critical service (spiideo) is down', async () => {
    mockAllHealthy()
    vi.mocked(testConnection).mockResolvedValue({
      success: false,
      message: 'Failed',
      account: 'kuwait',
      accountType: 'play',
      error: 'Auth failed',
    })

    const { status, body } = await parseResponse(await GET())

    expect(status).toBe(503)
    expect(body.status).toBe('unhealthy')
    const spiideo = body.services.find((s: any) => s.name === 'spiideo')
    expect(spiideo.status).toBe('unhealthy')
  })

  it('returns 200 degraded when only non-critical (resend) is down', async () => {
    mockAllHealthy()
    delete process.env.RESEND_API_KEY

    const { status, body } = await parseResponse(await GET())

    expect(status).toBe(200)
    expect(body.status).toBe('degraded')
    const resend = body.services.find((s: any) => s.name === 'resend')
    expect(resend.status).toBe('unhealthy')
  })

  it('returns 200 degraded when only stripe is down', async () => {
    mockAllHealthy()
    mockStripeBalanceRetrieve.mockRejectedValue(new Error('Invalid key'))

    const { status, body } = await parseResponse(await GET())

    expect(status).toBe(200)
    expect(body.status).toBe('degraded')
  })

  it('returns all five service names', async () => {
    mockAllHealthy()
    const { body } = await parseResponse(await GET())

    const names = body.services.map((s: any) => s.name)
    expect(names).toContain('spiideo')
    expect(names).toContain('s3')
    expect(names).toContain('supabase')
    expect(names).toContain('stripe')
    expect(names).toContain('resend')
  })
})
