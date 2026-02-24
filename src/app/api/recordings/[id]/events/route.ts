// GET + POST /api/recordings/[id]/events
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { checkRecordingAccess } from '@/lib/recordings/access-control'
import { isValidEventType } from '@/lib/recordings/event-types'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
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

  // Check access to the recording
  const accessResult = await checkRecordingAccess(id, user.id)
  if (!accessResult.hasAccess) {
    return NextResponse.json({ error: accessResult.reason }, { status: 403 })
  }

  // Fetch events: public events + user's own private events
  // RLS handles this automatically since the policy is:
  //   visibility = 'public' OR created_by = auth.uid()
  const { data: events, error } = await supabase
    .from('playhub_recording_events' as any)
    .select('*')
    .eq('match_recording_id', id)
    .order('timestamp_seconds', { ascending: true })

  if (error) {
    console.error('Failed to fetch events:', error)
    return NextResponse.json(
      { error: 'Failed to fetch events' },
      { status: 500 }
    )
  }

  return NextResponse.json({ events: events || [] })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
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

  // Check access to the recording
  const accessResult = await checkRecordingAccess(id, user.id)
  if (!accessResult.hasAccess) {
    return NextResponse.json({ error: accessResult.reason }, { status: 403 })
  }

  // Parse and validate body
  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { event_type, timestamp_seconds, team, label, visibility } = body

  // Validate required fields
  if (
    !event_type ||
    timestamp_seconds === undefined ||
    timestamp_seconds === null
  ) {
    return NextResponse.json(
      { error: 'event_type and timestamp_seconds are required' },
      { status: 400 }
    )
  }

  if (!isValidEventType(event_type)) {
    return NextResponse.json({ error: 'Invalid event_type' }, { status: 400 })
  }

  if (typeof timestamp_seconds !== 'number' || timestamp_seconds < 0) {
    return NextResponse.json(
      { error: 'timestamp_seconds must be a non-negative number' },
      { status: 400 }
    )
  }

  if (team && !['home', 'away'].includes(team)) {
    return NextResponse.json(
      { error: 'team must be "home" or "away"' },
      { status: 400 }
    )
  }

  if (visibility && !['public', 'private'].includes(visibility)) {
    return NextResponse.json(
      { error: 'visibility must be "public" or "private"' },
      { status: 400 }
    )
  }

  // Insert the event
  const { data: event, error } = await (supabase as any)
    .from('playhub_recording_events')
    .insert({
      match_recording_id: id,
      event_type,
      timestamp_seconds,
      team: team || null,
      label: label || null,
      visibility: visibility || 'public',
      source: 'manual',
      created_by: user.id,
    })
    .select('*')
    .single()

  if (error) {
    console.error('Failed to create event:', error)
    return NextResponse.json(
      { error: 'Failed to create event' },
      { status: 500 }
    )
  }

  return NextResponse.json({ event }, { status: 201 })
}
