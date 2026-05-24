// Academy subscription provisioning — Checkpoint B1
//
// Given an active row in playhub_academy_subscriptions with provisioned_at IS NULL,
// this function:
//   (1) gates on `auth.users.email_confirmed_at IS NOT NULL` — the load-bearing
//       salted-account defence. An attacker who runs a real Stripe checkout for
//       victim@example.com cannot obtain entitlement unless they can also click
//       a confirmation link sent to that inbox.
//   (2) cross-checks the Stripe customer's email against the row's customer_email
//       — defence in depth against operational drift (e.g. ops or a Customer
//       Portal flow editing the Stripe customer object). NOT the primary salted-
//       account defence; the email at row-create time is whatever the attacker
//       entered, so this comparison passes for the textbook attack.
//   (3) resolves the Veo team via the playhub_academy_teams mapping,
//   (4) calls invitePlayer() in lib/veo/client (idempotent — Veo returns success
//       even if the email already has a pending invitation),
//   (5) writes provisioned_at on success or provisioning_error on failure.
//
// Idempotency layered three ways:
//   - row-level: skip if provisioned_at is already set,
//   - DB-write: UPDATE WHERE provisioned_at IS NULL so a concurrent success isn't
//     clobbered,
//   - Veo-level: invitePlayer treats "already invited" as success.
//
// Trust contract: callers MUST authorize the subscription belongs to the
// invoking user (or be a service-role webhook handler). Pass `expectedUserId`
// to have the function enforce this defensively.
//
// Dependency injection via the `deps` arg keeps unit tests pure: defaults wire
// to real Stripe / Veo / Supabase, tests inject mocks. No webhook integration
// here — Checkpoint B2 wires this into the Stripe event handlers and the
// post-claim provisioning endpoint.

import Stripe from 'stripe'
import { createServiceClient } from '@/lib/supabase/server'
import { type VeoResult } from '@/lib/veo/client'
import { getClubBySlug, type AcademyClub } from './config'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'

// Production Veo invite path goes through the playhub-veo-sync Lambda
// (`action: 'invite-member'`) — Netlify functions have no Chromium binary
// so direct invitePlayer() calls from here would crash on every paying
// customer. The Lambda owns the DB flip (provisioned_at, provisioning_error)
// asynchronously; this module just enqueues the dispatch.
const VEO_SYNC_LAMBDA_NAME =
  process.env.VEO_SYNC_LAMBDA_NAME || 'playhub-veo-sync'

let cachedLambda: LambdaClient | null = null
function getLambda(): LambdaClient {
  if (!cachedLambda) {
    cachedLambda = new LambdaClient({
      region: process.env.PLAYHUB_AWS_REGION || 'eu-west-2',
      credentials: {
        accessKeyId: process.env.PLAYHUB_AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.PLAYHUB_AWS_SECRET_ACCESS_KEY!,
      },
    })
  }
  return cachedLambda
}

/**
 * Dispatch the Veo invite to the playhub-veo-sync Lambda asynchronously.
 * Returns `{ success: true }` once the Lambda accepts the dispatch — the
 * actual Veo invite happens in the background. The Lambda is responsible
 * for flipping `provisioned_at`, recording `provisioning_error`, and
 * emailing admin@playbacksports.ai on failure.
 *
 * The shape mirrors the legacy invitePlayer signature so the rest of
 * provision.ts (which DI's `inviteToVeo`) doesn't need to know about
 * the async-vs-sync change.
 */
async function dispatchInviteToVeoLambda(
  veoClubSlug: string,
  veoTeamSlug: string,
  email: string,
  subId: string
): Promise<VeoResult> {
  try {
    await getLambda().send(
      new InvokeCommand({
        FunctionName: VEO_SYNC_LAMBDA_NAME,
        InvocationType: 'Event', // async — Lambda runs in background
        Payload: Buffer.from(
          JSON.stringify({
            action: 'invite-member',
            subId,
            veoClubSlug,
            veoTeamSlug,
            email,
          })
        ),
      })
    )
    return {
      success: true,
      message: `dispatched invite for ${email} → ${veoClubSlug}/${veoTeamSlug} (sub ${subId})`,
    }
  } catch (err) {
    return {
      success: false,
      message: `Lambda dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ============================================================================
// Types
// ============================================================================

/** A row from playhub_academy_subscriptions, with the columns provisioning needs. */
export interface AcademySubscriptionRow {
  id: string
  user_id: string
  club_slug: string
  stripe_subscription_id: string
  stripe_customer_id: string
  registration_team: string | null
  /** Hierarchical-academy middle layer (LYL → "barnes-eagles", etc).
   *  NULL for flat configs (CFA, SEFA). When set, Veo club lookup is
   *  redirected to playhub_academy_subclubs.veo_club_slug instead of the
   *  config-level veoClubSlug, and team lookup is scoped to (club, subclub). */
  registration_subclub: string | null
  customer_email: string
  status: string
  provisioned_at: string | null
}

export type ProvisionOutcome =
  | {
      kind: 'success'
      subId: string
      alreadyProvisioned: boolean
      veoMessage?: string
    }
  | {
      kind: 'failure'
      subId: string
      error: string
      retryable: boolean
      // Categorical reason codes — used by callers for structured logging /
      // alerting (security-relevant failures should page; transient should not).
      reason:
        | 'not_found'
        | 'authorization' // expectedUserId mismatch
        | 'not_entitled' // status not active/trialing
        | 'email_not_confirmed' // SECURITY: salted-account primary defence
        | 'auth_unreachable' // isEmailConfirmed threw — page on rate, not single occurrence
        | 'stripe_email_mismatch' // SECURITY: defence in depth
        | 'stripe_unreachable'
        | 'stripe_customer_missing'
        | 'stripe_forbidden' // misconfigured key — page ops immediately
        | 'config_missing_team'
        | 'config_unknown_club'
        | 'config_no_veo_club'
        | 'config_no_veo_team'
        | 'veo_invite_failed'
        | 'veo_threw'
    }

export interface ProvisionDeps {
  loadSub: (subId: string) => Promise<AcademySubscriptionRow | null>
  loadClub: (clubSlug: string) => Promise<AcademyClub | undefined>
  /**
   * Hierarchical Veo-club resolution. Returns the subclub's veo_club_slug
   * if both the row exists and the field is non-NULL. NULL return means
   * provisioning should fail with config_no_veo_club at the subclub level.
   */
  loadSubclubVeoClubSlug: (
    clubSlug: string,
    subclubSlug: string
  ) => Promise<string | null>
  /**
   * Resolve the Veo team slug. When `subclubSlug` is set the lookup uses
   * the (club, subclub, team) partial UNIQUE; when null it uses the flat
   * (club, team) partial UNIQUE. The two indexes are mutually exclusive,
   * so a single dep covers both layouts without ambiguity.
   */
  resolveVeoTeamSlug: (
    clubSlug: string,
    teamSlug: string,
    subclubSlug: string | null
  ) => Promise<string | null>
  /** Returns true iff the auth user has confirmed their email. */
  isEmailConfirmed: (userId: string) => Promise<boolean>
  /**
   * Returns the Stripe customer's current email (lowercased + trimmed),
   * `null` for a deleted customer, or throws a structured error for
   * unreachable / missing / forbidden cases.
   */
  fetchStripeCustomerEmail: (stripeCustomerId: string) => Promise<string | null>
  /** Enqueues the Veo invite for the given subscription. Production impl
   *  fires an async invocation to the playhub-veo-sync Lambda — the actual
   *  Veo dashboard scrape happens out-of-band and the Lambda owns the
   *  DB flip (`provisioned_at` / `provisioning_error`). Sync test impls
   *  pass through to a fake that returns immediately. */
  inviteToVeo: (
    veoClubSlug: string,
    veoTeamSlug: string,
    email: string,
    subId: string
  ) => Promise<VeoResult>
  /** Persists outcome. Skips writes that would clobber an already-provisioned row. */
  recordOutcome: (subId: string, outcome: ProvisionOutcome) => Promise<void>
}

/** Distinguishes Stripe-level failure modes for the caller's classifier. */
export class StripeFetchError extends Error {
  constructor(
    public reason: 'unreachable' | 'customer_missing' | 'forbidden',
    message: string
  ) {
    super(message)
    this.name = 'StripeFetchError'
  }
}

// ============================================================================
// Default dependencies — real Stripe / Veo / Supabase
// ============================================================================

let cachedStripe: Stripe | null = null
function getStripe(): Stripe {
  if (!cachedStripe) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) {
      throw new Error(
        'STRIPE_SECRET_KEY is not set — provision.ts cannot run without it'
      )
    }
    cachedStripe = new Stripe(key, { apiVersion: '2025-02-24.acacia' })
  }
  return cachedStripe
}

export function buildDefaultDeps(): ProvisionDeps {
  return {
    loadSub: async (subId) => {
      const supabase = createServiceClient() as any
      const { data, error } = await supabase
        .from('playhub_academy_subscriptions')
        .select(
          'id, user_id, club_slug, stripe_subscription_id, stripe_customer_id, registration_team, registration_subclub, customer_email, status, provisioned_at'
        )
        .eq('id', subId)
        .maybeSingle()
      if (error) throw new Error(`loadSub: ${error.message}`)
      return data as AcademySubscriptionRow | null
    },

    loadClub: getClubBySlug,

    loadSubclubVeoClubSlug: async (clubSlug, subclubSlug) => {
      const supabase = createServiceClient() as any
      const { data, error } = await supabase
        .from('playhub_academy_subclubs')
        .select('veo_club_slug')
        .eq('club_slug', clubSlug)
        .eq('subclub_slug', subclubSlug)
        .eq('is_active', true)
        .maybeSingle()
      if (error) throw new Error(`loadSubclubVeoClubSlug: ${error.message}`)
      return data?.veo_club_slug ?? null
    },

    resolveVeoTeamSlug: async (clubSlug, teamSlug, subclubSlug) => {
      const supabase = createServiceClient() as any
      let q = supabase
        .from('playhub_academy_teams')
        .select('veo_team_slug')
        .eq('club_slug', clubSlug)
        .eq('team_slug', teamSlug)
        .eq('is_active', true)
      // Postgres treats NULL as distinct in UNIQUE. We mirror that here:
      // when the row's subclub is NULL we MUST filter `IS NULL` (not `eq`),
      // otherwise Supabase emits `subclub_slug=eq.null` which matches no
      // rows and a hierarchical team would silently masquerade as a flat
      // team. The two partial UNIQUE indexes guarantee at most one match.
      q = subclubSlug
        ? q.eq('subclub_slug', subclubSlug)
        : q.is('subclub_slug', null)
      const { data, error } = await q.maybeSingle()
      if (error) throw new Error(`resolveVeoTeamSlug: ${error.message}`)
      return data?.veo_team_slug ?? null
    },

    isEmailConfirmed: async (userId) => {
      const supabase = createServiceClient() as any
      const { data, error } = await supabase.auth.admin.getUserById(userId)
      if (error) throw new Error(`isEmailConfirmed: ${error.message}`)
      // Both fields are populated by Supabase. `email_confirmed_at` reflects
      // the email-link confirmation; `confirmed_at` reflects the most recent
      // confirmation across channels (email, OAuth provider verification).
      // Accepting either is intentional: Google/Apple OAuth providers verify
      // the email as part of sign-in, so confirmed_at is also load-bearing
      // trust here. PLAYHUB is currently email-only, so they should equal in
      // practice — accepting both makes us forward-compatible with OAuth.
      const u = data?.user
      return Boolean(u?.email_confirmed_at || u?.confirmed_at)
    },

    fetchStripeCustomerEmail: async (stripeCustomerId) => {
      let customer: Stripe.Customer | Stripe.DeletedCustomer
      try {
        customer = await getStripe().customers.retrieve(stripeCustomerId)
      } catch (err) {
        // Map known Stripe errors to a structured class so the caller can
        // classify retryable vs non-retryable. Unknown errors bubble up
        // (will be caught at the top level and returned as 'stripe_unreachable').
        if (err instanceof Stripe.errors.StripeInvalidRequestError) {
          throw new StripeFetchError(
            'customer_missing',
            `Stripe customer not found: ${err.message}`
          )
        }
        // Auth + permission errors mean the key is misconfigured / scoped wrong /
        // rotated — retrying won't help and will hammer Stripe. Distinct from
        // 'customer_missing' because ops needs a different alert path.
        if (
          err instanceof Stripe.errors.StripePermissionError ||
          err instanceof Stripe.errors.StripeAuthenticationError
        ) {
          throw new StripeFetchError(
            'forbidden',
            `Stripe key cannot read customer: ${err.message}`
          )
        }
        if (
          err instanceof Stripe.errors.StripeConnectionError ||
          err instanceof Stripe.errors.StripeAPIError ||
          err instanceof Stripe.errors.StripeRateLimitError
        ) {
          throw new StripeFetchError(
            'unreachable',
            `Stripe transient error: ${err.message}`
          )
        }
        throw err
      }
      if ((customer as Stripe.DeletedCustomer).deleted) return null
      const email = (customer as Stripe.Customer).email?.trim().toLowerCase()
      // Treat empty string as null — same posture as a missing email.
      return email || null
    },

    inviteToVeo: dispatchInviteToVeoLambda,

    recordOutcome: async (subId, outcome) => {
      const supabase = createServiceClient() as any
      // Async-Lambda model: `provisioned_at` is owned by the Lambda's
      // invite-member action handler — it flips it only when Veo actually
      // accepts the invite. THIS function only records the enqueue-level
      // outcome (Lambda dispatch ok / Lambda dispatch failed). Setting
      // provisioned_at here would falsely mark the row as provisioned
      // before any real Veo call had happened.
      //
      // - kind=success → enqueue ok. Clear stale error (we're retrying).
      //   Lambda will set provisioned_at when the invite actually lands.
      // - kind=failure → enqueue failed (or a pre-enqueue check did).
      //   Record the error so the admin UI surfaces it.
      // Set `provisioning_dispatched_at` on enqueue success so we can
      // detect rows stuck in flight via SQL: provisioned_at IS NULL AND
      // provisioning_error IS NULL AND provisioning_dispatched_at < now() - '15 min'.
      // The Lambda then flips provisioned_at when the actual Veo invite lands.
      const patch =
        outcome.kind === 'success'
          ? {
              provisioning_error: null,
              provisioning_dispatched_at: new Date().toISOString(),
            }
          : { provisioning_error: outcome.error }
      const { error } = await supabase
        .from('playhub_academy_subscriptions')
        .update(patch)
        .eq('id', subId)
        // Don't clobber an already-provisioned row by re-running.
        .is('provisioned_at', null)
      if (error) throw new Error(`recordOutcome: ${error.message}`)
    },
  }
}

// ============================================================================
// Helpers
// ============================================================================

function fail(
  subId: string,
  reason: Extract<ProvisionOutcome, { kind: 'failure' }>['reason'],
  error: string,
  retryable: boolean
): Extract<ProvisionOutcome, { kind: 'failure' }> {
  return { kind: 'failure', subId, error, retryable, reason }
}

// ============================================================================
// Main entry point
// ============================================================================

export interface ProvisionOptions {
  /**
   * If set, the function fails with reason='authorization' when the row's
   * user_id doesn't match. Pass the calling user's id from any caller that
   * isn't a service-role webhook handler.
   */
  expectedUserId?: string
}

/** Provision a single academy subscription row by id. Idempotent + safe to retry. */
export async function provisionAcademyAccess(
  subId: string,
  deps: ProvisionDeps = buildDefaultDeps(),
  options: ProvisionOptions = {}
): Promise<ProvisionOutcome> {
  const sub = await deps.loadSub(subId)
  if (!sub) {
    // No row to write against — return without persistence.
    return fail(subId, 'not_found', `subscription ${subId} not found`, false)
  }

  if (options.expectedUserId && sub.user_id !== options.expectedUserId) {
    // Authz mismatch — do NOT write to the row (would leak which subId exists).
    return fail(
      subId,
      'authorization',
      `subscription ${subId} not owned by expected user`,
      false
    )
  }

  // Row-level idempotency: already done = success, no external calls.
  if (sub.provisioned_at) {
    return { kind: 'success', subId, alreadyProvisioned: true }
  }

  // Only provision rows that are actually entitled (active or trialing).
  // past_due / canceled / unpaid / incomplete / paused are NOT failures —
  // they're "not eligible right now". Don't write provisioning_error every
  // dunning retry; just return the outcome without persisting.
  if (sub.status !== 'active' && sub.status !== 'trialing') {
    return fail(
      subId,
      'not_entitled',
      `subscription not entitled (status=${sub.status})`,
      true
    )
  }

  if (!sub.registration_team) {
    const outcome = fail(
      subId,
      'config_missing_team',
      'no registration_team on row — cannot resolve Veo team',
      false
    )
    await deps.recordOutcome(subId, outcome)
    return outcome
  }

  // PRIMARY salted-account defence: the auth user must have confirmed their
  // email. An attacker who runs a real Stripe checkout for victim@example.com
  // and waits for victim to sign up cannot complete provisioning unless
  // victim clicks the Supabase confirmation link in their inbox.
  //
  // RETRYABLE BUT NOT AUTO-RETRIED: if the user confirms later, *something*
  // must call provisionAcademyAccess again. Today that "something" is the
  // /api/me/provision-pending endpoint hit on next authenticated PLAYHUB
  // page load (Checkpoint D2). If a parent confirms via inbox and never
  // returns to the app, the row stays in this state until the next visit.
  let emailConfirmed: boolean
  try {
    emailConfirmed = await deps.isEmailConfirmed(sub.user_id)
  } catch (err) {
    // Supabase auth admin outage — symmetric with stripe_unreachable.
    const outcome = fail(
      subId,
      'auth_unreachable',
      `isEmailConfirmed threw: ${err instanceof Error ? err.message : String(err)}`,
      true
    )
    await deps.recordOutcome(subId, outcome)
    return outcome
  }
  if (!emailConfirmed) {
    const outcome = fail(
      subId,
      'email_not_confirmed',
      `auth user ${sub.user_id} has not confirmed their email`,
      true
    )
    await deps.recordOutcome(subId, outcome)
    return outcome
  }

  // DEFENCE-IN-DEPTH: Stripe customer's email should match the row. This
  // catches operational drift (ops edited the Customer in dashboard, parent
  // changed email via Customer Portal). It does NOT defend against the
  // textbook salted-account attack — the email_confirmed_at gate above does.
  let stripeEmail: string | null
  try {
    stripeEmail = await deps.fetchStripeCustomerEmail(sub.stripe_customer_id)
  } catch (err) {
    if (err instanceof StripeFetchError) {
      const reasonMap: Record<
        StripeFetchError['reason'],
        Extract<ProvisionOutcome, { kind: 'failure' }>['reason']
      > = {
        customer_missing: 'stripe_customer_missing',
        forbidden: 'stripe_forbidden',
        unreachable: 'stripe_unreachable',
      }
      const outcome = fail(
        subId,
        reasonMap[err.reason],
        err.message,
        err.reason === 'unreachable' // only transient → retryable
      )
      await deps.recordOutcome(subId, outcome)
      return outcome
    }
    // Unknown Stripe error — treat as transient.
    const outcome = fail(
      subId,
      'stripe_unreachable',
      `Stripe error: ${err instanceof Error ? err.message : String(err)}`,
      true
    )
    await deps.recordOutcome(subId, outcome)
    return outcome
  }

  const rowEmail = sub.customer_email.trim().toLowerCase()
  if (!stripeEmail || stripeEmail !== rowEmail) {
    const outcome = fail(
      subId,
      'stripe_email_mismatch',
      `Stripe customer email mismatch (stripe=${stripeEmail ?? '<none>'}, sub=${rowEmail})`,
      false
    )
    await deps.recordOutcome(subId, outcome)
    return outcome
  }

  const club = await deps.loadClub(sub.club_slug)
  if (!club) {
    const outcome = fail(
      subId,
      'config_unknown_club',
      `unknown club ${sub.club_slug}`,
      false
    )
    await deps.recordOutcome(subId, outcome)
    return outcome
  }

  // Resolve the Veo club slug with cascading fallback:
  //   1. If the row carries a subclub_slug AND the subclub row has a
  //      non-NULL veo_club_slug → use that (subclub override).
  //   2. Otherwise fall back to the config-level veoClubSlug.
  //   3. If neither resolves → config_no_veo_club.
  //
  // This shape lets two production realities coexist:
  //   - LYL: one league-level Veo club (`london-youth-league`) shared across
  //     all 16 subclubs. Set `veo_club_slug` once on the config row; every
  //     subclub leaves theirs NULL and inherits.
  //   - Future leagues where each member club has its own Veo club: set
  //     `veo_club_slug` on each subclub row to override the inherited value.
  //
  // Both branches emit the SAME failure reason (`config_no_veo_club`) so
  // callers don't need to know which level resolved the Veo club.
  let veoClubSlug: string | null = null
  if (sub.registration_subclub) {
    try {
      veoClubSlug = await deps.loadSubclubVeoClubSlug(
        sub.club_slug,
        sub.registration_subclub
      )
    } catch (err) {
      // Treat infra failure as transient — same posture as auth_unreachable.
      // Don't fall back to config in this case: a Supabase blip shouldn't
      // be silently absorbed; surface it for retry.
      const outcome = fail(
        subId,
        'config_no_veo_club',
        `loadSubclubVeoClubSlug threw: ${err instanceof Error ? err.message : String(err)}`,
        true
      )
      await deps.recordOutcome(subId, outcome)
      return outcome
    }
    // veoClubSlug stays null here if (a) the subclub row is missing entirely,
    // or (b) it exists but has veo_club_slug=NULL. Either way, fall through
    // to the config-level fallback below — the row's subclub_slug remains the
    // load-bearing identifier for the team lookup, and the config-level Veo
    // club is the right inherited default.
  }
  if (!veoClubSlug) {
    veoClubSlug = club.veoClubSlug ?? null
  }
  if (!veoClubSlug) {
    // Future PLAYHUB-native path lives here. For Phase 1 every academy is
    // Veo-backed, so a missing veoClubSlug is a config error.
    const teamPath = sub.registration_subclub
      ? `${sub.club_slug}/${sub.registration_subclub}`
      : sub.club_slug
    const outcome = fail(
      subId,
      'config_no_veo_club',
      `${teamPath} has no veo_club_slug configured (neither subclub nor config)`,
      false
    )
    await deps.recordOutcome(subId, outcome)
    return outcome
  }

  // The team_slug stored on the row is the parent's checkout selection
  // (e.g. 'u12-tigers'). The Veo team identifier may differ — look it
  // up in playhub_academy_teams. For hierarchical rows the (club, subclub)
  // pair scopes the lookup; for flat rows the legacy (club, team) lookup
  // applies and the subclub_slug is NULL on both sides.
  const veoTeamSlug = await deps.resolveVeoTeamSlug(
    sub.club_slug,
    sub.registration_team,
    sub.registration_subclub
  )
  if (!veoTeamSlug) {
    const teamPath = sub.registration_subclub
      ? `${sub.club_slug}/${sub.registration_subclub}/${sub.registration_team}`
      : `${sub.club_slug}/${sub.registration_team}`
    const outcome = fail(
      subId,
      'config_no_veo_team',
      `no veo_team_slug mapped for ${teamPath}`,
      false
    )
    await deps.recordOutcome(subId, outcome)
    return outcome
  }

  // Fire the Veo invite. Network errors → retryable.
  //
  // Important: the prod impl is now an async LAMBDA DISPATCH not a direct
  // Veo call. `veoResult.success` here means "Lambda accepted the event",
  // not "Veo accepted the invite". The actual Veo write happens out-of-
  // band; the Lambda owns flipping `provisioned_at` and emailing
  // admin@playbacksports.ai on Veo-level failures. From this caller's
  // perspective, an enqueue success transitions the row to "in flight".
  let veoResult: VeoResult
  try {
    veoResult = await deps.inviteToVeo(
      veoClubSlug,
      veoTeamSlug,
      rowEmail,
      sub.id
    )
  } catch (err) {
    const outcome = fail(
      subId,
      'veo_threw',
      `Veo invite threw: ${err instanceof Error ? err.message : String(err)}`,
      true
    )
    await deps.recordOutcome(subId, outcome)
    return outcome
  }

  if (!veoResult.success) {
    const outcome = fail(
      subId,
      'veo_invite_failed',
      `Veo invite failed: ${veoResult.message}`,
      true
    )
    await deps.recordOutcome(subId, outcome)
    return outcome
  }

  const outcome: ProvisionOutcome = {
    kind: 'success',
    subId,
    alreadyProvisioned: false,
    veoMessage: veoResult.message,
  }
  await deps.recordOutcome(subId, outcome)
  return outcome
}

// ============================================================================
// Convenience: provision every unprovisioned active sub for a given user
// ============================================================================
// Used by Checkpoint D2's post-signup claim flow: after the trigger has
// promoted pending rows into active rows, the PLAYBACK register-success page
// calls /api/me/provision-pending which invokes this for the new user.

export async function provisionPendingForUser(
  userId: string,
  deps: ProvisionDeps = buildDefaultDeps()
): Promise<ProvisionOutcome[]> {
  const supabase = createServiceClient() as any
  const { data, error } = await supabase
    .from('playhub_academy_subscriptions')
    .select('id')
    .eq('user_id', userId)
    .is('provisioned_at', null)
  if (error) throw new Error(`provisionPendingForUser: ${error.message}`)

  const ids = ((data as { id: string }[]) || []).map((r) => r.id)
  const results: ProvisionOutcome[] = []
  for (const id of ids) {
    // Pass expectedUserId so a future caller that hands in a wrong list
    // can't sneak through. provisionAcademyAccess re-checks the row.
    results.push(
      await provisionAcademyAccess(id, deps, { expectedUserId: userId })
    )
  }
  return results
}

// ============================================================================
// Failure-reason helpers for callers (logging, alerting, retry policy)
// ============================================================================

const SECURITY_REASONS: ReadonlySet<string> = new Set([
  'authorization',
  'email_not_confirmed',
  'stripe_email_mismatch',
])

/** True if the failure reason should be treated as a security signal (PagerDuty / Sentry). */
export function isSecurityFailure(outcome: ProvisionOutcome): boolean {
  return outcome.kind === 'failure' && SECURITY_REASONS.has(outcome.reason)
}
