import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ───────────────────────────────────────────────────
const { mockGetUser, mockIsVenueAdmin, mockServiceFrom } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockIsVenueAdmin: vi.fn(),
  mockServiceFrom: vi.fn(),
}))

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

import { POST, DELETE } from '@/app/api/recordings/[id]/marketplace/route'

// ── Helpers ─────────────────────────────────────────────────────────

function makeRequest(body: any) {
  return new Request('http://localhost:3001/api/recordings/rec-1/marketplace', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeDeleteRequest() {
  return new Request('http://localhost:3001/api/recordings/rec-1/marketplace', {
    method: 'DELETE',
  })
}

const params = { params: Promise.resolve({ id: 'rec-1' }) }

// Build a chainable mock keyed by table name. Each .from() call returns a
// fresh chain wired to per-call resolutions for the query the route makes.
function setupChain(opts: {
  recording?: { data: any; error: any }
  productLookup?: { data: any; error: any }
  productInsert?: { data: any; error: any }
  productUpdate?: { data: any; error: any }
  recordingFlag?: { error: any }
  productUnlist?: { error: any }
  recordingUnflag?: { error: any }
}) {
  mockServiceFrom.mockImplementation((table: string) => {
    const chain: any = {}
    chain.select = vi.fn().mockReturnValue(chain)
    chain.eq = vi.fn().mockReturnValue(chain)
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    chain.single = vi.fn().mockResolvedValue({ data: null, error: null })
    chain.insert = vi.fn().mockReturnValue(chain)
    chain.update = vi.fn().mockReturnValue(chain)

    if (table === 'playhub_match_recordings') {
      // First call resolves the recording lookup; subsequent calls (the flag
      // update) just return the chain without resolving.
      let firstCall = true
      chain.select = vi.fn().mockImplementation(() => {
        // The route does .from('playhub_match_recordings').select(...).eq(...).maybeSingle()
        // for the lookup, and .from(...).update(...).eq(...) for the flag flip.
        return chain
      })
      chain.maybeSingle = vi
        .fn()
        .mockResolvedValueOnce(opts.recording ?? { data: null, error: null })
      chain.update = vi.fn().mockImplementation(() => {
        if (firstCall) {
          firstCall = false
          return {
            eq: vi
              .fn()
              .mockResolvedValue(opts.recordingFlag ?? { error: null }),
          }
        }
        return {
          eq: vi
            .fn()
            .mockResolvedValue(opts.recordingUnflag ?? { error: null }),
        }
      })
      return chain
    }

    if (table === 'playhub_products') {
      // Lookup → insert/update. Use call counters to differentiate.
      let lookupDone = false
      chain.select = vi.fn().mockImplementation(() => {
        if (!lookupDone) {
          lookupDone = true
          return {
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi
                .fn()
                .mockResolvedValue(
                  opts.productLookup ?? { data: null, error: null }
                ),
            }),
          }
        }
        return {
          single: vi
            .fn()
            .mockResolvedValue(
              opts.productInsert ??
                opts.productUpdate ?? { data: null, error: null }
            ),
        }
      })
      chain.insert = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi
            .fn()
            .mockResolvedValue(
              opts.productInsert ?? { data: null, error: null }
            ),
        }),
      })
      chain.update = vi.fn().mockReturnValue({
        eq: vi.fn().mockImplementation(() => {
          // For the unlist DELETE path the call ends at .eq(); for the POST
          // update path it continues to .select().single(). Both return a
          // thenable-shaped object resolving to {error,data}.
          const result: any = Promise.resolve(
            opts.productUnlist ?? opts.productUpdate ?? { error: null }
          )
          result.select = vi.fn().mockReturnValue({
            single: vi
              .fn()
              .mockResolvedValue(
                opts.productUpdate ?? { data: null, error: null }
              ),
          })
          return result
        }),
      })
      return chain
    }

    return chain
  })
}

// ── Setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()

  mockGetUser.mockResolvedValue({
    data: { user: { id: 'user-1' } },
    error: null,
  })
  mockIsVenueAdmin.mockResolvedValue(true)
})

// ── Tests ───────────────────────────────────────────────────────────

describe('POST /api/recordings/[id]/marketplace', () => {
  it('returns 401 when no user is authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    setupChain({})

    const res = await POST(
      makeRequest({ price_amount: 100, currency: 'AED' }),
      params
    )

    expect(res.status).toBe(401)
  })

  it('returns 404 when recording does not exist', async () => {
    setupChain({ recording: { data: null, error: null } })

    const res = await POST(
      makeRequest({ price_amount: 100, currency: 'AED' }),
      params
    )

    expect(res.status).toBe(404)
  })

  it('returns 403 when user is not the venue admin', async () => {
    mockIsVenueAdmin.mockResolvedValue(false)
    setupChain({
      recording: {
        data: {
          id: 'rec-1',
          organization_id: 'org-1',
          status: 'published',
          title: 't',
          description: null,
        },
        error: null,
      },
    })

    const res = await POST(
      makeRequest({ price_amount: 100, currency: 'AED' }),
      params
    )

    expect(res.status).toBe(403)
  })

  it('rejects unpublished recordings', async () => {
    setupChain({
      recording: {
        data: {
          id: 'rec-1',
          organization_id: 'org-1',
          status: 'scheduled',
          title: 't',
          description: null,
        },
        error: null,
      },
    })

    const res = await POST(
      makeRequest({ price_amount: 100, currency: 'AED' }),
      params
    )

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/published/i)
  })

  it('returns 400 on invalid currency', async () => {
    setupChain({
      recording: {
        data: {
          id: 'rec-1',
          organization_id: 'org-1',
          status: 'published',
          title: 't',
          description: null,
        },
        error: null,
      },
    })

    const res = await POST(
      makeRequest({ price_amount: 100, currency: 'XYZ' }),
      params
    )

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/currency/i)
  })

  it('returns 400 on missing or invalid price', async () => {
    setupChain({
      recording: {
        data: {
          id: 'rec-1',
          organization_id: 'org-1',
          status: 'published',
          title: 't',
          description: null,
        },
        error: null,
      },
    })

    const res = await POST(makeRequest({ currency: 'AED' }), params)
    expect(res.status).toBe(400)

    const res2 = await POST(
      makeRequest({ price_amount: -5, currency: 'AED' }),
      params
    )
    expect(res2.status).toBe(400)

    const res3 = await POST(
      makeRequest({ price_amount: 999_999_999, currency: 'AED' }),
      params
    )
    expect(res3.status).toBe(400)
  })

  it('returns 400 on invalid JSON body', async () => {
    setupChain({
      recording: {
        data: {
          id: 'rec-1',
          organization_id: 'org-1',
          status: 'published',
          title: 't',
          description: null,
        },
        error: null,
      },
    })

    const res = await POST(makeRequest('not-json'), params)
    expect(res.status).toBe(400)
  })

  it('creates a new product row when none exists', async () => {
    setupChain({
      recording: {
        data: {
          id: 'rec-1',
          organization_id: 'org-1',
          status: 'published',
          title: 'Match A',
          description: 'desc',
        },
        error: null,
      },
      productLookup: { data: null, error: null },
      productInsert: {
        data: {
          id: 'prod-1',
          match_recording_id: 'rec-1',
          price_amount: 200,
          currency: 'AED',
          is_available: true,
        },
        error: null,
      },
    })

    const res = await POST(
      makeRequest({ price_amount: 200, currency: 'AED' }),
      params
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.product.price_amount).toBe(200)
    expect(json.product.currency).toBe('AED')
    expect(json.product.is_available).toBe(true)
  })

  it('updates the existing product row when one already exists', async () => {
    setupChain({
      recording: {
        data: {
          id: 'rec-1',
          organization_id: 'org-1',
          status: 'published',
          title: 'Match A',
          description: null,
        },
        error: null,
      },
      productLookup: { data: { id: 'prod-1' }, error: null },
      productUpdate: {
        data: {
          id: 'prod-1',
          match_recording_id: 'rec-1',
          price_amount: 250,
          currency: 'AED',
          is_available: true,
        },
        error: null,
      },
    })

    const res = await POST(
      makeRequest({ price_amount: 250, currency: 'AED' }),
      params
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.product.price_amount).toBe(250)
  })
})

describe('DELETE /api/recordings/[id]/marketplace', () => {
  it('returns 401 when no user is authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    setupChain({})

    const res = await DELETE(makeDeleteRequest(), params)
    expect(res.status).toBe(401)
  })

  it('returns 403 when user is not the venue admin', async () => {
    mockIsVenueAdmin.mockResolvedValue(false)
    setupChain({
      recording: {
        data: { id: 'rec-1', organization_id: 'org-1' },
        error: null,
      },
    })

    const res = await DELETE(makeDeleteRequest(), params)
    expect(res.status).toBe(403)
  })

  it('marks product unavailable and flips marketplace_enabled false', async () => {
    setupChain({
      recording: {
        data: { id: 'rec-1', organization_id: 'org-1' },
        error: null,
      },
      productUnlist: { error: null },
      recordingUnflag: { error: null },
    })

    const res = await DELETE(makeDeleteRequest(), params)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
  })
})
