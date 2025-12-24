// GET /api/venue/[venueId]/spiideo/scenes - List Spiideo scenes mapped to this venue

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'

const SPIIDEO_API_BASE = 'https://api-public.spiideo.com'
const SPIIDEO_TOKEN_URL = 'https://auth-play.spiideo.net/oauth2/token'

// Shared Spiideo account credentials from environment
const SPIIDEO_CLIENT_ID = process.env.SPIIDEO_CLIENT_ID!
const SPIIDEO_CLIENT_SECRET = process.env.SPIIDEO_CLIENT_SECRET!
const SPIIDEO_ACCOUNT_ID = process.env.SPIIDEO_ACCOUNT_ID!
const SPIIDEO_USER_ID = process.env.SPIIDEO_USER_ID!

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

  // Check if Spiideo is configured (env vars)
  if (!SPIIDEO_CLIENT_ID || !SPIIDEO_CLIENT_SECRET || !SPIIDEO_ACCOUNT_ID) {
    return NextResponse.json(
      { error: 'Spiideo not configured' },
      { status: 404 }
    )
  }

  try {
    // Get scene mappings for this venue
    const serviceClient = createServiceClient()
    const { data: mappings } = await (serviceClient as any)
      .from('playhub_scene_venue_mapping')
      .select('scene_id, scene_name')
      .eq('organization_id', venueId)

    const mappedSceneIds = new Set(mappings?.map((m: any) => m.scene_id) || [])
    const sceneNameOverrides = new Map(
      mappings?.map((m: any) => [m.scene_id, m.scene_name]) || []
    )

    // Fetch all scenes from Spiideo
    const scenesResponse = await getAllScenes()
    const allScenes = scenesResponse.content || []

    // Filter to only scenes mapped to this venue
    // If no mappings exist, show all scenes (for initial setup)
    const scenes =
      mappedSceneIds.size > 0
        ? allScenes.filter((scene: any) => mappedSceneIds.has(scene.id))
        : allScenes

    return NextResponse.json({
      scenes: scenes.map((scene: any) => ({
        id: scene.id,
        name: sceneNameOverrides.get(scene.id) || scene.name,
        accountId: scene.accountId,
      })),
      allScenes: mappedSceneIds.size === 0, // Indicate if showing all (no mappings)
    })
  } catch (error) {
    console.error('Failed to fetch Spiideo scenes:', error)
    return NextResponse.json(
      { error: 'Failed to fetch scenes from Spiideo' },
      { status: 500 }
    )
  }
}
