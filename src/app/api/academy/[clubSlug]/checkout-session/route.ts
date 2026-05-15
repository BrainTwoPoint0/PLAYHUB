// POST /api/academy/[clubSlug]/checkout-session
//
// Server-to-server endpoint called by PLAYBACK's `/api/academy/[clubSlug]/checkout`
// proxy (Checkpoint D1). Returns a Stripe Checkout Session URL the parent's
// browser is redirected to.
//
// Auth: API-key (x-api-key header) verified against SYNC_API_KEY env. Same
// pattern as /api/veo/invite — only PLAYBACK's server (which holds the key)
// can hit this endpoint. The parent themselves has no PLAYBACK account yet
// at the point of checkout, so user-session auth is not an option.
//
// Optional `Idempotency-Key` request header is passed through to Stripe so a
// browser double-submit / proxy retry resolves to the same checkout session
// rather than minting a duplicate.
//
// Error shape matches the existing /api/checkout/session contract:
//   { error: { code: '<reason>', message: '...' } }
//
// All actual session-building logic lives in src/lib/academy/checkout.ts so
// the unit tests can DI the Stripe + Supabase calls without module mocking.

import { NextRequest, NextResponse } from 'next/server'
import { verifyApiKey } from '@braintwopoint0/playback-commons/security'
import {
  createAcademyCheckoutSession,
  type CheckoutOutcome,
} from '@/lib/academy/checkout'

const SYNC_API_KEY = process.env.SYNC_API_KEY || ''

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ clubSlug: string }> }
) {
  if (!verifyApiKey(request, SYNC_API_KEY)) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Unauthorized' } },
      { status: 401 }
    )
  }

  const { clubSlug } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_body', message: 'Invalid JSON body' } },
      { status: 400 }
    )
  }

  const teamSlug =
    body && typeof body === 'object' && 'team_slug' in body
      ? String((body as { team_slug: unknown }).team_slug)
      : ''

  // Optional — only present for hierarchical academies (LYL). Flat configs
  // (CFA, SEFA) omit it. Empty string treated as absent so a thoughtless
  // form serialiser doesn't promote a flat checkout into a hierarchical one.
  // Non-string + non-null values (numbers, objects) are REJECTED rather
  // than silently coerced — a malformed body shouldn't be able to demote a
  // hierarchical intent into a flat checkout that lands the wrong row.
  const rawSubclub =
    body && typeof body === 'object' && 'subclub_slug' in body
      ? (body as { subclub_slug: unknown }).subclub_slug
      : undefined
  if (
    rawSubclub !== undefined &&
    rawSubclub !== null &&
    typeof rawSubclub !== 'string'
  ) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_body',
          message: 'subclub_slug must be a string or null',
        },
      },
      { status: 400 }
    )
  }
  const subclubSlug =
    typeof rawSubclub === 'string' && rawSubclub.length > 0 ? rawSubclub : null

  if (!teamSlug) {
    return NextResponse.json(
      { error: { code: 'invalid_body', message: 'team_slug is required' } },
      { status: 400 }
    )
  }

  // Idempotency-Key passthrough: bound length + charset before forwarding.
  // Stripe rejects malformed/oversized values but only after a roundtrip;
  // this is a cheap pre-flight guard. Stripe doc-max is 255 chars; we accept
  // printable ASCII only (any reasonable nonce / UUID format).
  const rawIdem = request.headers.get('idempotency-key')
  const idempotencyKey =
    rawIdem && rawIdem.length <= 255 && /^[\x20-\x7E]+$/.test(rawIdem)
      ? rawIdem
      : undefined

  let outcome: CheckoutOutcome
  try {
    outcome = await createAcademyCheckoutSession(
      { clubSlug, teamSlug, subclubSlug },
      undefined,
      idempotencyKey ? { idempotencyKey } : undefined
    )
  } catch (err) {
    // Programmer-error or unexpected upstream throw — return 500 to surface
    // it. Stripe / Supabase errors are caught inside the lib and mapped to
    // structured failure outcomes; reaching here means something else.
    console.error(
      JSON.stringify({
        event: 'academy_checkout_threw',
        club_slug: clubSlug,
        error: err instanceof Error ? err.message : String(err),
      })
    )
    return NextResponse.json(
      {
        error: {
          code: 'internal_error',
          message: 'Internal error creating checkout session',
        },
      },
      { status: 500 }
    )
  }

  if (outcome.kind === 'success') {
    // Success-path log lets us trace funnel from create → webhook → provision.
    // session_id is the natural correlation key in Stripe + our DB.
    console.log(
      JSON.stringify({
        event: 'academy_checkout_created',
        club_slug: clubSlug,
        // subclub_slug only logged for hierarchical leagues; absent for flat.
        ...(subclubSlug ? { subclub_slug: subclubSlug } : {}),
        team_slug: teamSlug,
        session_id: outcome.sessionId,
      })
    )
    return NextResponse.json({ url: outcome.url, session_id: outcome.sessionId })
  }

  // Map categorical failure reasons to HTTP statuses.
  // 4xx = permanent, no retry. 429 = back off + retry. 5xx = transient.
  const statusMap: Record<typeof outcome.reason, number> = {
    invalid_team_slug: 400,
    invalid_subclub_slug: 400,
    club_not_found: 404,
    subclub_not_found: 404,
    team_not_found: 404,
    no_recurring_price: 500,
    stripe_invalid_request: 400,
    stripe_rate_limited: 429,
    stripe_unreachable: 503,
    unknown: 500,
  }
  console.error(
    JSON.stringify({
      event: 'academy_checkout_failure',
      club_slug: clubSlug,
      ...(subclubSlug ? { subclub_slug: subclubSlug } : {}),
      team_slug: teamSlug,
      reason: outcome.reason,
      error: outcome.error,
    })
  )

  const headers: Record<string, string> = {}
  if (outcome.reason === 'stripe_rate_limited') {
    // Tell the proxy when to retry — Stripe's own back-off for rate limits is
    // 1-5 seconds; pick the upper end to absorb most spikes without retry storms.
    headers['Retry-After'] = '5'
  } else if (outcome.reason === 'stripe_unreachable') {
    headers['Retry-After'] = '10'
  }

  return NextResponse.json(
    { error: { code: outcome.reason, message: outcome.error } },
    { status: statusMap[outcome.reason], headers }
  )
}
