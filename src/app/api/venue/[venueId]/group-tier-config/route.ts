// GET/PUT /api/venue/[venueId]/group-tier-config
// Admin-set deployed-camera counts for a GROUP org. Presence of a row marks the
// group as revenue-tiered (Li3ib annex): its footage share is computed as 15%/5%
// of gross by monthly utilisation per deployed camera. Platform admin only —
// camera counts directly move money.

import {
  getAuthUser,
  getAuthUserStrict,
  createServiceClient,
} from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { isPlatformAdmin } from '@/lib/admin/auth'

// Sanity ceiling for a per-sport deployed-camera count. Guards against a typo
// that would drive utilisation-per-camera toward zero and silently force the
// low tier (underpaying the partner), or overflow int4.
const MAX_CAMERA_COUNT = 10000

type RouteContext = { params: Promise<{ venueId: string }> }

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { venueId } = await params
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Group admins may read their own camera counts (matches the RLS read policy
  // and the sibling billing route); only platform admins may write them.
  const [isAdmin, isPlatform] = await Promise.all([
    isVenueAdmin(user.id, venueId),
    isPlatformAdmin(user.id),
  ])
  if (!isAdmin && !isPlatform) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const serviceClient = createServiceClient() as any

  const { data, error } = await serviceClient
    .from('playhub_group_tier_config')
    .select('*')
    .eq('group_organization_id', venueId)
    .maybeSingle()

  if (error) {
    console.error('Failed to fetch group tier config:', error)
    return NextResponse.json(
      { error: 'Failed to fetch group tier config' },
      { status: 500 }
    )
  }

  return NextResponse.json({
    config: data || {
      group_organization_id: venueId,
      football_camera_count: 0,
      padel_camera_count: 0,
    },
    exists: !!data,
  })
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const { venueId } = await params
  // Strict auth: this write moves money (camera counts set the revenue split),
  // so a revoked/rotated session must be rejected immediately, not trusted to TTL.
  const { user } = await getAuthUserStrict()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!(await isPlatformAdmin(user.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // This is a full replace: both counts must be sent explicitly, so a partial
  // request can't silently zero the omitted sport (a 0/0-or-zeroed row marks the
  // group tiered but then throws at invoice time for any sport with revenue).
  if (
    body.football_camera_count === undefined ||
    body.padel_camera_count === undefined
  ) {
    return NextResponse.json(
      {
        error:
          'Both football_camera_count and padel_camera_count are required',
      },
      { status: 400 }
    )
  }

  const football = Number(body.football_camera_count)
  const padel = Number(body.padel_camera_count)
  const valid = (n: number) =>
    Number.isSafeInteger(n) && n >= 0 && n <= MAX_CAMERA_COUNT
  if (!valid(football) || !valid(padel)) {
    return NextResponse.json(
      {
        error: `Camera counts must be integers between 0 and ${MAX_CAMERA_COUNT}`,
      },
      { status: 400 }
    )
  }
  // A tiered group with zero cameras of either sport is meaningless — it would
  // throw at invoice time for any sport that earned revenue. Reject at write time.
  if (football === 0 && padel === 0) {
    return NextResponse.json(
      { error: 'A tiered group must have at least one deployed camera' },
      { status: 400 }
    )
  }

  const serviceClient = createServiceClient() as any

  // Tier config only makes sense for a group org — the tier is a portfolio-level
  // determination applied across the group's child venues.
  const { data: org } = await serviceClient
    .from('organizations')
    .select('id, type')
    .eq('id', venueId)
    .maybeSingle()

  if (!org) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
  }
  if (org.type !== 'group') {
    return NextResponse.json(
      { error: 'Tier config can only be set on a group organization' },
      { status: 400 }
    )
  }

  const { data, error } = await serviceClient
    .from('playhub_group_tier_config')
    .upsert(
      {
        group_organization_id: venueId,
        football_camera_count: football,
        padel_camera_count: padel,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'group_organization_id' }
    )
    .select()
    .single()

  if (error) {
    console.error('Failed to update group tier config:', error)
    return NextResponse.json(
      { error: 'Failed to update group tier config' },
      { status: 500 }
    )
  }

  return NextResponse.json({ config: data })
}
