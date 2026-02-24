// PATCH + DELETE /api/recordings/[id]/events/[eventId]
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { isValidEventType } from '@/lib/recordings/event-types'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; eventId: string }> }
) {
  const { id, eventId } = await params
  const supabase = await createClient()

  // Get current user
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: 401 }
    )
  }

  // Verify the event exists and belongs to the user
  const { data: existing, error: fetchError } = await (supabase as any)
    .from('playhub_recording_events')
    .select('id, created_by, match_recording_id')
    .eq('id', eventId)
    .eq('match_recording_id', id)
    .single()

  if (fetchError || !existing) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }

  if (existing.created_by !== user.id) {
    return NextResponse.json(
      { error: 'You can only edit your own events' },
      { status: 403 }
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
    update.label = body.label
  }

  if (body.visibility !== undefined) {
    if (!['public', 'private'].includes(body.visibility)) {
      return NextResponse.json(
        { error: 'visibility must be "public" or "private"' },
        { status: 400 }
      )
    }
    update.visibility = body.visibility
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  update.updated_at = new Date().toISOString()

  // Update the event
  const { data: event, error } = await (supabase as any)
    .from('playhub_recording_events')
    .update(update)
    .eq('id', eventId)
    .select('*')
    .single()

  if (error) {
    console.error('Failed to update event:', error)
    return NextResponse.json(
      { error: 'Failed to update event' },
      { status: 500 }
    )
  }

  return NextResponse.json({ event })
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; eventId: string }> }
) {
  const { id, eventId } = await params
  const supabase = await createClient()

  // Get current user
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: 401 }
    )
  }

  // Verify the event exists and belongs to the user
  const { data: existing, error: fetchError } = await (supabase as any)
    .from('playhub_recording_events')
    .select('id, created_by, match_recording_id')
    .eq('id', eventId)
    .eq('match_recording_id', id)
    .single()

  if (fetchError || !existing) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }

  if (existing.created_by !== user.id) {
    return NextResponse.json(
      { error: 'You can only delete your own events' },
      { status: 403 }
    )
  }

  // Delete the event
  const { error } = await (supabase as any)
    .from('playhub_recording_events')
    .delete()
    .eq('id', eventId)

  if (error) {
    console.error('Failed to delete event:', error)
    return NextResponse.json(
      { error: 'Failed to delete event' },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true })
}
