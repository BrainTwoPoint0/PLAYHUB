// POST /api/streaming/channels/[channelId]/start - Start a channel

import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { mediaLiveClient } from '@/lib/aws/medialive'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { DescribeChannelCommand, MediaLiveClient } from '@aws-sdk/client-medialive'

// Helper to get channel's venueId from AWS tags
async function getChannelVenueId(channelId: string): Promise<string | null> {
  const client = new MediaLiveClient({
    region: process.env.PLAYHUB_AWS_REGION || 'eu-west-2',
    credentials: {
      accessKeyId: process.env.PLAYHUB_AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.PLAYHUB_AWS_SECRET_ACCESS_KEY!,
    },
  })

  try {
    const response = await client.send(
      new DescribeChannelCommand({ ChannelId: channelId })
    )
    return response.Tags?.VenueId || null
  } catch {
    return null
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const { channelId } = await params
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Check authorization - platform admin or venue admin for this channel
  const platformAdmin = await isPlatformAdmin(user.id)
  if (!platformAdmin) {
    const venueId = await getChannelVenueId(channelId)
    if (!venueId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const venueAdmin = await isVenueAdmin(user.id, venueId)
    if (!venueAdmin) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  try {
    // Get channel first to verify it exists and check state
    const channel = await mediaLiveClient.getChannel(channelId)

    if (channel.state === 'RUNNING') {
      return NextResponse.json({
        success: true,
        message: 'Channel is already running',
        channel: {
          id: channel.id,
          name: channel.name,
          state: channel.state,
        },
      })
    }

    if (channel.state !== 'IDLE') {
      return NextResponse.json(
        {
          error: `Cannot start channel in state: ${channel.state}. Channel must be IDLE.`,
        },
        { status: 400 }
      )
    }

    await mediaLiveClient.startChannel(channelId)

    return NextResponse.json({
      success: true,
      message:
        'Channel starting. It may take 1-2 minutes to become fully operational.',
      channel: {
        id: channel.id,
        name: channel.name,
        state: 'STARTING',
        rtmp: channel.rtmpCredentials,
        playbackUrl: channel.playbackUrl,
      },
    })
  } catch (error: any) {
    console.error('Error starting channel:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to start channel' },
      { status: 500 }
    )
  }
}
