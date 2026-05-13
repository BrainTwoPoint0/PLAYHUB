// Unit tests for the academy checkout-session library.
//
// Same DI pattern as provision.test.ts and webhook-handlers.test.ts: tests
// inject mock Stripe + Supabase deps, no module mocking. Curl + real-Stripe
// validation happens during E's go-live.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createAcademyCheckoutSession,
  isValidTeamSlug,
  type CheckoutDeps,
  type CheckoutOutcome,
} from '../checkout'
import type { AcademyClub } from '../config'
import Stripe from 'stripe'

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const baseClub: AcademyClub = {
  slug: 'lyl',
  name: 'London Youth League',
  stripeProductId: 'prod_lyl_1',
  veoClubSlug: 'lyl-veo-slug',
}

function makeDeps(overrides: Partial<CheckoutDeps> = {}): CheckoutDeps {
  return {
    loadClub: vi.fn(async () => baseClub),
    loadActiveTeam: vi.fn(async () => ({ display_name: 'U12 Tigers' })),
    listActiveRecurringPrices: vi.fn(async () => [{ id: 'price_lyl_1' }]),
    createCheckoutSession: vi.fn(async (params) => ({
      id: 'cs_test_1',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    })),
    playbackUrl: 'https://playbacksports.ai',
    ...overrides,
  }
}

function expectSuccess(
  outcome: CheckoutOutcome
): Extract<CheckoutOutcome, { kind: 'success' }> {
  expect(outcome.kind).toBe('success')
  return outcome as Extract<CheckoutOutcome, { kind: 'success' }>
}

function expectFailure(
  outcome: CheckoutOutcome
): Extract<CheckoutOutcome, { kind: 'failure' }> {
  expect(outcome.kind).toBe('failure')
  return outcome as Extract<CheckoutOutcome, { kind: 'failure' }>
}

// ----------------------------------------------------------------------------
// isValidTeamSlug
// ----------------------------------------------------------------------------

describe('isValidTeamSlug', () => {
  it('accepts well-formed slugs', () => {
    for (const s of ['lyl', 'lyl-u12-tigers', 'a1', '1team', 'a' + '-'.repeat(63)]) {
      expect(isValidTeamSlug(s)).toBe(true)
    }
  })

  it('rejects malformed slugs', () => {
    for (const s of [
      '',
      ' ',
      'team with spaces',
      '<script>',
      'A'.repeat(65),
      '-leading-hyphen',
      'UPPERCASE',
      'team\nnewline',
    ]) {
      expect(isValidTeamSlug(s)).toBe(false)
    }
  })
})

// ----------------------------------------------------------------------------
// createAcademyCheckoutSession
// ----------------------------------------------------------------------------

describe('createAcademyCheckoutSession', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('input validation', () => {
    it('rejects invalid team_slug shape', async () => {
      const deps = makeDeps()
      const outcome = await createAcademyCheckoutSession(
        { clubSlug: 'lyl', teamSlug: '<script>alert(1)</script>' },
        deps
      )
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('invalid_team_slug')
      expect(deps.loadClub).not.toHaveBeenCalled()
      expect(deps.loadActiveTeam).not.toHaveBeenCalled()
      expect(deps.createCheckoutSession).not.toHaveBeenCalled()
    })

    it('returns club_not_found when academy config is missing', async () => {
      const deps = makeDeps({ loadClub: vi.fn(async () => undefined) })
      const outcome = await createAcademyCheckoutSession(
        { clubSlug: 'unknown', teamSlug: 'lyl-u12-tigers' },
        deps
      )
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('club_not_found')
      expect(deps.loadActiveTeam).not.toHaveBeenCalled()
    })

    it('returns team_not_found when team is missing or inactive', async () => {
      const deps = makeDeps({ loadActiveTeam: vi.fn(async () => null) })
      const outcome = await createAcademyCheckoutSession(
        { clubSlug: 'lyl', teamSlug: 'lyl-no-such-team' },
        deps
      )
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('team_not_found')
      expect(deps.listActiveRecurringPrices).not.toHaveBeenCalled()
    })
  })

  describe('Stripe price lookup', () => {
    it('returns no_recurring_price when product has no active recurring prices', async () => {
      const deps = makeDeps({
        listActiveRecurringPrices: vi.fn(async () => []),
      })
      const outcome = await createAcademyCheckoutSession(
        { clubSlug: 'lyl', teamSlug: 'lyl-u12-tigers' },
        deps
      )
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('no_recurring_price')
      expect(deps.createCheckoutSession).not.toHaveBeenCalled()
    })

    it('picks the first price + warns when multiple active prices exist', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const deps = makeDeps({
        listActiveRecurringPrices: vi.fn(async () => [
          { id: 'price_a' },
          { id: 'price_b' },
        ]),
      })
      await createAcademyCheckoutSession(
        { clubSlug: 'lyl', teamSlug: 'lyl-u12-tigers' },
        deps
      )
      expect(deps.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: [{ price: 'price_a', quantity: 1 }],
        }),
        undefined
      )
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const warnPayload = JSON.parse(warnSpy.mock.calls[0][0] as string)
      expect(warnPayload.event).toBe('academy_checkout_multiple_prices')
      expect(warnPayload.chosen_price_id).toBe('price_a')
      warnSpy.mockRestore()
    })
  })

  describe('Stripe session creation', () => {
    it('returns success URL on happy path', async () => {
      const deps = makeDeps()
      const outcome = await createAcademyCheckoutSession(
        { clubSlug: 'lyl', teamSlug: 'lyl-u12-tigers' },
        deps
      )
      const ok = expectSuccess(outcome)
      expect(ok.url).toMatch(/^https:\/\/checkout\.stripe\.com/)
      expect(ok.sessionId).toBe('cs_test_1')
    })

    it('builds the correct Stripe session params', async () => {
      const deps = makeDeps()
      await createAcademyCheckoutSession(
        { clubSlug: 'lyl', teamSlug: 'lyl-u12-tigers' },
        deps
      )
      expect(deps.createCheckoutSession).toHaveBeenCalledWith(
        {
          mode: 'subscription',
          payment_method_types: ['card'],
          line_items: [{ price: 'price_lyl_1', quantity: 1 }],
          metadata: {
            type: 'academy_subscription',
            club_slug: 'lyl',
            team_slug: 'lyl-u12-tigers',
            source: 'playback_web',
          },
          subscription_data: {
            metadata: {
              type: 'academy_subscription',
              club_slug: 'lyl',
              team_slug: 'lyl-u12-tigers',
              source: 'playback_web',
            },
          },
          customer_creation: 'always',
          allow_promotion_codes: true,
          // Only {CHECKOUT_SESSION_ID} is a documented Stripe template var;
          // the register page server-side fetches the session to read the email.
          success_url:
            'https://playbacksports.ai/auth/register?intent=academy' +
            '&session_id={CHECKOUT_SESSION_ID}' +
            '&club=lyl',
          cancel_url: 'https://playbacksports.ai/academy/lyl?canceled=1',
        },
        // No idempotencyKey passed in this test → second arg is undefined
        undefined
      )
    })

    it('passes Idempotency-Key through to Stripe when provided', async () => {
      const deps = makeDeps()
      await createAcademyCheckoutSession(
        { clubSlug: 'lyl', teamSlug: 'lyl-u12-tigers' },
        deps,
        { idempotencyKey: 'browser-nonce-abc-123' }
      )
      expect(deps.createCheckoutSession).toHaveBeenCalledWith(
        expect.any(Object),
        { idempotencyKey: 'browser-nonce-abc-123' }
      )
    })

    it('URL-encodes club_slug into success/cancel URLs against URL metacharacters', async () => {
      // Defense-in-depth: a malicious slug should not be able to break out of
      // the URL via &, ?, #, or /. encodeURIComponent neutralises all four.
      // (A real injection should never reach here — playhub_academy_config
      // controls the slug — but a future maintainer "optimising" by replacing
      // encodeURIComponent with encodeURI would fail this test.)
      const cases = [
        { slug: 'odd club', enc: 'odd%20club' },
        { slug: 'a&b=c', enc: 'a%26b%3Dc' },
        { slug: 'a?x', enc: 'a%3Fx' },
        { slug: 'a#frag', enc: 'a%23frag' },
        { slug: 'a/b', enc: 'a%2Fb' },
      ]
      for (const c of cases) {
        const deps = makeDeps({
          loadClub: vi.fn(async () => ({ ...baseClub, slug: c.slug })),
        })
        await createAcademyCheckoutSession(
          { clubSlug: c.slug, teamSlug: 'lyl-u12-tigers' },
          deps
        )
        const params = (deps.createCheckoutSession as any).mock.calls[0][0]
        expect(params.success_url).toContain(`club=${c.enc}`)
        expect(params.cancel_url).toContain(`/academy/${c.enc}?`)
      }
    })

    it('returns failure when Stripe returns a session with no URL', async () => {
      const deps = makeDeps({
        createCheckoutSession: vi.fn(async () => ({
          id: 'cs_test_no_url',
          url: null,
        })),
      })
      const outcome = await createAcademyCheckoutSession(
        { clubSlug: 'lyl', teamSlug: 'lyl-u12-tigers' },
        deps
      )
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('unknown')
      expect(fail.error).toMatch(/no URL/)
    })
  })

  describe('Stripe error handling', () => {
    it('classifies StripeInvalidRequestError as stripe_invalid_request', async () => {
      const err = new Stripe.errors.StripeInvalidRequestError({
        message: 'No such price',
        type: 'invalid_request_error',
      } as any)
      const deps = makeDeps({
        listActiveRecurringPrices: vi.fn(async () => {
          throw err
        }),
      })
      const outcome = await createAcademyCheckoutSession(
        { clubSlug: 'lyl', teamSlug: 'lyl-u12-tigers' },
        deps
      )
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('stripe_invalid_request')
    })

    it('classifies StripeConnectionError as stripe_unreachable', async () => {
      const err = new Stripe.errors.StripeConnectionError({
        message: 'ECONNRESET',
        type: 'connection_error',
      } as any)
      const deps = makeDeps({
        createCheckoutSession: vi.fn(async () => {
          throw err
        }),
      })
      const outcome = await createAcademyCheckoutSession(
        { clubSlug: 'lyl', teamSlug: 'lyl-u12-tigers' },
        deps
      )
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('stripe_unreachable')
    })

    it('classifies StripeRateLimitError as stripe_rate_limited (distinct from unreachable)', async () => {
      // Rate-limit is its own bucket so the route can map to 429 + Retry-After
      // (not 503, which signals total outage).
      const err = new Stripe.errors.StripeRateLimitError({
        message: 'Too many requests',
        type: 'rate_limit_error',
      } as any)
      const deps = makeDeps({
        createCheckoutSession: vi.fn(async () => {
          throw err
        }),
      })
      const outcome = await createAcademyCheckoutSession(
        { clubSlug: 'lyl', teamSlug: 'lyl-u12-tigers' },
        deps
      )
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('stripe_rate_limited')
    })

    it('classifies StripeAPIError as stripe_unreachable', async () => {
      const err = new Stripe.errors.StripeAPIError({
        message: 'API error',
        type: 'api_error',
      } as any)
      const deps = makeDeps({
        createCheckoutSession: vi.fn(async () => {
          throw err
        }),
      })
      const outcome = await createAcademyCheckoutSession(
        { clubSlug: 'lyl', teamSlug: 'lyl-u12-tigers' },
        deps
      )
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('stripe_unreachable')
    })

    it('catches unknown thrown errors as unknown failure', async () => {
      const deps = makeDeps({
        createCheckoutSession: vi.fn(async () => {
          throw new Error('something weird')
        }),
      })
      const outcome = await createAcademyCheckoutSession(
        { clubSlug: 'lyl', teamSlug: 'lyl-u12-tigers' },
        deps
      )
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('unknown')
    })
  })
})
