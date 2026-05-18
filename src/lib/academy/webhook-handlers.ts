// Academy subscription webhook handlers — Checkpoint B2
//
// Three Stripe event types land here from src/app/api/webhooks/stripe/route.ts:
//   - checkout.session.completed (with metadata.type === 'academy_subscription')
//   - customer.subscription.updated (any sub against an academy product)
//   - customer.subscription.deleted (any sub against an academy product)
//
// Each handler is idempotent against Stripe webhook redelivery via the UNIQUE
// constraints on stripe_subscription_id (in both the pending and active tables).
// A duplicate INSERT returns the 'duplicate' branch; the handler responds 200
// to Stripe so it stops retrying.
//
// Veo provisioning is fired from the existing-profile path of
// handleAcademyCheckoutCompleted and from the active-row promotion path of
// handleAcademySubscriptionUpdated. Both call provisionAcademyAccess() (B1)
// which has its own three layers of idempotency. Provisioning failures do
// NOT fail the webhook — a structured log is emitted; Checkpoint D2's
// /api/me/provision-pending endpoint is the user-facing retry surface.
//
// Dependency injection mirrors provision.ts: defaults wire to real Supabase,
// real provisionAcademyAccess, real sendAcademyClaimEmail. Tests inject mocks.

import type Stripe from 'stripe'
import { createServiceClient } from '@/lib/supabase/server'
import { sendAcademyClaimEmail } from '@/lib/email'
import {
  getClubBySlug,
  getAllClubs,
  getAllProductIds,
  type AcademyClub,
} from './config'
import {
  provisionAcademyAccess,
  isSecurityFailure,
  type ProvisionOutcome,
} from './provision'

// Stripe Subscription.items[].price.product can be either a string ID or an
// expanded Stripe.Product depending on account expansion settings. Defending
// against both shapes prevents silent "not_academy" misclassification when an
// account-level default expansion lands on customer.subscription.* events.
function extractProductIds(subscription: Stripe.Subscription): string[] {
  const ids: string[] = []
  for (const item of subscription.items.data ?? []) {
    const raw = item?.price?.product
    if (typeof raw === 'string') ids.push(raw)
    else if (raw && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string')
      ids.push(raw.id)
  }
  return ids
}

// team_slug + subclub_slug arrive via attacker-influenceable Stripe metadata
// (any successful Checkout against our account can set them). Validate as
// slugs to bound the risk surface before they land in the DB / logs / future
// UI surfaces. Same shape constraint as our own ACADEMY_SLUG_RE in checkout.ts.
const TEAM_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
function isValidTeamSlug(slug: string): boolean {
  return TEAM_SLUG_RE.test(slug)
}
// Reuse the same regex shape for subclub — both are user-supplied slugs
// from the picker that get round-tripped through Stripe metadata.
const SUBCLUB_SLUG_RE = TEAM_SLUG_RE
function isValidSubclubSlug(slug: string): boolean {
  return SUBCLUB_SLUG_RE.test(slug)
}

// True iff ANY item on the subscription matches an academy product. Iterates
// the items array (rather than `data[0]`) so that if Stripe ever resorts items
// or someone adds a non-academy add-on alongside the academy line, we still
// route the event correctly.
async function isAcademySubscription(
  subscription: Stripe.Subscription,
  deps: Pick<WebhookDeps, 'isAcademyProduct'>
): Promise<boolean> {
  const productIds = extractProductIds(subscription)
  if (productIds.length === 0) return false
  const checks = await Promise.all(
    productIds.map((id) => deps.isAcademyProduct(id))
  )
  return checks.some(Boolean)
}

// Cap error strings before they hit the structured log. Postgres error messages
// can include row data via DETAIL lines and Stripe SDK errors sometimes embed
// partial customer info — truncating bounds the PII leak without removing the
// signal ops needs to triage.
function truncateError(message: string | undefined, max = 120): string {
  if (!message) return ''
  const firstLine = message.split('\n')[0]
  return firstLine.length > max ? firstLine.slice(0, max) + '…' : firstLine
}

// ============================================================================
// Types
// ============================================================================

export type CheckoutResult =
  | { status: 'created'; subId: string; provisionOutcome: ProvisionOutcome }
  | { status: 'pending'; pendingId: string }
  | { status: 'duplicate'; reason: 'active_exists' | 'pending_exists' }
  | { status: 'error'; error: string }

export type UpdateResult =
  | { status: 'updated'; rowKind: 'active' | 'pending' }
  | { status: 'updated_and_provisioned'; subId: string; provisionOutcome: ProvisionOutcome }
  | { status: 'not_academy' }
  | { status: 'not_found' }
  | { status: 'error'; error: string }

export type DeleteResult =
  | { status: 'canceled'; rowKind: 'active' | 'pending' }
  | { status: 'not_academy' }
  | { status: 'not_found' }
  | { status: 'error'; error: string }

export interface WebhookDeps {
  /** Look up a profile by lowercased email; returns user_id if exists. */
  loadProfileByEmail: (email: string) => Promise<{ user_id: string } | null>
  /** Look up the academy club config by slug. */
  loadClub: (clubSlug: string) => Promise<AcademyClub | undefined>
  /** Returns true if a Stripe product ID belongs to any academy club. */
  isAcademyProduct: (productId: string) => Promise<boolean>
  /** INSERT into playhub_academy_subscriptions; returns the new id or maps PG codes. */
  insertActiveSub: (row: ActiveSubInsert) => Promise<InsertResult>
  /** INSERT into playhub_pending_academy_subscriptions; returns the new id or maps PG codes. */
  insertPendingSub: (row: PendingSubInsert) => Promise<InsertResult>
  /** UPDATE the active row's status/period_end by stripe_subscription_id. */
  updateActiveStatus: (
    stripeSubscriptionId: string,
    status: string,
    currentPeriodEnd: string | null
  ) => Promise<{ id: string; provisioned_at: string | null } | null>
  /** UPDATE the pending row's last_known_status by stripe_subscription_id (only if not yet claimed). */
  updatePendingStatus: (
    stripeSubscriptionId: string,
    status: string
  ) => Promise<{ id: string } | null>
  /** Fire provisioning for a freshly active row. Wrapped in try/catch by the caller. */
  provision: (subId: string) => Promise<ProvisionOutcome>
  /** Send the "claim your account" email to a parent without a profile yet. */
  sendClaimEmail: (toEmail: string, clubName: string) => Promise<void>
}

export interface ActiveSubInsert {
  user_id: string
  club_slug: string
  stripe_subscription_id: string
  stripe_customer_id: string
  registration_team: string
  /** NULL for flat configs (CFA, SEFA). Set for hierarchical configs (LYL). */
  registration_subclub: string | null
  customer_email: string
  customer_name: string | null
  /** From Stripe custom_fields[playername]. NULL on legacy Payment Links that omit the field. */
  player_name: string | null
  /** From Stripe custom_fields[subscribertype]. 'parent' | 'player' | NULL. */
  subscriber_type: string | null
  status: string
}

export interface PendingSubInsert {
  club_slug: string
  invited_email: string
  stripe_subscription_id: string
  stripe_customer_id: string
  registration_team: string
  registration_subclub: string | null
  customer_name: string | null
  player_name: string | null
  subscriber_type: string | null
  last_known_status: string
}

export type InsertResult =
  | { kind: 'inserted'; id: string }
  | { kind: 'duplicate' }
  | { kind: 'error'; message: string }

// ============================================================================
// Default dependencies
// ============================================================================

export function buildDefaultDeps(): WebhookDeps {
  return {
    loadProfileByEmail: async (email) => {
      const supabase = createServiceClient() as any
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('email', email)
        .maybeSingle()
      if (error) throw new Error(`loadProfileByEmail: ${error.message}`)
      return data ?? null
    },

    loadClub: getClubBySlug,

    isAcademyProduct: async (productId) => {
      const clubs = await getAllClubs()
      for (const club of clubs) {
        if (getAllProductIds(club).includes(productId)) return true
      }
      return false
    },

    insertActiveSub: async (row) => {
      const supabase = createServiceClient() as any
      const { data, error } = await supabase
        .from('playhub_academy_subscriptions')
        .insert(row)
        .select('id')
        .single()
      if (error) {
        // 23505 is Postgres' unique_violation — webhook replay or concurrent
        // claim from the trigger. Treat as idempotent success.
        if ((error as any).code === '23505') return { kind: 'duplicate' }
        return { kind: 'error', message: truncateError(error.message) }
      }
      return { kind: 'inserted', id: data.id }
    },

    insertPendingSub: async (row) => {
      const supabase = createServiceClient() as any
      const { data, error } = await supabase
        .from('playhub_pending_academy_subscriptions')
        .insert(row)
        .select('id')
        .single()
      if (error) {
        if ((error as any).code === '23505') return { kind: 'duplicate' }
        return { kind: 'error', message: truncateError(error.message) }
      }
      return { kind: 'inserted', id: data.id }
    },

    updateActiveStatus: async (stripeSubscriptionId, status, currentPeriodEnd) => {
      const supabase = createServiceClient() as any
      const patch: Record<string, unknown> = { status }
      if (currentPeriodEnd) patch.current_period_end = currentPeriodEnd
      const { data, error } = await supabase
        .from('playhub_academy_subscriptions')
        .update(patch)
        .eq('stripe_subscription_id', stripeSubscriptionId)
        .select('id, provisioned_at')
        .maybeSingle()
      if (error) throw new Error(`updateActiveStatus: ${error.message}`)
      return data ?? null
    },

    updatePendingStatus: async (stripeSubscriptionId, status) => {
      const supabase = createServiceClient() as any
      const { data, error } = await supabase
        .from('playhub_pending_academy_subscriptions')
        .update({ last_known_status: status })
        .eq('stripe_subscription_id', stripeSubscriptionId)
        .is('claimed_at', null)
        .select('id')
        .maybeSingle()
      if (error) throw new Error(`updatePendingStatus: ${error.message}`)
      return data ?? null
    },

    provision: provisionAcademyAccess,

    sendClaimEmail: async (toEmail, clubName) => {
      const result = await sendAcademyClaimEmail({ toEmail, clubName })
      if (!result.success) {
        // Don't throw — failed claim email shouldn't fail the webhook.
        // Structured log (matches the academy_webhook_* event family) so ops
        // alerts can grep on it. Includes only domain (not full email) to
        // avoid PII in the function log.
        console.warn(
          JSON.stringify({
            event: 'academy_claim_email_failed',
            email_domain: toEmail.split('@')[1] ?? 'unknown',
            club_name: clubName,
            error: truncateError(result.error),
          })
        )
      }
    },
  }
}

// ============================================================================
// checkout.session.completed handler (academy_subscription metadata)
// ============================================================================

export async function handleAcademyCheckoutCompleted(
  session: Stripe.Checkout.Session,
  deps: WebhookDeps = buildDefaultDeps()
): Promise<CheckoutResult> {
  const metadata = session.metadata || {}
  const clubSlug = metadata.club_slug
  const teamSlug = metadata.team_slug
  // Optional middle layer. Absent or empty string ⇒ flat config (CFA, SEFA).
  // Present ⇒ hierarchical (LYL). We don't enforce hierarchical-vs-flat here:
  // the FK in the DB and the slug-shape regex are the bounded validations.
  // (Cross-checking against playhub_academy_subclubs would couple this
  // handler to subclub-table reads — not worth the latency cost given the
  // FK already deny-by-default; see E.2 schema migration.)
  const subclubSlugRaw = metadata.subclub_slug
  // Empty-string normalization. Includes the literal strings "null" /
  // "undefined" because PLAYBACK's form serialiser used to emit those when
  // a field was absent — defence in depth for the FK that already
  // deny-by-defaults at provisioning time, but keeps failure logs clean.
  const subclubSlugTrimmed =
    typeof subclubSlugRaw === 'string' ? subclubSlugRaw.trim() : ''
  const subclubSlug =
    subclubSlugTrimmed.length > 0 &&
    subclubSlugTrimmed !== 'null' &&
    subclubSlugTrimmed !== 'undefined'
      ? subclubSlugTrimmed
      : null
  const stripeSubscriptionId = session.subscription as string | null
  const stripeCustomerId = session.customer as string | null
  const customerEmail = session.customer_details?.email?.trim().toLowerCase()
  const customerName = session.customer_details?.name || null

  // Stripe Checkout custom_fields. Self-serve flow sets `playername` (text)
  // and `subscribertype` (dropdown: 'parent' | 'player'). Legacy CFA / SEFA
  // Payment Links use the same keys for the playername entry but a different
  // key family for team — we only care about the two roster fields here;
  // team_slug already lives in session.metadata. Bounded both fields to
  // protect downstream UI from oversized attacker input; subscriber_type is
  // additionally allowlisted because it drives roster-side logic.
  let playerName: string | null = null
  let subscriberType: string | null = null
  for (const cf of session.custom_fields || []) {
    const raw =
      cf.type === 'dropdown'
        ? cf.dropdown?.value
        : cf.type === 'text'
          ? cf.text?.value
          : null
    if (!raw) continue
    if (cf.key === 'playername') {
      playerName = raw.trim().slice(0, 80) || null
    } else if (cf.key === 'subscribertype') {
      const v = raw.trim().toLowerCase()
      subscriberType = v === 'parent' || v === 'player' ? v : null
    }
  }

  if (!clubSlug || !teamSlug) {
    return { status: 'error', error: 'missing club_slug or team_slug in metadata' }
  }
  if (!isValidTeamSlug(teamSlug)) {
    // Bounded slug shape protects DB / logs / downstream UI from
    // attacker-controlled metadata. team_slug comes from a custom_field at
    // checkout, but Stripe doesn't constrain its content.
    return { status: 'error', error: `invalid team_slug shape: ${teamSlug.slice(0, 32)}` }
  }
  if (subclubSlug !== null && !isValidSubclubSlug(subclubSlug)) {
    return {
      status: 'error',
      error: `invalid subclub_slug shape: ${subclubSlug.slice(0, 32)}`,
    }
  }
  if (!stripeSubscriptionId) {
    return { status: 'error', error: 'session has no subscription id' }
  }
  if (!stripeCustomerId) {
    return { status: 'error', error: 'session has no customer id' }
  }
  if (!customerEmail) {
    return { status: 'error', error: 'session has no customer email' }
  }

  const club = await deps.loadClub(clubSlug)
  if (!club) {
    return { status: 'error', error: `unknown club slug: ${clubSlug}` }
  }

  const profile = await deps.loadProfileByEmail(customerEmail)

  if (profile) {
    // Existing-profile path: insert active row directly + fire provisioning.
    const insert = await deps.insertActiveSub({
      user_id: profile.user_id,
      club_slug: clubSlug,
      stripe_subscription_id: stripeSubscriptionId,
      stripe_customer_id: stripeCustomerId,
      registration_team: teamSlug,
      registration_subclub: subclubSlug,
      customer_email: customerEmail,
      customer_name: customerName,
      player_name: playerName,
      subscriber_type: subscriberType,
      // checkout.session.completed implies the first payment succeeded; status is
      // 'active' (or 'trialing' if a trial was configured — webhook only fires
      // when payment-side checkout completes, so 'active' is the safe default).
      status: 'active',
    })

    if (insert.kind === 'duplicate') {
      return { status: 'duplicate', reason: 'active_exists' }
    }
    if (insert.kind === 'error') {
      return { status: 'error', error: `insert active sub failed: ${insert.message}` }
    }

    let provisionOutcome: ProvisionOutcome
    try {
      provisionOutcome = await deps.provision(insert.id)
    } catch (err) {
      // Provisioning threw — return success on the row creation; D2's
      // /api/me/provision-pending will retry on next visit. The structured
      // log lands via logProvisioningOutcome() below.
      provisionOutcome = {
        kind: 'failure',
        subId: insert.id,
        error: truncateError(err instanceof Error ? err.message : String(err)),
        retryable: true,
        reason: 'veo_threw',
      }
    }
    logProvisioningOutcome(provisionOutcome, 'checkout.session.completed')
    return { status: 'created', subId: insert.id, provisionOutcome }
  }

  // No-profile path: stash a pending row + send claim email.
  const insert = await deps.insertPendingSub({
    club_slug: clubSlug,
    invited_email: customerEmail,
    stripe_subscription_id: stripeSubscriptionId,
    stripe_customer_id: stripeCustomerId,
    registration_team: teamSlug,
    registration_subclub: subclubSlug,
    customer_name: customerName,
    player_name: playerName,
    subscriber_type: subscriberType,
    last_known_status: 'active',
  })

  if (insert.kind === 'duplicate') {
    return { status: 'duplicate', reason: 'pending_exists' }
  }
  if (insert.kind === 'error') {
    return { status: 'error', error: `insert pending sub failed: ${insert.message}` }
  }

  // Fire-and-forget — failed claim email is logged but doesn't fail the webhook.
  await deps.sendClaimEmail(customerEmail, club.name)
  return { status: 'pending', pendingId: insert.id }
}

// ============================================================================
// customer.subscription.updated handler
// ============================================================================

export async function handleAcademySubscriptionUpdated(
  subscription: Stripe.Subscription,
  deps: WebhookDeps = buildDefaultDeps()
): Promise<UpdateResult> {
  if (!(await isAcademySubscription(subscription, deps))) {
    return { status: 'not_academy' }
  }

  const newStatus = subscription.status
  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null

  // Try the active table first.
  const activeRow = await deps.updateActiveStatus(
    subscription.id,
    newStatus,
    periodEnd
  )

  if (activeRow) {
    // If freshly active/trialing AND not yet provisioned → fire provisioning.
    // (e.g. trial ended → active, or past_due → active after retried payment.)
    const shouldProvision =
      (newStatus === 'active' || newStatus === 'trialing') &&
      !activeRow.provisioned_at
    if (shouldProvision) {
      let provisionOutcome: ProvisionOutcome
      try {
        provisionOutcome = await deps.provision(activeRow.id)
      } catch (err) {
        // Structured log lands via logProvisioningOutcome() below.
        provisionOutcome = {
          kind: 'failure',
          subId: activeRow.id,
          error: truncateError(err instanceof Error ? err.message : String(err)),
          retryable: true,
          reason: 'veo_threw',
        }
      }
      logProvisioningOutcome(provisionOutcome, 'customer.subscription.updated')
      return {
        status: 'updated_and_provisioned',
        subId: activeRow.id,
        provisionOutcome,
      }
    }
    return { status: 'updated', rowKind: 'active' }
  }

  // Fall back to the pending table — keeps last_known_status fresh so the
  // trigger uses the right status if the row is claimed later.
  const pendingRow = await deps.updatePendingStatus(subscription.id, newStatus)
  if (pendingRow) return { status: 'updated', rowKind: 'pending' }

  return { status: 'not_found' }
}

// ============================================================================
// customer.subscription.deleted handler
// ============================================================================

export async function handleAcademySubscriptionDeleted(
  subscription: Stripe.Subscription,
  deps: WebhookDeps = buildDefaultDeps()
): Promise<DeleteResult> {
  if (!(await isAcademySubscription(subscription, deps))) {
    return { status: 'not_academy' }
  }

  // Active row first.
  const activeRow = await deps.updateActiveStatus(subscription.id, 'canceled', null)
  if (activeRow) return { status: 'canceled', rowKind: 'active' }

  // Pending row fallback.
  const pendingRow = await deps.updatePendingStatus(subscription.id, 'canceled')
  if (pendingRow) return { status: 'canceled', rowKind: 'pending' }

  return { status: 'not_found' }
}

// ============================================================================
// Internal: structured logging for provisioning outcomes
// ============================================================================
// Per the B2 carry-over from B1: every call site of provisionAcademyAccess
// MUST emit structured logs and branch on isSecurityFailure for ops escalation.

function logProvisioningOutcome(
  outcome: ProvisionOutcome,
  context: string
): void {
  if (outcome.kind === 'success') {
    // IMPORTANT: `kind === 'success'` here means "Lambda dispatch accepted"
    // (the async-invoke fan-out from the webhook), NOT "Veo confirmed the
    // invite". The Lambda emits a separate `veo_invite_succeeded` /
    // `veo_invite_failed` log when the actual Veo write lands ~10-30s later.
    // Alerts that need "the customer actually has access" must key on the
    // Lambda's veo_invite_* events or on `provisioned_at IS NOT NULL`,
    // NOT on this dispatch event.
    //
    // The `result: 'dispatched'` field below is the load-bearing signal.
    // Renamed from 'success' on 2026-05-17 per API-architect review.
    console.log(
      JSON.stringify({
        event: 'academy_provisioning',
        context,
        result: outcome.alreadyProvisioned ? 'already_provisioned' : 'dispatched',
        sub_id: outcome.subId,
        already_provisioned: outcome.alreadyProvisioned,
      })
    )
    return
  }
  const security = isSecurityFailure(outcome)
  // SECURITY-tagged failures should be alertable — ops should grep
  // for "academy_provisioning_security_failure" and route to PagerDuty/Sentry.
  console.error(
    JSON.stringify({
      event: security
        ? 'academy_provisioning_security_failure'
        : 'academy_provisioning_failure',
      context,
      sub_id: outcome.subId,
      reason: outcome.reason,
      retryable: outcome.retryable,
      error: outcome.error,
    })
  )
}
