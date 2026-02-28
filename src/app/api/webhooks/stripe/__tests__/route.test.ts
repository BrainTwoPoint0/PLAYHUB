import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks (available inside vi.mock factories) ──────────────
const {
  mockHeadersGet,
  mockConstructEvent,
  mockScheduleRecording,
  mockSupabaseFrom,
} = vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_xxx'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'

  return {
    mockHeadersGet: vi.fn(),
    mockConstructEvent: vi.fn(),
    mockScheduleRecording: vi.fn(),
    mockSupabaseFrom: vi.fn(),
  }
})

// ── Module mocks ────────────────────────────────────────────────────

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue({
    get: (...args: any[]) => mockHeadersGet(...args),
  }),
}))

vi.mock('stripe', () => {
  const MockStripe = function () {
    return {
      webhooks: {
        constructEvent: (...args: any[]) => mockConstructEvent(...args),
      },
    }
  }
  return { default: MockStripe }
})

vi.mock('@/lib/spiideo/schedule-recording', () => ({
  scheduleRecording: (...args: any[]) => mockScheduleRecording(...args),
}))

// Chainable Supabase mock
function supaChain(resolvedValue: { data: any; error: any }) {
  const c: any = {}
  c.from = vi.fn().mockReturnValue(c)
  c.select = vi.fn().mockReturnValue(c)
  c.insert = vi.fn().mockReturnValue(c)
  c.upsert = vi.fn().mockReturnValue(c)
  c.update = vi.fn().mockReturnValue(c)
  c.eq = vi.fn().mockReturnValue(c)
  c.gte = vi.fn().mockReturnValue(c)
  c.lte = vi.fn().mockReturnValue(c)
  c.single = vi.fn().mockResolvedValue(resolvedValue)
  c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
  return c
}

vi.mock('@/lib/supabase/server', () => {
  const client = supaChain({ data: { id: 'purchase-1' }, error: null })
  mockSupabaseFrom.mockImplementation((...args: any[]) => client.from(...args))
  return {
    createClient: vi.fn().mockResolvedValue(client),
    createServiceClient: vi.fn().mockReturnValue(client),
  }
})

// ── Import after mocks ──────────────────────────────────────────────
import { POST } from '@/app/api/webhooks/stripe/route'

// ── Helpers ─────────────────────────────────────────────────────────

function makeRequest(body = 'raw-body') {
  return { text: () => Promise.resolve(body) } as unknown as Request
}

function stripeEvent(type: string, dataObject: any) {
  return { type, data: { object: dataObject } }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('POST /api/webhooks/stripe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHeadersGet.mockReturnValue('sig_test')
  })

  it('returns 400 for invalid signature', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('Invalid signature')
    })

    const res = await POST(makeRequest())
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('Invalid signature')
  })

  it('returns { received: true } for unhandled event types', async () => {
    mockConstructEvent.mockReturnValue(stripeEvent('customer.created', {}))

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.received).toBe(true)
  })

  it('routes camera_booking to scheduleRecording with correct params', async () => {
    mockScheduleRecording.mockResolvedValue({
      gameId: 'g-1',
      productionId: 'p-1',
      recordingId: 'r-1',
      startTime: '2026-03-01T10:01:00Z',
      stopTime: '2026-03-01T11:01:00Z',
    })

    mockConstructEvent.mockReturnValue(
      stripeEvent('payment_intent.succeeded', {
        id: 'pi_123',
        metadata: {
          type: 'camera_booking',
          cameraId: 'cam-1',
          venueId: 'venue-1',
          durationMinutes: '60',
          email: 'test@example.com',
          sceneName: 'Pitch A',
        },
      })
    )

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)

    expect(mockScheduleRecording).toHaveBeenCalledOnce()
    const input = mockScheduleRecording.mock.calls[0][0]
    expect(input.venueId).toBe('venue-1')
    expect(input.sceneId).toBe('cam-1')
    expect(input.collectedBy).toBe('playhub')
    expect(input.startBufferMs).toBe(60_000)
    expect(input.durationMinutes).toBe(60)
    expect(input.email).toBe('test@example.com')
  })

  it('returns 400 for camera_booking with missing metadata', async () => {
    mockConstructEvent.mockReturnValue(
      stripeEvent('payment_intent.succeeded', {
        id: 'pi_456',
        metadata: {
          type: 'camera_booking',
          cameraId: 'cam-1',
          // missing venueId, durationMinutes, email
        },
      })
    )

    const res = await POST(makeRequest())
    expect(res.status).toBe(400)
  })

  it('handles venue_booking via checkout.session.completed', async () => {
    mockScheduleRecording.mockResolvedValue({
      gameId: 'g-2',
      productionId: 'p-2',
      recordingId: 'r-2',
      startTime: '2026-03-01T10:01:00Z',
      stopTime: '2026-03-01T11:01:00Z',
    })

    mockConstructEvent.mockReturnValue(
      stripeEvent('checkout.session.completed', {
        id: 'cs_789',
        metadata: {
          type: 'venue_booking',
          venueId: 'venue-2',
          sceneId: 'scene-2',
          durationMinutes: '90',
          email: 'user@example.com',
          sceneName: 'Main Pitch',
        },
      })
    )

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    expect(mockScheduleRecording).toHaveBeenCalledOnce()
  })

  it('handles stream_access via checkout.session.completed', async () => {
    mockConstructEvent.mockReturnValue(
      stripeEvent('checkout.session.completed', {
        id: 'cs_stream',
        payment_intent: 'pi_stream',
        amount_total: 1000,
        metadata: {
          type: 'stream_access',
          stream_id: 'stream-1',
          user_id: 'user-1',
          access_type: 'individual',
        },
      })
    )

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    expect(mockScheduleRecording).not.toHaveBeenCalled()
  })

  it('ignores payment_intent.succeeded without camera_booking type', async () => {
    mockConstructEvent.mockReturnValue(
      stripeEvent('payment_intent.succeeded', {
        id: 'pi_other',
        metadata: { type: 'some_other_type' },
      })
    )

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.received).toBe(true)
    expect(mockScheduleRecording).not.toHaveBeenCalled()
  })

  it('handles invoice.paid by updating status to paid', async () => {
    mockConstructEvent.mockReturnValue(
      stripeEvent('invoice.paid', {
        id: 'inv_paid_123',
      })
    )

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.received).toBe(true)
    expect(mockScheduleRecording).not.toHaveBeenCalled()
  })

  it('handles invoice.payment_failed by updating status to overdue', async () => {
    mockConstructEvent.mockReturnValue(
      stripeEvent('invoice.payment_failed', {
        id: 'inv_failed_456',
      })
    )

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.received).toBe(true)
    expect(mockScheduleRecording).not.toHaveBeenCalled()
  })
})
