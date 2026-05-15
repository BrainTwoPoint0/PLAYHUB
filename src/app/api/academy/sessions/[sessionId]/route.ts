// GET /api/academy/sessions/[sessionId]
//
// Server-to-server endpoint called by PLAYBACK's register-page server
// action (Checkpoint D2). Returns the safe subset of a Stripe Checkout
// Session needed to pre-fill the academy register form.
//
// Auth: API-key (`x-api-key` against `SYNC_API_KEY`) — same pattern as
// /api/veo/invite + /api/academy/[clubSlug]/checkout-session. Anyone with
// the key can ask about any session_id, but the lib gates by metadata.type
// + payment_status so only paid academy_subscription sessions return data.
//
// Response shape (matches /api/academy/[clubSlug]/checkout-session for
// consistency):
//   200 { customer_email, customer_name, club_slug, club_name, team_slug }
//   401 { error: { code: 'unauthorized', message: '...' } }
//   404 { error: { code: 'not_found', message: '...' } }
//   500 { error: { code: 'internal_error', message: '...' } }
//   503 { error: { code: 'transient', message: '...' } }
// Permanent failures (4xx) tell PLAYBACK "stop retrying"; transient (503)
// signals "back off and retry." Body carries PII (email, name) — every
// response is Cache-Control: no-store to prevent caching at any hop.

import { NextRequest, NextResponse } from 'next/server'
import { verifyApiKey } from '@braintwopoint0/playback-commons/security'
import { lookupAcademySession } from '@/lib/academy/session-lookup'

const SYNC_API_KEY = process.env.SYNC_API_KEY || ''

// Body contains email + name. Force no caching at any layer between
// PLAYHUB and PLAYBACK — defense against future infrastructure additions
// (CDN, debugging proxy, in-process HTTP cache) that could persist PII
// keyed by URL.
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const

// Bound session_id length in logs (Stripe ids are ~66 chars; cap at 64
// to keep log lines tidy and bound damage from any malformed input that
// somehow slipped through earlier validation).
function logId(sessionId: string): string {
  return String(sessionId).slice(0, 64)
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  if (!verifyApiKey(request, SYNC_API_KEY)) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Unauthorized' } },
      { status: 401, headers: NO_STORE_HEADERS }
    )
  }

  const { sessionId } = await params

  let outcome
  try {
    outcome = await lookupAcademySession(sessionId)
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'academy_session_lookup_threw',
        session_id: logId(sessionId),
        error: err instanceof Error ? err.message : String(err),
      })
    )
    return NextResponse.json(
      {
        error: {
          code: 'internal_error',
          message: 'Internal error looking up session',
        },
      },
      { status: 500, headers: NO_STORE_HEADERS }
    )
  }

  if (outcome.kind === 'found') {
    // Success-path log lets us trace the post-checkout funnel — parent
    // landed on the register page, we resolved their session.
    console.log(
      JSON.stringify({
        event: 'academy_session_lookup_resolved',
        session_id: logId(sessionId),
        club_slug: outcome.data.club_slug,
        // subclub_slug only logged when set — flat configs (CFA, SEFA)
        // produce log lines without the field, which keeps existing
        // log-based dashboards forward-compatible.
        ...(outcome.data.subclub_slug
          ? { subclub_slug: outcome.data.subclub_slug }
          : {}),
        team_slug: outcome.data.team_slug,
      })
    )
    return NextResponse.json(outcome.data, { headers: NO_STORE_HEADERS })
  }

  if (outcome.kind === 'transient') {
    return NextResponse.json(
      {
        error: { code: 'transient', message: outcome.error },
      },
      {
        status: 503,
        headers: { ...NO_STORE_HEADERS, 'Retry-After': '5' },
      }
    )
  }

  // not_found — single bucket so the response can't be used as an
  // enumeration oracle (don't leak whether the session_id exists but is
  // the wrong type vs doesn't exist at all).
  return NextResponse.json(
    {
      error: {
        code: 'not_found',
        message: 'Session not found or not eligible',
      },
    },
    { status: 404, headers: NO_STORE_HEADERS }
  )
}
