// PATCH /api/venue/[venueId]/recordings/[recordingId]/pitch-focus
//
// Sets a recording's half-pitch focus (full | left_half | right_half) against
// the venue midline. Chosen at scheduling and changeable post-hoc — the raw
// panorama is preserved, so focus resolves at watch time from the scene's
// CURRENT active calibration (never snapshotted into view coordinates here).

import { NextRequest, NextResponse } from 'next/server'

import { isPlatformAdmin } from '@/lib/admin/auth'
import {
  PITCH_FOCUS_VALUES,
  hasMidline,
  type PitchFocus,
} from '@/lib/panorama/pitch-marks'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { createServiceClient, getAuthUserStrict } from '@/lib/supabase/server'

type RouteContext = {
  params: Promise<{ venueId: string; recordingId: string }>
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const { venueId, recordingId } = await params
  const { user } = await getAuthUserStrict()
  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'unauthorized' },
      { status: 401 }
    )
  }
  const [isAdmin, isPlatform] = await Promise.all([
    isVenueAdmin(user.id, venueId),
    isPlatformAdmin(user.id),
  ])
  if (!isAdmin && !isPlatform) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'forbidden' },
      { status: 403 }
    )
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body', code: 'bad_request' },
      { status: 400 }
    )
  }
  const focus = body.pitchFocus as PitchFocus
  if (!PITCH_FOCUS_VALUES.includes(focus)) {
    return NextResponse.json(
      {
        error: `pitchFocus must be one of ${PITCH_FOCUS_VALUES.join(', ')}`,
        code: 'bad_request',
      },
      { status: 400 }
    )
  }

  const serviceClient = createServiceClient() as any

  const { data: recording } = await serviceClient
    .from('playhub_match_recordings')
    .select('id, venue_organization_id, spiideo_scene_id')
    .eq('id', recordingId)
    .maybeSingle()
  if (!recording || recording.venue_organization_id !== venueId) {
    return NextResponse.json(
      { error: 'Recording not found for this venue', code: 'not_found' },
      { status: 404 }
    )
  }

  // Half focus needs a midline to resolve against: require an active
  // calibration on the recording's scene carrying both midline marks.
  // v1 asymmetry (deliberate): the scene is resolved via spiideo_scene_id
  // only, so half-focus is a FOOTBALL/Spiideo feature — Clutch (padel)
  // recordings 409 no_scene, which is correct: padel courts have no
  // half-pitch training split. Calibrations themselves still support
  // provider='clutch' for boundary/gating uses.
  if (focus !== 'full') {
    if (!recording.spiideo_scene_id) {
      return NextResponse.json(
        {
          error: 'Recording has no camera scene; half-pitch focus unavailable',
          code: 'no_scene',
        },
        { status: 409 }
      )
    }
    const { data: calib } = await serviceClient
      .from('playhub_pitch_calibrations')
      .select('marks')
      .eq('scene_id', recording.spiideo_scene_id)
      .eq('status', 'active')
      .maybeSingle()
    if (!calib || !hasMidline(calib.marks ?? [])) {
      return NextResponse.json(
        {
          error:
            'Scene has no active calibration with midline marks; calibrate the pitch (including the midline) first',
          code: 'no_midline_calibration',
        },
        { status: 409 }
      )
    }
  }

  // Curated columns, mirroring the venue recordings list — never `*`: the
  // full row carries internal ops fields (pipeline statuses/errors, S3 keys)
  // that don't belong in a venue-admin response.
  const { data, error } = await serviceClient
    .from('playhub_match_recordings')
    .update({ pitch_focus: focus })
    .eq('id', recordingId)
    .eq('venue_organization_id', venueId)
    .select(
      'id, title, status, spiideo_scene_id, pitch_focus, home_team, away_team, match_date'
    )
    .single()

  if (error) {
    console.error('Failed to update pitch focus:', error)
    return NextResponse.json(
      { error: 'Failed to update pitch focus', code: 'internal' },
      { status: 500 }
    )
  }

  return NextResponse.json({ recording: data })
}
