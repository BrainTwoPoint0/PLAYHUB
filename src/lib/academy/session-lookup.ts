// Stripe Checkout Session lookup for the PLAYBACK register page (D2).
//
// After checkout, Stripe redirects to:
//   playbacksports.ai/auth/register?intent=academy&session_id={CHECKOUT_SESSION_ID}&club=...
//
// PLAYBACK doesn't have the Stripe key (lives in PLAYHUB). The register
// page calls PLAYBACK's server action → PLAYBACK's proxy → this lookup,
// which fetches the Stripe session, validates it's a paid academy
// subscription, and returns ONLY the safe subset (email, name, club name)
// the register form needs to pre-fill.
//
// SECURITY CONTRACT (carry-over from C/D1):
//   - Anyone with a session_id can call this — there's no user-session at
//     register time. Treat the returned email as DISPLAY ONLY. The actual
//     auth identity comes from Supabase signup + email confirmation.
//   - Validate metadata.type === 'academy_subscription' before returning
//     anything — prevents someone passing in any other session id from
//     this Stripe account (e.g. a venue booking) and seeing that customer's
//     email pre-filled on the register form.
//   - Validate payment_status === 'paid' (or 'no_payment_required' for
//     trials) AND session.status === 'complete'. Don't pre-fill on
//     'expired' or 'open' sessions.
//   - Return a single 'not_found' outcome for any failure (invalid id,
//     wrong type, not paid, expired, missing metadata) so the endpoint
//     can't be used as an enumeration oracle on existing sessions.
//
// DI'd for unit tests — defaults wire to real Stripe + the academy config
// loader so unit tests can mock both without module mocking.

import Stripe from 'stripe'
import { createServiceClient } from '@/lib/supabase/server'
import { getClubBySlug, type AcademyClub } from './config'

export interface SessionLookupResult {
  // Safe subset to return to PLAYBACK. Anything in here ends up rendered to
  // the parent's browser — keep it minimal and PII-aware.
  customer_email: string
  customer_name: string | null
  club_slug: string
  club_name: string
  team_slug: string
  /** Hierarchical-academy middle layer (LYL → 'barnes-eagles'). NULL for
   *  flat configs (CFA, SEFA). Validated to the same slug shape as
   *  team_slug before being returned. */
  subclub_slug: string | null
  /** Human-readable subclub name resolved from playhub_academy_subclubs.
   *  NULL when subclub_slug is NULL OR when the subclub row was
   *  deactivated between checkout and register (parent should still be
   *  able to register — the slug is the load-bearing identifier, the
   *  name is just nice-to-have copy). */
  subclub_name: string | null
}

export type SessionLookupOutcome =
  | { kind: 'found'; data: SessionLookupResult }
  // Single 'not_found' bucket so the response shape can't be used to tell
  // valid-but-wrong-type sessions apart from non-existent ones.
  | { kind: 'not_found' }
  | { kind: 'transient'; error: string }

export interface SessionLookupDeps {
  fetchStripeSession: (
    sessionId: string
  ) => Promise<Stripe.Checkout.Session | null>
  loadClub: (clubSlug: string) => Promise<AcademyClub | undefined>
  /** Resolve a subclub's display_name. Only called when the session has a
   *  subclub_slug in metadata. Returns null when row missing/inactive — the
   *  outcome stays 'found' so the parent can still register. */
  loadSubclubDisplayName: (
    clubSlug: string,
    subclubSlug: string
  ) => Promise<string | null>
}

let cachedStripe: Stripe | null = null
function getStripe(): Stripe {
  if (!cachedStripe) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) {
      throw new Error(
        'STRIPE_SECRET_KEY is not set — academy/session-lookup cannot run without it'
      )
    }
    cachedStripe = new Stripe(key, { apiVersion: '2025-02-24.acacia' })
  }
  return cachedStripe
}

export function buildDefaultDeps(): SessionLookupDeps {
  return {
    fetchStripeSession: async (sessionId) => {
      try {
        return await getStripe().checkout.sessions.retrieve(sessionId)
      } catch (err) {
        // Stripe returns StripeInvalidRequestError for missing sessions.
        // Anything else (network / 5xx) is transient; rethrow so the caller
        // can classify.
        if (err instanceof Stripe.errors.StripeInvalidRequestError) return null
        throw err
      }
    },
    loadClub: getClubBySlug,
    loadSubclubDisplayName: async (clubSlug, subclubSlug) => {
      const supabase = createServiceClient() as any
      const { data, error } = await supabase
        .from('playhub_academy_subclubs')
        .select('display_name')
        .eq('club_slug', clubSlug)
        .eq('subclub_slug', subclubSlug)
        .eq('is_active', true)
        .maybeSingle()
      if (error) throw new Error(`loadSubclubDisplayName: ${error.message}`)
      return data?.display_name ?? null
    },
  }
}

// Stripe session ids are stable: cs_test_xxx or cs_live_xxx, alphanumeric.
// Bound the input shape so a junk id can't waste a Stripe roundtrip / pollute
// logs / smuggle anything into the proxy.
const SESSION_ID_RE = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/

// Same shape as the checkout/webhook regex — bound subclub slug pulled
// from session metadata before it lands in our response body / logs.
const SUBCLUB_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export async function lookupAcademySession(
  sessionId: string,
  deps: SessionLookupDeps = buildDefaultDeps()
): Promise<SessionLookupOutcome> {
  if (!SESSION_ID_RE.test(sessionId)) {
    return { kind: 'not_found' }
  }

  let session: Stripe.Checkout.Session | null
  try {
    session = await deps.fetchStripeSession(sessionId)
  } catch (err) {
    return {
      kind: 'transient',
      error: err instanceof Error ? err.message : String(err),
    }
  }
  if (!session) return { kind: 'not_found' }

  // SECURITY: type gate. Without this, anyone with a session_id from any
  // other Stripe flow in this account (venue bookings, future products) can
  // call this endpoint and see that customer's email.
  const metadata = session.metadata || {}
  if (metadata.type !== 'academy_subscription') return { kind: 'not_found' }

  const clubSlug = metadata.club_slug
  const teamSlug = metadata.team_slug
  if (!clubSlug || !teamSlug) return { kind: 'not_found' }

  // Payment gate. Stripe payment_status:
  //   'paid'                — first invoice paid (standard subscription)
  //   'no_payment_required' — trialing subscription, valid entitlement
  //   'unpaid'              — incomplete; do NOT trust the email
  // Plus session.status must be 'complete' (not 'expired' / 'open').
  if (session.status !== 'complete') return { kind: 'not_found' }
  if (
    session.payment_status !== 'paid' &&
    session.payment_status !== 'no_payment_required'
  ) {
    return { kind: 'not_found' }
  }

  const email = session.customer_details?.email?.trim().toLowerCase()
  if (!email) return { kind: 'not_found' }

  const club = await deps.loadClub(clubSlug)
  if (!club) return { kind: 'not_found' }

  // Cap customer_name length before it leaves the boundary. Stripe accepts
  // up to 255 chars including UTF-8 control codepoints (RTL overrides,
  // zero-width joiners) which can disrupt downstream rendering — bound
  // here so future devs reading the value into PDF/email/CSV contexts
  // don't have to defend independently.
  const rawName = session.customer_details?.name?.trim()
  const customerName = rawName ? rawName.slice(0, 120) : null

  // Hierarchical-academy middle layer. Validate slug shape BEFORE letting
  // it leave the lookup — even though metadata.subclub_slug came from our
  // own checkout flow, future Stripe Payment Links / dashboard-edited
  // sessions could carry a malformed value. A failed shape check downgrades
  // to flat (subclub_slug=null, subclub_name=null) so the parent can still
  // register; the row's authoritative subclub identity is whatever the
  // webhook persisted, NOT this display surface.
  const rawSubclub = metadata.subclub_slug
  let subclubSlug: string | null = null
  let subclubName: string | null = null
  if (typeof rawSubclub === 'string' && SUBCLUB_SLUG_RE.test(rawSubclub)) {
    subclubSlug = rawSubclub
    try {
      subclubName = await deps.loadSubclubDisplayName(clubSlug, rawSubclub)
    } catch {
      // Supabase blip — keep the slug, drop the name. Register page degrades
      // gracefully ("Welcome to your subscription" instead of subclub copy).
      subclubName = null
    }
  }

  return {
    kind: 'found',
    data: {
      customer_email: email,
      customer_name: customerName,
      club_slug: clubSlug,
      club_name: club.name,
      team_slug: teamSlug,
      subclub_slug: subclubSlug,
      subclub_name: subclubName,
    },
  }
}
