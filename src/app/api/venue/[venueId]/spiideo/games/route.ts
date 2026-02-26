// POST /api/venue/[venueId]/spiideo/games - Schedule a new recording in Spiideo

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import {
  createGame,
  createProduction,
  getAccountConfig,
} from '@/lib/spiideo/client'

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
    accessEmails, // Array of emails to grant access
    isBillable,
    billableAmount,
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
    const config = getAccountConfig('kuwait')
    const game = await createGame({
      accountId: config.accountId!,
      title,
      description: description || '',
      sceneId,
      scheduledStartTime,
      scheduledStopTime,
      sport: sport || 'football',
    })

    // 2. Create live production
    const production = await createProduction(game.id, {
      productionType: 'single_game',
      type: 'live',
    })

    // 3. Look up billing config for billable defaults
    const { data: billingConfig } = await (serviceClient as any)
      .from('playhub_venue_billing_config')
      .select('default_billable_amount, currency')
      .eq('organization_id', venueId)
      .maybeSingle()

    // 4. Create recording entry in Supabase (placeholder with status='scheduled')
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
        is_billable: isBillable ?? true,
        billable_amount:
          billableAmount ?? billingConfig?.default_billable_amount ?? null,
        billable_currency: billingConfig?.currency ?? 'KWD',
        collected_by: 'venue',
      })
      .select('id')
      .single()

    if (recordingError) {
      console.error('Failed to create recording entry:', recordingError)
      // Don't fail - game is already scheduled in Spiideo
    }

    // 5. Grant access to emails if provided
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
