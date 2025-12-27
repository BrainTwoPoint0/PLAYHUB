// GET /api/streaming/channels - List channels (filtered by venueId)
// POST /api/streaming/channels - Create a new channel

import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { mediaLiveClient } from '@/lib/aws/medialive'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { isVenueAdmin } from '@/lib/recordings/access-control'

export async function GET(request: NextRequest) {
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get venueId from query params
  const { searchParams } = new URL(request.url)
  const venueId = searchParams.get('venueId')

  // Check authorization
  const platformAdmin = await isPlatformAdmin(user.id)
  const venueAdmin = venueId ? await isVenueAdmin(user.id, venueId) : false

  if (!platformAdmin && !venueAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const channels = await mediaLiveClient.listChannels()

    // Filter by venueId if provided (check tags)
    const filteredChannels = venueId
      ? channels.filter((ch) => ch.Tags?.VenueId === venueId)
      : channels

    return NextResponse.json({
      channels: filteredChannels.map((ch) => ({
        id: ch.Id,
        name: ch.Name,
        state: ch.State,
        arn: ch.Arn,
        venueId: ch.Tags?.VenueId,
      })),
    })
  } catch (error: any) {
    console.error('Error listing channels:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to list channels' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { name, streamId, venueId } = body

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }

    if (!venueId) {
      return NextResponse.json({ error: 'venueId is required' }, { status: 400 })
    }

    // Check authorization - platform admin or venue admin
    const platformAdmin = await isPlatformAdmin(user.id)
    const venueAdmin = await isVenueAdmin(user.id, venueId)

    if (!platformAdmin && !venueAdmin) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Generate a streamId if not provided
    const finalStreamId =
      streamId || `${venueId.slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const channel = await mediaLiveClient.createChannel({
      name,
      streamId: finalStreamId,
      venueId,
    })

    return NextResponse.json({
      success: true,
      channel: {
        id: channel.id,
        name: channel.name,
        state: channel.state,
        inputId: channel.inputId,
        rtmp: channel.rtmpCredentials,
        playbackUrl: channel.playbackUrl,
        venueId,
      },
      message:
        'Channel created. Use /api/streaming/channels/[id]/start to begin streaming.',
    })
  } catch (error: any) {
    console.error('Error creating channel:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to create channel' },
      { status: 500 }
    )
  }
}
