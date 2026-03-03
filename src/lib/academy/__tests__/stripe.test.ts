import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Stripe from 'stripe'

// Use vi.hoisted so the mock instance is available when vi.mock is hoisted
const mockStripeInstance = vi.hoisted(() => ({
  prices: {
    list: vi.fn(),
  },
  subscriptions: {
    list: vi.fn(),
  },
  invoices: {
    list: vi.fn(),
  },
  checkout: {
    sessions: {
      list: vi.fn(),
    },
  },
}))

vi.mock('stripe', () => {
  function MockStripe() {
    return mockStripeInstance
  }
  return { default: MockStripe }
})

// Mock the config module — getClubBySlug is now async (DB-backed)
vi.mock('../config', () => ({
  getClubBySlug: vi.fn(async (slug: string) => {
    const clubs: Record<string, any> = {
      cfa: {
        slug: 'cfa',
        name: 'Complete Football Academy',
        stripeProductId: 'prod_RWhRQ4wM3PiEBJ',
        veoClubSlug: 'playback-15fdc44b',
      },
      sefa: {
        slug: 'sefa',
        name: 'Soccer Elite FA',
        stripeProductId: 'prod_QiMBPC4wf4nff1',
        additionalStripeProductIds: [
          'prod_Qyv9ID1M0sCowi',
          'prod_QuA6axz11zTGbw',
        ],
        veoClubSlug: 'soccer-elite-fa-0b0814d2',
      },
    }
    return clubs[slug] || undefined
  }),
  getAllClubs: vi.fn(async () => [
    {
      slug: 'cfa',
      name: 'Complete Football Academy',
      stripeProductId: 'prod_RWhRQ4wM3PiEBJ',
      veoClubSlug: 'playback-15fdc44b',
    },
    {
      slug: 'sefa',
      name: 'Soccer Elite FA',
      stripeProductId: 'prod_QiMBPC4wf4nff1',
      additionalStripeProductIds: [
        'prod_Qyv9ID1M0sCowi',
        'prod_QuA6axz11zTGbw',
      ],
      veoClubSlug: 'soccer-elite-fa-0b0814d2',
    },
  ]),
  getAllProductIds: vi.fn((club: any) => [
    club.stripeProductId,
    ...(club.additionalStripeProductIds || []),
  ]),
}))

// Helper to create async iterable from array (Stripe auto-pagination)
function asyncIterable<T>(items: T[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          if (i < items.length) return { value: items[i++], done: false }
          return { value: undefined as any, done: true }
        },
      }
    },
  }
}

import {
  getAcademySummary,
  getAcademySubscribers,
  getAcademyRevenue,
  clearCache,
} from '../stripe'

// ============================================================================
// Test data factories
// ============================================================================

function makePrice(overrides: Partial<Stripe.Price> = {}): Stripe.Price {
  return {
    id: 'price_u9',
    object: 'price',
    nickname: 'CFA U9 Monthly',
    unit_amount: 3000, // £30.00
    currency: 'gbp',
    recurring: { interval: 'month', interval_count: 1 } as any,
    active: true,
    product: 'prod_CFA',
    ...overrides,
  } as Stripe.Price
}

function makeSubscription(
  overrides: Partial<Stripe.Subscription> & {
    priceId?: string
    priceNickname?: string
    unitAmount?: number
    interval?: string
  } = {}
): Stripe.Subscription {
  const {
    priceId = 'price_u9',
    priceNickname = 'CFA U9 Monthly',
    unitAmount = 3000,
    interval = 'month',
    ...rest
  } = overrides

  return {
    id: `sub_${Math.random().toString(36).slice(2, 8)}`,
    object: 'subscription',
    status: 'active',
    customer: {
      id: 'cus_123',
      object: 'customer',
      email: 'parent@example.com',
      name: 'Test Parent',
    } as Stripe.Customer,
    items: {
      data: [
        {
          price: {
            id: priceId,
            nickname: priceNickname,
            unit_amount: unitAmount,
            currency: 'gbp',
            recurring: { interval, interval_count: 1 },
          },
        },
      ],
    } as any,
    current_period_start: Math.floor(Date.now() / 1000) - 30 * 86400,
    current_period_end: Math.floor(Date.now() / 1000),
    canceled_at: null,
    created: Math.floor(Date.now() / 1000) - 90 * 86400,
    ...rest,
  } as unknown as Stripe.Subscription
}

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  clearCache()
  vi.clearAllMocks()
})

// Helper to create a Stripe paginated response (for manual pagination)
function paginatedResponse<T>(items: T[]) {
  return Promise.resolve({ data: items, has_more: false })
}

// Default: return a single price with no subscriptions
function setupEmptyClub() {
  ;(mockStripeInstance as any).prices.list.mockReturnValue(asyncIterable([]))
  ;(mockStripeInstance as any).checkout.sessions.list.mockReturnValue(
    paginatedResponse([])
  )
}

// Setup a club with given prices and subscriptions
function setupClubData(
  pricesAndSubs: { price: Stripe.Price; subscriptions: Stripe.Subscription[] }[]
) {
  const activePrices = pricesAndSubs.map((ps) => ps.price)

  let callCount = 0
  ;(mockStripeInstance as any).prices.list.mockImplementation(
    (params: { active?: boolean }) => {
      callCount++
      // First call is active=true, second is active=false
      if (params?.active === true) return asyncIterable(activePrices)
      return asyncIterable([]) // no inactive prices
    }
  )
  ;(mockStripeInstance as any).subscriptions.list.mockImplementation(
    (params: { price: string }) => {
      const match = pricesAndSubs.find((ps) => ps.price.id === params.price)
      return asyncIterable(match?.subscriptions || [])
    }
  )
  // Default: no checkout sessions (tests can override)
  ;(mockStripeInstance as any).checkout.sessions.list.mockReturnValue(
    paginatedResponse([])
  )
}

// ============================================================================
// Tests: getAcademySummary
// ============================================================================

describe('getAcademySummary', () => {
  it('throws for unknown club slug', async () => {
    await expect(getAcademySummary('unknown')).rejects.toThrow(
      'Unknown club: unknown'
    )
  })

  it('returns zeros for a club with no subscriptions', async () => {
    setupEmptyClub()

    const summary = await getAcademySummary('cfa')

    expect(summary.clubSlug).toBe('cfa')
    expect(summary.clubName).toBe('Complete Football Academy')
    expect(summary.active).toBe(0)
    expect(summary.pastDue).toBe(0)
    expect(summary.canceled).toBe(0)
    expect(summary.trialing).toBe(0)
    expect(summary.total).toBe(0)
    expect(summary.mrr).toBe(0)
    expect(summary.churnRate).toBe(0)
    expect(summary.teams).toEqual([])
  })

  it('correctly counts subscriptions by status', async () => {
    const price = makePrice()

    setupClubData([
      {
        price,
        subscriptions: [
          makeSubscription({ status: 'active' }),
          makeSubscription({ status: 'active' }),
          makeSubscription({ status: 'past_due' }),
          makeSubscription({
            status: 'canceled',
            canceled_at: Math.floor(Date.now() / 1000) - 5 * 86400,
          }),
          makeSubscription({ status: 'trialing' }),
        ],
      },
    ])

    const summary = await getAcademySummary('cfa')

    expect(summary.active).toBe(2)
    expect(summary.pastDue).toBe(1)
    expect(summary.canceled).toBe(1)
    expect(summary.trialing).toBe(1)
    expect(summary.total).toBe(5)
  })

  it('calculates MRR from active subscriptions only', async () => {
    const price = makePrice({ unit_amount: 3000 }) // £30

    setupClubData([
      {
        price,
        subscriptions: [
          makeSubscription({ status: 'active', unitAmount: 3000 }),
          makeSubscription({ status: 'active', unitAmount: 3000 }),
          makeSubscription({ status: 'canceled' }), // should not count
        ],
      },
    ])

    const summary = await getAcademySummary('cfa')

    expect(summary.mrr).toBe(6000) // £60 = 2 * £30
  })

  it('excludes scholarship subscriptions (100% off coupon) from MRR', async () => {
    const price = makePrice({ unit_amount: 1500 }) // £15

    setupClubData([
      {
        price,
        subscriptions: [
          makeSubscription({ status: 'active', unitAmount: 1500 }),
          // Scholarship: has 100% off coupon
          makeSubscription({
            status: 'active',
            unitAmount: 1500,
            discount: {
              coupon: {
                percent_off: 100,
                id: 'coupon_scholarship',
                name: 'SEFA Scholarship',
              },
            },
          } as any),
        ],
      },
    ])

    const summary = await getAcademySummary('cfa')

    expect(summary.mrr).toBe(1500) // Only 1 paying sub × £15
    expect(summary.scholarships).toBe(1)
    expect(summary.active).toBe(2) // Both still count as active
  })

  it('normalizes yearly subscriptions to monthly for MRR', async () => {
    const price = makePrice({
      id: 'price_yearly',
      nickname: 'CFA Annual',
      unit_amount: 36000, // £360/year
      recurring: { interval: 'year', interval_count: 1 } as any,
    })

    setupClubData([
      {
        price,
        subscriptions: [
          makeSubscription({
            status: 'active',
            priceId: 'price_yearly',
            unitAmount: 36000,
            interval: 'year',
          }),
        ],
      },
    ])

    const summary = await getAcademySummary('cfa')

    expect(summary.mrr).toBe(3000) // £360/12 = £30/month
  })

  it('groups subscriptions by team (price)', async () => {
    const u9Price = makePrice({ id: 'price_u9', nickname: 'CFA U9 Monthly' })
    const u10Price = makePrice({ id: 'price_u10', nickname: 'CFA U10 Monthly' })

    setupClubData([
      {
        price: u9Price,
        subscriptions: [
          makeSubscription({ status: 'active' }),
          makeSubscription({ status: 'active' }),
        ],
      },
      {
        price: u10Price,
        subscriptions: [
          makeSubscription({ status: 'active' }),
          makeSubscription({
            status: 'canceled',
            canceled_at: Math.floor(Date.now() / 1000) - 5 * 86400,
          }),
        ],
      },
    ])

    const summary = await getAcademySummary('cfa')

    expect(summary.teams).toHaveLength(2)

    const u9 = summary.teams.find((t) => t.teamName === 'CFA U9 Monthly')
    expect(u9?.active).toBe(2)
    expect(u9?.total).toBe(2)

    const u10 = summary.teams.find((t) => t.teamName === 'CFA U10 Monthly')
    expect(u10?.active).toBe(1)
    expect(u10?.canceled).toBe(1)
    expect(u10?.total).toBe(2)
  })

  it('calculates churn rate from last 30 days', async () => {
    const price = makePrice()
    const recentCancel = Math.floor(Date.now() / 1000) - 5 * 86400 // 5 days ago
    const oldCancel = Math.floor(Date.now() / 1000) - 60 * 86400 // 60 days ago

    setupClubData([
      {
        price,
        subscriptions: [
          makeSubscription({ status: 'active' }),
          makeSubscription({ status: 'active' }),
          makeSubscription({ status: 'active' }),
          makeSubscription({ status: 'canceled', canceled_at: recentCancel }), // counts
          makeSubscription({ status: 'canceled', canceled_at: oldCancel }), // doesn't count
        ],
      },
    ])

    const summary = await getAcademySummary('cfa')

    // churn = 1 recent cancel / (3 active + 1 recent cancel) = 0.25
    expect(summary.churnRate).toBeCloseTo(0.25)
  })

  it('returns cached data on second call', async () => {
    setupEmptyClub()

    const first = await getAcademySummary('cfa')
    const second = await getAcademySummary('cfa')

    expect(first).toBe(second) // same reference = cache hit
    // prices.list should only be called once (2 calls for active+inactive)
    expect((mockStripeInstance as any).prices.list).toHaveBeenCalledTimes(2)
  })
})

// ============================================================================
// Tests: getAcademySubscribers
// ============================================================================

describe('getAcademySubscribers', () => {
  it('returns subscriber details with customer info', async () => {
    const price = makePrice()

    setupClubData([
      {
        price,
        subscriptions: [
          makeSubscription({
            status: 'active',
            customer: {
              id: 'cus_1',
              object: 'customer',
              email: 'jane@example.com',
              name: 'Jane Doe',
            } as Stripe.Customer,
          }),
        ],
      },
    ])

    const subscribers = await getAcademySubscribers('cfa')

    expect(subscribers).toHaveLength(1)
    expect(subscribers[0].customerEmail).toBe('jane@example.com')
    expect(subscribers[0].customerName).toBe('Jane Doe')
    expect(subscribers[0].teamName).toBe('CFA U9 Monthly')
    expect(subscribers[0].status).toBe('active')
    expect(subscribers[0].amount).toBe(3000)
    expect(subscribers[0].currency).toBe('gbp')
  })

  it('sorts by status (active first, canceled last)', async () => {
    const price = makePrice()

    setupClubData([
      {
        price,
        subscriptions: [
          makeSubscription({ id: 'sub_canceled', status: 'canceled' } as any),
          makeSubscription({ id: 'sub_active', status: 'active' } as any),
          makeSubscription({ id: 'sub_past_due', status: 'past_due' } as any),
        ],
      },
    ])

    const subscribers = await getAcademySubscribers('cfa')

    expect(subscribers[0].status).toBe('active')
    expect(subscribers[1].status).toBe('past_due')
    expect(subscribers[2].status).toBe('canceled')
  })
})

// ============================================================================
// Tests: getAcademyRevenue
// ============================================================================

describe('getAcademyRevenue', () => {
  it('sums paid invoices for revenue', async () => {
    const price = makePrice()
    const sub = makeSubscription({ id: 'sub_1', status: 'active' } as any)

    setupClubData([{ price, subscriptions: [sub] }])
    ;(mockStripeInstance as any).invoices.list.mockReturnValue(
      asyncIterable([
        { id: 'inv_1', amount_paid: 3000, currency: 'gbp', status: 'paid' },
        { id: 'inv_2', amount_paid: 3000, currency: 'gbp', status: 'paid' },
      ])
    )

    const revenue = await getAcademyRevenue('cfa')

    expect(revenue.totalRevenue).toBe(6000)
    expect(revenue.invoiceCount).toBe(2)
    expect(revenue.currency).toBe('gbp')
  })

  it('deduplicates invoices across subscriptions', async () => {
    const price = makePrice()
    const sub1 = makeSubscription({ id: 'sub_1', status: 'active' } as any)
    const sub2 = makeSubscription({ id: 'sub_2', status: 'active' } as any)

    setupClubData([{ price, subscriptions: [sub1, sub2] }])

    // Both subs return the same invoice (shouldn't happen in practice but tests dedup)
    ;(mockStripeInstance as any).invoices.list.mockReturnValue(
      asyncIterable([
        { id: 'inv_same', amount_paid: 5000, currency: 'gbp', status: 'paid' },
      ])
    )

    const revenue = await getAcademyRevenue('cfa')

    expect(revenue.totalRevenue).toBe(5000)
    expect(revenue.invoiceCount).toBe(1)
  })
})
