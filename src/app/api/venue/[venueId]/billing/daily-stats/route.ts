// GET /api/venue/[venueId]/billing/daily-stats
// Returns daily recording counts for the current month, grouped by pitch/scene

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { isPlatformAdmin } from '@/lib/admin/auth'

type RouteContext = { params: Promise<{ venueId: string }> }

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { venueId } = await params
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [isAdmin, isPlatform] = await Promise.all([
    isVenueAdmin(user.id, venueId),
    isPlatformAdmin(user.id),
  ])
  if (!isAdmin && !isPlatform) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const serviceClient = createServiceClient() as any

  // Get billing config for daily target and currency
  const { data: config } = await serviceClient
    .from('playhub_venue_billing_config')
    .select('daily_recording_target, currency, default_billable_amount')
    .eq('organization_id', venueId)
    .maybeSingle()

  // Month boundaries — use query params if provided, otherwise current month
  const now = new Date()
  const searchParams = request.nextUrl.searchParams
  const paramMonth = searchParams.get('month')
  const paramYear = searchParams.get('year')
  const targetMonth = paramMonth ? parseInt(paramMonth, 10) - 1 : now.getMonth()
  const targetYear = paramYear ? parseInt(paramYear, 10) : now.getFullYear()
  const isCurrentMonth =
    targetMonth === now.getMonth() && targetYear === now.getFullYear()

  const monthStart = new Date(targetYear, targetMonth, 1).toISOString()
  const monthEnd = new Date(
    targetYear,
    targetMonth + 1,
    0,
    23,
    59,
    59
  ).toISOString()

  // Fetch all billable recordings for this month
  const { data: recordings } = await serviceClient
    .from('playhub_match_recordings')
    .select('id, created_at, pitch_name, billable_amount')
    .eq('organization_id', venueId)
    .eq('is_billable', true)
    .eq('status', 'published')
    .gte('created_at', monthStart)
    .lte('created_at', monthEnd)
    .order('created_at', { ascending: true })

  const recs = recordings || []
  const defaultAmount = config?.default_billable_amount || 5.0

  // Collect all unique scene/pitch names
  const scenesSet = new Set<string>()
  recs.forEach((r: any) => {
    scenesSet.add(r.pitch_name || 'Unknown')
  })
  const scenes = Array.from(scenesSet).sort()

  // Build a map: date -> { total, byScene, revenue }
  const dayMap = new Map<
    string,
    { total: number; byScene: Record<string, number>; revenue: number }
  >()

  // Pre-fill all days of the month
  const daysInMonth = new Date(targetYear, targetMonth + 1, 0).getDate()
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    dayMap.set(dateStr, { total: 0, byScene: {}, revenue: 0 })
  }

  // Populate from recordings
  recs.forEach((r: any) => {
    const dateStr = r.created_at.slice(0, 10) // YYYY-MM-DD
    const entry = dayMap.get(dateStr)
    if (entry) {
      entry.total++
      const scene = r.pitch_name || 'Unknown'
      entry.byScene[scene] = (entry.byScene[scene] || 0) + 1
      entry.revenue += Number(r.billable_amount) || defaultAmount
    }
  })

  // Ensure every day has entries for every scene (0 if missing)
  for (const entry of dayMap.values()) {
    for (const scene of scenes) {
      if (!(scene in entry.byScene)) {
        entry.byScene[scene] = 0
      }
    }
  }

  // Convert to sorted array
  const days = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, data]) => ({
      date,
      total: data.total,
      byScene: data.byScene,
      revenue: Number(data.revenue.toFixed(3)),
    }))

  // Calculate average per day (up to today for current month, full month for past)
  const daysElapsed = isCurrentMonth
    ? Math.min(now.getDate(), daysInMonth)
    : daysInMonth
  const totalRecordings = recs.length
  const averagePerDay =
    daysElapsed > 0 ? Number((totalRecordings / daysElapsed).toFixed(1)) : 0

  return NextResponse.json({
    days,
    averagePerDay,
    dailyTarget: config?.daily_recording_target || 0,
    scenes,
    currency: config?.currency || 'KWD',
  })
}
