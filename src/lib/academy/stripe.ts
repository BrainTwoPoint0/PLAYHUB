// Academy subscription data fetching from Stripe
// Follows the Spiideo client caching pattern with 5-minute TTL

import Stripe from 'stripe'
import { getClubBySlug } from './config'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
})

// ============================================================================
// Types
// ============================================================================

export interface TeamBreakdown {
  priceId: string
  teamName: string
  active: number
  pastDue: number
  canceled: number
  trialing: number
  total: number
}

export interface AcademySummary {
  clubSlug: string
  clubName: string
  active: number
  pastDue: number
  canceled: number
  trialing: number
  total: number
  scholarships: number
  mrr: number // Monthly recurring revenue in smallest currency unit (pence)
  churnRate: number // 0-1 decimal
  teams: TeamBreakdown[]
  registrationTeams: TeamBreakdown[] // Teams from checkout custom fields
}

export interface AcademySubscriber {
  subscriptionId: string
  customerEmail: string | null
  customerName: string | null
  teamName: string
  registrationTeam: string | null // Team chosen at checkout (e.g. "sefaboysjplu15")
  subscriberType: string | null // "player" or "parent"
  isScholarship: boolean // true if subscription has 100% off coupon
  additionalTeams: string | null
  status: string
  amount: number // in smallest currency unit
  currency: string
  interval: string
  currentPeriodStart: string
  currentPeriodEnd: string
  canceledAt: string | null
  createdAt: string
}

export interface AcademyRevenue {
  clubSlug: string
  totalRevenue: number // in smallest currency unit
  currency: string
  mrr: number
  invoiceCount: number
}

// ============================================================================
// Cache (in-memory, 5-minute TTL)
// ============================================================================

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

const cache: Record<string, CacheEntry<unknown>> = {}
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

function getCached<T>(key: string): T | null {
  const entry = cache[key]
  if (entry && Date.now() < entry.expiresAt) {
    return entry.data as T
  }
  if (entry) delete cache[key]
  return null
}

function setCache<T>(key: string, data: T): void {
  cache[key] = { data, expiresAt: Date.now() + CACHE_TTL_MS }
}

// Exported for testing
export function clearCache(): void {
  Object.keys(cache).forEach((key) => delete cache[key])
}

// ============================================================================
// Internal: Fetch checkout session registration data for a club
// ============================================================================

interface RegistrationInfo {
  customerEmail: string | null
  customerName: string | null
  registrationTeam: string | null
  subscriberType: string | null
  additionalTeams: string | null
  isScholarship: boolean
}

async function fetchRegistrationData(
  stripeProductId: string
): Promise<Map<string, RegistrationInfo>> {
  const cacheKey = `academy:registrations:${stripeProductId}`
  const cached = getCached<Map<string, RegistrationInfo>>(cacheKey)
  if (cached) return cached

  // Map by customer email (lowercase) for matching to subscriptions
  const registrations = new Map<string, RegistrationInfo>()

  // Fetch in pages of 100 — stop after 500 sessions to avoid slow iteration
  let hasMore = true
  let startingAfter: string | undefined
  let totalFetched = 0
  const MAX_SESSIONS = 500

  while (hasMore && totalFetched < MAX_SESSIONS) {
    const params: Record<string, unknown> = {
      limit: 100,
      status: 'complete',
      expand: ['data.line_items'],
    }
    if (startingAfter) params.starting_after = startingAfter

    const page = await stripe.checkout.sessions.list(
      params as Stripe.Checkout.SessionListParams
    )

    for (const session of page.data) {
      const lineItems = session.line_items?.data || []
      const isThisProduct = lineItems.some(
        (li) => li.price?.product === stripeProductId
      )
      if (!isThisProduct) continue

      const email = session.customer_details?.email?.toLowerCase() || null
      if (!email) continue

      let registrationTeam: string | null = null
      let subscriberType: string | null = null
      let additionalTeams: string | null = null

      for (const cf of session.custom_fields || []) {
        const val = cf.dropdown?.value || cf.text?.value || null
        if (!val) continue

        if (cf.key === 'teamname' || cf.key === 'teamnameagegroup') {
          registrationTeam = val
        } else if (cf.key === 'subscribertype') {
          subscriberType = val
        } else if (
          cf.key === 'playername' ||
          cf.key.startsWith('additionalteams')
        ) {
          additionalTeams = val
        }
      }

      const isScholarship = (session.amount_total || 0) <= 100

      registrations.set(email, {
        customerEmail: session.customer_details?.email || null,
        customerName: session.customer_details?.name || null,
        registrationTeam,
        subscriberType,
        additionalTeams,
        isScholarship,
      })
    }

    totalFetched += page.data.length
    hasMore = page.has_more
    if (page.data.length > 0) {
      startingAfter = page.data[page.data.length - 1].id
    }
  }

  setCache(cacheKey, registrations)
  return registrations
}

// ============================================================================
// Internal: Fetch all subscriptions for a club's Stripe product
// ============================================================================

interface PriceWithSubs {
  price: Stripe.Price
  subscriptions: Stripe.Subscription[]
}

async function fetchClubData(
  stripeProductId: string
): Promise<PriceWithSubs[]> {
  // Get all prices for this product (each price = a team)
  const prices: Stripe.Price[] = []
  for await (const price of stripe.prices.list({
    product: stripeProductId,
    active: true,
    limit: 100,
  })) {
    prices.push(price)
  }

  // Also fetch inactive prices to capture canceled subscriptions
  for await (const price of stripe.prices.list({
    product: stripeProductId,
    active: false,
    limit: 100,
  })) {
    prices.push(price)
  }

  // Deduplicate prices by ID
  const uniquePrices = Array.from(
    new Map(prices.map((p) => [p.id, p])).values()
  )

  // Fetch subscriptions per price
  const results: PriceWithSubs[] = []

  for (const price of uniquePrices) {
    const subscriptions: Stripe.Subscription[] = []

    for await (const sub of stripe.subscriptions.list({
      price: price.id,
      status: 'all',
      limit: 100,
      expand: ['data.customer', 'data.discount'],
    })) {
      subscriptions.push(sub)
    }

    if (subscriptions.length > 0) {
      results.push({ price, subscriptions })
    }
  }

  return results
}

// ============================================================================
// Parse team name from price nickname or product metadata
// ============================================================================

function getTeamName(price: Stripe.Price): string {
  return price.nickname || price.id
}

// ============================================================================
// Normalize subscription amount to monthly (in smallest currency unit)
// ============================================================================

function normalizeToMonthly(amount: number, interval: string): number {
  switch (interval) {
    case 'year':
      return Math.round(amount / 12)
    case 'week':
      return Math.round((amount * 52) / 12)
    case 'day':
      return Math.round((amount * 365) / 12)
    default:
      return amount // 'month'
  }
}

// ============================================================================
// Normalize registration team slugs (e.g. "sefawomen1" → "sefawomen")
// ============================================================================

function normalizeTeamSlug(slug: string): string {
  // Merge known team variants: "sefawomen1" → "sefawomen"
  return slug.replace(/women\d+$/, 'women')
}

// ============================================================================
// Detect scholarship from subscription coupon (100% off)
// ============================================================================

function isScholarshipSubscription(sub: Stripe.Subscription): boolean {
  const coupon = sub.discount?.coupon
  return coupon?.percent_off === 100
}

// ============================================================================
// Public API
// ============================================================================

export async function getAcademySummary(
  clubSlug: string
): Promise<AcademySummary> {
  const cacheKey = `academy:summary:${clubSlug}`
  const cached = getCached<AcademySummary>(cacheKey)
  if (cached) return cached

  const club = getClubBySlug(clubSlug)
  if (!club) throw new Error(`Unknown club: ${clubSlug}`)

  const [clubData, registrations] = await Promise.all([
    fetchClubData(club.stripeProductId),
    fetchRegistrationData(club.stripeProductId),
  ])

  let totalActive = 0
  let totalPastDue = 0
  let totalCanceled = 0
  let totalTrialing = 0
  let totalScholarships = 0
  let mrr = 0
  const teams: TeamBreakdown[] = []

  // Track registration team counts
  const regTeamCounts: Record<
    string,
    { active: number; pastDue: number; canceled: number; trialing: number }
  > = {}

  const now = Date.now()
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000
  let recentCanceled = 0

  for (const { price, subscriptions } of clubData) {
    let active = 0
    let pastDue = 0
    let canceled = 0
    let trialing = 0

    for (const sub of subscriptions) {
      // Skip incomplete payment attempts — not real subscribers
      if (sub.status === 'incomplete' || sub.status === 'incomplete_expired') continue

      // Look up registration info for this subscriber
      const customer = sub.customer as Stripe.Customer
      const email = customer?.email?.toLowerCase() || null
      const reg = email ? registrations.get(email) : undefined
      const rawTeam = reg?.registrationTeam || 'unknown'
      const regTeam = rawTeam === 'unknown' ? 'unknown' : normalizeTeamSlug(rawTeam)

      // Detect scholarship via subscription coupon (100% off)
      const scholarship = isScholarshipSubscription(sub)
      if (scholarship) totalScholarships++

      // Track per registration team
      if (!regTeamCounts[regTeam]) {
        regTeamCounts[regTeam] = { active: 0, pastDue: 0, canceled: 0, trialing: 0 }
      }

      switch (sub.status) {
        case 'active':
          active++
          regTeamCounts[regTeam].active++
          // Add to MRR — exclude scholarships (they pay £0)
          if (!scholarship) {
            for (const item of sub.items.data) {
              if (item.price.unit_amount && item.price.recurring?.interval) {
                mrr += normalizeToMonthly(
                  item.price.unit_amount,
                  item.price.recurring.interval
                )
              }
            }
          }
          break
        case 'past_due':
          pastDue++
          regTeamCounts[regTeam].pastDue++
          break
        case 'canceled':
          canceled++
          regTeamCounts[regTeam].canceled++
          // Track recent cancellations for churn
          if (sub.canceled_at && sub.canceled_at * 1000 > thirtyDaysAgo) {
            recentCanceled++
          }
          break
        case 'trialing':
          trialing++
          regTeamCounts[regTeam].trialing++
          break
      }
    }

    totalActive += active
    totalPastDue += pastDue
    totalCanceled += canceled
    totalTrialing += trialing

    teams.push({
      priceId: price.id,
      teamName: getTeamName(price),
      active,
      pastDue,
      canceled,
      trialing,
      total: active + pastDue + canceled + trialing,
    })
  }

  // Build registration team breakdown
  const registrationTeams: TeamBreakdown[] = Object.entries(regTeamCounts)
    .map(([teamName, counts]) => ({
      priceId: '',
      teamName,
      ...counts,
      total: counts.active + counts.pastDue + counts.canceled + counts.trialing,
    }))
    .sort((a, b) => b.total - a.total)

  // Churn rate = cancelled in last 30 days / (active + cancelled in last 30 days)
  const churnDenominator = totalActive + recentCanceled
  const churnRate = churnDenominator > 0 ? recentCanceled / churnDenominator : 0

  const summary: AcademySummary = {
    clubSlug,
    clubName: club.name,
    active: totalActive,
    pastDue: totalPastDue,
    canceled: totalCanceled,
    trialing: totalTrialing,
    total: totalActive + totalPastDue + totalCanceled + totalTrialing,
    scholarships: totalScholarships,
    mrr,
    churnRate,
    teams,
    registrationTeams,
  }

  setCache(cacheKey, summary)
  return summary
}

export async function getAcademySubscribers(
  clubSlug: string
): Promise<AcademySubscriber[]> {
  const cacheKey = `academy:subscribers:${clubSlug}`
  const cached = getCached<AcademySubscriber[]>(cacheKey)
  if (cached) return cached

  const club = getClubBySlug(clubSlug)
  if (!club) throw new Error(`Unknown club: ${clubSlug}`)

  const [clubData, registrations] = await Promise.all([
    fetchClubData(club.stripeProductId),
    fetchRegistrationData(club.stripeProductId),
  ])
  const subscribers: AcademySubscriber[] = []

  for (const { price, subscriptions } of clubData) {
    for (const sub of subscriptions) {
      // Skip incomplete payment attempts — not real subscribers
      if (sub.status === 'incomplete' || sub.status === 'incomplete_expired') continue

      const customer = sub.customer as Stripe.Customer
      const item = sub.items.data[0]
      const email = customer?.email?.toLowerCase() || null
      const reg = email ? registrations.get(email) : undefined

      const rawRegTeam = reg?.registrationTeam || null
      const normalizedRegTeam = rawRegTeam ? normalizeTeamSlug(rawRegTeam) : null

      subscribers.push({
        subscriptionId: sub.id,
        customerEmail: customer?.email || null,
        customerName: reg?.customerName || customer?.name || null,
        teamName: getTeamName(price),
        registrationTeam: normalizedRegTeam,
        subscriberType: reg?.subscriberType || null,
        isScholarship: isScholarshipSubscription(sub),
        additionalTeams: reg?.additionalTeams || null,
        status: sub.status,
        amount: item?.price?.unit_amount || 0,
        currency: item?.price?.currency || 'gbp',
        interval: item?.price?.recurring?.interval || 'month',
        currentPeriodStart: new Date(
          sub.current_period_start * 1000
        ).toISOString(),
        currentPeriodEnd: new Date(
          sub.current_period_end * 1000
        ).toISOString(),
        canceledAt: sub.canceled_at
          ? new Date(sub.canceled_at * 1000).toISOString()
          : null,
        createdAt: new Date(sub.created * 1000).toISOString(),
      })
    }
  }

  // Sort by status (active first), then by team name
  subscribers.sort((a, b) => {
    const statusOrder: Record<string, number> = {
      active: 0,
      trialing: 1,
      past_due: 2,
      canceled: 3,
    }
    const statusDiff =
      (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4)
    if (statusDiff !== 0) return statusDiff
    return a.teamName.localeCompare(b.teamName)
  })

  setCache(cacheKey, subscribers)
  return subscribers
}

/** Fetch subscribers for a specific Stripe product ID (used for additional products in Veo audit) */
export async function getSubscribersByProduct(
  stripeProductId: string
): Promise<AcademySubscriber[]> {
  const cacheKey = `academy:subscribers:product:${stripeProductId}`
  const cached = getCached<AcademySubscriber[]>(cacheKey)
  if (cached) return cached

  const [clubData, registrations] = await Promise.all([
    fetchClubData(stripeProductId),
    fetchRegistrationData(stripeProductId),
  ])
  const subscribers: AcademySubscriber[] = []

  for (const { price, subscriptions } of clubData) {
    for (const sub of subscriptions) {
      if (sub.status === 'incomplete' || sub.status === 'incomplete_expired') continue

      const customer = sub.customer as Stripe.Customer
      const item = sub.items.data[0]
      const email = customer?.email?.toLowerCase() || null
      const reg = email ? registrations.get(email) : undefined

      const rawRegTeam = reg?.registrationTeam || null
      const normalizedRegTeam = rawRegTeam ? normalizeTeamSlug(rawRegTeam) : null

      subscribers.push({
        subscriptionId: sub.id,
        customerEmail: customer?.email || null,
        customerName: reg?.customerName || customer?.name || null,
        teamName: getTeamName(price),
        registrationTeam: normalizedRegTeam,
        subscriberType: reg?.subscriberType || null,
        isScholarship: isScholarshipSubscription(sub),
        additionalTeams: reg?.additionalTeams || null,
        status: sub.status,
        amount: item?.price?.unit_amount || 0,
        currency: item?.price?.currency || 'gbp',
        interval: item?.price?.recurring?.interval || 'month',
        currentPeriodStart: new Date(
          sub.current_period_start * 1000
        ).toISOString(),
        currentPeriodEnd: new Date(
          sub.current_period_end * 1000
        ).toISOString(),
        canceledAt: sub.canceled_at
          ? new Date(sub.canceled_at * 1000).toISOString()
          : null,
        createdAt: new Date(sub.created * 1000).toISOString(),
      })
    }
  }

  setCache(cacheKey, subscribers)
  return subscribers
}

export async function getAcademyRevenue(
  clubSlug: string
): Promise<AcademyRevenue> {
  const cacheKey = `academy:revenue:${clubSlug}`
  const cached = getCached<AcademyRevenue>(cacheKey)
  if (cached) return cached

  const club = getClubBySlug(clubSlug)
  if (!club) throw new Error(`Unknown club: ${clubSlug}`)

  // Get the summary for MRR (reuses cache if available)
  const summary = await getAcademySummary(clubSlug)

  // Fetch paid invoices for this product's subscriptions
  // We search invoices by iterating subscriptions and their invoices
  const clubData = await fetchClubData(club.stripeProductId)
  let totalRevenue = 0
  let invoiceCount = 0
  let currency = 'gbp'

  const processedInvoices = new Set<string>()

  for (const { subscriptions } of clubData) {
    for (const sub of subscriptions) {
      for await (const invoice of stripe.invoices.list({
        subscription: sub.id,
        status: 'paid',
        limit: 100,
      })) {
        if (!processedInvoices.has(invoice.id)) {
          processedInvoices.add(invoice.id)
          totalRevenue += invoice.amount_paid
          invoiceCount++
          currency = invoice.currency
        }
      }
    }
  }

  const revenue: AcademyRevenue = {
    clubSlug,
    totalRevenue,
    currency,
    mrr: summary.mrr,
    invoiceCount,
  }

  setCache(cacheKey, revenue)
  return revenue
}
