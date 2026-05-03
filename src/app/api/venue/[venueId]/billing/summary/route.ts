// GET /api/venue/[venueId]/billing/summary
// Returns current month billing stats with two-way profit share breakdown

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { getKwdToEurRate, getEurToAedRate } from '@/lib/fx/rates'

type RouteContext = { params: Promise<{ venueId: string }> }

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { venueId } = await params
  const { user } = await getAuthUser()

  if (!user) {
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

  // Get billing config (includes agreement parameters)
  const { data: config } = await serviceClient
    .from('playhub_venue_billing_config')
    .select(
      'default_billable_amount, currency, daily_recording_target, fixed_cost_eur, ambassador_pct, venue_profit_share_pct'
    )
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

  // Today boundaries (only relevant for current month)
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

  const defaultAmount = config?.default_billable_amount || 5.0

  // Query billable recordings for this month
  const { data: monthRecordings } = await serviceClient
    .from('playhub_match_recordings')
    .select('id, billable_amount, collected_by, created_at, duration_seconds')
    .eq('organization_id', venueId)
    .eq('is_billable', true)
    .eq('status', 'published')
    .gte('created_at', monthStart)
    .lte('created_at', monthEnd)

  // Query today's recordings (only for current month)
  let todayRecordings: any[] | null = null
  if (isCurrentMonth) {
    const { data } = await serviceClient
      .from('playhub_match_recordings')
      .select('id')
      .eq('organization_id', venueId)
      .eq('is_billable', true)
      .eq('status', 'published')
      .gte('created_at', todayStart)
      .lte('created_at', todayEnd)
    todayRecordings = data
  }

  const recordings = monthRecordings || []
  const fixedCostEurPerHour = Number(config?.fixed_cost_eur) || 0
  const ambassadorPct = Number(config?.ambassador_pct) || 0
  const venuePct = Number(config?.venue_profit_share_pct) || 0
  const venueCurrency = (config?.currency || 'KWD').toUpperCase()

  // Convert per-hour EUR fixed cost into venue's local currency.
  // Only KWD and AED have FX paths today; unknown currencies return 400 rather
  // than silently equate EUR to local.
  let perHourFixedCostLocal = 0
  let fxRate = 0
  if (fixedCostEurPerHour > 0) {
    if (venueCurrency === 'KWD') {
      const kwdToEur = await getKwdToEurRate()
      perHourFixedCostLocal = fixedCostEurPerHour / kwdToEur
      fxRate = kwdToEur
    } else if (venueCurrency === 'AED') {
      const eurToAed = await getEurToAedRate()
      perHourFixedCostLocal = fixedCostEurPerHour * eurToAed
      fxRate = eurToAed
    } else if (venueCurrency === 'EUR') {
      perHourFixedCostLocal = fixedCostEurPerHour
      fxRate = 1
    } else {
      return NextResponse.json(
        {
          error: `Unsupported venue currency for cost conversion: ${venueCurrency}. Supported: KWD, AED, EUR.`,
        },
        { status: 400 }
      )
    }
  }

  // Revenue: use billable_amount if set, otherwise default from config (5 KWD)
  const totalRevenue = recordings.reduce(
    (sum: number, r: any) => sum + (Number(r.billable_amount) || defaultAmount),
    0
  )

  // Split recordings by collector
  const count = recordings.length
  const venueRecordings = recordings.filter(
    (r: any) => r.collected_by !== 'playhub'
  )
  const playhubRecordings = recordings.filter(
    (r: any) => r.collected_by === 'playhub'
  )

  const venueCollectedCount = venueRecordings.length
  const playhubCollectedCount = playhubRecordings.length

  const venueCollectedRevenue = venueRecordings.reduce(
    (sum: number, r: any) => sum + (Number(r.billable_amount) || defaultAmount),
    0
  )
  const playhubCollectedRevenue = playhubRecordings.reduce(
    (sum: number, r: any) => sum + (Number(r.billable_amount) || defaultAmount),
    0
  )

  // Profit share calculation:
  // fixed_cost_eur is stored as a per-hour figure; cost scales by recording duration.
  // cost_per_recording = perHourFixedCostLocal * hours + ambassador_pct% of price
  // profit = revenue - total_costs
  // venue_keeps = profit * venue_pct%
  // Recordings missing duration_seconds (legacy rows) fall back to 1 hour.
  function totalCost(recs: any[]) {
    return recs.reduce((sum: number, r: any) => {
      const seconds = r.duration_seconds ?? 3600
      const hours = (Number(seconds) || 3600) / 3600
      const price = Number(r.billable_amount) || defaultAmount
      const ambassadorFee = price * (ambassadorPct / 100)
      return sum + perHourFixedCostLocal * hours + ambassadorFee
    }, 0)
  }

  // Venue-collected: venue keeps their profit share, owes PLAYBACK the rest
  const venueCosts = totalCost(venueRecordings)
  const venueProfit = Math.max(0, venueCollectedRevenue - venueCosts)
  const venueKeeps = venueProfit * (venuePct / 100)
  const venueOwesPlayhub = venueCollectedRevenue - venueKeeps

  // PLAYHUB-collected: PLAYHUB owes venue their profit share
  const playhubCosts = totalCost(playhubRecordings)
  const playhubProfit = Math.max(0, playhubCollectedRevenue - playhubCosts)
  const playhubOwesVenue = playhubProfit * (venuePct / 100)

  // Net: positive = venue owes PLAYHUB, negative = PLAYHUB owes venue
  const netBalance = venueOwesPlayhub - playhubOwesVenue

  // Total venue profit from both sources
  const venueTotalProfit = venueKeeps + playhubOwesVenue

  return NextResponse.json({
    totalRevenue: Number(totalRevenue.toFixed(3)),
    count,
    currency: config?.currency || 'KWD',
    venueCollectedCount,
    venueCollectedRevenue: Number(venueCollectedRevenue.toFixed(3)),
    venueOwesPlayhub: Number(venueOwesPlayhub.toFixed(3)),
    venueKeeps: Number(venueKeeps.toFixed(3)),
    venueTotalProfit: Number(venueTotalProfit.toFixed(3)),
    playhubCollectedCount,
    playhubCollectedRevenue: Number(playhubCollectedRevenue.toFixed(3)),
    playhubOwesVenue: Number(playhubOwesVenue.toFixed(3)),
    netBalance: Number(netBalance.toFixed(3)),
    fixedCostEur: fixedCostEurPerHour,
    ambassadorPct: ambassadorPct,
    venueProfitSharePct: venuePct,
    fxRate: Number(fxRate.toFixed(4)),
    dailyTarget: config?.daily_recording_target || 0,
    todayCount: todayRecordings?.length || 0,
    monthStart,
    monthEnd,
  })
}
