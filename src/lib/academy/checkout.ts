// Academy checkout session creation — Checkpoint C
//
// Builds a Stripe Checkout Session for a parent subscribing to an academy
// team. The PLAYBACK landing page (D1) calls this via a thin proxy route on
// PLAYBACK, which forwards to the PLAYHUB API endpoint at
// /api/academy/[clubSlug]/checkout-session. This module does the actual
// work, dependency-injected so unit tests can mock Stripe + Supabase
// without module-level mocking.
//
// Session shape:
//   - mode: 'subscription' (single recurring price per club)
//   - line_items: [{ price: <looked up from playhub_academy_config>, quantity: 1 }]
//   - metadata + subscription_data.metadata both carry type/club_slug/team_slug
//     so the B2 webhook handler can route by metadata.type and the row that
//     gets created has the right registration_team
//   - success_url drops the parent on PLAYBACK's claim/register page with the
//     email pre-filled via Stripe's {CHECKOUT_SESSION_CUSTOMER_EMAIL} variable
//   - cancel_url returns to the same /academy/[clubSlug] page with ?canceled=1
//
// No idempotency key on the Stripe call: two different parents picking the
// same (club, team) inside 24h would collide on a (club, team, price)-based
// key. Per-call freshness is correct here — duplicate sessions cost nothing
// (they expire after 24h with no payment).

import Stripe from 'stripe'
import { createServiceClient } from '@/lib/supabase/server'
import { getClubBySlug, type AcademyClub } from './config'

// ============================================================================
// Types
// ============================================================================

export interface CreateAcademyCheckoutInput {
  clubSlug: string
  teamSlug: string
}

export type CheckoutOutcome =
  | { kind: 'success'; url: string; sessionId: string }
  | {
      kind: 'failure'
      reason:
        | 'invalid_team_slug'
        | 'club_not_found'
        | 'team_not_found'
        | 'no_recurring_price'
        | 'stripe_invalid_request'
        | 'stripe_rate_limited'
        | 'stripe_unreachable'
        | 'unknown'
      error: string
    }

export interface CheckoutDeps {
  loadClub: (clubSlug: string) => Promise<AcademyClub | undefined>
  loadActiveTeam: (
    clubSlug: string,
    teamSlug: string
  ) => Promise<{ display_name: string } | null>
  listActiveRecurringPrices: (
    productId: string
  ) => Promise<Pick<Stripe.Price, 'id'>[]>
  createCheckoutSession: (
    params: Stripe.Checkout.SessionCreateParams,
    options?: { idempotencyKey?: string }
  ) => Promise<Pick<Stripe.Checkout.Session, 'id' | 'url'>>
  /** Where the parent goes after success / cancel. PLAYBACK domain by default.
   *  Trailing slashes are normalized away in buildDefaultDeps. */
  playbackUrl: string
}

export interface CreateAcademyCheckoutOptions {
  /** Caller-supplied idempotency key (e.g. from a browser submit nonce).
   *  Pass through to Stripe so retries resolve to the same session. */
  idempotencyKey?: string
}

// ============================================================================
// Validation
// ============================================================================
// Same shape as the webhook-side validation so both ends agree on what's a
// valid slug. Required: lowercase alphanumeric or hyphen, leading alnum, ≤64.
const TEAM_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export function isValidTeamSlug(slug: string): boolean {
  return TEAM_SLUG_RE.test(slug)
}

// ============================================================================
// Default dependencies
// ============================================================================

let cachedStripe: Stripe | null = null
function getStripe(): Stripe {
  if (!cachedStripe) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) {
      throw new Error(
        'STRIPE_SECRET_KEY is not set — academy/checkout cannot run without it'
      )
    }
    cachedStripe = new Stripe(key, { apiVersion: '2025-02-24.acacia' })
  }
  return cachedStripe
}

export function buildDefaultDeps(): CheckoutDeps {
  return {
    loadClub: getClubBySlug,
    loadActiveTeam: async (clubSlug, teamSlug) => {
      const supabase = createServiceClient() as any
      const { data, error } = await supabase
        .from('playhub_academy_teams')
        .select('display_name')
        .eq('club_slug', clubSlug)
        .eq('team_slug', teamSlug)
        .eq('is_active', true)
        .maybeSingle()
      if (error) throw new Error(`loadActiveTeam: ${error.message}`)
      return data ?? null
    },
    listActiveRecurringPrices: async (productId) => {
      const stripe = getStripe()
      const list = await stripe.prices.list({
        product: productId,
        active: true,
        type: 'recurring',
        limit: 5,
      })
      return list.data
    },
    createCheckoutSession: async (params, options) => {
      const stripe = getStripe()
      const session = await stripe.checkout.sessions.create(
        params,
        options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined
      )
      return { id: session.id, url: session.url }
    },
    playbackUrl: (
      process.env.NEXT_PUBLIC_PLAYBACK_URL || 'https://playbacksports.ai'
    ).replace(/\/+$/, ''),
  }
}

// ============================================================================
// Main entry point
// ============================================================================

export async function createAcademyCheckoutSession(
  input: CreateAcademyCheckoutInput,
  deps: CheckoutDeps = buildDefaultDeps(),
  options: CreateAcademyCheckoutOptions = {}
): Promise<CheckoutOutcome> {
  const { clubSlug, teamSlug } = input

  if (!isValidTeamSlug(teamSlug)) {
    return {
      kind: 'failure',
      reason: 'invalid_team_slug',
      error: `team_slug must match ^[a-z0-9][a-z0-9-]{0,63}$`,
    }
  }

  const club = await deps.loadClub(clubSlug)
  if (!club) {
    return {
      kind: 'failure',
      reason: 'club_not_found',
      error: `unknown club: ${clubSlug}`,
    }
  }

  const team = await deps.loadActiveTeam(clubSlug, teamSlug)
  if (!team) {
    return {
      kind: 'failure',
      reason: 'team_not_found',
      error: `unknown team ${teamSlug} for club ${clubSlug}`,
    }
  }

  let prices: Pick<Stripe.Price, 'id'>[]
  try {
    prices = await deps.listActiveRecurringPrices(club.stripeProductId)
  } catch (err) {
    return classifyStripeError(err)
  }
  if (prices.length === 0) {
    return {
      kind: 'failure',
      reason: 'no_recurring_price',
      error: `no active recurring price for product ${club.stripeProductId}`,
    }
  }
  // LYL pilot: one product, one price per club. If we ever ship multiple
  // prices (e.g. monthly vs annual) the choice should land on the input
  // payload — for now, pick the first deterministically and surface a warn.
  if (prices.length > 1) {
    console.warn(
      JSON.stringify({
        event: 'academy_checkout_multiple_prices',
        club_slug: clubSlug,
        product_id: club.stripeProductId,
        price_count: prices.length,
        chosen_price_id: prices[0].id,
      })
    )
  }
  const price = prices[0]

  // Build the success URL on PLAYBACK (consumer brand). Only `{CHECKOUT_SESSION_ID}`
  // is a documented Stripe template variable on success_url. PLAYBACK's
  // register page (D1/D2) takes session_id, server-side calls
  // stripe.checkout.sessions.retrieve(id) to get customer_details.email, and
  // pre-fills the form. Single Stripe roundtrip — keeps secrets in PLAYBACK.
  // Including club_slug in the URL lets the register page render club-aware copy.
  const successUrl =
    `${deps.playbackUrl}/auth/register?intent=academy` +
    `&session_id={CHECKOUT_SESSION_ID}` +
    `&club=${encodeURIComponent(clubSlug)}`
  const cancelUrl = `${deps.playbackUrl}/academy/${encodeURIComponent(clubSlug)}?canceled=1`

  // Metadata is duplicated onto BOTH session.metadata and
  // subscription_data.metadata. The webhook handler reads session.metadata
  // on checkout.session.completed; subscription metadata is what shows up on
  // every customer.subscription.* event afterwards (handy for ops tooling).
  const sharedMetadata = {
    type: 'academy_subscription',
    club_slug: clubSlug,
    team_slug: teamSlug,
    source: 'playback_web',
  }

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: price.id, quantity: 1 }],
    metadata: sharedMetadata,
    subscription_data: { metadata: sharedMetadata },
    customer_creation: 'always',
    allow_promotion_codes: true,
    success_url: successUrl,
    cancel_url: cancelUrl,
  }

  let session: Pick<Stripe.Checkout.Session, 'id' | 'url'>
  try {
    session = await deps.createCheckoutSession(
      params,
      options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined
    )
  } catch (err) {
    return classifyStripeError(err)
  }

  if (!session.url) {
    return {
      kind: 'failure',
      reason: 'unknown',
      error: 'Stripe returned a session with no URL',
    }
  }

  return { kind: 'success', url: session.url, sessionId: session.id }
}

// ============================================================================
// Stripe error classification
// ============================================================================
// Mirrors the pattern in src/app/api/checkout/session/route.ts but uses the
// CheckoutOutcome shape so callers can branch on the categorical reason.

function classifyStripeError(err: unknown): CheckoutOutcome {
  if (err instanceof Stripe.errors.StripeInvalidRequestError) {
    return {
      kind: 'failure',
      reason: 'stripe_invalid_request',
      error: err.message,
    }
  }
  // Rate-limit gets its own bucket so the route can return 429 + Retry-After
  // (lets PLAYBACK's proxy back off rather than treating it as a 5xx outage).
  if (err instanceof Stripe.errors.StripeRateLimitError) {
    return {
      kind: 'failure',
      reason: 'stripe_rate_limited',
      error: err.message,
    }
  }
  if (
    err instanceof Stripe.errors.StripeConnectionError ||
    err instanceof Stripe.errors.StripeAPIError
  ) {
    return {
      kind: 'failure',
      reason: 'stripe_unreachable',
      error: err.message,
    }
  }
  return {
    kind: 'failure',
    reason: 'unknown',
    error: err instanceof Error ? err.message : String(err),
  }
}
