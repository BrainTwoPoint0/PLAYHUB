// POST /api/venue/[venueId]/spiideo/games - Schedule a new recording in Spiideo

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'

const SPIIDEO_API_BASE = 'https://api-public.spiideo.com'
const SPIIDEO_TOKEN_URL = 'https://auth-play.spiideo.net/oauth2/token'

// Shared Spiideo account credentials from environment (Kuwait)
const SPIIDEO_CLIENT_ID = process.env.SPIIDEO_KUWAIT_CLIENT_ID!
const SPIIDEO_CLIENT_SECRET = process.env.SPIIDEO_KUWAIT_CLIENT_SECRET!
const SPIIDEO_ACCOUNT_ID = process.env.SPIIDEO_KUWAIT_ACCOUNT_ID!
const SPIIDEO_USER_ID = process.env.SPIIDEO_PLAYBACK_ADMIN_USER_ID!

async function getAccessToken(): Promise<string> {
  const basicAuth = Buffer.from(
    `${SPIIDEO_CLIENT_ID}:${SPIIDEO_CLIENT_SECRET}`
  ).toString('base64')

  const response = await fetch(SPIIDEO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
    }),
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error(`Failed to get Spiideo token: ${response.status}`)
  }

  const data = await response.json()
  return data.access_token
}

async function createSpiideoGame(gameData: {
  title: string
  description?: string
  sceneId: string
  scheduledStartTime: string
  scheduledStopTime: string
  sport?: string
}) {
  const token = await getAccessToken()

  const body = {
    accountId: SPIIDEO_ACCOUNT_ID,
    title: gameData.title,
    description: gameData.description || '',
    sceneId: gameData.sceneId,
    scheduledStartTime: gameData.scheduledStartTime,
    scheduledStopTime: gameData.scheduledStopTime,
    sport: gameData.sport || 'football',
  }

  const response = await fetch(`${SPIIDEO_API_BASE}/v1/games`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Spiideo-Api-User': SPIIDEO_USER_ID,
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Spiideo API error: ${response.status} - ${errorText}`)
  }

  return response.json()
}

async function createSpiideoProduction(gameId: string, recipeId?: string) {
  const token = await getAccessToken()

  const body: any = {
    productionType: 'single_game',
    type: 'live',
  }

  if (recipeId) {
    body.productionRecipeId = recipeId
  }

  const response = await fetch(
    `${SPIIDEO_API_BASE}/v1/games/${gameId}/productions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Spiideo-Api-User': SPIIDEO_USER_ID,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    }
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Spiideo production error: ${response.status} - ${errorText}`
    )
  }

  return response.json()
}

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

  // Check if Spiideo is configured
  if (!SPIIDEO_CLIENT_ID || !SPIIDEO_CLIENT_SECRET || !SPIIDEO_ACCOUNT_ID) {
    return NextResponse.json(
      { error: 'Spiideo not configured' },
      { status: 404 }
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
    accessEmails, // Array of emails to grant access
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

  try {
    // 1. Create game in Spiideo
    const game = await createSpiideoGame({
      title,
      description,
      sceneId,
      scheduledStartTime,
      scheduledStopTime,
      sport,
    })

    // 2. Create live production
    const production = await createSpiideoProduction(game.id)

    // 3. Create recording entry in Supabase (placeholder with status='scheduled')
    const { data: recording, error: recordingError } = await (
      serviceClient as any
    )
      .from('playhub_match_recordings')
      .insert({
        organization_id: venueId,
        spiideo_game_id: game.id,
        spiideo_production_id: production.id,
        title,
        description,
        match_date: scheduledStartTime,
        home_team: homeTeam || 'Home',
        away_team: awayTeam || 'Away',
        pitch_name: pitchName || null,
        status: 'scheduled',
        access_type: 'private_link',
        created_by: user.id,
      })
      .select('id')
      .single()

    if (recordingError) {
      console.error('Failed to create recording entry:', recordingError)
      // Don't fail - game is already scheduled in Spiideo
    }

    // 4. Grant access to emails if provided
    if (accessEmails && accessEmails.length > 0 && recording?.id) {
      const accessInserts = accessEmails.map((email: string) => ({
        match_recording_id: recording.id,
        invited_email: email.toLowerCase().trim(),
        granted_by: user.id,
        granted_at: new Date().toISOString(),
        is_active: true,
      }))

      await (serviceClient as any)
        .from('playhub_access_rights')
        .insert(accessInserts)
    }

    return NextResponse.json({
      success: true,
      gameId: game.id,
      productionId: production.id,
      recordingId: recording?.id,
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
