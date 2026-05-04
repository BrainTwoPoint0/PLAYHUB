// PATCH + DELETE /api/recordings/[id]/events/[eventId]
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { isValidEventType } from '@/lib/recordings/event-types'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { recordAuditEvent } from '@/lib/audit/log'

// Resolve auth + the recording's organization for an event-mutation request.
// Returns the existing event row, the recording's org id, and whether the
// requesting user is the creator and/or a venue admin. Centralised so PATCH
// and DELETE share the same authorization shape — both should treat the
// row as deletable/editable when the user is creator OR venue admin of the
// recording's organization.
async function resolveEventAuth(
  recordingId: string,
  eventId: string,
  userId: string
) {
  const serviceClient = createServiceClient() as any

  const { data: existing, error: existingErr } = await serviceClient
    .from('playhub_recording_events')
    .select('*')
    .eq('id', eventId)
    .eq('match_recording_id', recordingId)
    .maybeSingle()

  // Distinguish a transient DB error from "row doesn't exist" — otherwise a
  // flaky connection produces wrong-looking 404s to legitimate admin requests.
  if (existingErr) {
    return { ok: false as const, status: 500 as const }
  }
  if (!existing) {
    return { ok: false as const, status: 404 as const }
  }

  // Single recording lookup regardless of creator vs admin path. The audit
  // logger needs organizationId in either branch (and a future self-action
  // audit pass will want it too); avoiding a duplicate fetch also stops
  // future drift between the two branches.
  const { data: rec, error: recErr } = await serviceClient
    .from('playhub_match_recordings')
    .select('organization_id')
    .eq('id', recordingId)
    .maybeSingle()
  if (recErr) {
    return { ok: false as const, status: 500 as const }
  }
  const organizationId = rec?.organization_id ?? null

  const isCreator = existing.created_by === userId
  const isAdmin =
    !isCreator && organizationId
      ? await isVenueAdmin(userId, organizationId)
      : false

  if (!isCreator && !isAdmin) {
    return { ok: false as const, status: 403 as const }
  }

  return {
    ok: true as const,
    serviceClient,
    existing,
    isCreator,
    isAdmin,
    organizationId,
  }
}

// Map an auth-failure status to a stable error message. Centralised so
// PATCH/DELETE produce identical wording for identical conditions.
function authFailureMessage(
  status: 404 | 403 | 500,
  verb: 'edit' | 'delete'
): string {
  switch (status) {
    case 404:
      return 'Event not found'
    case 403:
      return `You do not have permission to ${verb} this event`
    case 500:
      return 'Internal error'
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; eventId: string }> }
) {
  const { id, eventId } = await params
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: 401 }
    )
  }

  const auth = await resolveEventAuth(id, eventId, user.id)
  if (!auth.ok) {
    return NextResponse.json(
      { error: authFailureMessage(auth.status, 'edit') },
      { status: auth.status }
    )
  }

  // Parse and validate body
  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Build update object with only allowed fields
  const update: Record<string, any> = {}

  if (body.event_type !== undefined) {
    if (!isValidEventType(body.event_type)) {
      return NextResponse.json({ error: 'Invalid event_type' }, { status: 400 })
    }
    update.event_type = body.event_type
  }

  if (body.timestamp_seconds !== undefined) {
    if (
      typeof body.timestamp_seconds !== 'number' ||
      body.timestamp_seconds < 0
    ) {
      return NextResponse.json(
        { error: 'timestamp_seconds must be a non-negative number' },
        { status: 400 }
      )
    }
    update.timestamp_seconds = body.timestamp_seconds
  }

  if (body.team !== undefined) {
    if (body.team !== null && !['home', 'away'].includes(body.team)) {
      return NextResponse.json(
        { error: 'team must be "home", "away", or null' },
        { status: 400 }
      )
    }
    update.team = body.team
  }

  if (body.label !== undefined) {
    // Tighten label: must be string (or null) and bounded length so it can't
    // bloat the audit-log JSONB or exfiltrate megabyte payloads. Matches the
    // shape we want to render in any future audit viewer too.
    if (body.label !== null && typeof body.label !== 'string') {
      return NextResponse.json(
        { error: 'label must be a string or null' },
        { status: 400 }
      )
    }
    if (typeof body.label === 'string' && body.label.length > 200) {
      return NextResponse.json(
        { error: 'label must be 200 characters or fewer' },
        { status: 400 }
      )
    }
    update.label = body.label
  }

  if (body.visibility !== undefined) {
    if (!['public', 'private'].includes(body.visibility)) {
      return NextResponse.json(
        { error: 'visibility must be "public" or "private"' },
        { status: 400 }
      )
    }
    // Mirror the POST route's silent-downgrade contract: only venue admins
    // and paying buyers can set visibility=public. Without this, a regular
    // creator could POST a private tag then PATCH it to public, bypassing
    // the publish gate. Admin path already qualifies via auth.isAdmin.
    let canPublish = auth.isAdmin
    if (!canPublish && body.visibility === 'public') {
      const { data: purchase } = await auth.serviceClient
        .from('playhub_purchases')
        .select('id')
        .eq('user_id', user.id)
        .eq('match_recording_id', id)
        .eq('status', 'completed')
        .maybeSingle()
      canPublish = !!purchase
    }
    update.visibility =
      body.visibility === 'public' && !canPublish ? 'private' : body.visibility
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  update.updated_at = new Date().toISOString()

  // Apply via service client when admin override; otherwise via service
  // client too (consistent path), with the same id+recording scoping that
  // DELETE uses for defence-in-depth against re-parenting races.
  const { data: event, error } = await auth.serviceClient
    .from('playhub_recording_events')
    .update(update)
    .eq('id', eventId)
    .eq('match_recording_id', id)
    .select('*')
    .single()

  if (error) {
    console.error('Failed to update event:', error)
    return NextResponse.json(
      { error: 'Failed to update event' },
      { status: 500 }
    )
  }

  // Audit-log admin-override edits so venue staff disagreements are
  // traceable. Self-edits are ordinary and skipped.
  if (!auth.isCreator && auth.isAdmin) {
    await recordAuditEvent(auth.serviceClient, {
      actorUserId: user.id,
      action: 'recording_event.update',
      targetType: 'recording_event',
      targetId: eventId,
      targetRecordingId: id,
      targetOrganizationId: auth.organizationId,
      wasAdminOverride: true,
      metadata: {
        prior: pickAuditFields(auth.existing),
        diff: update,
      },
    })
  }

  return NextResponse.json({ event })
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; eventId: string }> }
) {
  const { id, eventId } = await params
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: 401 }
    )
  }

  const auth = await resolveEventAuth(id, eventId, user.id)
  if (!auth.ok) {
    return NextResponse.json(
      { error: authFailureMessage(auth.status, 'delete') },
      { status: auth.status }
    )
  }

  // Delete via the service client (RLS only permits creator-self deletes).
  // Scope by both id AND match_recording_id so a row re-parented between
  // the existence check and the delete can't sneak through the auth gate.
  const { error } = await auth.serviceClient
    .from('playhub_recording_events')
    .delete()
    .eq('id', eventId)
    .eq('match_recording_id', id)

  if (error) {
    console.error('Failed to delete event:', error)
    return NextResponse.json(
      { error: 'Failed to delete event' },
      { status: 500 }
    )
  }

  // Audit-log admin-override deletes so a venue admin removing a parent's
  // private tag (or another staff member's tag) is traceable. Self-deletes
  // are ordinary and skipped.
  if (!auth.isCreator && auth.isAdmin) {
    await recordAuditEvent(auth.serviceClient, {
      actorUserId: user.id,
      action: 'recording_event.delete',
      targetType: 'recording_event',
      targetId: eventId,
      targetRecordingId: id,
      targetOrganizationId: auth.organizationId,
      wasAdminOverride: true,
      metadata: { prior: pickAuditFields(auth.existing) },
    })
  }

  return NextResponse.json({ success: true })
}

// Trim the event row down to the fields worth preserving in the audit log.
// We don't want the full DB row (could grow over time) — just enough to
// reconstruct what was deleted/changed for an admin investigation.
function pickAuditFields(event: Record<string, any>) {
  return {
    event_type: event.event_type,
    timestamp_seconds: event.timestamp_seconds,
    team: event.team ?? null,
    label: event.label ?? null,
    visibility: event.visibility,
    source: event.source,
    created_by: event.created_by,
    created_at: event.created_at,
  }
}
