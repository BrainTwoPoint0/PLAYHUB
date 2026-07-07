// POST /api/venue/[venueId]/spiideo/games - Schedule a new recording
// (Spiideo or Clutch, resolved per camera mapping; URL keeps its historical name)

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { scheduleRecording } from '@/lib/spiideo/schedule-recording'
import { scheduleClutchRecording } from '@/lib/clutch/schedule-recording'
import { ClutchConflictError } from '@/lib/clutch/client'

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

  // Billing inputs land verbatim in invoicing data — reject anything that
  // isn't a real boolean / non-negative number instead of coercing.
  if (isBillable != null && typeof isBillable !== 'boolean') {
    return NextResponse.json(
      { error: 'isBillable must be a boolean' },
      { status: 400 }
    )
  }
  if (
    billableAmount != null &&
    (typeof billableAmount !== 'number' ||
      !Number.isFinite(billableAmount) ||
      billableAmount < 0)
  ) {
    return NextResponse.json(
      { error: 'billableAmount must be a non-negative number' },
      { status: 400 }
    )
  }

  const serviceClient = createServiceClient()

  // Verify scene is mapped to this venue and resolve which provider owns
  // the camera. Cameras live in a SHARED Spiideo account, so scheduling on
  // an unmapped scene is a cross-tenant action — only platform admins may
  // do it (initial venue setup), and the fallback is Spiideo-only: Clutch
  // devices must always be explicitly mapped.
  const { data: mappings } = await (serviceClient as any)
    .from('playhub_scene_venue_mapping')
    .select('scene_id, provider')
    .eq('organization_id', venueId)

  let provider: 'spiideo' | 'clutch' = 'spiideo'
  const mapping = (mappings || []).find((m: any) => m.scene_id === sceneId)
  if (mapping) {
    provider = mapping.provider === 'clutch' ? 'clutch' : 'spiideo'
  } else {
    const allowUnmapped =
      (mappings || []).length === 0 && (await isPlatformAdmin(user.id))
    if (!allowUnmapped) {
      return NextResponse.json(
        { error: 'Scene not mapped to this venue' },
        { status: 403 }
      )
    }
  }

  // Calculate duration from start/stop for the helper.
  // Validate timestamps parse cleanly, the window is positive, and the cap
  // (4 hours) blocks accidental admin entries from invoicing thousands of hours.
  const startMs = new Date(scheduledStartTime).getTime()
  const stopMs = new Date(scheduledStopTime).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(stopMs)) {
    return NextResponse.json(
      {
        error:
          'scheduledStartTime and scheduledStopTime must be valid ISO 8601 timestamps',
      },
      { status: 400 }
    )
  }
  const durationMinutes = Math.round((stopMs - startMs) / 60_000)
  const MAX_DURATION_MINUTES = 240
  if (durationMinutes <= 0 || durationMinutes > MAX_DURATION_MINUTES) {
    return NextResponse.json(
      {
        error: `Recording duration must be between 1 and ${MAX_DURATION_MINUTES} minutes (got ${durationMinutes}).`,
      },
      { status: 400 }
    )
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
          .in('role', ['admin', 'manager', 'club_admin', 'league_admin'])
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
    const sharedInput = {
      venueId,
      sceneName: pitchName || 'Pitch',
      durationMinutes,
      title,
      description: description || '',
      createdBy: user.id,
      // Admin-scheduled recordings are always venue-collected. The QR/Stripe
      // self-service flow (`/api/start/[cameraId]`) is the only path that
      // sets collected_by = 'playhub'.
      collectedBy: 'venue' as const,
      // Tenants (ownerOrgId set — scheduling via organization_venue_access)
      // don't control billing: the recording is always billable and priced
      // from the venue's billing config (billableAmount undefined → the
      // venue's hourly rate scaled by duration). Only the venue's own
      // admins may mark a session comp or override the amount.
      isBillable: ownerOrgId ? true : (isBillable ?? true),
      billableAmount: ownerOrgId ? undefined : billableAmount,
      accessEmails,
      homeTeam,
      awayTeam,
      startBufferMs: 0,
      scheduledStartTime,
      scheduledStopTime,
      marketplaceEnabled,
      priceAmount: priceAmount ? Number(priceAmount) : undefined,
      priceCurrency,
      ownerOrgId,
    }

    if (provider === 'clutch') {
      // Clutch Cams are padel-only; graphic packages are a Spiideo concept.
      const result = await scheduleClutchRecording({
        ...sharedInput,
        sceneId,
        sport: 'padel',
      })

      return NextResponse.json({
        success: true,
        videoId: result.videoId,
        recordingId: result.recordingId,
        message: 'Recording scheduled successfully',
      })
    }

    const result = await scheduleRecording({
      ...sharedInput,
      sceneId,
      sport,
      graphicPackageId: resolvedGraphicPackageId,
    })

    return NextResponse.json({
      success: true,
      gameId: result.gameId,
      productionId: result.productionId,
      recordingId: result.recordingId,
      message: 'Recording scheduled successfully',
    })
  } catch (error) {
    if (error instanceof ClutchConflictError) {
      // conflictingIds may belong to bookings made directly in the Clutch
      // app by other parties — log them for staff, never return them.
      console.warn(
        `Clutch schedule conflict for venue ${venueId}:`,
        error.conflictingIds
      )
      return NextResponse.json(
        {
          error:
            'Time slot conflicts with an existing recording on this camera (it may have been booked directly in the Clutch app)',
          code: 'SCHEDULE_CONFLICT',
        },
        { status: 409 }
      )
    }
    // Provider/DB error internals stay in server logs only.
    console.error('Failed to schedule recording:', error)
    return NextResponse.json(
      { error: 'Failed to schedule recording' },
      { status: 500 }
    )
  }
}
