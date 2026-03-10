// GET /api/org/[slug]/manage/recordings — Admin: list org's recordings (all statuses)

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { isPlatformAdmin } from '@/lib/admin/auth'

type RouteContext = { params: Promise<{ slug: string }> }

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { slug } = await params
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const serviceClient = createServiceClient() as any

  const { data: org } = await serviceClient
    .from('organizations')
    .select('id, name')
    .eq('slug', slug)
    .single()

  if (!org) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const [isAdmin, isPlatform] = await Promise.all([
    isVenueAdmin(user.id, org.id),
    isPlatformAdmin(user.id),
  ])
  if (!isAdmin && !isPlatform) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Pagination
  const searchParams = request.nextUrl.searchParams
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
  const limit = 20
  const offset = (page - 1) * limit
  const status = searchParams.get('status') // optional filter

  // Count query
  let countQuery = serviceClient
    .from('playhub_match_recordings')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', org.id)

  if (status) {
    countQuery = countQuery.eq('status', status)
  }

  const { count } = await countQuery

  // Data query
  let dataQuery = serviceClient
    .from('playhub_match_recordings')
    .select(
      `
      id,
      title,
      home_team,
      away_team,
      match_date,
      pitch_name,
      status,
      is_billable,
      billable_amount,
      marketplace_enabled,
      created_at
    `
    )
    .eq('organization_id', org.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (status) {
    dataQuery = dataQuery.eq('status', status)
  }

  const { data: recordings } = await dataQuery

  return NextResponse.json({
    recordings: recordings || [],
    total: count || 0,
    page,
    totalPages: Math.ceil((count || 0) / limit),
  })
}
