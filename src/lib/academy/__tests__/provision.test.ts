// Unit tests for the academy subscription provisioning library.
//
// All external systems (Stripe, Veo, Supabase) are injected via the
// ProvisionDeps interface, so these tests are pure — no module mocking,
// no network. The integration test that hits real Stripe + Veo lives in
// scripts/test-provision-academy.ts (manual one-shot, not part of the suite).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  provisionAcademyAccess,
  isSecurityFailure,
  StripeFetchError,
  type AcademySubscriptionRow,
  type ProvisionDeps,
  type ProvisionOutcome,
} from '../provision'
import type { AcademyClub } from '../config'

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const baseSub: AcademySubscriptionRow = {
  id: 'sub-uuid-1',
  user_id: 'user-uuid-1',
  club_slug: 'lyl',
  stripe_subscription_id: 'sub_stripe_1',
  stripe_customer_id: 'cus_stripe_1',
  registration_team: 'lyl-u12-tigers',
  // Default to flat (CFA/SEFA-shaped). Hierarchical-shape coverage is in
  // its own describe block below.
  registration_subclub: null,
  customer_email: 'parent@example.com',
  status: 'active',
  provisioned_at: null,
}

const baseClub: AcademyClub = {
  slug: 'lyl',
  name: 'London Youth League',
  stripeProductId: 'prod_lyl_1',
  veoClubSlug: 'lyl-veo-slug',
}

function makeDeps(overrides: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    loadSub: vi.fn(async () => baseSub),
    loadClub: vi.fn(async () => baseClub),
    // Default mock returns null. The flat-config code path never calls this,
    // so the default is a safety net — any hierarchical test must override
    // it explicitly. A non-null default would mask "did the right branch run?"
    loadSubclubVeoClubSlug: vi.fn(async () => null),
    resolveVeoTeamSlug: vi.fn(async () => 'lyl-u12-tigers-veo'),
    isEmailConfirmed: vi.fn(async () => true),
    fetchStripeCustomerEmail: vi.fn(async () => baseSub.customer_email),
    inviteToVeo: vi.fn(async () => ({
      success: true,
      message: 'Invitation sent to parent@example.com',
    })),
    recordOutcome: vi.fn(async () => undefined),
    ...overrides,
  }
}

function expectSuccess(
  outcome: ProvisionOutcome
): Extract<ProvisionOutcome, { kind: 'success' }> {
  expect(outcome.kind).toBe('success')
  return outcome as Extract<ProvisionOutcome, { kind: 'success' }>
}

function expectFailure(
  outcome: ProvisionOutcome
): Extract<ProvisionOutcome, { kind: 'failure' }> {
  expect(outcome.kind).toBe('failure')
  return outcome as Extract<ProvisionOutcome, { kind: 'failure' }>
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('provisionAcademyAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('idempotency + identity', () => {
    it('returns alreadyProvisioned without calling Stripe / Veo when row already provisioned', async () => {
      const deps = makeDeps({
        loadSub: vi.fn(async () => ({
          ...baseSub,
          provisioned_at: '2026-05-10T12:00:00Z',
        })),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)

      const ok = expectSuccess(outcome)
      expect(ok.alreadyProvisioned).toBe(true)
      expect(ok.subId).toBe('sub-uuid-1')
      expect(deps.isEmailConfirmed).not.toHaveBeenCalled()
      expect(deps.fetchStripeCustomerEmail).not.toHaveBeenCalled()
      expect(deps.inviteToVeo).not.toHaveBeenCalled()
      expect(deps.recordOutcome).not.toHaveBeenCalled()
    })

    it('returns failure when subscription not found (no recordOutcome write)', async () => {
      const deps = makeDeps({ loadSub: vi.fn(async () => null) })
      const outcome = await provisionAcademyAccess('missing-id', deps)

      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('not_found')
      expect(fail.retryable).toBe(false)
      expect(deps.recordOutcome).not.toHaveBeenCalled()
    })

    it('returns authorization failure when expectedUserId mismatches (no row leakage)', async () => {
      const deps = makeDeps()
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps, {
        expectedUserId: 'attacker-uuid',
      })
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('authorization')
      expect(fail.retryable).toBe(false)
      expect(isSecurityFailure(fail)).toBe(true)
      // Critically: do NOT write to the row — would surface its existence.
      expect(deps.recordOutcome).not.toHaveBeenCalled()
      expect(deps.isEmailConfirmed).not.toHaveBeenCalled()
    })

    it('passes expectedUserId guard when ids match', async () => {
      const deps = makeDeps()
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps, {
        expectedUserId: 'user-uuid-1',
      })
      expectSuccess(outcome)
    })
  })

  describe('status filter', () => {
    it('returns retryable not_entitled WITHOUT writing provisioning_error (avoids dunning noise)', async () => {
      const deps = makeDeps({
        loadSub: vi.fn(async () => ({ ...baseSub, status: 'past_due' })),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('not_entitled')
      expect(fail.retryable).toBe(true)
      // Critical: don't write provisioning_error every dunning retry.
      expect(deps.recordOutcome).not.toHaveBeenCalled()
      expect(deps.isEmailConfirmed).not.toHaveBeenCalled()
    })

    it('accepts trialing status alongside active', async () => {
      const deps = makeDeps({
        loadSub: vi.fn(async () => ({ ...baseSub, status: 'trialing' })),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      expectSuccess(outcome)
      expect(deps.inviteToVeo).toHaveBeenCalledTimes(1)
    })

    it('rejects canceled / unpaid / incomplete / paused with not_entitled', async () => {
      for (const status of ['canceled', 'unpaid', 'incomplete', 'paused']) {
        const deps = makeDeps({
          loadSub: vi.fn(async () => ({ ...baseSub, status })),
        })
        const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
        const fail = expectFailure(outcome)
        expect(fail.reason).toBe('not_entitled')
      }
    })
  })

  describe('email confirmation gate (PRIMARY salted-account defence)', () => {
    it('blocks provisioning when auth user has not confirmed email', async () => {
      const deps = makeDeps({ isEmailConfirmed: vi.fn(async () => false) })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)

      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('email_not_confirmed')
      expect(fail.retryable).toBe(true) // they may confirm later
      expect(isSecurityFailure(fail)).toBe(true)
      expect(deps.fetchStripeCustomerEmail).not.toHaveBeenCalled()
      expect(deps.inviteToVeo).not.toHaveBeenCalled()
      expect(deps.recordOutcome).toHaveBeenCalledWith(
        'sub-uuid-1',
        expect.objectContaining({ reason: 'email_not_confirmed' })
      )
    })

    it('proceeds when isEmailConfirmed returns true (control case)', async () => {
      const deps = makeDeps({ isEmailConfirmed: vi.fn(async () => true) })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      expectSuccess(outcome)
    })
  })

  describe('Stripe email cross-check (defence in depth)', () => {
    it('blocks provisioning when Stripe customer email differs from row email', async () => {
      const deps = makeDeps({
        fetchStripeCustomerEmail: vi.fn(async () => 'attacker@elsewhere.com'),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)

      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('stripe_email_mismatch')
      expect(fail.retryable).toBe(false)
      expect(isSecurityFailure(fail)).toBe(true)
      expect(deps.inviteToVeo).not.toHaveBeenCalled()
      expect(deps.recordOutcome).toHaveBeenCalledWith(
        'sub-uuid-1',
        expect.objectContaining({ reason: 'stripe_email_mismatch' })
      )
    })

    it('blocks when Stripe customer email is null (deleted customer)', async () => {
      const deps = makeDeps({
        fetchStripeCustomerEmail: vi.fn(async () => null),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('stripe_email_mismatch')
      expect(deps.inviteToVeo).not.toHaveBeenCalled()
    })

    it('whitespace-padded row email is trimmed before compare AND before passing to Veo', async () => {
      // Defensive: row CHECK enforces lowercase but doesn't trim. If a future
      // migration drops the CHECK, the trim still saves us.
      const deps = makeDeps({
        loadSub: vi.fn(async () => ({
          ...baseSub,
          customer_email: '  parent@example.com  ',
        })),
        fetchStripeCustomerEmail: vi.fn(async () => 'parent@example.com'),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      expectSuccess(outcome)
      // Critical: Veo must receive the trimmed email, otherwise a regression
      // dropping the .trim() in the comparison path but not the Veo-arg path
      // would silently poison invitations with whitespace.
      expect(deps.inviteToVeo).toHaveBeenCalledWith(
        'lyl-veo-slug',
        'lyl-u12-tigers-veo',
        'parent@example.com',
        'sub-uuid-1'
      )
    })

    it('uppercase difference still mismatches (no silent re-lowercase on row side)', async () => {
      // Verifies we are NOT silently re-lowercasing the comparison — Stripe
      // returns 'PARENT@example.com' which must be normalized by the deps
      // implementation, not by provisionAcademyAccess. With the default
      // mock returning the literal value, this should mismatch.
      const deps = makeDeps({
        fetchStripeCustomerEmail: vi.fn(async () => 'PARENT@example.com'),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('stripe_email_mismatch')
    })
  })

  describe('Stripe API errors', () => {
    it('classifies StripeFetchError(customer_missing) as non-retryable', async () => {
      const deps = makeDeps({
        fetchStripeCustomerEmail: vi.fn(async () => {
          throw new StripeFetchError('customer_missing', 'no such customer')
        }),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('stripe_customer_missing')
      expect(fail.retryable).toBe(false)
      expect(deps.recordOutcome).toHaveBeenCalledTimes(1)
    })

    it('classifies StripeFetchError(unreachable) as retryable', async () => {
      const deps = makeDeps({
        fetchStripeCustomerEmail: vi.fn(async () => {
          throw new StripeFetchError('unreachable', 'ECONNRESET')
        }),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('stripe_unreachable')
      expect(fail.retryable).toBe(true)
    })

    it('catches unknown thrown errors and returns retryable stripe_unreachable', async () => {
      const deps = makeDeps({
        fetchStripeCustomerEmail: vi.fn(async () => {
          throw new Error('something weird')
        }),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('stripe_unreachable')
      expect(fail.retryable).toBe(true)
      expect(deps.recordOutcome).toHaveBeenCalledTimes(1)
    })

    it('classifies StripeFetchError(forbidden) as non-retryable stripe_forbidden', async () => {
      const deps = makeDeps({
        fetchStripeCustomerEmail: vi.fn(async () => {
          throw new StripeFetchError(
            'forbidden',
            'Stripe key cannot read customer'
          )
        }),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('stripe_forbidden')
      expect(fail.retryable).toBe(false)
    })

    it('returns retryable auth_unreachable when isEmailConfirmed throws', async () => {
      const deps = makeDeps({
        isEmailConfirmed: vi.fn(async () => {
          throw new Error('Supabase auth admin 503')
        }),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('auth_unreachable')
      expect(fail.retryable).toBe(true)
      expect(deps.fetchStripeCustomerEmail).not.toHaveBeenCalled()
      expect(deps.inviteToVeo).not.toHaveBeenCalled()
    })
  })

  describe('config errors', () => {
    it('fails when registration_team is null (config_missing_team)', async () => {
      const deps = makeDeps({
        loadSub: vi.fn(async () => ({ ...baseSub, registration_team: null })),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('config_missing_team')
      expect(fail.retryable).toBe(false)
      // Pre-Stripe, pre-email-check.
      expect(deps.isEmailConfirmed).not.toHaveBeenCalled()
      expect(deps.fetchStripeCustomerEmail).not.toHaveBeenCalled()
    })

    it('fails when club is unknown (config_unknown_club)', async () => {
      const deps = makeDeps({ loadClub: vi.fn(async () => undefined) })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('config_unknown_club')
      expect(fail.retryable).toBe(false)
    })

    it('fails when club has no veoClubSlug (config_no_veo_club)', async () => {
      const deps = makeDeps({
        loadClub: vi.fn(async () => ({ ...baseClub, veoClubSlug: undefined })),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('config_no_veo_club')
      expect(fail.retryable).toBe(false)
    })

    it('fails when no veo_team_slug mapping exists (config_no_veo_team)', async () => {
      const deps = makeDeps({ resolveVeoTeamSlug: vi.fn(async () => null) })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('config_no_veo_team')
      expect(fail.retryable).toBe(false)
      expect(deps.inviteToVeo).not.toHaveBeenCalled()
    })
  })

  describe('hierarchical (subclub) Veo resolution', () => {
    // When registration_subclub is set on the row (LYL-shaped league), the
    // Veo club identity comes from playhub_academy_subclubs, NOT from the
    // playhub_academy_config row. The team lookup is also scoped to
    // (club, subclub) so two subclubs in the same league can re-use 'u11'
    // without collision (see partial UNIQUE indexes in 20260515 migration).

    const hierarchicalSub: AcademySubscriptionRow = {
      ...baseSub,
      registration_subclub: 'barnes-eagles',
      registration_team: 'u12-tigers',
    }

    it('uses subclub.veo_club_slug as override when set (subclub overrides config)', async () => {
      const deps = makeDeps({
        loadSub: vi.fn(async () => hierarchicalSub),
        loadSubclubVeoClubSlug: vi.fn(async () => 'barnes-eagles-veo'),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      expectSuccess(outcome)

      // CRITICAL: when the subclub row carries its own veo_club_slug, it
      // takes precedence over the config-level value. This is the future-
      // league shape where each member club is on Veo independently.
      expect(deps.inviteToVeo).toHaveBeenCalledWith(
        'barnes-eagles-veo',
        'lyl-u12-tigers-veo',
        'parent@example.com',
        'sub-uuid-1'
      )
      expect(deps.loadSubclubVeoClubSlug).toHaveBeenCalledWith(
        'lyl',
        'barnes-eagles'
      )
      // Resolution scoped to (club, subclub, team) — see SQL partial UNIQUE.
      expect(deps.resolveVeoTeamSlug).toHaveBeenCalledWith(
        'lyl',
        'u12-tigers',
        'barnes-eagles'
      )
    })

    it('falls back to config.veoClubSlug when subclub.veo_club_slug is NULL (LYL shape)', async () => {
      // LYL on Veo is one league-level club ('london-youth-league') shared
      // across all 16 subclubs. Subclubs leave veo_club_slug NULL and
      // inherit from the config row. This is the canonical pilot shape.
      const deps = makeDeps({
        loadSub: vi.fn(async () => hierarchicalSub),
        loadSubclubVeoClubSlug: vi.fn(async () => null),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      expectSuccess(outcome)
      // Falls back to baseClub.veoClubSlug ('lyl-veo-slug').
      expect(deps.inviteToVeo).toHaveBeenCalledWith(
        'lyl-veo-slug',
        'lyl-u12-tigers-veo',
        'parent@example.com',
        'sub-uuid-1'
      )
    })

    it('fails config_no_veo_club when BOTH subclub.veo_club_slug AND config.veoClubSlug are NULL', async () => {
      const deps = makeDeps({
        loadSub: vi.fn(async () => hierarchicalSub),
        loadClub: vi.fn(async () => ({ ...baseClub, veoClubSlug: undefined })),
        loadSubclubVeoClubSlug: vi.fn(async () => null),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('config_no_veo_club')
      expect(fail.retryable).toBe(false)
      // No path to Veo — must NOT call invite.
      expect(deps.inviteToVeo).not.toHaveBeenCalled()
      // Error message identifies the (club, subclub) path so operators
      // can resolve at the right level.
      expect(fail.error).toContain('lyl/barnes-eagles')
    })

    it('treats loadSubclubVeoClubSlug throwing as transient (retryable)', async () => {
      const deps = makeDeps({
        loadSub: vi.fn(async () => hierarchicalSub),
        loadSubclubVeoClubSlug: vi.fn(async () => {
          throw new Error('Supabase timeout')
        }),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('config_no_veo_club')
      expect(fail.retryable).toBe(true)
      expect(deps.recordOutcome).toHaveBeenCalled()
      expect(deps.inviteToVeo).not.toHaveBeenCalled()
    })

    it('flat path (registration_subclub=null) NEVER calls loadSubclubVeoClubSlug', async () => {
      const deps = makeDeps()
      await provisionAcademyAccess('sub-uuid-1', deps)
      expect(deps.loadSubclubVeoClubSlug).not.toHaveBeenCalled()
      // And uses the config-level veoClubSlug as before.
      expect(deps.inviteToVeo).toHaveBeenCalledWith(
        'lyl-veo-slug',
        'lyl-u12-tigers-veo',
        'parent@example.com',
        'sub-uuid-1'
      )
      // resolveVeoTeamSlug receives null subclub for the flat-path lookup.
      expect(deps.resolveVeoTeamSlug).toHaveBeenCalledWith(
        'lyl',
        'lyl-u12-tigers',
        null
      )
    })

    it('hierarchical path: config_no_veo_team failure includes subclub in the team path', async () => {
      const deps = makeDeps({
        loadSub: vi.fn(async () => hierarchicalSub),
        loadSubclubVeoClubSlug: vi.fn(async () => 'barnes-eagles-veo'),
        resolveVeoTeamSlug: vi.fn(async () => null),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('config_no_veo_team')
      // Error message disambiguates which subclub the team is missing under
      // (operators triaging will need this for hierarchical leagues).
      expect(fail.error).toContain('lyl/barnes-eagles/u12-tigers')
    })
  })

  describe('Veo invite path', () => {
    it('happy path: invites the parent into the resolved Veo team and persists success', async () => {
      const deps = makeDeps()
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)

      const ok = expectSuccess(outcome)
      expect(ok.alreadyProvisioned).toBe(false)
      expect(ok.subId).toBe('sub-uuid-1')
      expect(ok.veoMessage).toBe('Invitation sent to parent@example.com')
      expect(deps.inviteToVeo).toHaveBeenCalledWith(
        'lyl-veo-slug',
        'lyl-u12-tigers-veo',
        'parent@example.com',
        'sub-uuid-1'
      )
      expect(deps.recordOutcome).toHaveBeenCalledWith(
        'sub-uuid-1',
        expect.objectContaining({ kind: 'success', alreadyProvisioned: false })
      )
    })

    it('treats Veo "already invited" as success (Veo-level idempotency)', async () => {
      const deps = makeDeps({
        inviteToVeo: vi.fn(async () => ({
          success: true,
          message: 'parent@example.com already has a pending invitation',
        })),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      const ok = expectSuccess(outcome)
      expect(ok.veoMessage).toMatch(/already has/)
    })

    it('returns retryable failure (veo_threw) when Veo throws', async () => {
      const deps = makeDeps({
        inviteToVeo: vi.fn(async () => {
          throw new Error('ECONNRESET')
        }),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('veo_threw')
      expect(fail.retryable).toBe(true)
      expect(fail.error).toMatch(/ECONNRESET/)
    })

    it('returns retryable failure (veo_invite_failed) when Veo returns success=false', async () => {
      const deps = makeDeps({
        inviteToVeo: vi.fn(async () => ({
          success: false,
          message: 'Failed to invite parent@example.com: 503',
        })),
      })
      const outcome = await provisionAcademyAccess('sub-uuid-1', deps)
      const fail = expectFailure(outcome)
      expect(fail.reason).toBe('veo_invite_failed')
      expect(fail.retryable).toBe(true)
    })
  })

  describe('side-effect ordering', () => {
    it('only persists outcome AFTER the Veo invite resolves', async () => {
      const events: string[] = []
      const deps = makeDeps({
        inviteToVeo: vi.fn(async () => {
          events.push('veo-invite')
          return { success: true, message: 'ok' }
        }),
        recordOutcome: vi.fn(async () => {
          events.push('record-outcome')
        }),
      })
      await provisionAcademyAccess('sub-uuid-1', deps)
      expect(events).toEqual(['veo-invite', 'record-outcome'])
    })
  })

  describe('isSecurityFailure helper', () => {
    it('returns true for security-relevant reasons', () => {
      const reasons = [
        'authorization',
        'email_not_confirmed',
        'stripe_email_mismatch',
      ] as const
      for (const reason of reasons) {
        expect(
          isSecurityFailure({
            kind: 'failure',
            subId: 'x',
            error: 'x',
            retryable: false,
            reason,
          })
        ).toBe(true)
      }
    })

    it('returns false for operational/config reasons', () => {
      const reasons = [
        'not_found',
        'not_entitled',
        'auth_unreachable',
        'config_missing_team',
        'config_unknown_club',
        'config_no_veo_club',
        'config_no_veo_team',
        'stripe_unreachable',
        'stripe_customer_missing',
        'stripe_forbidden',
        'veo_threw',
        'veo_invite_failed',
      ] as const
      for (const reason of reasons) {
        expect(
          isSecurityFailure({
            kind: 'failure',
            subId: 'x',
            error: 'x',
            retryable: false,
            reason,
          })
        ).toBe(false)
      }
    })

    it('returns false for success outcomes', () => {
      expect(
        isSecurityFailure({
          kind: 'success',
          subId: 'x',
          alreadyProvisioned: false,
        })
      ).toBe(false)
    })
  })
})
