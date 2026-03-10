// GET /api/org/[slug]/manage/group-dashboard
// Returns aggregated data for a group org across all child venues (resolved by slug)

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

  // Resolve org by slug
  const { data: org } = await serviceClient
    .from('organizations')
    .select('id, type, name')
    .eq('slug', slug)
    .single()

  if (!org || org.type !== 'group') {
    return NextResponse.json(
      { error: 'Not a group organization' },
      { status: 400 }
    )
  }

  const [isAdmin, isPlatform] = await Promise.all([
    isVenueAdmin(user.id, org.id),
    isPlatformAdmin(user.id),
  ])
  if (!isAdmin && !isPlatform) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Get child venues
  const { data: children } = await serviceClient
    .from('organizations')
    .select('id, name, slug, logo_url, type, is_active')
    .eq('parent_organization_id', org.id)
    .eq('is_active', true)
    .order('name', { ascending: true })

  const childVenues = children || []
  const childIds = childVenues.map((c: any) => c.id)

  if (childIds.length === 0) {
    return NextResponse.json({
      childVenues: [],
      totals: {
        totalRecordings: 0,
        publishedRecordings: 0,
        monthRecordings: 0,
        monthRevenue: 0,
        todayCount: 0,
      },
      dailyChart: [],
      venueNames: [],
      totalDailyTarget: 0,
      averagePerDay: 0,
      currency: 'KWD',
    })
  }

  // Month boundaries
  const now = new Date()
  const searchParams = request.nextUrl.searchParams
  const paramMonth = searchParams.get('month')
  const paramYear = searchParams.get('year')
  const targetMonth = paramMonth ? parseInt(paramMonth, 10) - 1 : now.getMonth()
  const targetYear = paramYear ? parseInt(paramYear, 10) : now.getFullYear()

  const monthStart = new Date(targetYear, targetMonth, 1).toISOString()
  const monthEnd = new Date(
    targetYear,
    targetMonth + 1,
    0,
    23,
    59,
    59
  ).toISOString()

  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).toISOString()
  const todayEnd = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59
  ).toISOString()

  // Fetch all recordings for child venues
  const { data: allRecordings } = await serviceClient
    .from('playhub_match_recordings')
    .select(
      'id, organization_id, status, is_billable, billable_amount, created_at'
    )
    .in('organization_id', childIds)

  const recs = allRecordings || []

  // Fetch billing configs for child venues
  const { data: billingConfigs } = await serviceClient
    .from('playhub_venue_billing_config')
    .select(
      'organization_id, default_billable_amount, currency, daily_recording_target'
    )
    .in('organization_id', childIds)

  const configMap: Record<string, any> = {}
  ;(billingConfigs || []).forEach((c: any) => {
    configMap[c.organization_id] = c
  })

  // Build per-venue stats
  const venueStats = childVenues.map((venue: any) => {
    const venueRecs = recs.filter((r: any) => r.organization_id === venue.id)
    const config = configMap[venue.id]
    const defaultAmount = config?.default_billable_amount || 5.0

    const totalCount = venueRecs.length
    const publishedCount = venueRecs.filter(
      (r: any) => r.status === 'published'
    ).length

    const monthRecs = venueRecs.filter(
      (r: any) =>
        r.is_billable &&
        r.status === 'published' &&
        r.created_at >= monthStart &&
        r.created_at <= monthEnd
    )
    const monthRevenue = monthRecs.reduce(
      (sum: number, r: any) =>
        sum + (Number(r.billable_amount) || defaultAmount),
      0
    )

    const todayRecs = venueRecs.filter(
      (r: any) =>
        r.is_billable &&
        r.status === 'published' &&
        r.created_at >= todayStart &&
        r.created_at <= todayEnd
    )

    return {
      id: venue.id,
      name: venue.name,
      slug: venue.slug,
      logo_url: venue.logo_url,
      type: venue.type,
      totalRecordings: totalCount,
      publishedRecordings: publishedCount,
      monthRecordings: monthRecs.length,
      monthRevenue: Number(monthRevenue.toFixed(3)),
      todayCount: todayRecs.length,
      dailyTarget: config?.daily_recording_target || 0,
      currency: config?.currency || 'KWD',
    }
  })

  // Aggregated totals
  const totals = {
    totalRecordings: recs.length,
    publishedRecordings: recs.filter((r: any) => r.status === 'published')
      .length,
    monthRecordings: venueStats.reduce(
      (sum: number, v: any) => sum + v.monthRecordings,
      0
    ),
    monthRevenue: Number(
      venueStats
        .reduce((sum: number, v: any) => sum + v.monthRevenue, 0)
        .toFixed(3)
    ),
    todayCount: venueStats.reduce(
      (sum: number, v: any) => sum + v.todayCount,
      0
    ),
  }

  // Build daily chart data
  const isCurrentMonth =
    targetMonth === now.getMonth() && targetYear === now.getFullYear()
  const daysInMonth = new Date(targetYear, targetMonth + 1, 0).getDate()

  const venueNameMap: Record<string, string> = {}
  childVenues.forEach((v: any) => {
    venueNameMap[v.id] = v.name
  })

  const dailyMap = new Map<string, Record<string, number>>()
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const entry: Record<string, number> = { total: 0 }
    childIds.forEach((id: string) => {
      entry[venueNameMap[id]] = 0
    })
    dailyMap.set(dateStr, entry)
  }

  const monthBillableRecs = recs.filter(
    (r: any) =>
      r.is_billable &&
      r.status === 'published' &&
      r.created_at >= monthStart &&
      r.created_at <= monthEnd
  )

  monthBillableRecs.forEach((r: any) => {
    const dateStr = r.created_at.slice(0, 10)
    const entry = dailyMap.get(dateStr)
    if (entry) {
      entry.total++
      const venueName = venueNameMap[r.organization_id]
      if (venueName) entry[venueName] = (entry[venueName] || 0) + 1
    }
  })

  const dailyChart = Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, data]) => ({ date, ...data }))

  const totalDailyTarget = venueStats.reduce(
    (sum: number, v: any) => sum + v.dailyTarget,
    0
  )

  const daysElapsed = isCurrentMonth
    ? Math.min(now.getDate(), daysInMonth)
    : daysInMonth
  const averagePerDay =
    daysElapsed > 0
      ? Number((totals.monthRecordings / daysElapsed).toFixed(1))
      : 0

  return NextResponse.json({
    childVenues: venueStats,
    totals,
    dailyChart,
    venueNames: childVenues.map((v: any) => v.name),
    totalDailyTarget,
    averagePerDay,
    currency: venueStats[0]?.currency || 'KWD',
  })
}
