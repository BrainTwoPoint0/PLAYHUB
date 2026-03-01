import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock email module before importing
vi.mock('@/lib/email', () => ({
  sendInvoiceEmail: vi.fn().mockResolvedValue({ success: true }),
}))

import { generateMonthlyInvoice } from '../generate-invoice'

// Helper to build a chainable Supabase mock
function createSupabaseMock(overrides: Record<string, any> = {}) {
  const chain: any = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.select = vi.fn().mockReturnValue(chain)
  chain.insert = vi.fn().mockReturnValue(chain)
  chain.update = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.in = vi.fn().mockReturnValue(chain)
  chain.gte = vi.fn().mockReturnValue(chain)
  chain.lte = vi.fn().mockReturnValue(chain)
  chain.not = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn().mockResolvedValue({ data: null, error: null })
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
  chain.auth = {
    admin: { listUsers: vi.fn().mockResolvedValue({ data: { users: [] } }) },
  }

  // Apply overrides
  Object.assign(chain, overrides)
  return chain
}

function createStripeMock() {
  return {
    invoices: {
      create: vi.fn().mockResolvedValue({ id: 'inv_123' }),
      finalizeInvoice: vi.fn().mockResolvedValue({
        id: 'inv_123',
        hosted_invoice_url: 'https://invoice.stripe.com/inv_123',
      }),
    },
    invoiceItems: {
      create: vi.fn().mockResolvedValue({ id: 'ii_123' }),
    },
  } as any
}

describe('generateMonthlyInvoice', () => {
  let supabase: any
  let stripe: any

  beforeEach(() => {
    vi.clearAllMocks()
    stripe = createStripeMock()
  })

  it('returns null when no billing config exists', async () => {
    supabase = createSupabaseMock()
    // First .from().select().eq().single() returns no config
    supabase.single.mockResolvedValueOnce({ data: null, error: null })

    const result = await generateMonthlyInvoice('venue-1', 2026, 2, {
      supabase,
      stripe,
    })

    expect(result).toBeNull()
  })

  it('returns null when invoice already exists (duplicate)', async () => {
    supabase = createSupabaseMock()

    // 1st call: billing config found
    supabase.single.mockResolvedValueOnce({
      data: {
        organization_id: 'venue-1',
        stripe_customer_id: 'cus_123',
        currency: 'KWD',
        fixed_cost_per_recording: 0,
        venue_profit_share_pct: 30,
      },
      error: null,
    })
    // 2nd call: maybeSingle returns existing invoice
    supabase.maybeSingle.mockResolvedValueOnce({
      data: { id: 'existing-invoice' },
      error: null,
    })

    const result = await generateMonthlyInvoice('venue-1', 2026, 2, {
      supabase,
      stripe,
    })

    expect(result).toBeNull()
    expect(stripe.invoices.create).not.toHaveBeenCalled()
  })

  it('creates invoice with correct calculations for venue-collected recordings', async () => {
    // Build a mock that tracks which table is being queried
    const callLog: string[] = []
    const mockData: Record<string, any> = {
      playhub_venue_billing_config: {
        organization_id: 'venue-1',
        stripe_customer_id: 'cus_123',
        currency: 'KWD',
        fixed_cost_per_recording: 0,
        venue_profit_share_pct: 30,
      },
      playhub_venue_invoices_check: null, // no duplicate
      playhub_match_recordings: [
        {
          id: 'r1',
          title: 'Match 1',
          billable_amount: 10,
          collected_by: 'venue',
        },
        {
          id: 'r2',
          title: 'Match 2',
          billable_amount: 20,
          collected_by: 'venue',
        },
      ],
      playhub_venue_invoices_insert: {
        id: 'new-invoice',
        net_amount: 21,
        status: 'pending',
      },
      organizations: { name: 'Test Venue' },
      organization_members: [],
    }

    supabase = createSupabaseMock()

    let fromCallCount = 0
    supabase.from.mockImplementation((table: string) => {
      callLog.push(table)
      fromCallCount++
      return supabase
    })

    // single() calls: 1st = config, last = insert result
    let singleCallCount = 0
    supabase.single.mockImplementation(() => {
      singleCallCount++
      if (singleCallCount === 1) {
        return Promise.resolve({
          data: mockData.playhub_venue_billing_config,
          error: null,
        })
      }
      // insert().select().single()
      return Promise.resolve({
        data: mockData.playhub_venue_invoices_insert,
        error: null,
      })
    })

    // maybeSingle = duplicate check (no match)
    supabase.maybeSingle.mockResolvedValue({ data: null, error: null })

    // select() for recordings returns array via the chain — we override the
    // chain to resolve recordings when the right table is queried.
    // Trick: after the maybeSingle (duplicate check), the next from() is recordings.
    // We'll intercept the `lte` call that ends the recording query chain.
    let lteCallCount = 0
    supabase.lte.mockImplementation(() => {
      lteCallCount++
      if (lteCallCount === 1) {
        // This is the recordings query — return data directly
        return Promise.resolve({
          data: mockData.playhub_match_recordings,
          error: null,
        })
      }
      return supabase
    })

    const result = await generateMonthlyInvoice('venue-1', 2026, 2, {
      supabase,
      stripe,
    })

    expect(result).not.toBeNull()
    expect(result!.recordingCount).toBe(2)

    // Stripe should be called: 30 total revenue, 30% venue keeps = 9, venue owes 21
    expect(stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_123',
        collection_method: 'send_invoice',
        days_until_due: 30,
      })
    )

    // Invoice should be finalized
    expect(stripe.invoices.finalizeInvoice).toHaveBeenCalledWith('inv_123')

    // Line item amount: 21 * 1000 = 21000 (KWD 3 decimals)
    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 21000,
        currency: 'kwd',
      })
    )
  })

  it('does not create Stripe invoice when net amount is zero', async () => {
    supabase = createSupabaseMock()

    let singleCallCount = 0
    supabase.single.mockImplementation(() => {
      singleCallCount++
      if (singleCallCount === 1) {
        return Promise.resolve({
          data: {
            organization_id: 'venue-1',
            stripe_customer_id: 'cus_123',
            currency: 'KWD',
            fixed_cost_per_recording: 0,
            venue_profit_share_pct: 30,
          },
          error: null,
        })
      }
      return Promise.resolve({
        data: { id: 'invoice-draft', status: 'draft' },
        error: null,
      })
    })

    supabase.maybeSingle.mockResolvedValue({ data: null, error: null })

    // No recordings
    supabase.lte.mockResolvedValueOnce({ data: [], error: null })

    const result = await generateMonthlyInvoice('venue-1', 2026, 2, {
      supabase,
      stripe,
    })

    expect(result).not.toBeNull()
    expect(result!.recordingCount).toBe(0)
    expect(stripe.invoices.create).not.toHaveBeenCalled()
  })

  it('throws when DB insert fails', async () => {
    supabase = createSupabaseMock()

    let singleCallCount = 0
    supabase.single.mockImplementation(() => {
      singleCallCount++
      if (singleCallCount === 1) {
        return Promise.resolve({
          data: {
            organization_id: 'venue-1',
            stripe_customer_id: null,
            currency: 'KWD',
            fixed_cost_per_recording: 0,
            venue_profit_share_pct: 30,
          },
          error: null,
        })
      }
      return Promise.resolve({
        data: null,
        error: { message: 'unique constraint violated' },
      })
    })

    supabase.maybeSingle.mockResolvedValue({ data: null, error: null })
    supabase.lte.mockResolvedValueOnce({ data: [], error: null })

    await expect(
      generateMonthlyInvoice('venue-1', 2026, 2, { supabase, stripe })
    ).rejects.toThrow('Failed to insert invoice')
  })
})
