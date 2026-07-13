import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock email module before importing
vi.mock('@/lib/email', () => ({
  sendInvoiceEmail: vi.fn().mockResolvedValue({ success: true }),
}))

import { generateMonthlyInvoice } from '../generate-invoice'

// ── Table-aware Supabase mock ───────────────────────────────────────
// `tables` maps a table name to a queue of results consumed in call order
// (a table queried N times pulls its 1st..Nth result). Every terminal —
// .single(), .maybeSingle(), and awaiting an array/insert/update chain —
// consumes one result. Insert payloads are captured on `sb._inserts`.
function makeSupabase(
  tables: Record<string, Array<{ data?: any; error?: any }>>
) {
  const counters: Record<string, number> = {}
  const inserts: any[] = []
  const sb: any = {
    _inserts: inserts,
    auth: {
      admin: {
        listUsers: vi.fn().mockResolvedValue({ data: { users: [] } }),
      },
    },
    from(table: string) {
      const nextResult = () => {
        const arr = tables[table] || []
        const i = counters[table] ?? 0
        counters[table] = i + 1
        const r = arr[Math.min(i, arr.length - 1)] ?? {
          data: null,
          error: null,
        }
        return { error: null, ...r }
      }
      const c: any = {}
      const pass = () => c
      c.select = pass
      c.eq = pass
      c.in = pass
      c.not = pass
      c.gte = pass
      c.lte = pass
      c.update = pass
      c.insert = (payload: any) => {
        inserts.push(payload)
        return c
      }
      c.single = () => Promise.resolve(nextResult())
      c.maybeSingle = () => Promise.resolve(nextResult())
      c.then = (onF: any, onR: any) =>
        Promise.resolve(nextResult()).then(onF, onR)
      return c
    },
  }
  return sb
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

const groupOrg = { id: 'venue-1', type: 'group', parent_organization_id: null }

describe('generateMonthlyInvoice', () => {
  let stripe: any

  beforeEach(() => {
    vi.clearAllMocks()
    stripe = createStripeMock()
  })

  it('returns null when no billing config exists', async () => {
    const supabase = makeSupabase({
      playhub_venue_billing_config: [{ data: null }],
    })
    const result = await generateMonthlyInvoice('venue-1', 2026, 2, {
      supabase,
      stripe,
    })
    expect(result).toBeNull()
  })

  it('returns null when invoice already exists (duplicate)', async () => {
    const supabase = makeSupabase({
      playhub_venue_billing_config: [
        { data: { organization_id: 'venue-1', currency: 'KWD' } },
      ],
      playhub_venue_invoices: [{ data: { id: 'existing-invoice' } }],
    })
    const result = await generateMonthlyInvoice('venue-1', 2026, 2, {
      supabase,
      stripe,
    })
    expect(result).toBeNull()
    expect(stripe.invoices.create).not.toHaveBeenCalled()
  })

  it('splits gross at the flat default (5%) for a non-tiered group, venue-collected', async () => {
    const supabase = makeSupabase({
      playhub_venue_billing_config: [
        {
          data: {
            organization_id: 'venue-1',
            stripe_customer_id: 'cus_123',
            currency: 'KWD',
            default_billable_amount: 5,
          },
        },
      ],
      playhub_venue_invoices: [
        { data: null }, // duplicate check
        { data: { id: 'new-invoice' } }, // insert
        { data: null }, // stripe-success update
      ],
      playhub_match_recordings: [
        {
          data: [
            {
              id: 'r1',
              title: 'M1',
              billable_amount: 10,
              collected_by: 'venue',
            },
            {
              id: 'r2',
              title: 'M2',
              billable_amount: 20,
              collected_by: 'venue',
            },
          ],
        },
      ],
      organizations: [{ data: groupOrg }, { data: { name: 'Test Venue' } }],
      playhub_group_tier_config: [{ data: null }], // non-tiered
      playhub_invoice_line_items: [{ error: null }],
      organization_members: [{ data: [] }],
    })

    const result = await generateMonthlyInvoice('venue-1', 2026, 2, {
      supabase,
      stripe,
    })

    expect(result).not.toBeNull()
    expect(result!.recordingCount).toBe(2)

    // gross 30, partner share 5% = 1.5, venue owes PLAYBACK the playback share = 28.5
    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 28500, currency: 'kwd' }),
      expect.objectContaining({
        idempotencyKey: 'invoice:venue-1:2026:02:item',
      })
    )
    expect(stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_123' }),
      expect.objectContaining({
        idempotencyKey: 'invoice:venue-1:2026:02:create',
      })
    )
  })

  it('nets mixed venue + online collection and rounds KWD to a Stripe-valid amount', async () => {
    const supabase = makeSupabase({
      playhub_venue_billing_config: [
        {
          data: {
            organization_id: 'venue-1',
            stripe_customer_id: 'cus_123',
            currency: 'KWD',
            default_billable_amount: 5,
          },
        },
      ],
      playhub_venue_invoices: [
        { data: null },
        { data: { id: 'inv-mixed' } },
        { data: null },
      ],
      playhub_match_recordings: [
        {
          // venue 4.5 @ 5% → playback 4.275 ; online 3.0 @ 5% → partner 0.15
          data: [
            { id: 'v', billable_amount: 4.5, collected_by: 'venue' },
            { id: 'o', billable_amount: 3.0, collected_by: 'playhub' },
          ],
        },
      ],
      organizations: [{ data: groupOrg }, { data: { name: 'V' } }],
      playhub_group_tier_config: [{ data: null }],
      playhub_invoice_line_items: [{ error: null }],
      organization_members: [{ data: [] }],
    })

    await generateMonthlyInvoice('venue-1', 2026, 2, { supabase, stripe })

    // net = 4.275 − 0.15 = 4.125 KWD → 4125 fils, NOT a multiple of 10.
    // Stripe rejects 3-decimal amounts whose last digit isn't 0, so it must be
    // rounded to the nearest 10 → 4130.
    const call = stripe.invoiceItems.create.mock.calls[0][0]
    expect(call.amount % 10).toBe(0)
    expect(call.amount).toBe(4130)
  })

  it('freezes the computed tier % (15%) in the line-item snapshot for a tiered group', async () => {
    // Portfolio: 900 football recordings @ 5 KWD, 12 cameras, Feb 2026 (28 days).
    // 900/12/28 = 2.68 >= 2.3 and 900*5/12 = 375 >= 345 => 15% football tier.
    const footballPortfolio = Array.from({ length: 900 }, () => ({
      billable_amount: 5,
    }))

    const supabase = makeSupabase({
      playhub_venue_billing_config: [
        {
          data: {
            organization_id: 'venue-1',
            stripe_customer_id: null,
            currency: 'KWD',
            default_billable_amount: 5,
          },
        },
      ],
      playhub_venue_invoices: [
        { data: null }, // duplicate check
        { data: { id: 'inv-1' } }, // insert
      ],
      playhub_match_recordings: [
        {
          // main (venue) recording — one online-collected football recording
          data: [
            {
              id: 'r-f',
              title: 'Football',
              match_date: '2026-02-15T10:00:00Z',
              billable_amount: 5,
              collected_by: 'playhub',
              spiideo_game_id: 'g1',
              clutch_video_id: null,
            },
          ],
        },
        { data: footballPortfolio }, // computeSharePct football
        { data: [] }, // computeSharePct padel
      ],
      organizations: [
        { data: groupOrg }, // resolveGroupId
        { data: [{ id: 'venue-1' }] }, // children (football)
        { data: [{ id: 'venue-1' }] }, // children (padel)
        { data: { name: 'Li3ib Venue' } }, // notify name
      ],
      playhub_group_tier_config: [
        { data: { group_organization_id: 'venue-1' } }, // isGroupTiered → tiered
        { data: { football_camera_count: 12, padel_camera_count: 2 } }, // football
        { data: { football_camera_count: 12, padel_camera_count: 2 } }, // padel
      ],
      playhub_invoice_line_items: [{ error: null }],
      organization_members: [{ data: [] }],
    })

    await generateMonthlyInvoice('venue-1', 2026, 2, { supabase, stripe })

    const lineItemInsert = supabase._inserts.find(
      (p: any) => Array.isArray(p) && p[0]?.recording_id
    )
    expect(lineItemInsert).toBeDefined()
    expect(lineItemInsert).toHaveLength(1)
    expect(lineItemInsert[0]).toMatchObject({
      recording_id: 'r-f',
      sport: 'football',
      gross_amount: 5,
      partner_share_pct: 15,
      partner_share: 0.75,
      playback_share: 4.25,
      currency: 'KWD',
      collected_by: 'playhub',
    })
    // Legacy cost-recovery columns are no longer written.
    expect(lineItemInsert[0].fixed_cost_local).toBeNull()
    expect(lineItemInsert[0].ambassador_fee).toBeNull()

    // Online-collected only => PLAYBACK owes the venue => negative net => no Stripe.
    expect(stripe.invoices.create).not.toHaveBeenCalled()
  })

  it('does not create Stripe invoice when net amount is zero (no recordings)', async () => {
    const supabase = makeSupabase({
      playhub_venue_billing_config: [
        {
          data: {
            organization_id: 'venue-1',
            stripe_customer_id: 'cus_123',
            currency: 'KWD',
            default_billable_amount: 5,
          },
        },
      ],
      playhub_venue_invoices: [{ data: null }, { data: { id: 'inv-draft' } }],
      playhub_match_recordings: [{ data: [] }],
      organizations: [{ data: groupOrg }, { data: { name: 'V' } }],
      playhub_group_tier_config: [{ data: null }],
      organization_members: [{ data: [] }],
    })

    const result = await generateMonthlyInvoice('venue-1', 2026, 2, {
      supabase,
      stripe,
    })

    expect(result).not.toBeNull()
    expect(result!.recordingCount).toBe(0)
    expect(stripe.invoices.create).not.toHaveBeenCalled()
  })

  it('throws when DB insert fails', async () => {
    const supabase = makeSupabase({
      playhub_venue_billing_config: [
        {
          data: {
            organization_id: 'venue-1',
            stripe_customer_id: null,
            currency: 'KWD',
            default_billable_amount: 5,
          },
        },
      ],
      playhub_venue_invoices: [
        { data: null }, // duplicate
        { data: null, error: { message: 'unique constraint violated' } }, // insert fails
      ],
      playhub_match_recordings: [{ data: [] }],
      organizations: [{ data: groupOrg }],
      playhub_group_tier_config: [{ data: null }],
    })

    await expect(
      generateMonthlyInvoice('venue-1', 2026, 2, { supabase, stripe })
    ).rejects.toThrow('Failed to insert invoice')
  })
})
