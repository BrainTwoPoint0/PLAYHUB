// Unit tests for the Stripe Checkout Session lookup library.
//
// All Stripe + config calls are injected via SessionLookupDeps — no module
// mocking, no network. Real-Stripe validation happens during E with a real
// session_id minted from the live checkout flow.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Stripe from 'stripe'
import {
  lookupAcademySession,
  type SessionLookupDeps,
  type SessionLookupOutcome,
} from '../session-lookup'
import type { AcademyClub } from '../config'

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const baseClub: AcademyClub = {
  slug: 'lyl',
  name: 'London Youth League',
  stripeProductId: 'prod_lyl_1',
  veoClubSlug: 'lyl-veo-slug',
}

function makeSession(
  overrides: Partial<Stripe.Checkout.Session> = {},
  metadataOverrides: Record<string, string> = {}
): Stripe.Checkout.Session {
  return {
    id: 'cs_live_aaaaaaaaaaaaaaaaaaaa',
    status: 'complete',
    payment_status: 'paid',
    metadata: {
      type: 'academy_subscription',
      club_slug: 'lyl',
      team_slug: 'lyl-u12-tigers',
      ...metadataOverrides,
    },
    customer_details: {
      email: 'parent@example.com',
      name: 'Test Parent',
    } as Stripe.Checkout.Session.CustomerDetails,
    ...overrides,
  } as Stripe.Checkout.Session
}

function makeDeps(overrides: Partial<SessionLookupDeps> = {}): SessionLookupDeps {
  return {
    fetchStripeSession: vi.fn(async () => makeSession()),
    loadClub: vi.fn(async () => baseClub),
    ...overrides,
  }
}

function expectFound(o: SessionLookupOutcome) {
  expect(o.kind).toBe('found')
  return o as Extract<SessionLookupOutcome, { kind: 'found' }>
}
function expectNotFound(o: SessionLookupOutcome) {
  expect(o.kind).toBe('not_found')
  return o as Extract<SessionLookupOutcome, { kind: 'not_found' }>
}
function expectTransient(o: SessionLookupOutcome) {
  expect(o.kind).toBe('transient')
  return o as Extract<SessionLookupOutcome, { kind: 'transient' }>
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('lookupAcademySession', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('input validation', () => {
    it('returns not_found WITHOUT calling Stripe for malformed session ids', async () => {
      const deps = makeDeps()
      for (const bad of [
        '',
        'not-a-stripe-id',
        'cs_live_short',
        'cs_test_<script>',
        'cs_live_' + 'x'.repeat(201),
        'CS_LIVE_AAAAAAAAAA',
        '../../etc/passwd',
      ]) {
        const o = await lookupAcademySession(bad, deps)
        expectNotFound(o)
      }
      expect(deps.fetchStripeSession).not.toHaveBeenCalled()
    })

    it('accepts well-formed cs_live_ and cs_test_ ids', async () => {
      const deps = makeDeps()
      for (const good of [
        'cs_live_aaaaaaaaaaaaaaaaaaaa',
        'cs_test_AbCdEfGhIjKlMnOpQrSt12345',
      ]) {
        await lookupAcademySession(good, deps)
      }
      expect(deps.fetchStripeSession).toHaveBeenCalledTimes(2)
    })
  })

  describe('SECURITY — type/payment/status gates', () => {
    it('rejects sessions with metadata.type !== academy_subscription (anti-enumeration)', async () => {
      const deps = makeDeps({
        fetchStripeSession: vi.fn(async () =>
          makeSession({}, { type: 'venue_booking' })
        ),
      })
      const o = await lookupAcademySession('cs_live_aaaaaaaaaaaaaaaaaaaa', deps)
      expectNotFound(o)
      expect(deps.loadClub).not.toHaveBeenCalled()
    })

    it('rejects sessions with no metadata.type', async () => {
      const deps = makeDeps({
        fetchStripeSession: vi.fn(async () =>
          makeSession({ metadata: null as any })
        ),
      })
      const o = await lookupAcademySession('cs_live_aaaaaaaaaaaaaaaaaaaa', deps)
      expectNotFound(o)
    })

    it('rejects sessions with payment_status === unpaid', async () => {
      const deps = makeDeps({
        fetchStripeSession: vi.fn(async () =>
          makeSession({ payment_status: 'unpaid' })
        ),
      })
      const o = await lookupAcademySession('cs_live_aaaaaaaaaaaaaaaaaaaa', deps)
      expectNotFound(o)
    })

    it('accepts payment_status === no_payment_required (trialing)', async () => {
      const deps = makeDeps({
        fetchStripeSession: vi.fn(async () =>
          makeSession({ payment_status: 'no_payment_required' })
        ),
      })
      const o = await lookupAcademySession('cs_live_aaaaaaaaaaaaaaaaaaaa', deps)
      expectFound(o)
    })

    it('rejects sessions with status !== complete (open / expired)', async () => {
      for (const status of ['open', 'expired'] as const) {
        const deps = makeDeps({
          fetchStripeSession: vi.fn(async () => makeSession({ status })),
        })
        const o = await lookupAcademySession('cs_live_aaaaaaaaaaaaaaaaaaaa', deps)
        expectNotFound(o)
      }
    })

    it('rejects sessions with no customer email', async () => {
      const deps = makeDeps({
        fetchStripeSession: vi.fn(async () =>
          makeSession({
            customer_details: {
              name: 'No Email',
            } as Stripe.Checkout.Session.CustomerDetails,
          })
        ),
      })
      const o = await lookupAcademySession('cs_live_aaaaaaaaaaaaaaaaaaaa', deps)
      expectNotFound(o)
    })

    it('rejects sessions where club_slug references a missing config row', async () => {
      const deps = makeDeps({
        loadClub: vi.fn(async () => undefined),
      })
      const o = await lookupAcademySession('cs_live_aaaaaaaaaaaaaaaaaaaa', deps)
      expectNotFound(o)
    })

    it('rejects sessions with missing metadata.club_slug or team_slug', async () => {
      for (const stripped of ['club_slug', 'team_slug']) {
        const deps = makeDeps({
          fetchStripeSession: vi.fn(async () => {
            const s = makeSession()
            const meta = { ...s.metadata }
            delete meta[stripped as keyof typeof meta]
            return { ...s, metadata: meta } as Stripe.Checkout.Session
          }),
        })
        const o = await lookupAcademySession('cs_live_aaaaaaaaaaaaaaaaaaaa', deps)
        expectNotFound(o)
      }
    })
  })

  describe('happy path', () => {
    it('returns the safe subset (email lowercased + trimmed, no Stripe internals)', async () => {
      const deps = makeDeps({
        fetchStripeSession: vi.fn(async () =>
          makeSession({
            customer_details: {
              email: '  PARENT@Example.COM  ',
              name: 'Test Parent',
            } as Stripe.Checkout.Session.CustomerDetails,
          })
        ),
      })
      const o = await lookupAcademySession('cs_live_aaaaaaaaaaaaaaaaaaaa', deps)
      const ok = expectFound(o)
      expect(ok.data).toEqual({
        customer_email: 'parent@example.com',
        customer_name: 'Test Parent',
        club_slug: 'lyl',
        club_name: 'London Youth League',
        team_slug: 'lyl-u12-tigers',
      })
    })

    it('does NOT leak Stripe customer_id, subscription_id, or price details', async () => {
      const deps = makeDeps({
        fetchStripeSession: vi.fn(async () =>
          makeSession({
            customer: 'cus_secret_xxx',
            subscription: 'sub_secret_xxx',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any)
        ),
      })
      const o = await lookupAcademySession('cs_live_aaaaaaaaaaaaaaaaaaaa', deps)
      const ok = expectFound(o)
      // Verify the result has ONLY the expected keys.
      expect(Object.keys(ok.data).sort()).toEqual([
        'club_name',
        'club_slug',
        'customer_email',
        'customer_name',
        'team_slug',
      ])
    })

    it('returns customer_name as null when Stripe omits it', async () => {
      const deps = makeDeps({
        fetchStripeSession: vi.fn(async () =>
          makeSession({
            customer_details: {
              email: 'parent@example.com',
            } as Stripe.Checkout.Session.CustomerDetails,
          })
        ),
      })
      const o = await lookupAcademySession('cs_live_aaaaaaaaaaaaaaaaaaaa', deps)
      const ok = expectFound(o)
      expect(ok.data.customer_name).toBeNull()
    })
  })

  describe('Stripe error handling', () => {
    it('returns not_found when Stripe returns null (resource_missing)', async () => {
      const deps = makeDeps({
        fetchStripeSession: vi.fn(async () => null),
      })
      const o = await lookupAcademySession('cs_live_aaaaaaaaaaaaaaaaaaaa', deps)
      expectNotFound(o)
    })

    it('returns transient when Stripe call throws (network / 5xx)', async () => {
      const deps = makeDeps({
        fetchStripeSession: vi.fn(async () => {
          throw new Error('ECONNRESET')
        }),
      })
      const o = await lookupAcademySession('cs_live_aaaaaaaaaaaaaaaaaaaa', deps)
      const t = expectTransient(o)
      expect(t.error).toMatch(/ECONNRESET/)
    })
  })
})
