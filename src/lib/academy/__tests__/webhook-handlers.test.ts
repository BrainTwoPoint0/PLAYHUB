// Unit tests for the academy webhook handler module.
//
// All external systems (Supabase, provisioning, email) are injected via the
// WebhookDeps interface — same DI pattern as provision.test.ts. Tests are
// pure: no module mocking, no network. The end-to-end Stripe CLI replay
// against the live webhook is the integration validation, run manually
// against staging at the end of B2.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Stripe from 'stripe'
import {
  handleAcademyCheckoutCompleted,
  handleAcademySubscriptionUpdated,
  handleAcademySubscriptionDeleted,
  type WebhookDeps,
  type ActiveSubInsert,
  type PendingSubInsert,
  type InsertResult,
} from '../webhook-handlers'
import { type ProvisionOutcome } from '../provision'
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

function makeDeps(overrides: Partial<WebhookDeps> = {}): WebhookDeps {
  return {
    loadProfileByEmail: vi.fn(async () => null),
    loadClub: vi.fn(async () => baseClub),
    isAcademyProduct: vi.fn(async () => true),
    insertActiveSub: vi.fn(
      async (): Promise<InsertResult> => ({ kind: 'inserted', id: 'active-1' })
    ),
    insertPendingSub: vi.fn(
      async (): Promise<InsertResult> => ({ kind: 'inserted', id: 'pending-1' })
    ),
    updateActiveStatus: vi.fn(async () => null),
    updatePendingStatus: vi.fn(async () => null),
    provision: vi.fn(
      async (subId): Promise<ProvisionOutcome> => ({
        kind: 'success',
        subId,
        alreadyProvisioned: false,
      })
    ),
    sendClaimEmail: vi.fn(async () => undefined),
    ...overrides,
  }
}

function makeCheckoutSession(
  overrides: Partial<Stripe.Checkout.Session> = {},
  metadataOverrides: Record<string, string> = {}
): Stripe.Checkout.Session {
  return {
    id: 'cs_test_1',
    metadata: {
      type: 'academy_subscription',
      club_slug: 'lyl',
      team_slug: 'lyl-u12-tigers',
      ...metadataOverrides,
    },
    subscription: 'sub_stripe_1',
    customer: 'cus_stripe_1',
    customer_details: {
      email: 'parent@example.com',
      name: 'Test Parent',
    } as any,
    ...overrides,
  } as Stripe.Checkout.Session
}

function makeSubscription(
  overrides: Partial<Stripe.Subscription> = {}
): Stripe.Subscription {
  return {
    id: 'sub_stripe_1',
    status: 'active',
    current_period_end: 1735689600, // 2025-01-01
    items: {
      data: [
        {
          price: { product: 'prod_lyl_1' } as any,
        },
      ],
    } as any,
    ...overrides,
  } as Stripe.Subscription
}

// ----------------------------------------------------------------------------
// handleAcademyCheckoutCompleted
// ----------------------------------------------------------------------------

describe('handleAcademyCheckoutCompleted', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('input validation', () => {
    it('errors when club_slug missing', async () => {
      const deps = makeDeps()
      const session = makeCheckoutSession({}, { club_slug: '' })
      const result = await handleAcademyCheckoutCompleted(session, deps)
      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.error).toMatch(/club_slug/)
    })

    it('errors when team_slug missing', async () => {
      const deps = makeDeps()
      const session = makeCheckoutSession({}, { team_slug: '' })
      const result = await handleAcademyCheckoutCompleted(session, deps)
      expect(result.status).toBe('error')
    })

    it('errors when subscription missing', async () => {
      const deps = makeDeps()
      const session = makeCheckoutSession({ subscription: null })
      const result = await handleAcademyCheckoutCompleted(session, deps)
      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.error).toMatch(/subscription id/)
    })

    it('rejects invalid subclub_slug shape (same defence as team_slug — attacker-controlled metadata)', async () => {
      const deps = makeDeps()
      const bad = ['barnes eagles', '<img src=x>', 'A'.repeat(65), 'b\nINFO']
      for (const subclubSlug of bad) {
        const session = makeCheckoutSession({}, { subclub_slug: subclubSlug })
        const result = await handleAcademyCheckoutCompleted(session, deps)
        expect(result.status).toBe('error')
        if (result.status === 'error') {
          expect(result.error).toMatch(/invalid subclub_slug/)
        }
      }
      // Sanity: the writes never fired.
      expect(deps.insertActiveSub).not.toHaveBeenCalled()
      expect(deps.insertPendingSub).not.toHaveBeenCalled()
    })

    it('rejects invalid team_slug shape (defends DB / logs / future UI from attacker metadata)', async () => {
      const deps = makeDeps()
      // Spaces, HTML, log-injection sequences, length > 64, wrong charset.
      const bad = ['team with spaces', '<script>', 'A'.repeat(65), 'team\n[INFO] forged']
      for (const teamSlug of bad) {
        const session = makeCheckoutSession({}, { team_slug: teamSlug })
        const result = await handleAcademyCheckoutCompleted(session, deps)
        expect(result.status).toBe('error')
        if (result.status === 'error') {
          expect(result.error).toMatch(/invalid team_slug/)
        }
      }
      // No DB writes when the slug is rejected.
      expect(deps.insertActiveSub).not.toHaveBeenCalled()
      expect(deps.insertPendingSub).not.toHaveBeenCalled()
    })

    it('accepts well-formed slugs (lowercase, digits, hyphens, ≤64 chars)', async () => {
      const deps = makeDeps()
      const good = ['lyl', 'lyl-u12-tigers', 'a1', '1team', 'a' + '-'.repeat(63)]
      for (const teamSlug of good) {
        const session = makeCheckoutSession({}, { team_slug: teamSlug })
        const result = await handleAcademyCheckoutCompleted(session, deps)
        // No-profile path produces 'pending' for the default deps.
        expect(['pending', 'created']).toContain(result.status)
      }
    })

    it('errors when customer missing', async () => {
      const deps = makeDeps()
      const session = makeCheckoutSession({ customer: null })
      const result = await handleAcademyCheckoutCompleted(session, deps)
      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.error).toMatch(/customer id/)
    })

    it('errors when customer email missing', async () => {
      const deps = makeDeps()
      const session = makeCheckoutSession({
        customer_details: { name: 'No Email' } as any,
      })
      const result = await handleAcademyCheckoutCompleted(session, deps)
      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.error).toMatch(/customer email/)
    })

    it('errors when club_slug not in academy config', async () => {
      const deps = makeDeps({ loadClub: vi.fn(async () => undefined) })
      const result = await handleAcademyCheckoutCompleted(makeCheckoutSession(), deps)
      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.error).toMatch(/unknown club/)
    })
  })

  describe('existing-profile path', () => {
    it('inserts active sub + fires provisioning + returns created', async () => {
      const deps = makeDeps({
        loadProfileByEmail: vi.fn(async () => ({ user_id: 'user-uuid-1' })),
      })
      const session = makeCheckoutSession()
      const result = await handleAcademyCheckoutCompleted(session, deps)

      expect(result.status).toBe('created')
      if (result.status === 'created') {
        expect(result.subId).toBe('active-1')
        expect(result.provisionOutcome.kind).toBe('success')
      }

      expect(deps.insertActiveSub).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-uuid-1',
          club_slug: 'lyl',
          stripe_subscription_id: 'sub_stripe_1',
          stripe_customer_id: 'cus_stripe_1',
          registration_team: 'lyl-u12-tigers',
          // Default fixture omits subclub metadata → flat-config persistence.
          // Hierarchical persistence has dedicated coverage below.
          registration_subclub: null,
          customer_email: 'parent@example.com',
          customer_name: 'Test Parent',
          status: 'active',
        } satisfies ActiveSubInsert)
      )
      expect(deps.provision).toHaveBeenCalledWith('active-1')
      expect(deps.insertPendingSub).not.toHaveBeenCalled()
      expect(deps.sendClaimEmail).not.toHaveBeenCalled()
    })

    it('returns duplicate when insert hits unique violation', async () => {
      const deps = makeDeps({
        loadProfileByEmail: vi.fn(async () => ({ user_id: 'user-uuid-1' })),
        insertActiveSub: vi.fn(
          async (): Promise<InsertResult> => ({ kind: 'duplicate' })
        ),
      })
      const result = await handleAcademyCheckoutCompleted(makeCheckoutSession(), deps)
      expect(result.status).toBe('duplicate')
      if (result.status === 'duplicate') expect(result.reason).toBe('active_exists')
      // Critically: do NOT call provision on a duplicate.
      expect(deps.provision).not.toHaveBeenCalled()
    })

    it('returns error when insert fails for non-unique reason', async () => {
      const deps = makeDeps({
        loadProfileByEmail: vi.fn(async () => ({ user_id: 'user-uuid-1' })),
        insertActiveSub: vi.fn(
          async (): Promise<InsertResult> => ({
            kind: 'error',
            message: 'FK violation',
          })
        ),
      })
      const result = await handleAcademyCheckoutCompleted(makeCheckoutSession(), deps)
      expect(result.status).toBe('error')
      expect(deps.provision).not.toHaveBeenCalled()
    })

    it('does not fail webhook when provision throws — returns created with synthesized failure', async () => {
      const deps = makeDeps({
        loadProfileByEmail: vi.fn(async () => ({ user_id: 'user-uuid-1' })),
        provision: vi.fn(async () => {
          throw new Error('Veo session boot failed')
        }),
      })
      const result = await handleAcademyCheckoutCompleted(makeCheckoutSession(), deps)
      expect(result.status).toBe('created')
      if (result.status === 'created') {
        expect(result.provisionOutcome.kind).toBe('failure')
        if (result.provisionOutcome.kind === 'failure') {
          expect(result.provisionOutcome.reason).toBe('veo_threw')
          expect(result.provisionOutcome.retryable).toBe(true)
        }
      }
    })

    it('preserves the row when provision returns failure outcome', async () => {
      const deps = makeDeps({
        loadProfileByEmail: vi.fn(async () => ({ user_id: 'user-uuid-1' })),
        provision: vi.fn(
          async (subId): Promise<ProvisionOutcome> => ({
            kind: 'failure',
            subId,
            error: 'email not confirmed yet',
            retryable: true,
            reason: 'email_not_confirmed',
          })
        ),
      })
      const result = await handleAcademyCheckoutCompleted(makeCheckoutSession(), deps)
      expect(result.status).toBe('created')
      if (result.status === 'created' && result.provisionOutcome.kind === 'failure') {
        expect(result.provisionOutcome.reason).toBe('email_not_confirmed')
      }
    })
  })

  describe('no-profile path', () => {
    it('inserts pending sub + sends claim email + returns pending', async () => {
      const deps = makeDeps()
      const session = makeCheckoutSession()
      const result = await handleAcademyCheckoutCompleted(session, deps)

      expect(result.status).toBe('pending')
      if (result.status === 'pending') expect(result.pendingId).toBe('pending-1')

      expect(deps.insertPendingSub).toHaveBeenCalledWith(
        expect.objectContaining({
          club_slug: 'lyl',
          invited_email: 'parent@example.com',
          stripe_subscription_id: 'sub_stripe_1',
          stripe_customer_id: 'cus_stripe_1',
          registration_team: 'lyl-u12-tigers',
          registration_subclub: null,
          customer_name: 'Test Parent',
          last_known_status: 'active',
        } satisfies PendingSubInsert)
      )
      expect(deps.sendClaimEmail).toHaveBeenCalledWith(
        'parent@example.com',
        'London Youth League'
      )
      expect(deps.insertActiveSub).not.toHaveBeenCalled()
      expect(deps.provision).not.toHaveBeenCalled()
    })

    it('returns duplicate when pending insert hits unique violation', async () => {
      const deps = makeDeps({
        insertPendingSub: vi.fn(
          async (): Promise<InsertResult> => ({ kind: 'duplicate' })
        ),
      })
      const result = await handleAcademyCheckoutCompleted(makeCheckoutSession(), deps)
      expect(result.status).toBe('duplicate')
      if (result.status === 'duplicate') expect(result.reason).toBe('pending_exists')
      // No claim email on duplicate (parent already received the first one).
      expect(deps.sendClaimEmail).not.toHaveBeenCalled()
    })

    it('returns error when pending insert fails for non-unique reason', async () => {
      const deps = makeDeps({
        insertPendingSub: vi.fn(
          async (): Promise<InsertResult> => ({
            kind: 'error',
            message: 'FK violation',
          })
        ),
      })
      const result = await handleAcademyCheckoutCompleted(makeCheckoutSession(), deps)
      expect(result.status).toBe('error')
      expect(deps.sendClaimEmail).not.toHaveBeenCalled()
    })
  })

  describe('hierarchical (subclub) persistence', () => {
    // The hierarchical surface is opt-in: presence of metadata.subclub_slug
    // promotes a checkout from "flat (CFA/SEFA)" to "subclub (LYL)". These
    // tests pin the round-trip from Stripe metadata → INSERT row so that a
    // subclub-aware Veo invite can be fired from provision.ts later.

    it('persists subclub_slug to active row when metadata includes a valid subclub', async () => {
      const deps = makeDeps({
        loadProfileByEmail: vi.fn(async () => ({ user_id: 'user-uuid-1' })),
        insertActiveSub: vi.fn(
          async (): Promise<InsertResult> => ({ kind: 'inserted', id: 'active-1' })
        ),
      })
      const session = makeCheckoutSession({}, { subclub_slug: 'barnes-eagles' })
      const result = await handleAcademyCheckoutCompleted(session, deps)
      expect(result.status).toBe('created')
      expect(deps.insertActiveSub).toHaveBeenCalledWith(
        expect.objectContaining({
          club_slug: 'lyl',
          registration_team: 'lyl-u12-tigers',
          registration_subclub: 'barnes-eagles',
        } satisfies Partial<ActiveSubInsert>)
      )
    })

    it('persists subclub_slug to pending row when no profile exists yet', async () => {
      const deps = makeDeps({
        loadProfileByEmail: vi.fn(async () => null),
        insertPendingSub: vi.fn(
          async (): Promise<InsertResult> => ({ kind: 'inserted', id: 'pending-1' })
        ),
      })
      const session = makeCheckoutSession({}, { subclub_slug: 'barnes-eagles' })
      const result = await handleAcademyCheckoutCompleted(session, deps)
      expect(result.status).toBe('pending')
      expect(deps.insertPendingSub).toHaveBeenCalledWith(
        expect.objectContaining({
          club_slug: 'lyl',
          registration_team: 'lyl-u12-tigers',
          registration_subclub: 'barnes-eagles',
        } satisfies Partial<PendingSubInsert>)
      )
    })

    it('treats absent subclub_slug as flat config (registration_subclub=null on both insert paths)', async () => {
      // Existing-profile path
      const activeDeps = makeDeps({
        loadProfileByEmail: vi.fn(async () => ({ user_id: 'user-uuid-1' })),
        insertActiveSub: vi.fn(
          async (): Promise<InsertResult> => ({ kind: 'inserted', id: 'active-1' })
        ),
      })
      await handleAcademyCheckoutCompleted(makeCheckoutSession(), activeDeps)
      expect(activeDeps.insertActiveSub).toHaveBeenCalledWith(
        expect.objectContaining({ registration_subclub: null })
      )
      // No-profile path
      const pendingDeps = makeDeps({ loadProfileByEmail: vi.fn(async () => null) })
      await handleAcademyCheckoutCompleted(makeCheckoutSession(), pendingDeps)
      expect(pendingDeps.insertPendingSub).toHaveBeenCalledWith(
        expect.objectContaining({ registration_subclub: null })
      )
    })

    it('treats empty-string subclub_slug as flat (defends against accidental "" from form serialisation)', async () => {
      const deps = makeDeps({
        loadProfileByEmail: vi.fn(async () => null),
      })
      const session = makeCheckoutSession({}, { subclub_slug: '' })
      const result = await handleAcademyCheckoutCompleted(session, deps)
      expect(result.status).toBe('pending')
      expect(deps.insertPendingSub).toHaveBeenCalledWith(
        expect.objectContaining({ registration_subclub: null })
      )
    })
  })

  describe('email canonicalisation', () => {
    it('trims + lowercases the customer email before profile lookup', async () => {
      const deps = makeDeps()
      const session = makeCheckoutSession({
        customer_details: {
          email: '  PARENT@Example.COM  ',
          name: 'Parent',
        } as any,
      })
      await handleAcademyCheckoutCompleted(session, deps)
      // The lookup must use the normalized email.
      expect(deps.loadProfileByEmail).toHaveBeenCalledWith('parent@example.com')
      // The persisted row must also use the normalized email.
      expect(deps.insertPendingSub).toHaveBeenCalledWith(
        expect.objectContaining({ invited_email: 'parent@example.com' })
      )
    })
  })
})

// ----------------------------------------------------------------------------
// handleAcademySubscriptionUpdated
// ----------------------------------------------------------------------------

describe('handleAcademySubscriptionUpdated', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns not_academy when product is not in academy config', async () => {
    const deps = makeDeps({ isAcademyProduct: vi.fn(async () => false) })
    const sub = makeSubscription({
      items: { data: [{ price: { product: 'prod_other' } as any }] } as any,
    })
    const result = await handleAcademySubscriptionUpdated(sub, deps)
    expect(result.status).toBe('not_academy')
    expect(deps.updateActiveStatus).not.toHaveBeenCalled()
  })

  it('returns not_academy when subscription has no product', async () => {
    const deps = makeDeps()
    const sub = makeSubscription({
      items: { data: [{ price: {} as any }] } as any,
    })
    const result = await handleAcademySubscriptionUpdated(sub, deps)
    expect(result.status).toBe('not_academy')
  })

  it('detects academy product when price.product is an EXPANDED Stripe.Product object', async () => {
    // Account-level expansion settings (or future Stripe API changes) can
    // make price.product land as a full object instead of a string ID.
    const deps = makeDeps({
      isAcademyProduct: vi.fn(async (id) => id === 'prod_lyl_1'),
      updateActiveStatus: vi.fn(async () => ({
        id: 'active-1',
        provisioned_at: '2026-05-10T12:00:00Z',
      })),
    })
    const sub = makeSubscription({
      items: {
        data: [
          {
            price: { product: { id: 'prod_lyl_1', name: 'LYL' } as any },
          },
        ],
      } as any,
    })
    const result = await handleAcademySubscriptionUpdated(sub, deps)
    expect(result.status).toBe('updated')
    expect(deps.isAcademyProduct).toHaveBeenCalledWith('prod_lyl_1')
  })

  it('returns not_academy without crashing when subscription has empty items array', async () => {
    const deps = makeDeps()
    const sub = makeSubscription({ items: { data: [] } as any })
    const result = await handleAcademySubscriptionUpdated(sub, deps)
    expect(result.status).toBe('not_academy')
    expect(deps.isAcademyProduct).not.toHaveBeenCalled()
    expect(deps.updateActiveStatus).not.toHaveBeenCalled()
  })

  it('detects academy when ANY item on a multi-item subscription is academy', async () => {
    // Multi-item subs (e.g. main academy + add-on add-on credit) — academy
    // product can be on any index. Iterating prevents silent misses.
    const deps = makeDeps({
      isAcademyProduct: vi.fn(async (id) => id === 'prod_lyl_1'),
      updateActiveStatus: vi.fn(async () => ({
        id: 'active-1',
        provisioned_at: '2026-05-10T12:00:00Z',
      })),
    })
    const sub = makeSubscription({
      items: {
        data: [
          { price: { product: 'prod_addon' } as any },
          { price: { product: 'prod_lyl_1' } as any },
        ],
      } as any,
    })
    const result = await handleAcademySubscriptionUpdated(sub, deps)
    expect(result.status).toBe('updated')
    expect(deps.isAcademyProduct).toHaveBeenCalledWith('prod_lyl_1')
  })

  it('returns updated when active row exists, already provisioned, status changes', async () => {
    const deps = makeDeps({
      updateActiveStatus: vi.fn(async () => ({
        id: 'active-1',
        provisioned_at: '2026-05-10T12:00:00Z',
      })),
    })
    const result = await handleAcademySubscriptionUpdated(makeSubscription(), deps)
    expect(result.status).toBe('updated')
    if (result.status === 'updated') expect(result.rowKind).toBe('active')
    // No re-provision: row was already provisioned.
    expect(deps.provision).not.toHaveBeenCalled()
  })

  it('fires provisioning when active row exists, NOT yet provisioned, status flips to active', async () => {
    const deps = makeDeps({
      updateActiveStatus: vi.fn(async () => ({
        id: 'active-1',
        provisioned_at: null,
      })),
    })
    const result = await handleAcademySubscriptionUpdated(makeSubscription({ status: 'active' }), deps)
    expect(result.status).toBe('updated_and_provisioned')
    if (result.status === 'updated_and_provisioned') {
      expect(result.subId).toBe('active-1')
      expect(result.provisionOutcome.kind).toBe('success')
    }
    expect(deps.provision).toHaveBeenCalledWith('active-1')
  })

  it('fires provisioning on trial start (status=trialing)', async () => {
    const deps = makeDeps({
      updateActiveStatus: vi.fn(async () => ({
        id: 'active-1',
        provisioned_at: null,
      })),
    })
    const result = await handleAcademySubscriptionUpdated(makeSubscription({ status: 'trialing' }), deps)
    expect(result.status).toBe('updated_and_provisioned')
    expect(deps.provision).toHaveBeenCalledTimes(1)
  })

  it('does NOT fire provisioning when status flips to past_due (not entitled)', async () => {
    const deps = makeDeps({
      updateActiveStatus: vi.fn(async () => ({
        id: 'active-1',
        provisioned_at: null,
      })),
    })
    const result = await handleAcademySubscriptionUpdated(makeSubscription({ status: 'past_due' }), deps)
    expect(result.status).toBe('updated')
    expect(deps.provision).not.toHaveBeenCalled()
  })

  it('falls back to pending row when no active row exists', async () => {
    const deps = makeDeps({
      updateActiveStatus: vi.fn(async () => null),
      updatePendingStatus: vi.fn(async () => ({ id: 'pending-1' })),
    })
    const result = await handleAcademySubscriptionUpdated(makeSubscription(), deps)
    expect(result.status).toBe('updated')
    if (result.status === 'updated') expect(result.rowKind).toBe('pending')
    expect(deps.updatePendingStatus).toHaveBeenCalledWith('sub_stripe_1', 'active')
  })

  it('returns not_found when neither active nor pending row exists', async () => {
    const deps = makeDeps({
      updateActiveStatus: vi.fn(async () => null),
      updatePendingStatus: vi.fn(async () => null),
    })
    const result = await handleAcademySubscriptionUpdated(makeSubscription(), deps)
    expect(result.status).toBe('not_found')
  })

  it('does not fail webhook when provision throws on update', async () => {
    const deps = makeDeps({
      updateActiveStatus: vi.fn(async () => ({
        id: 'active-1',
        provisioned_at: null,
      })),
      provision: vi.fn(async () => {
        throw new Error('Veo down')
      }),
    })
    const result = await handleAcademySubscriptionUpdated(makeSubscription(), deps)
    expect(result.status).toBe('updated_and_provisioned')
    if (
      result.status === 'updated_and_provisioned' &&
      result.provisionOutcome.kind === 'failure'
    ) {
      expect(result.provisionOutcome.reason).toBe('veo_threw')
    }
  })
})

// ----------------------------------------------------------------------------
// handleAcademySubscriptionDeleted
// ----------------------------------------------------------------------------

describe('handleAcademySubscriptionDeleted', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns not_academy when product is not academy', async () => {
    const deps = makeDeps({ isAcademyProduct: vi.fn(async () => false) })
    const result = await handleAcademySubscriptionDeleted(makeSubscription(), deps)
    expect(result.status).toBe('not_academy')
  })

  it('cancels active row when one exists', async () => {
    const deps = makeDeps({
      updateActiveStatus: vi.fn(async () => ({ id: 'active-1', provisioned_at: null })),
    })
    const result = await handleAcademySubscriptionDeleted(makeSubscription(), deps)
    expect(result.status).toBe('canceled')
    if (result.status === 'canceled') expect(result.rowKind).toBe('active')
    expect(deps.updateActiveStatus).toHaveBeenCalledWith('sub_stripe_1', 'canceled', null)
  })

  it('falls back to pending row when no active row exists', async () => {
    const deps = makeDeps({
      updateActiveStatus: vi.fn(async () => null),
      updatePendingStatus: vi.fn(async () => ({ id: 'pending-1' })),
    })
    const result = await handleAcademySubscriptionDeleted(makeSubscription(), deps)
    expect(result.status).toBe('canceled')
    if (result.status === 'canceled') expect(result.rowKind).toBe('pending')
  })

  it('returns not_found when no row exists', async () => {
    const deps = makeDeps({
      updateActiveStatus: vi.fn(async () => null),
      updatePendingStatus: vi.fn(async () => null),
    })
    const result = await handleAcademySubscriptionDeleted(makeSubscription(), deps)
    expect(result.status).toBe('not_found')
  })

  it('does not fire provisioning on delete (entitlement is being revoked, not granted)', async () => {
    const deps = makeDeps({
      updateActiveStatus: vi.fn(async () => ({ id: 'active-1', provisioned_at: null })),
    })
    await handleAcademySubscriptionDeleted(makeSubscription(), deps)
    expect(deps.provision).not.toHaveBeenCalled()
  })
})
