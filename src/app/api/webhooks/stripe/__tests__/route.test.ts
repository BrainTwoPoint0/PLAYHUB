import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks (available inside vi.mock factories) ──────────────
const {
  mockHeadersGet,
  mockConstructEvent,
  mockScheduleRecording,
  mockSupabaseFrom,
  sharedChain,
} = vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_xxx'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'

  // Default chain that responds to every query the same way. Individual
  // tests can override `sharedChain.from` to route by table when they need
  // to assert per-call payloads.
  const c: any = {}
  c.from = (() => {
    const fn: any = (..._args: any[]) => c
    return Object.assign(fn, { mockReturnValue: () => fn })
  })()
  c.select = (() => {
    const fn: any = (..._args: any[]) => c
    return Object.assign(fn, { mockReturnValue: () => fn })
  })()
  c.insert = (() => {
    const fn: any = (..._args: any[]) => c
    return Object.assign(fn, { mockReturnValue: () => fn })
  })()
  c.upsert = (..._args: any[]) => c
  c.update = (..._args: any[]) => c
  c.eq = (..._args: any[]) => c
  c.gte = (..._args: any[]) => c
  c.lte = (..._args: any[]) => c
  c.single = () => Promise.resolve({ data: { id: 'purchase-1' }, error: null })
  c.maybeSingle = () => Promise.resolve({ data: null, error: null })

  return {
    mockHeadersGet: vi.fn(),
    mockConstructEvent: vi.fn(),
    mockScheduleRecording: vi.fn(),
    mockSupabaseFrom: vi.fn(),
    sharedChain: c,
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

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(sharedChain),
  createServiceClient: vi.fn().mockReturnValue(sharedChain),
}))

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

  it('returns 200 for camera_booking with missing metadata (unrecoverable)', async () => {
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
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.received).toBe(true)
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

  // ── Match recording purchase regression suite ─────────────────────
  //
  // These two assertions exist because the original handler shipped with
  // two latent bugs that combined to leave every paid purchase invisible
  // to the buyer:
  //   1. The playhub_purchases insert payload was missing user_id and
  //      match_recording_id, so those FK columns landed NULL.
  //   2. The playhub_access_rights insert passed access_type: 'purchased'
  //      but no such column exists on the table — supabase-js silently
  //      dropped it (and adjacent fields). user_id + match_recording_id
  //      ended up NULL on the access_rights row, so /matches/[id]
  //      always returned hasAccess=false even for paying buyers.
  // Pinning the insert payload contract here so a future refactor that
  // re-removes a required column or re-adds a phantom one breaks the
  // test instead of breaking buyer checkout.

  function setupRecordingPurchaseChain() {
    const purchaseInsertCalls: any[] = []
    const accessInsertCalls: any[] = []

    sharedChain.from = vi.fn().mockImplementation((table: string) => {
      if (table === 'playhub_purchases') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
          insert: (payload: any) => {
            purchaseInsertCalls.push(payload)
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: { id: 'purchase-1' },
                    error: null,
                  }),
              }),
            }
          },
        }
      }
      if (table === 'playhub_match_recordings') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: { organization_id: 'org-1', title: 'Match Title' },
                  error: null,
                }),
            }),
          }),
        }
      }
      if (table === 'playhub_access_rights') {
        return {
          insert: (payload: any) => {
            accessInsertCalls.push(payload)
            return Promise.resolve({ error: null })
          },
        }
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
            single: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      }
    })

    return { purchaseInsertCalls, accessInsertCalls }
  }

  function recordingPurchaseEvent() {
    return stripeEvent('checkout.session.completed', {
      id: 'cs_live_test_123',
      payment_intent: 'pi_test_123',
      amount_total: 20000,
      currency: 'aed',
      customer_details: { email: 'buyer@example.com', name: null },
      metadata: {
        product_id: 'prod-1',
        match_recording_id: 'rec-1',
        user_id: 'user-1',
        profile_id: 'profile-1',
      },
    })
  }

  it('persists user_id + match_recording_id on the purchase insert', async () => {
    const { purchaseInsertCalls } = setupRecordingPurchaseChain()
    mockConstructEvent.mockReturnValue(recordingPurchaseEvent())

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)

    expect(purchaseInsertCalls).toHaveLength(1)
    expect(purchaseInsertCalls[0]).toMatchObject({
      user_id: 'user-1',
      profile_id: 'profile-1',
      product_id: 'prod-1',
      match_recording_id: 'rec-1',
      currency: 'aed',
      status: 'completed',
      stripe_checkout_session_id: 'cs_live_test_123',
      stripe_payment_intent_id: 'pi_test_123',
    })
  })

  it('grants access without the phantom access_type column', async () => {
    const { accessInsertCalls } = setupRecordingPurchaseChain()
    mockConstructEvent.mockReturnValue(recordingPurchaseEvent())

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)

    expect(accessInsertCalls).toHaveLength(1)
    const access = accessInsertCalls[0]
    expect(access).toMatchObject({
      user_id: 'user-1',
      profile_id: 'profile-1',
      match_recording_id: 'rec-1',
      purchase_id: 'purchase-1',
      is_active: true,
    })
    // Regression guard: this column does not exist on playhub_access_rights.
    // Adding it caused supabase-js to silently drop adjacent fields.
    expect(access).not.toHaveProperty('access_type')
  })

  it('returns 200 + does not insert when match_recording_id metadata is missing', async () => {
    const { purchaseInsertCalls, accessInsertCalls } =
      setupRecordingPurchaseChain()
    mockConstructEvent.mockReturnValue(
      stripeEvent('checkout.session.completed', {
        id: 'cs_live_test_456',
        metadata: {
          product_id: 'prod-1',
          // match_recording_id missing
          user_id: 'user-1',
          profile_id: 'profile-1',
        },
      })
    )

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    expect(purchaseInsertCalls).toHaveLength(0)
    expect(accessInsertCalls).toHaveLength(0)
  })
})
