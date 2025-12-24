// GET /api/venue/[venueId]/recordings - List recordings for a venue

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ venueId: string }> }
) {
  const { venueId } = await params
  const supabase = await createClient()

  // Get current user
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Check if user is admin for this venue
  const isAdmin = await isVenueAdmin(user.id, venueId)
  if (!isAdmin) {
    return NextResponse.json(
      { error: 'Not authorized for this venue' },
      { status: 403 }
    )
  }

  // Use service client for data queries to bypass RLS
  const serviceClient = createServiceClient()

  // Get recordings for this venue
  const { data: recordings, error } = await (serviceClient as any)
    .from('playhub_match_recordings')
    .select(
      `
      id,
      title,
      description,
      match_date,
      home_team,
      away_team,
      venue,
      pitch_name,
      status,
      s3_key,
      file_size_bytes,
      transferred_at,
      spiideo_game_id,
      created_at
    `
    )
    .eq('organization_id', venueId)
    .order('match_date', { ascending: false })

  if (error) {
    console.error('Failed to fetch recordings:', error)
    return NextResponse.json(
      { error: 'Failed to fetch recordings' },
      { status: 500 }
    )
  }

  // Get access counts for each recording
  const recordingIds = recordings?.map((r: any) => r.id) || []
  let accessCounts: Record<string, number> = {}

  if (recordingIds.length > 0) {
    const { data: accessData } = await (serviceClient as any)
      .from('playhub_access_rights')
      .select('match_recording_id')
      .in('match_recording_id', recordingIds)
      .eq('is_active', true)

    if (accessData) {
      accessData.forEach((a: any) => {
        accessCounts[a.match_recording_id] =
          (accessCounts[a.match_recording_id] || 0) + 1
      })
    }
  }

  // Enrich recordings with access count
  const enrichedRecordings = (recordings || []).map((r: any) => ({
    ...r,
    accessCount: accessCounts[r.id] || 0,
  }))

  return NextResponse.json({ recordings: enrichedRecordings })
}
