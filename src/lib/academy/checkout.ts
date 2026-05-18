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
  /** Hierarchical-academy middle layer (LYL → 'barnes-eagles'). Optional —
   *  flat configs (CFA, SEFA) omit this. When present, the team lookup is
   *  scoped to (club, subclub, team) and the metadata round-trips through
   *  Stripe so the webhook can persist the right subscription row. */
  subclubSlug?: string | null
}

export type CheckoutOutcome =
  | { kind: 'success'; url: string; sessionId: string }
  | {
      kind: 'failure'
      reason:
        | 'invalid_team_slug'
        | 'invalid_subclub_slug'
        | 'club_not_found'
        | 'subclub_not_found'
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
  /** Verify the subclub exists + is active under this club. Returns its
   *  display_name so the success page can render "Welcome to <subclub>".
   *  Only called when subclubSlug is provided. */
  loadActiveSubclub: (
    clubSlug: string,
    subclubSlug: string
  ) => Promise<{ display_name: string } | null>
  /** Subclub-aware team lookup. When subclubSlug is null the SQL filters
   *  `subclub_slug IS NULL` to match the flat-config partial UNIQUE; when
   *  set it filters by exact match against the hierarchical UNIQUE. The
   *  two indexes are mutually exclusive so each query returns ≤1 row. */
  loadActiveTeam: (
    clubSlug: string,
    teamSlug: string,
    subclubSlug: string | null
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
// subclub_slug shares the team_slug shape — both are user-facing slugs
// surfaced in URLs and Stripe metadata; the same charset/length bounds apply.
const SUBCLUB_SLUG_RE = TEAM_SLUG_RE
export function isValidSubclubSlug(slug: string): boolean {
  return SUBCLUB_SLUG_RE.test(slug)
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
    loadActiveSubclub: async (clubSlug, subclubSlug) => {
      const supabase = createServiceClient() as any
      const { data, error } = await supabase
        .from('playhub_academy_subclubs')
        .select('display_name')
        .eq('club_slug', clubSlug)
        .eq('subclub_slug', subclubSlug)
        .eq('is_active', true)
        .maybeSingle()
      if (error) throw new Error(`loadActiveSubclub: ${error.message}`)
      return data ?? null
    },
    loadActiveTeam: async (clubSlug, teamSlug, subclubSlug) => {
      const supabase = createServiceClient() as any
      let q = supabase
        .from('playhub_academy_teams')
        .select('display_name')
        .eq('club_slug', clubSlug)
        .eq('team_slug', teamSlug)
        .eq('is_active', true)
      // NULL-aware filter: Postgres treats NULL as distinct, so the eq
      // operator on null returns zero rows. Use IS NULL explicitly so the
      // flat-config (CFA/SEFA) lookup hits the right partial UNIQUE.
      q = subclubSlug
        ? q.eq('subclub_slug', subclubSlug)
        : q.is('subclub_slug', null)
      const { data, error } = await q.maybeSingle()
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
  // Empty string and null both mean "flat config" — caller-side serialisers
  // sometimes hand us "" instead of omitting the field. Symmetric with the
  // webhook handler's normalisation so the round-trip is loss-free.
  const subclubSlug =
    typeof input.subclubSlug === 'string' && input.subclubSlug.length > 0
      ? input.subclubSlug
      : null

  if (!isValidTeamSlug(teamSlug)) {
    return {
      kind: 'failure',
      reason: 'invalid_team_slug',
      error: `team_slug must match ^[a-z0-9][a-z0-9-]{0,63}$`,
    }
  }
  if (subclubSlug !== null && !isValidSubclubSlug(subclubSlug)) {
    return {
      kind: 'failure',
      reason: 'invalid_subclub_slug',
      error: `subclub_slug must match ^[a-z0-9][a-z0-9-]{0,63}$`,
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

  // Hierarchical pre-flight: when the caller picked a subclub, verify it
  // exists + is active under this club before we touch the teams table.
  // Returning a distinct reason lets the UI surface a "this subclub no
  // longer exists" message instead of a generic "team not found".
  if (subclubSlug !== null) {
    const subclub = await deps.loadActiveSubclub(clubSlug, subclubSlug)
    if (!subclub) {
      return {
        kind: 'failure',
        reason: 'subclub_not_found',
        error: `unknown subclub ${subclubSlug} for club ${clubSlug}`,
      }
    }
  }

  const team = await deps.loadActiveTeam(clubSlug, teamSlug, subclubSlug)
  if (!team) {
    const teamPath = subclubSlug
      ? `${clubSlug}/${subclubSlug}/${teamSlug}`
      : `${clubSlug}/${teamSlug}`
    return {
      kind: 'failure',
      reason: 'team_not_found',
      error: `unknown team: ${teamPath}`,
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
  // Including club_slug + (optionally) subclub in the URL lets the register
  // page render hierarchical-aware copy without an extra DB roundtrip.
  const successUrl =
    `${deps.playbackUrl}/auth/register?intent=academy` +
    `&session_id={CHECKOUT_SESSION_ID}` +
    `&club=${encodeURIComponent(clubSlug)}` +
    (subclubSlug ? `&subclub=${encodeURIComponent(subclubSlug)}` : '')
  // Cancel returns the parent to the page they came FROM. PLAYBACK's
  // hierarchical picker (AcademyHierarchicalPicker.tsx) keeps subclub
  // selection in the `?club=<subclubSlug>` QUERY PARAM — there is NO
  // nested /academy/[clubSlug]/[subclubSlug] route. So a nested-path
  // cancel_url 404s. Always land on /academy/[clubSlug], optionally
  // carrying the subclub selection so the picker re-opens the right tab.
  const cancelQs = subclubSlug
    ? `?club=${encodeURIComponent(subclubSlug)}&canceled=1`
    : `?canceled=1`
  const cancelUrl = `${deps.playbackUrl}/academy/${encodeURIComponent(clubSlug)}${cancelQs}`

  // Metadata is duplicated onto BOTH session.metadata and
  // subscription_data.metadata. The webhook handler reads session.metadata
  // on checkout.session.completed; subscription metadata is what shows up on
  // every customer.subscription.* event afterwards (handy for ops tooling).
  // Stripe rejects null/undefined metadata values — we omit subclub_slug
  // from the object entirely when null rather than serialising "null".
  const sharedMetadata: Record<string, string> = {
    type: 'academy_subscription',
    club_slug: clubSlug,
    team_slug: teamSlug,
    source: 'playback_web',
  }
  if (subclubSlug) sharedMetadata.subclub_slug = subclubSlug

  // subscription mode always creates a Stripe Customer — explicit
  // customer_creation is rejected by Stripe ("customer_creation can only be
  // used in payment mode"). Stripe's docs confirm: every subscription
  // checkout gets a customer for free.
  // Line items: recurring subscription + optional one-time registration
  // fee. Stripe charges the one-time fee on the first invoice alongside
  // the recurring price. Same shape as the legacy CFA Payment Links
  // (which include the canonical £0.35 Processing Fee as a second line
  // item). Per-club via playhub_academy_config.registration_fee_stripe_price_id.
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    { price: price.id, quantity: 1 },
  ]
  if (club.registrationFeeStripePriceId) {
    lineItems.push({ price: club.registrationFeeStripePriceId, quantity: 1 })
  }

  // Custom fields collected at Stripe Checkout. Both are OPTIONAL on Stripe's
  // side so the form NEVER blocks the parent from paying — the change must
  // not introduce a new failure mode in the checkout funnel. The webhook
  // parser at handleAcademyCheckoutCompleted reads them out by key when
  // present (null otherwise) and stores them on playhub_academy_subscriptions
  // for roster reconciliation later. Keys MUST stay alphanumeric — Stripe
  // rejects underscores in custom_field keys, hence "playername" /
  // "subscribertype" (matching the legacy CFA / SEFA Payment Link convention
  // that lib/academy/stripe.ts already parses).
  const customFields: Stripe.Checkout.SessionCreateParams.CustomField[] = [
    {
      key: 'playername',
      type: 'text',
      label: { type: 'custom', custom: "Player's full name" },
      optional: true,
      text: { maximum_length: 80 },
    },
    {
      key: 'subscribertype',
      type: 'dropdown',
      label: { type: 'custom', custom: 'I am the…' },
      optional: true,
      dropdown: {
        options: [
          { label: 'Parent / guardian', value: 'parent' },
          { label: 'Player', value: 'player' },
        ],
      },
    },
  ]

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: lineItems,
    metadata: sharedMetadata,
    subscription_data: { metadata: sharedMetadata },
    allow_promotion_codes: true,
    custom_fields: customFields,
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
