// POST /api/users/[userId]/provision-pending
//
// Server-to-server endpoint called by PLAYBACK's dashboard provisioning
// hook (Checkpoint E). Triggers Veo provisioning for any unprovisioned
// active subscriptions belonging to the userId in the path.
//
// NAMED `/users/[userId]/...` rather than `/me/...` because the subject is
// supplied by the caller (path) — it's NOT derived from a user session
// here. The trust boundary is the API key + the caller (PLAYBACK) having
// proven the user owns the session before forwarding the id. `/me/` would
// mislead future readers into assuming session-cookie auth.
//
// Auth: API-key (`x-api-key` against `SYNC_API_KEY`). PLAYBACK reads the
// current Supabase user from its session cookies and forwards user.id in
// the path; this endpoint trusts that PLAYBACK has authorised the user
// before calling.
//
// Provisioning is idempotent at three layers (per B1):
//   - row-level: skip if provisioned_at is set
//   - DB-write: UPDATE WHERE provisioned_at IS NULL (concurrent-safe)
//   - Veo-level: invitePlayer treats "already invited" as success
// So calling this endpoint repeatedly is safe — each call re-attempts only
// the rows that genuinely need it.
//
// Response (200): { total, successes, failures, security_failures }.
// `security_failures` is in the body so future alerting hooks can page on
// salted-account bypass attempts without scraping logs.

import { NextRequest, NextResponse } from 'next/server'
import { verifyApiKey } from '@braintwopoint0/playback-commons/security'
import {
  provisionPendingForUser,
  isSecurityFailure,
  type ProvisionOutcome,
} from '@/lib/academy/provision'

const SYNC_API_KEY = process.env.SYNC_API_KEY || ''

// Supabase auth.users.id is a UUID v4. Bound the input shape so attacker-
// controlled junk can't pollute logs / drive a flood of pointless DB scans.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  if (!verifyApiKey(request, SYNC_API_KEY)) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Unauthorized' } },
      { status: 401, headers: NO_STORE_HEADERS }
    )
  }

  const { userId } = await params

  if (!UUID_RE.test(userId)) {
    return NextResponse.json(
      { error: { code: 'invalid_user_id', message: 'userId must be a UUID' } },
      { status: 400, headers: NO_STORE_HEADERS }
    )
  }

  let outcomes: ProvisionOutcome[]
  try {
    outcomes = await provisionPendingForUser(userId)
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'academy_provision_pending_threw',
        user_id: userId,
        error: err instanceof Error ? err.message : String(err),
      })
    )
    return NextResponse.json(
      {
        error: {
          code: 'internal_error',
          message: 'Internal error during provisioning',
        },
      },
      { status: 500, headers: NO_STORE_HEADERS }
    )
  }

  // Summarise outcomes for the structured log + the response. The detailed
  // per-row logs land via logProvisioningOutcome inside provisionAcademyAccess.
  const successes = outcomes.filter((o) => o.kind === 'success').length
  const failures = outcomes.filter((o) => o.kind === 'failure').length
  const securityFailures = outcomes.filter(isSecurityFailure).length

  console.log(
    JSON.stringify({
      event: 'academy_provision_pending_completed',
      user_id: userId,
      total: outcomes.length,
      successes,
      failures,
      security_failures: securityFailures,
    })
  )

  return NextResponse.json(
    {
      total: outcomes.length,
      successes,
      failures,
      security_failures: securityFailures,
    },
    { headers: NO_STORE_HEADERS }
  )
}
