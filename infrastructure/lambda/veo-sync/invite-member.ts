// Veo invite-member action — invoked async from the PLAYHUB Stripe
// webhook (handle_new_user trigger's follow-up + admin re-invite + post-
// claim retry endpoint all dispatch through here).
//
// Why this lives in the Lambda and not in the Next.js route: invitePlayer
// needs Playwright (headless Chromium), and Netlify functions have no
// Chromium binary. Bit us in prod-readiness audit 2026-05-17 — the
// webhook would 200 to Stripe then crash trying to launch chromium,
// leaving a paying customer with no Veo access.
//
// Invocation: `{ action: 'invite-member', subId, veoClubSlug, veoTeamSlug, email }`
// Webhook async-invokes via `LambdaClient.send({ InvocationType: 'Event' })`,
// returning to Stripe within ~200ms.
//
// On success: writes `provisioned_at = NOW()`, clears `provisioning_error`.
// On failure: writes `provisioning_error`, sends email to admin@playbacksports.ai.
// Failure is loud — the operator wants to know within minutes, not via
// silent CloudWatch logs.

import { createClient } from '@supabase/supabase-js'
import { getVeoSession, invitePlayerToTeam } from './veo-scraper'

const ADMIN_ALERT_EMAIL =
  process.env.ADMIN_ALERT_EMAIL || 'admin@playbacksports.ai'
const FROM_EMAIL = 'PLAYHUB Alerts <admin@playbacksports.ai>'
const RESEND_ENDPOINT = 'https://api.resend.com/emails'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface InviteMemberInput {
  /** When set, the Lambda will update `playhub_academy_subscriptions`
   *  for that row (provisioned_at on success, provisioning_error on
   *  failure). When omitted, the Lambda is an ad-hoc invite — it just
   *  calls Veo + emails admin on failure. Webhook-triggered invites
   *  always supply a subId; the admin `/api/veo/invite` route may not. */
  subId?: string
  veoClubSlug: string
  veoTeamSlug: string
  email: string
}

export interface InviteMemberResult {
  status:
    | 'success'
    | 'already_provisioned'
    | 'sub_not_found'
    | 'invalid_input'
    | 'invite_failed'
  subId: string
  message: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

async function sendAdminFailureEmail(
  input: InviteMemberInput,
  errorMessage: string
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.warn(
      '[invite-member] RESEND_API_KEY not set — skipping admin failure email'
    )
    return
  }
  const subject = `[Academy provisioning · FAILED] ${input.email} → ${input.veoClubSlug}/${input.veoTeamSlug}`
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0a100d; color:#d6d5c9; padding:32px 16px;">
      <div style="max-width:640px; margin:0 auto;">
        <h1 style="font-size:20px; color:#dc2626; margin:0 0 16px;">⛔ Academy Veo invite failed</h1>
        <p style="font-size:14px; color:#d6d5c9; margin:0 0 20px;">
          A paying parent just completed Stripe checkout but the Veo invite never landed.
          They are <strong>charged but without Veo access</strong> — manually invite them via the
          Veo dashboard, then run a retry from the admin UI to flip <code>provisioned_at</code>.
        </p>
        <table style="width:100%; border-collapse:collapse; font-size:13px; background:#1a1f1d; border-radius:6px; overflow:hidden;">
          <tr><td style="padding:8px 12px; color:#b9baa3; width:30%;">Sub ID</td><td style="padding:8px 12px; color:#d6d5c9; font-family:monospace;">${escapeHtml(input.subId)}</td></tr>
          <tr style="border-top:1px solid #2a2f2d;"><td style="padding:8px 12px; color:#b9baa3;">Customer email</td><td style="padding:8px 12px; color:#d6d5c9;">${escapeHtml(input.email)}</td></tr>
          <tr style="border-top:1px solid #2a2f2d;"><td style="padding:8px 12px; color:#b9baa3;">Veo club</td><td style="padding:8px 12px; color:#d6d5c9; font-family:monospace;">${escapeHtml(input.veoClubSlug)}</td></tr>
          <tr style="border-top:1px solid #2a2f2d;"><td style="padding:8px 12px; color:#b9baa3;">Veo team</td><td style="padding:8px 12px; color:#d6d5c9; font-family:monospace;">${escapeHtml(input.veoTeamSlug)}</td></tr>
        </table>
        <h3 style="color:#d6d5c9; font-size:14px; margin:24px 0 8px;">Error</h3>
        <div style="padding:12px 16px; background:#dc262622; border-left:3px solid #dc2626; border-radius:4px;">
          <pre style="margin:0; color:#d6d5c9; font-size:12px; white-space:pre-wrap; word-break:break-word;">${escapeHtml(errorMessage)}</pre>
        </div>
        <p style="margin-top:24px; padding-top:16px; border-top:1px solid #2a2f2d; font-size:12px; color:#6b7280;">
          Hourly retry sweep will re-invoke this Lambda automatically.
          If retries fail repeatedly, check Veo team exists + the email is well-formed.
        </p>
      </div>
    </div>
  `
  try {
    const resp = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [ADMIN_ALERT_EMAIL],
        subject,
        html,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      console.error(
        `[invite-member] Resend API error: ${resp.status} ${text.slice(0, 200)}`
      )
    } else {
      console.log(
        `[invite-member] failure email dispatched to ${ADMIN_ALERT_EMAIL}`
      )
    }
  } catch (err) {
    console.error(
      '[invite-member] failure email dispatch threw:',
      err instanceof Error ? err.message : err
    )
  }
}

/**
 * Defensive hourly sweep — picks up any academy_subscriptions row that
 * is active but unprovisioned for >5min and re-dispatches the invite.
 *
 * Catches the failure modes the primary webhook path can't survive:
 *   - Netlify function timed out before its Lambda dispatch completed
 *   - Lambda was throttled (concurrent execution limit hit)
 *   - Stripe webhook fired during a brief PLAYHUB outage
 *   - Lambda crashed mid-invite before flipping provisioned_at
 *
 * Self-rate-limited via the `provision_attempted_at` column: skips rows
 * that were attempted in the last 5 min (so a sweep running 1 min after
 * a successful Webhook dispatch doesn't double-fire).
 */
// Sweep tuning constants. Per the 2026-05-17 cloud-infra + security review:
//
//  - SWEEP_SKIP_WINDOW_MS must be LONGER than the Lambda's max wall-clock
//    (600s), otherwise a crashed-mid-invite row's `provision_attempted_at`
//    stays "recent" and never gets retried. 15min is the Lambda timeout
//    ceiling + 5min buffer.
//
//  - MAX_PROVISION_ATTEMPTS prevents email-storm scenarios where a
//    permanently-bad row (deleted Veo team, malformed but regex-passing
//    email) sweeps forever. 24 hourly attempts = 1 day before the row
//    parks with a final `provisioning_error`. Admin can break the loop
//    via the admin UI re-invite (which would presumably also fix the
//    upstream config).
//
//  - SWEEP_TIME_BUDGET_MS gives the sweep itself a hard yield-point so
//    a 50-row backlog doesn't kill the Lambda mid-iteration. Yield ~30s
//    before the Lambda's 600s timeout; the next hourly fire picks up.
//
//  - SWEEP_BATCH_LIMIT caps the per-invocation row pull. With ~50s per
//    invite (Chromium reused but Veo+API time dominates) and a 9.5-min
//    budget, ~10-15 rows per sweep is a realistic ceiling. Pull more
//    only if cheap (DB read).
const SWEEP_SKIP_WINDOW_MS = 15 * 60 * 1000
const MAX_PROVISION_ATTEMPTS = 24
const SWEEP_TIME_BUDGET_MS = 9.5 * 60 * 1000
const SWEEP_BATCH_LIMIT = 200

export async function runProvisionRetrySweep(): Promise<{
  total_pending: number
  retried: number
  skipped_recently_attempted: number
  skipped_max_attempts: number
  yielded_at_time_budget: boolean
}> {
  const sweepStart = Date.now()
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  const skipWindowCutoff = new Date(
    Date.now() - SWEEP_SKIP_WINDOW_MS
  ).toISOString()

  const { data: rows, error } = await supabase
    .from('playhub_academy_subscriptions')
    .select(
      'id, club_slug, registration_team, registration_subclub, customer_email, provision_attempted_at, provision_attempts, created_at'
    )
    .is('provisioned_at', null)
    .eq('status', 'active')
    .lt('created_at', fiveMinAgo)
    .order('created_at', { ascending: true })
    .limit(SWEEP_BATCH_LIMIT)
  if (error) {
    console.error(
      JSON.stringify({
        event: 'provision_retry_sweep_query_failed',
        error: error.message,
      })
    )
    return {
      total_pending: 0,
      retried: 0,
      skipped_recently_attempted: 0,
      skipped_max_attempts: 0,
      yielded_at_time_budget: false,
    }
  }
  const all = (rows ?? []) as Array<{
    id: string
    club_slug: string
    registration_team: string
    registration_subclub: string | null
    customer_email: string
    provision_attempted_at: string | null
    provision_attempts: number | null
    created_at: string
  }>

  let retried = 0
  let skipped = 0
  let skippedMaxAttempts = 0
  let yieldedAtBudget = false
  // Open ONE Veo session up-front so all invites in this sweep share
  // the same Chromium process. The Lambda's veo-scraper has no
  // session-cache (unlike PLAYHUB's src/lib/veo/auth.ts), so without
  // this each row would launch + tear down its own Chromium — 50 rows
  // × ~5-10s of Chromium overhead = guaranteed Lambda timeout. Per
  // cloud-infra review B1.
  //
  // Lazy-open so a zero-pending sweep doesn't pay the Chromium cost.
  let sharedSession: Awaited<ReturnType<typeof getVeoSession>> | null = null
  try {
    for (const row of all) {
      // Hard yield before the Lambda timeout. Next hourly sweep picks up
      // the remainder.
      if (Date.now() - sweepStart > SWEEP_TIME_BUDGET_MS) {
        yieldedAtBudget = true
        break
      }
      // Skip rows attempted in the last 15min — covers in-flight Lambda
      // invocations AND lets a recently-crashed Lambda's failure email
      // land before we re-attempt. Per cloud-infra review B2.
      if (
        row.provision_attempted_at &&
        row.provision_attempted_at > skipWindowCutoff
      ) {
        skipped++
        continue
      }
      // Stop retrying rows that have already failed 24+ times. Park them
      // with a final error message; admin UI re-invite is the manual
      // break-the-loop path. Prevents email-storm on permanently-bad
      // rows (e.g. Veo team deleted upstream).
      if ((row.provision_attempts ?? 0) >= MAX_PROVISION_ATTEMPTS) {
        await supabase
          .from('playhub_academy_subscriptions')
          .update({
            provisioning_error: `gave up after ${MAX_PROVISION_ATTEMPTS} attempts — manual admin re-invite required`,
          })
          .eq('id', row.id)
          .is('provisioned_at', null)
        skippedMaxAttempts++
        continue
      }
      const veoTeam = await resolveVeoTeamForRow(
        supabase,
        row.club_slug,
        row.registration_team,
        row.registration_subclub
      )
      if (!veoTeam) {
        console.warn(
          JSON.stringify({
            event: 'provision_retry_skipped_no_team',
            sub_id: row.id,
            club_slug: row.club_slug,
            subclub_slug: row.registration_subclub,
            team_slug: row.registration_team,
          })
        )
        continue
      }
      // Lazy-init the shared session — only pay the Chromium cost if
      // there's at least one row to actually invite.
      if (!sharedSession) {
        sharedSession = await getVeoSession()
      }
      const result = await runInviteMember(
        {
          subId: row.id,
          veoClubSlug: veoTeam.veoClubSlug,
          veoTeamSlug: veoTeam.veoTeamSlug,
          email: row.customer_email,
        },
        { session: sharedSession }
      )
      console.log(
        JSON.stringify({
          event: 'provision_retry_attempted',
          sub_id: row.id,
          status: result.status,
        })
      )
      retried++
    }
  } finally {
    if (sharedSession) {
      await sharedSession.close().catch(() => {})
    }
  }

  console.log(
    JSON.stringify({
      event: 'provision_retry_sweep_completed',
      total_pending: all.length,
      retried,
      skipped_recently_attempted: skipped,
      skipped_max_attempts: skippedMaxAttempts,
      yielded_at_time_budget: yieldedAtBudget,
      duration_ms: Date.now() - sweepStart,
    })
  )

  return {
    total_pending: all.length,
    retried,
    skipped_recently_attempted: skipped,
    skipped_max_attempts: skippedMaxAttempts,
    yielded_at_time_budget: yieldedAtBudget,
  }
}

async function resolveVeoTeamForRow(
  supabase: ReturnType<typeof createClient>,
  clubSlug: string,
  teamSlug: string,
  subclubSlug: string | null
): Promise<{ veoClubSlug: string; veoTeamSlug: string } | null> {
  // Veo team slug from playhub_academy_teams.
  let teamQ = supabase
    .from('playhub_academy_teams')
    .select('veo_team_slug')
    .eq('club_slug', clubSlug)
    .eq('team_slug', teamSlug)
    .eq('is_active', true)
  teamQ = subclubSlug
    ? teamQ.eq('subclub_slug', subclubSlug)
    : teamQ.is('subclub_slug', null)
  const { data: team } = await teamQ.maybeSingle()
  if (!team?.veo_team_slug) return null

  // Veo club slug — prefer subclub-level, fall back to config.
  let veoClubSlug: string | null = null
  if (subclubSlug) {
    const { data: sub } = await supabase
      .from('playhub_academy_subclubs')
      .select('veo_club_slug')
      .eq('club_slug', clubSlug)
      .eq('subclub_slug', subclubSlug)
      .eq('is_active', true)
      .maybeSingle()
    veoClubSlug = sub?.veo_club_slug ?? null
  }
  if (!veoClubSlug) {
    const { data: cfg } = await supabase
      .from('playhub_academy_config')
      .select('veo_club_slug')
      .eq('club_slug', clubSlug)
      .maybeSingle()
    veoClubSlug = cfg?.veo_club_slug ?? null
  }
  if (!veoClubSlug) return null
  return { veoClubSlug, veoTeamSlug: team.veo_team_slug as string }
}

export async function runInviteMember(
  input: InviteMemberInput,
  opts: { session?: Awaited<ReturnType<typeof getVeoSession>> } = {}
): Promise<InviteMemberResult> {
  const startedAt = Date.now()
  const correlationId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  console.log(
    JSON.stringify({
      event: 'veo_invite_attempted',
      correlation_id: correlationId,
      sub_id: input.subId ?? null,
      veo_club: input.veoClubSlug,
      veo_team: input.veoTeamSlug,
      email_domain: input.email.split('@')[1] ?? null,
    })
  )
  // Input shape validation — these come from PLAYHUB's webhook handler
  // which already validates, but defense-in-depth at the Lambda boundary
  // protects against any future caller passing bad data.
  if (input.subId !== undefined && !UUID_RE.test(input.subId)) {
    return {
      status: 'invalid_input',
      subId: input.subId,
      message: 'invalid subId shape (expected uuid)',
    }
  }
  if (!SLUG_RE.test(input.veoClubSlug) || !SLUG_RE.test(input.veoTeamSlug)) {
    return {
      status: 'invalid_input',
      subId: input.subId ?? '',
      message: 'invalid veo slug shape',
    }
  }
  if (!EMAIL_RE.test(input.email) || input.email.length > 320) {
    return {
      status: 'invalid_input',
      subId: input.subId ?? '',
      message: 'invalid email shape',
    }
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Only do DB-tied work when we have a subId. Ad-hoc admin invites
  // (no subId) skip straight to the Veo call + admin email path.
  if (input.subId) {
    const { data: row, error: loadErr } = await supabase
      .from('playhub_academy_subscriptions')
      .select('id, provisioned_at, provision_attempts')
      .eq('id', input.subId)
      .maybeSingle()
    if (loadErr) {
      console.error('[invite-member] loadSub failed:', loadErr.message)
      return {
        status: 'invalid_input',
        subId: input.subId,
        message: `loadSub failed: ${loadErr.message}`,
      }
    }
    if (!row) {
      return {
        status: 'sub_not_found',
        subId: input.subId,
        message: `subscription ${input.subId} not found`,
      }
    }
    if (row.provisioned_at) {
      return {
        status: 'already_provisioned',
        subId: input.subId,
        message: 'already provisioned, skipping',
      }
    }
    // Bump attempt counter + stamp the attempt time BEFORE the actual call
    // so we have a record even if the Lambda crashes mid-invite.
    await supabase
      .from('playhub_academy_subscriptions')
      .update({
        provision_attempted_at: new Date().toISOString(),
        provision_attempts: (row.provision_attempts ?? 0) + 1,
      })
      .eq('id', input.subId)
  }

  // Do the actual invite. Single attempt — defensive retry is handled by
  // the hourly cron sweep, not in-Lambda retry (which would burn time +
  // doesn't survive Lambda timeouts anyway).
  //
  // Session sharing: the sweep passes a single Chromium session in opts
  // so all sweep iterations re-use one browser. When called from the
  // primary webhook path (single invite), we own the session lifecycle.
  let inviteOutcome: { success: boolean; message: string }
  const ownsSession = !opts.session
  let session: Awaited<ReturnType<typeof getVeoSession>> | null =
    opts.session ?? null
  try {
    if (!session) {
      session = await getVeoSession()
    }
    inviteOutcome = await invitePlayerToTeam(
      session,
      input.veoClubSlug,
      input.veoTeamSlug,
      input.email
    )
  } catch (err) {
    inviteOutcome = {
      success: false,
      message: `invite threw: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    // Only tear down the browser if WE opened it. The sweep owns its
    // shared session and closes it in its own finally.
    if (ownsSession && session) {
      await session.close().catch(() => {})
    }
  }

  if (!inviteOutcome.success) {
    if (input.subId) {
      // Don't swallow the post-invite UPDATE error — if RLS or network
      // blip means the Veo invite landed but the DB write failed, ops
      // needs CloudWatch visibility to spot the divergence. Per
      // cloud-infra review Q6.
      const { error: updErr } = await supabase
        .from('playhub_academy_subscriptions')
        .update({ provisioning_error: inviteOutcome.message.slice(0, 500) })
        .eq('id', input.subId)
      if (updErr) {
        console.error(
          JSON.stringify({
            event: 'veo_invite_db_write_failed',
            correlation_id: correlationId,
            sub_id: input.subId,
            phase: 'failure_error_write',
            error: updErr.message,
          })
        )
      }
    }
    console.error(
      JSON.stringify({
        event: 'veo_invite_failed',
        correlation_id: correlationId,
        sub_id: input.subId ?? null,
        veo_club: input.veoClubSlug,
        veo_team: input.veoTeamSlug,
        duration_ms: Date.now() - startedAt,
        error: inviteOutcome.message.slice(0, 300),
      })
    )
    // Loud failure — admin@playbacksports.ai sees the email within ~1 min.
    await sendAdminFailureEmail(input, inviteOutcome.message)
    return {
      status: 'invite_failed',
      subId: input.subId ?? '',
      message: inviteOutcome.message,
    }
  }

  // Success — flip provisioned_at + clear the error column (DB-tied invites only).
  if (input.subId) {
    const { error: updErr } = await supabase
      .from('playhub_academy_subscriptions')
      .update({
        provisioned_at: new Date().toISOString(),
        provisioning_error: null,
      })
      .eq('id', input.subId)
    if (updErr) {
      // CRITICAL: Veo invite landed but our DB doesn't reflect it.
      // Customer has Veo access; admin UI shows "unprovisioned"; sweep
      // will retry (Veo idempotent at 200/existing_invitations so harmless).
      // Email admin so they can manually flip provisioned_at if needed.
      console.error(
        JSON.stringify({
          event: 'veo_invite_db_write_failed',
          correlation_id: correlationId,
          sub_id: input.subId,
          phase: 'success_provisioned_write',
          error: updErr.message,
        })
      )
      await sendAdminFailureEmail(
        input,
        `Veo invite SUCCEEDED but DB flip failed: ${updErr.message}. Customer has access; row still shows unprovisioned. Manual flip required (or wait for next sweep — Veo idempotent so safe).`
      )
    }
  }

  console.log(
    JSON.stringify({
      event: 'veo_invite_succeeded',
      correlation_id: correlationId,
      sub_id: input.subId ?? null,
      veo_club: input.veoClubSlug,
      veo_team: input.veoTeamSlug,
      duration_ms: Date.now() - startedAt,
      adhoc: !input.subId,
    })
  )
  return {
    status: 'success',
    subId: input.subId ?? '',
    message: inviteOutcome.message,
  }
}
