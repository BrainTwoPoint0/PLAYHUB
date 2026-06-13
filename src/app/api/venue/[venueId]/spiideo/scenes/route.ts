// GET /api/venue/[venueId]/spiideo/scenes - List cameras mapped to this venue
// (Spiideo scenes + Clutch devices; the URL keeps its historical name)

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { isPlatformAdmin } from '@/lib/admin/auth'

const SPIIDEO_API_BASE = 'https://api-public.spiideo.com'
const SPIIDEO_TOKEN_URL = 'https://auth-play.spiideo.net/oauth2/token'

// Shared Spiideo account credentials from environment
const SPIIDEO_CLIENT_ID = process.env.SPIIDEO_CLIENT_ID!
const SPIIDEO_CLIENT_SECRET = process.env.SPIIDEO_CLIENT_SECRET!
const SPIIDEO_ACCOUNT_ID = process.env.SPIIDEO_ACCOUNT_ID!
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

async function getAllScenes() {
  const token = await getAccessToken()

  const response = await fetch(
    `${SPIIDEO_API_BASE}/v1/scenes?accountId=${SPIIDEO_ACCOUNT_ID}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Spiideo-Api-User': SPIIDEO_USER_ID,
      },
      cache: 'no-store',
    }
  )

  if (!response.ok) {
    throw new Error(`Spiideo API error: ${response.status}`)
  }

  return response.json()
}

export async function GET(
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

  try {
    // Get camera mappings for this venue (Spiideo scenes + Clutch devices)
    const serviceClient = createServiceClient()
    const { data: mappings } = await (serviceClient as any)
      .from('playhub_scene_venue_mapping')
      .select('scene_id, scene_name, provider')
      .eq('organization_id', venueId)

    const spiideoMappings = (mappings || []).filter(
      (m: any) => (m.provider || 'spiideo') === 'spiideo'
    )
    // Clutch devices come straight from the mapping table — no provider call
    // needed, and they are never auto-discovered (must be explicitly mapped).
    const clutchCameras = (mappings || [])
      .filter((m: any) => m.provider === 'clutch')
      .map((m: any) => ({
        id: m.scene_id,
        name: m.scene_name || 'Clutch Cam',
        provider: 'clutch' as const,
      }))

    const spiideoConfigured = Boolean(
      SPIIDEO_CLIENT_ID && SPIIDEO_CLIENT_SECRET && SPIIDEO_ACCOUNT_ID
    )
    if (!spiideoConfigured && clutchCameras.length === 0) {
      return NextResponse.json(
        { error: 'Spiideo not configured' },
        { status: 404 }
      )
    }

    // The zero-mappings "show all scenes" fallback exposes every camera in
    // the SHARED Spiideo account, so it is platform-admin-only (initial
    // venue setup). Venue admins only ever see explicitly mapped cameras —
    // without this gate, any admin of an unmapped venue could enumerate
    // other tenants' cameras.
    const hasMappings = (mappings || []).length > 0
    const allowShowAll = !hasMappings && (await isPlatformAdmin(user.id))
    const needsSpiideo =
      spiideoConfigured && (allowShowAll || spiideoMappings.length > 0)

    let spiideoScenes: any[] = []
    if (needsSpiideo) {
      try {
        const mappedSceneIds = new Set(
          spiideoMappings.map((m: any) => m.scene_id)
        )
        const sceneNameOverrides = new Map(
          spiideoMappings.map((m: any) => [m.scene_id, m.scene_name])
        )

        // Fetch all scenes from Spiideo
        const scenesResponse = await getAllScenes()
        const allScenes = scenesResponse.content || []

        // Filter to only scenes mapped to this venue; platform admins on an
        // unmapped venue see everything (initial setup). Clutch devices are
        // excluded from the fallback by design.
        const scenes = allowShowAll
          ? allScenes
          : allScenes.filter((scene: any) => mappedSceneIds.has(scene.id))

        spiideoScenes = scenes.map((scene: any) => ({
          id: scene.id,
          name: sceneNameOverrides.get(scene.id) || scene.name,
          accountId: scene.accountId,
          provider: 'spiideo' as const,
        }))
      } catch (spiideoError) {
        // A Spiideo outage must not hide the venue's Clutch cameras —
        // degrade to the Clutch list when one exists, rethrow otherwise.
        if (clutchCameras.length === 0) throw spiideoError
        console.error(
          'Spiideo scenes fetch failed; returning Clutch cameras only:',
          spiideoError
        )
      }
    }

    return NextResponse.json({
      scenes: [...spiideoScenes, ...clutchCameras],
      allScenes: allowShowAll, // Indicate if showing all (platform-admin setup view)
    })
  } catch (error) {
    console.error('Failed to fetch venue cameras:', error)
    return NextResponse.json(
      { error: 'Failed to fetch scenes from Spiideo' },
      { status: 500 }
    )
  }
}
