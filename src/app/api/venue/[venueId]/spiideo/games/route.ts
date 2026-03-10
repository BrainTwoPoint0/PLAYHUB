// POST /api/venue/[venueId]/spiideo/games - Schedule a new recording in Spiideo

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { scheduleRecording } from '@/lib/spiideo/schedule-recording'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ venueId: string }> }
) {
  const { venueId } = await params
  const { user } = await getAuthUser()

  if (!user) {
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
    graphicPackageId,
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

  // Determine if user is a tenant (schedules at venue via organization_venue_access)
  // Check if user is a direct member or parent admin of this venue
  let ownerOrgId: string | undefined
  let tenantGraphicPackageId: string | undefined

  const { data: userProfile } = await serviceClient
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .single()

  if (userProfile) {
    // Check direct membership on this venue
    const { data: directMembership } = await serviceClient
      .from('organization_members')
      .select('id')
      .eq('profile_id', userProfile.id)
      .eq('organization_id', venueId)
      .eq('is_active', true)
      .maybeSingle()

    if (!directMembership) {
      // Not a direct member — check if parent org admin or tenant
      const { data: venueOrg } = await (serviceClient as any)
        .from('organizations')
        .select('parent_organization_id')
        .eq('id', venueId)
        .single()

      let isParentAdmin = false
      if (venueOrg?.parent_organization_id) {
        const { data: parentMembership } = await serviceClient
          .from('organization_members')
          .select('id')
          .eq('profile_id', userProfile.id)
          .eq('organization_id', venueOrg.parent_organization_id)
          .eq('is_active', true)
          .maybeSingle()
        isParentAdmin = !!parentMembership
      }

      if (!isParentAdmin) {
        // User must be a tenant — find their org via organization_venue_access
        const { data: userOrgs } = await serviceClient
          .from('organization_members')
          .select('organization_id')
          .eq('profile_id', userProfile.id)
          .in('role', ['admin', 'club_admin', 'league_admin'])
          .eq('is_active', true)

        if (userOrgs && userOrgs.length > 0) {
          const userOrgIds = userOrgs.map((o: any) => o.organization_id)
          const { data: venueAccess } = await (serviceClient as any)
            .from('organization_venue_access')
            .select('organization_id, default_graphic_package_id, can_record')
            .eq('venue_organization_id', venueId)
            .in('organization_id', userOrgIds)
            .eq('is_active', true)
            .eq('can_record', true)
            .maybeSingle()

          if (venueAccess) {
            ownerOrgId = venueAccess.organization_id
            tenantGraphicPackageId = venueAccess.default_graphic_package_id
          }
        }
      }
    }
  }

  // Auto-resolve graphic package: tenant default > explicit > venue default
  let resolvedGraphicPackageId = graphicPackageId
  if (!resolvedGraphicPackageId && tenantGraphicPackageId) {
    resolvedGraphicPackageId = tenantGraphicPackageId
  }
  if (!resolvedGraphicPackageId) {
    const { data: defaultPkg } = await (serviceClient as any)
      .from('playhub_graphic_packages')
      .select('id')
      .eq('organization_id', ownerOrgId || venueId)
      .eq('is_default', true)
      .maybeSingle()
    if (defaultPkg) resolvedGraphicPackageId = defaultPkg.id
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
      collectedBy: ownerOrgId ? 'venue' : 'venue',
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
      graphicPackageId: resolvedGraphicPackageId,
      ownerOrgId,
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
