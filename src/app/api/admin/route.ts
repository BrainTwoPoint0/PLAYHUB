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
  getAllSceneMappings,
  fetchSpiideoScenes,
  togglePlatformAdmin,
  deleteUser,
  updateOrgFeatures,
  setParentOrg,
  upsertVenueAccess,
  deleteVenueAccess,
  createOrganization,
  updateOrganization,
  upsertSceneMapping,
  SLUG_REGEX,
  VALID_ORG_TYPES,
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

    case 'scenes': {
      const [spiideoResult, mappings] = await Promise.all([
        fetchSpiideoScenes(),
        getAllSceneMappings(),
      ])
      return NextResponse.json({
        spiideoScenes: spiideoResult.scenes,
        mappings,
        error: spiideoResult.error,
      })
    }

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

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
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

    case 'createOrganization': {
      const { orgData } = body
      if (!orgData?.name?.trim()) {
        return NextResponse.json(
          { error: 'Name is required' },
          { status: 400 }
        )
      }
      if (!orgData?.slug || !SLUG_REGEX.test(orgData.slug)) {
        return NextResponse.json(
          { error: 'Slug must be lowercase alphanumeric with hyphens' },
          { status: 400 }
        )
      }
      if (orgData.slug.length > 100) {
        return NextResponse.json(
          { error: 'Slug must be 100 characters or less' },
          { status: 400 }
        )
      }
      if (!VALID_ORG_TYPES.includes(orgData?.type)) {
        return NextResponse.json(
          { error: 'Type must be one of: venue, league, academy, group' },
          { status: 400 }
        )
      }
      if (orgData.logo_url && !/^https?:\/\/.+/.test(orgData.logo_url)) {
        return NextResponse.json(
          { error: 'Logo URL must be a valid HTTP URL' },
          { status: 400 }
        )
      }
      const createResult = await createOrganization(orgData)
      if (!createResult.success) {
        return NextResponse.json(
          { error: createResult.error },
          { status: 400 }
        )
      }
      return NextResponse.json(createResult)
    }

    case 'updateOrganization': {
      const { orgId: updateOrgId, updates } = body
      if (!updateOrgId) {
        return NextResponse.json(
          { error: 'orgId is required' },
          { status: 400 }
        )
      }
      if (updates?.name !== undefined && !updates.name.trim()) {
        return NextResponse.json(
          { error: 'Name cannot be empty' },
          { status: 400 }
        )
      }
      if (updates?.slug && !SLUG_REGEX.test(updates.slug)) {
        return NextResponse.json(
          { error: 'Slug must be lowercase alphanumeric with hyphens' },
          { status: 400 }
        )
      }
      if (updates?.type) {
        if (!VALID_ORG_TYPES.includes(updates.type)) {
          return NextResponse.json(
            { error: 'Type must be one of: venue, league, academy, group' },
            { status: 400 }
          )
        }
      }
      if (updates?.logo_url && !/^https?:\/\/.+/.test(updates.logo_url)) {
        return NextResponse.json(
          { error: 'Logo URL must be a valid HTTP URL' },
          { status: 400 }
        )
      }
      const updateResult = await updateOrganization(updateOrgId, updates)
      if (!updateResult.success) {
        return NextResponse.json(
          { error: updateResult.error },
          { status: 400 }
        )
      }
      return NextResponse.json(updateResult)
    }

    case 'upsertSceneMapping': {
      const { sceneId, organizationId, sceneName } = body
      if (!sceneId) {
        return NextResponse.json(
          { error: 'sceneId is required' },
          { status: 400 }
        )
      }
      const sceneResult = await upsertSceneMapping({
        scene_id: sceneId,
        organization_id: organizationId || null,
        scene_name: sceneName || null,
      })
      if (!sceneResult.success) {
        return NextResponse.json(
          { error: sceneResult.error },
          { status: 400 }
        )
      }
      return NextResponse.json(sceneResult)
    }

    default:
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }
}
