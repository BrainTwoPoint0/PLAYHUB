// POST /api/streaming/spiideo/connect - Create Spiideo game + MediaLive channel in one step
// Can either connect to existing game (gameId) OR create new game (with schedule details)

import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import {
  setActiveAccount,
  getGame,
  createGame,
  setupLiveBroadcast,
  getAccountConfig,
  type SpiideoSport,
} from '@/lib/spiideo/client'
import { mediaLiveClient } from '@/lib/aws/medialive'

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  // Get current user
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { venueId } = body

  if (!venueId) {
    return NextResponse.json({ error: 'venueId is required' }, { status: 400 })
  }

  // Check if user is admin for this venue
  const isAdmin = await isVenueAdmin(user.id, venueId)
  if (!isAdmin) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  try {
    // Use Kuwait account (Spiideo Play - has RTMP access)
    setActiveAccount('kuwait')
    const config = getAccountConfig('kuwait')

    let gameId: string
    let gameTitle: string

    // Option 1: Connect to existing game
    if (body.gameId) {
      const game = await getGame(body.gameId)
      if (!game) {
        return NextResponse.json({ error: 'Spiideo game not found' }, { status: 404 })
      }
      gameId = game.id
      gameTitle = game.title
    }
    // Option 2: Create new game with schedule details
    else if (body.title && body.sceneId && body.scheduledStartTime && body.scheduledStopTime) {
      const newGame = await createGame({
        accountId: config.accountId!,
        title: body.title,
        description: body.description || '',
        sport: (body.sport as SpiideoSport) || 'football',
        sceneId: body.sceneId,
        scheduledStartTime: body.scheduledStartTime,
        scheduledStopTime: body.scheduledStopTime,
        homeTeamId: body.homeTeamId,
        awayTeamId: body.awayTeamId,
      })
      gameId = newGame.id
      gameTitle = newGame.title
    } else {
      return NextResponse.json(
        { error: 'Either gameId OR (title, sceneId, scheduledStartTime, scheduledStopTime) required' },
        { status: 400 }
      )
    }

    // Create MediaLive channel
    const channelName = body.channelName || `${gameTitle}-${Date.now()}`
    const streamId = `spiideo-${gameId}-${Date.now()}`

    const channel = await mediaLiveClient.createChannel({
      name: channelName,
      streamId,
      venueId,
    })

    if (!channel.rtmpCredentials) {
      return NextResponse.json(
        { error: 'Failed to get RTMP credentials from new channel' },
        { status: 500 }
      )
    }

    const rtmpUrl = channel.rtmpCredentials.fullUrl

    // Create Spiideo production with push_stream output to our RTMP endpoint
    const { production, output } = await setupLiveBroadcast(gameId, rtmpUrl, {
      productionRecipeId: config.recipeId,
      title: `PLAYHUB Live - ${gameTitle}`,
    })

    // Wait for channel to be ready then start it
    if (channel.state === 'CREATING') {
      // Wait for channel to transition to IDLE
      let attempts = 0
      while (attempts < 30) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        try {
          const updatedChannel = await mediaLiveClient.getChannel(channel.id)
          if (updatedChannel.state === 'IDLE') {
            break
          }
        } catch {
          // Ignore errors during polling
        }
        attempts++
      }
    }

    // Auto-start the channel
    try {
      await mediaLiveClient.startChannel(channel.id)
    } catch (startErr) {
      console.error('Failed to auto-start channel:', startErr)
      // Continue anyway - user can start manually
    }

    return NextResponse.json({
      success: true,
      channel: {
        id: channel.id,
        name: channel.name,
        state: 'STARTING',
        rtmpUrl: channel.rtmpCredentials?.fullUrl,
        playbackUrl: channel.playbackUrl,
      },
      spiideo: {
        gameId,
        gameTitle,
        productionId: production.id,
        outputId: output.id,
        outputUri: output.uri,
      },
    })
  } catch (error) {
    console.error('Error setting up live stream:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to set up live stream' },
      { status: 500 }
    )
  }
}
