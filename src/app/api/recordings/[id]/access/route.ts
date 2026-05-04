// GET/POST /api/recordings/[id]/access - List and grant access to a recording

import { getAuthUserStrict, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { passesCsrfCheck } from '@/lib/auth/csrf'

// Feature flag — when false, only admins and buyers can grant. When true,
// any user with access (including email-grantees) can grant too. Default
// true matches the explicit product call to ship permissive; flipping to
// false is a one-env-var revert if abuse signals appear.
const ALLOW_GRANTEE_FORWARDING =
  process.env.PLAYHUB_GRANT_ALLOW_GRANTEE_FORWARDING !== 'false'

// Per-user, per-day grant cap. Backed by a count query against the audit
// log (which has an index on actor_user_id, created_at DESC) — durable
// across serverless cold starts without Redis. Tuned generously for the
// "share with the team" use case while still bounded enough that a
// compromised account can't email-bomb thousands of inboxes overnight.
const GRANTS_PER_USER_PER_DAY = 200
import {
  isVenueAdmin,
  checkRecordingAccess,
  listRecordingAccess,
  grantRecordingAccess,
  grantRecordingAccessBulk,
} from '@/lib/recordings/access-control'
import {
  sendRecordingAccessEmail,
  sendRecordingAssignedEmail,
} from '@/lib/email'
import { recordAuditEvent } from '@/lib/audit/log'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: recordingId } = await params
  const { user, supabase } = await getAuthUserStrict()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get recording to check organization
  const { data: recording, error: recordingError } = await (supabase as any)
    .from('playhub_match_recordings')
    .select('id, organization_id, title')
    .eq('id', recordingId)
    .single()

  if (recordingError || !recording) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  // Check if user is admin for this venue, or has access to the recording
  let authorized = false
  if (recording.organization_id) {
    authorized = await isVenueAdmin(user.id, recording.organization_id)
  }
  if (!authorized) {
    const access = await checkRecordingAccess(recordingId, user.id)
    authorized = access.hasAccess
  }
  if (!authorized) {
    return NextResponse.json(
      { error: 'Not authorized to view access for this recording' },
      { status: 403 }
    )
  }

  // Get access list
  const accessList = await listRecordingAccess(recordingId)

  return NextResponse.json(
    {
      recording: {
        id: recording.id,
        title: recording.title,
      },
      access: accessList,
    },
    {
      // Per-user list mutates whenever any granter (admin OR access-holder)
      // adds a row. Don't let any intermediate cache hold a stale view.
      headers: { 'Cache-Control': 'no-store' },
    }
  )
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // CSRF defence-in-depth — Supabase cookies are SameSite=Lax by default
  // (which already blocks cross-site POSTs) but we want a backstop. Reject
  // if the Origin / Sec-Fetch-Site signal doesn't match same-origin.
  if (!passesCsrfCheck(request)) {
    return NextResponse.json(
      { error: 'Cross-origin request rejected' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    )
  }

  const { id: recordingId } = await params
  const { user } = await getAuthUserStrict()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const serviceClient = createServiceClient()

  // Per-user, per-day rate limit. Counts grants the user has made via the
  // audit log (which is indexed on actor_user_id, created_at DESC). Cheap
  // single-row count, durable across serverless cold starts. A buggy or
  // compromised account can't email-bomb thousands of inboxes overnight.
  // Fails CLOSED — a DB error here returns 503 rather than silently
  // disabling the limiter (which would convert any DB blip into an
  // unbounded-grant window).
  const windowStart = Date.now() - 24 * 60 * 60 * 1000
  const since = new Date(windowStart).toISOString()
  const { count: grantsToday, error: rateLimitErr } = await (
    serviceClient as any
  )
    .from('playhub_audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('actor_user_id', user.id)
    .eq('action', 'recording_access.grant')
    .gte('created_at', since)
  if (rateLimitErr || typeof grantsToday !== 'number') {
    console.error('rate-limit count failed', rateLimitErr?.message)
    return NextResponse.json(
      { error: 'Service temporarily unavailable. Please try again.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    )
  }
  if (grantsToday >= GRANTS_PER_USER_PER_DAY) {
    // Window resets when the oldest grant in the current 24h slides out.
    // Approximated as (windowStart + 24h) — the ceiling on Retry-After.
    const retryAfterSec = 60 * 60 // 1h hint, not the full 24h window
    return NextResponse.json(
      {
        error: `Daily grant limit reached (${GRANTS_PER_USER_PER_DAY}). Try again later.`,
      },
      {
        status: 429,
        headers: {
          'Cache-Control': 'no-store',
          'Retry-After': String(retryAfterSec),
          'X-RateLimit-Limit': String(GRANTS_PER_USER_PER_DAY),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(
            Math.floor((windowStart + 24 * 60 * 60 * 1000) / 1000)
          ),
        },
      }
    )
  }

  // Get recording to check organization
  const { data: recording, error: recordingError } = await (
    serviceClient as any
  )
    .from('playhub_match_recordings')
    .select('id, organization_id, title, s3_key')
    .eq('id', recordingId)
    .single()

  if (recordingError || !recording) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  const isReady = !!recording.s3_key

  // Authorization: admin always, plus "anyone with access" iff the
  // grantee-forwarding feature flag is enabled. Track HOW the granter was
  // authorized so the audit log can distinguish admin overrides from
  // organic peer-to-peer shares. The flag default is permissive; flipping
  // PLAYHUB_GRANT_ALLOW_GRANTEE_FORWARDING=false reverts to admin+buyer
  // semantics without a code change.
  const granterIsAdmin = recording.organization_id
    ? await isVenueAdmin(user.id, recording.organization_id)
    : false
  let granterHasAccess = granterIsAdmin
  if (!granterHasAccess) {
    const access = await checkRecordingAccess(recordingId, user.id)
    if (ALLOW_GRANTEE_FORWARDING) {
      // Permissive: any access at all qualifies (admin / buyer / grantee).
      granterHasAccess = access.hasAccess
    } else {
      // Locked-down: only admin (above) + buyer (purchase row) qualifies.
      // Grantees cannot forward.
      const { data: purchase } = await (serviceClient as any)
        .from('playhub_purchases')
        .select('id')
        .eq('user_id', user.id)
        .eq('match_recording_id', recordingId)
        .eq('status', 'completed')
        .maybeSingle()
      granterHasAccess = !!purchase && access.hasAccess
    }
  }
  if (!granterHasAccess) {
    // Tightened message — do not enumerate the invite path. The 403 is
    // enough; how to acquire access is a UX concern, not an API hint.
    return NextResponse.json(
      { error: "You don't have access to share this recording." },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    )
  }

  // Get venue name for email
  let venueName: string | undefined
  if (recording.organization_id) {
    const { data: venue } = await serviceClient
      .from('organizations')
      .select('name')
      .eq('id', recording.organization_id)
      .single()
    venueName = venue?.name
  }

  // Get inviter's name
  const { data: inviterProfile } = await serviceClient
    .from('profiles')
    .select('full_name')
    .eq('user_id', user.id)
    .single()

  const body = await request.json()
  const { emails, email, expiresAt, notes } = body

  // Support both single email and array of emails. Normalise to a clean
  // deduped lower-cased list before any validation / fan-out so two paths
  // can't end up reasoning about different shapes.
  const rawList: string[] = emails || (email ? [email] : [])
  const seen = new Set<string>()
  const emailList: string[] = []
  for (const raw of rawList) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim().toLowerCase()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    emailList.push(trimmed)
  }

  if (emailList.length === 0) {
    return NextResponse.json(
      { error: 'At least one email is required' },
      { status: 400 }
    )
  }

  // Hard cap per request — defends against bulk email bombing where a
  // single authenticated user fans out to a long attacker-controlled list
  // via the transactional sender. A real per-user / per-day limiter is
  // tracked as a follow-up; this is the stage-appropriate fence.
  const MAX_EMAILS_PER_REQUEST = 20
  if (emailList.length > MAX_EMAILS_PER_REQUEST) {
    return NextResponse.json(
      {
        error: `Too many recipients in one request (max ${MAX_EMAILS_PER_REQUEST}).`,
      },
      { status: 400 }
    )
  }

  // Validate emails. Cap length per RFC 5321 (254). Reject control chars
  // and require a TLD ≥ 2 chars on top of the basic shape check.
  const emailRegex = /^[^\s@<>"'\\]+@[^\s@<>"'\\]+\.[^\s@<>"'\\]{2,}$/
  const invalidEmails = emailList.filter(
    (e) => e.length > 254 || !emailRegex.test(e) || /[ -]/.test(e)
  )
  if (invalidEmails.length > 0) {
    return NextResponse.json(
      { error: `Invalid emails: ${invalidEmails.join(', ')}` },
      { status: 400 }
    )
  }

  // Grant access
  if (emailList.length === 1) {
    const result = await grantRecordingAccess(recordingId, user.id, {
      email: emailList[0],
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      notes,
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

    // Send appropriate email based on whether user exists
    if (result.userExists) {
      await sendRecordingAssignedEmail({
        toEmail: emailList[0],
        recordingTitle: recording.title,
        venueName,
        assignedBy: inviterProfile?.full_name || undefined,
        isReady,
      })
    } else {
      await sendRecordingAccessEmail({
        toEmail: emailList[0],
        recordingTitle: recording.title,
        venueName,
        inviterName: inviterProfile?.full_name || undefined,
      })
    }

    await recordAuditEvent(serviceClient as any, {
      actorUserId: user.id,
      action: 'recording_access.grant',
      targetType: 'recording_access',
      targetId: result.accessId ?? null,
      targetRecordingId: recordingId,
      targetOrganizationId: recording.organization_id ?? null,
      // wasAdminOverride is true when the granter was acting as venue
      // admin (vs an organic peer-to-peer share by a buyer/grantee).
      wasAdminOverride: granterIsAdmin,
      metadata: {
        granted_to_email: emailList[0],
        user_existed: result.userExists,
      },
    })

    // userExists is intentionally NOT returned in the response — exposing
    // it turns this endpoint into an account-enumeration oracle. It stays
    // in the audit log metadata for internal investigation.
    return NextResponse.json(
      {
        success: true,
        accessId: result.accessId,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  }

  // Bulk grant
  const result = await grantRecordingAccessBulk(
    recordingId,
    user.id,
    emailList,
    {
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      notes,
    }
  )

  // Send email notifications for successful grants
  const successfulResults = result.results.filter((r) => r.success)
  await Promise.all(
    successfulResults.map((r) =>
      r.userExists
        ? sendRecordingAssignedEmail({
            toEmail: r.email,
            recordingTitle: recording.title,
            venueName,
            assignedBy: inviterProfile?.full_name || undefined,
            isReady,
          })
        : sendRecordingAccessEmail({
            toEmail: r.email,
            recordingTitle: recording.title,
            venueName,
            inviterName: inviterProfile?.full_name || undefined,
          })
    )
  )

  // Audit-log each successful grant. One row per recipient so the per-
  // recipient context (email, whether they had an account) is preserved
  // and the audit log can be filtered/grouped per-target naturally.
  await Promise.all(
    successfulResults.map((r) =>
      recordAuditEvent(serviceClient as any, {
        actorUserId: user.id,
        action: 'recording_access.grant',
        targetType: 'recording_access',
        // Bulk helper now lifts accessId so each audit row can pinpoint
        // the exact playhub_access_rights row it created.
        targetId: r.accessId ?? null,
        targetRecordingId: recordingId,
        targetOrganizationId: recording.organization_id ?? null,
        wasAdminOverride: granterIsAdmin,
        metadata: {
          granted_to_email: r.email,
          user_existed: r.userExists,
        },
      })
    )
  )

  // Strip userExists + accessId from per-recipient results before returning
  // — same enumeration-oracle reasoning as the single-grant path. Internals
  // stay in the audit log for investigation.
  return NextResponse.json(
    {
      success: result.success,
      results: result.results.map((r) => ({
        email: r.email,
        success: r.success,
        error: r.error,
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
