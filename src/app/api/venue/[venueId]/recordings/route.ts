// GET /api/venue/[venueId]/recordings - List recordings for a venue (paginated)

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'

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

  // Parse query params
  const searchParams = request.nextUrl.searchParams
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)))
  // Sanitize search: escape PostgREST filter special chars to prevent filter injection
  const rawSearch = searchParams.get('search')?.trim() || ''
  const search = rawSearch.replace(/[%_,().\\*]/g, (c) => `\\${c}`)
  const status = searchParams.get('status') || ''
  const billable = searchParams.get('billable') || ''
  const VALID_STATUSES = ['draft', 'published', 'archived', 'processing', 'ready']

  // Use service client for data queries to bypass RLS
  const serviceClient = createServiceClient()

  // Build count query (same filters, head-only for count)
  let countQuery = (serviceClient as any)
    .from('playhub_match_recordings')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', venueId)

  if (search) {
    countQuery = countQuery.or(
      `title.ilike.%${search}%,home_team.ilike.%${search}%,away_team.ilike.%${search}%`
    )
  }
  if (status && VALID_STATUSES.includes(status)) {
    countQuery = countQuery.eq('status', status)
  }
  if (billable === 'true') {
    countQuery = countQuery.eq('is_billable', true)
  } else if (billable === 'false') {
    countQuery = countQuery.eq('is_billable', false)
  }

  const { count, error: countError } = await countQuery

  if (countError) {
    console.error('Failed to count recordings:', countError)
    return NextResponse.json(
      { error: 'Failed to fetch recordings' },
      { status: 500 }
    )
  }

  const total = count || 0
  const from = (page - 1) * limit
  const to = from + limit - 1

  // Build data query with same filters + pagination
  let dataQuery = (serviceClient as any)
    .from('playhub_match_recordings')
    .select(
      `
      id,
      title,
      description,
      match_date,
      home_team,
      away_team,
      venue,
      pitch_name,
      status,
      s3_key,
      file_size_bytes,
      transferred_at,
      spiideo_game_id,
      is_billable,
      billable_amount,
      collected_by,
      graphic_package_id,
      created_at
    `
    )
    .eq('organization_id', venueId)

  if (search) {
    dataQuery = dataQuery.or(
      `title.ilike.%${search}%,home_team.ilike.%${search}%,away_team.ilike.%${search}%`
    )
  }
  if (status) {
    dataQuery = dataQuery.eq('status', status)
  }
  if (billable === 'true') {
    dataQuery = dataQuery.eq('is_billable', true)
  } else if (billable === 'false') {
    dataQuery = dataQuery.eq('is_billable', false)
  }

  dataQuery = dataQuery
    .order('match_date', { ascending: false })
    .range(from, to)

  const { data: recordings, error } = await dataQuery

  if (error) {
    console.error('Failed to fetch recordings:', error)
    return NextResponse.json(
      { error: 'Failed to fetch recordings' },
      { status: 500 }
    )
  }

  // Get access counts for each recording on this page
  const recordingIds = recordings?.map((r: any) => r.id) || []
  let accessCounts: Record<string, number> = {}

  if (recordingIds.length > 0) {
    const { data: accessData } = await (serviceClient as any)
      .from('playhub_access_rights')
      .select('match_recording_id')
      .in('match_recording_id', recordingIds)
      .eq('is_active', true)

    if (accessData) {
      accessData.forEach((a: any) => {
        accessCounts[a.match_recording_id] =
          (accessCounts[a.match_recording_id] || 0) + 1
      })
    }
  }

  // Get graphic package names for recordings that have one
  const gpIds = [...new Set((recordings || []).map((r: any) => r.graphic_package_id).filter(Boolean))]
  let gpNames: Record<string, string> = {}

  if (gpIds.length > 0) {
    const { data: gpData } = await (serviceClient as any)
      .from('playhub_graphic_packages')
      .select('id, name')
      .in('id', gpIds)

    if (gpData) {
      gpData.forEach((g: any) => {
        gpNames[g.id] = g.name
      })
    }
  }

  // Enrich recordings with access count and graphic package name
  const enrichedRecordings = (recordings || []).map((r: any) => ({
    ...r,
    accessCount: accessCounts[r.id] || 0,
    graphicPackageName: gpNames[r.graphic_package_id] || null,
  }))

  return NextResponse.json({
    recordings: enrichedRecordings,
    total,
    page,
    pageSize: limit,
  })
}
