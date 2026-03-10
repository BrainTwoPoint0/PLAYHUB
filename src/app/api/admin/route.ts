// GET /api/admin - Get admin dashboard data
// POST /api/admin - Admin actions

import { getAuthUserStrict } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import {
  isPlatformAdmin,
  getAdminStats,
  getAllVenues,
  getAllUsers,
  getAllRecordings,
  getAllOrganizations,
  getAllVenueAccess,
  togglePlatformAdmin,
  deleteUser,
  updateOrgFeatures,
  setParentOrg,
  upsertVenueAccess,
  deleteVenueAccess,
} from '@/lib/admin/auth'

export async function GET(request: NextRequest) {
  const { user } = await getAuthUserStrict()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Check if user is platform admin
  const isAdmin = await isPlatformAdmin(user.id)
  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const section = searchParams.get('section') || 'stats'

  switch (section) {
    case 'stats':
      const stats = await getAdminStats()
      return NextResponse.json(stats)

    case 'venues':
      const venues = await getAllVenues()
      return NextResponse.json({ venues })

    case 'users':
      const users = await getAllUsers()
      return NextResponse.json({ users })

    case 'recordings':
      const recordings = await getAllRecordings()
      return NextResponse.json({ recordings })

    case 'organizations':
      const organizations = await getAllOrganizations()
      return NextResponse.json({ organizations })

    case 'venue-access':
      const venueAccess = await getAllVenueAccess()
      return NextResponse.json({ venueAccess })

    default:
      return NextResponse.json({ error: 'Invalid section' }, { status: 400 })
  }
}

export async function POST(request: NextRequest) {
  const { user } = await getAuthUserStrict()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Check if user is platform admin
  const isAdmin = await isPlatformAdmin(user.id)
  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json()
  const { action } = body

  switch (action) {
    case 'toggleAdmin': {
      const { profileId, isAdmin: makeAdmin } = body
      if (!profileId) {
        return NextResponse.json(
          { error: 'profileId required' },
          { status: 400 }
        )
      }
      const result = await togglePlatformAdmin(profileId, makeAdmin)
      return NextResponse.json(result)
    }

    case 'updateOrgFeatures': {
      const { orgId, features } = body
      if (!orgId || !features) {
        return NextResponse.json(
          { error: 'orgId and features required' },
          { status: 400 }
        )
      }
      const orgResult = await updateOrgFeatures(orgId, features)
      if (!orgResult.success) {
        return NextResponse.json({ error: orgResult.error }, { status: 400 })
      }
      return NextResponse.json(orgResult)
    }

    case 'deleteUser': {
      const { profileId } = body
      if (!profileId) {
        return NextResponse.json(
          { error: 'profileId required' },
          { status: 400 }
        )
      }
      const result = await deleteUser(profileId, user.id)
      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 400 })
      }
      return NextResponse.json(result)
    }

    case 'setParentOrg': {
      const { childOrgId, parentOrgId } = body
      if (!childOrgId) {
        return NextResponse.json(
          { error: 'childOrgId required' },
          { status: 400 }
        )
      }
      const parentResult = await setParentOrg(childOrgId, parentOrgId || null)
      if (!parentResult.success) {
        return NextResponse.json({ error: parentResult.error }, { status: 400 })
      }
      return NextResponse.json(parentResult)
    }

    case 'upsertVenueAccess': {
      const { venueAccessData } = body
      if (
        !venueAccessData?.organization_id ||
        !venueAccessData?.venue_organization_id
      ) {
        return NextResponse.json(
          { error: 'organization_id and venue_organization_id required' },
          { status: 400 }
        )
      }
      const accessResult = await upsertVenueAccess(venueAccessData)
      if (!accessResult.success) {
        return NextResponse.json({ error: accessResult.error }, { status: 400 })
      }
      return NextResponse.json(accessResult)
    }

    case 'deleteVenueAccess': {
      const { venueAccessId } = body
      if (!venueAccessId) {
        return NextResponse.json(
          { error: 'venueAccessId required' },
          { status: 400 }
        )
      }
      const deleteResult = await deleteVenueAccess(venueAccessId)
      if (!deleteResult.success) {
        return NextResponse.json({ error: deleteResult.error }, { status: 400 })
      }
      return NextResponse.json(deleteResult)
    }

    default:
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }
}
