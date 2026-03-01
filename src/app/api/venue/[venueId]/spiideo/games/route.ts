// POST /api/venue/[venueId]/spiideo/games - Schedule a new recording in Spiideo

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { scheduleRecording } from '@/lib/spiideo/schedule-recording'

export async function POST(
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

  const body = await request.json()
  const {
    title,
    description,
    sceneId,
    scheduledStartTime,
    scheduledStopTime,
    sport,
    homeTeam,
    awayTeam,
    pitchName,
    accessEmails,
    isBillable,
    billableAmount,
    broadcastToYoutube,
    marketplaceEnabled,
    priceAmount,
    priceCurrency,
  } = body

  // Validate required fields
  if (!title || !sceneId || !scheduledStartTime || !scheduledStopTime) {
    return NextResponse.json(
      {
        error:
          'Missing required fields: title, sceneId, scheduledStartTime, scheduledStopTime',
      },
      { status: 400 }
    )
  }

  const serviceClient = createServiceClient()

  // Verify scene is mapped to this venue (or allow if no mappings exist)
  const { data: mappings } = await (serviceClient as any)
    .from('playhub_scene_venue_mapping')
    .select('scene_id')
    .eq('organization_id', venueId)

  if (mappings && mappings.length > 0) {
    const mappedSceneIds = mappings.map((m: any) => m.scene_id)
    if (!mappedSceneIds.includes(sceneId)) {
      return NextResponse.json(
        { error: 'Scene not mapped to this venue' },
        { status: 403 }
      )
    }
  }

  // Calculate duration from start/stop for the helper
  const startMs = new Date(scheduledStartTime).getTime()
  const stopMs = new Date(scheduledStopTime).getTime()
  const durationMinutes = Math.round((stopMs - startMs) / 60_000)

  // Look up YouTube RTMP URL if broadcasting requested
  let youtubeRtmpUrl: string | undefined
  if (broadcastToYoutube) {
    const { data: billingCfg } = await (serviceClient as any)
      .from('playhub_venue_billing_config')
      .select('youtube_rtmp_url, youtube_stream_key')
      .eq('organization_id', venueId)
      .maybeSingle()

    if (billingCfg?.youtube_rtmp_url && billingCfg?.youtube_stream_key) {
      const base = billingCfg.youtube_rtmp_url.replace(/\/$/, '')
      youtubeRtmpUrl = `${base}/${billingCfg.youtube_stream_key}`
    }
  }

  try {
    const result = await scheduleRecording({
      venueId,
      sceneId,
      sceneName: pitchName || 'Pitch',
      durationMinutes,
      title,
      description: description || '',
      createdBy: user.id,
      collectedBy: 'venue',
      isBillable: isBillable ?? true,
      billableAmount,
      accessEmails,
      sport,
      homeTeam,
      awayTeam,
      startBufferMs: 0,
      scheduledStartTime,
      scheduledStopTime,
      youtubeRtmpUrl,
      marketplaceEnabled,
      priceAmount: priceAmount ? Number(priceAmount) : undefined,
      priceCurrency,
    })

    return NextResponse.json({
      success: true,
      gameId: result.gameId,
      productionId: result.productionId,
      recordingId: result.recordingId,
      message: 'Recording scheduled successfully',
    })
  } catch (error) {
    console.error('Failed to schedule recording:', error)
    return NextResponse.json(
      {
        error: 'Failed to schedule recording',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    )
  }
}
