// POST /api/me/pending-grants/[grantId]/decline
// Recipient explicitly declines a pending invitation. Sets the grant to
// inactive with a "user declined" reason. Audit-logged so the granter (or
// venue admin) has signal if a recipient repeatedly declines.

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { recordAuditEvent } from '@/lib/audit/log'
import { passesCsrfCheck } from '@/lib/auth/csrf'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ grantId: string }> }
) {
  if (!passesCsrfCheck(request)) {
    return NextResponse.json(
      { error: 'Cross-origin request rejected' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    )
  }

  const { grantId } = await params
  const { user } = await getAuthUser()
  if (!user) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: 401 }
    )
  }

  const serviceClient = createServiceClient() as any
  const email = (user.email || '').toLowerCase()

  // The grant must belong to this user — either by user_id or by an
  // invited_email matching the authenticated user's email. Service-role
  // read so we can find email-keyed rows that haven't been claimed yet.
  const { data: grant, error: grantErr } = await serviceClient
    .from('playhub_access_rights')
    .select(
      'id, match_recording_id, user_id, invited_email, is_active, granted_by'
    )
    .eq('id', grantId)
    .maybeSingle()

  if (grantErr) {
    return NextResponse.json(
      { error: 'Failed to fetch invitation' },
      { status: 500 }
    )
  }
  if (!grant) {
    return NextResponse.json({ error: 'Invitation not found' }, { status: 404 })
  }

  const ownsByUserId = grant.user_id === user.id
  const ownsByEmail =
    !!email && (grant.invited_email || '').toLowerCase() === email
  if (!ownsByUserId && !ownsByEmail) {
    return NextResponse.json(
      { error: 'You can only decline your own invitations' },
      { status: 403 }
    )
  }

  // Idempotent: declining an already-inactive grant is a no-op success.
  if (grant.is_active === false) {
    return NextResponse.json(
      { success: true, alreadyInactive: true },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  }

  const { error: updateErr } = await serviceClient
    .from('playhub_access_rights')
    .update({
      is_active: false,
      revoked_at: new Date().toISOString(),
      revoked_reason: 'user declined',
    })
    .eq('id', grantId)

  if (updateErr) {
    return NextResponse.json(
      { error: 'Failed to decline invitation' },
      { status: 500 }
    )
  }

  // Look up the recording's organization for the audit row's
  // target_organization_id — keeps the venue audit history complete.
  const { data: rec } = await serviceClient
    .from('playhub_match_recordings')
    .select('organization_id')
    .eq('id', grant.match_recording_id)
    .maybeSingle()

  await recordAuditEvent(serviceClient, {
    actorUserId: user.id,
    action: 'recording_access.decline',
    targetType: 'recording_access',
    targetId: grantId,
    targetRecordingId: grant.match_recording_id,
    targetOrganizationId: rec?.organization_id ?? null,
    // Recipient declining is never an admin override — it's a recipient
    // exercising their own consent. Always false.
    wasAdminOverride: false,
    metadata: {
      granted_by_user_id: grant.granted_by,
      // Don't echo invited_email if it's null (already-claimed grant).
      invited_email: grant.invited_email,
    },
  })

  return NextResponse.json(
    { success: true },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
