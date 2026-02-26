// GET /api/venue/[venueId]/billing/summary
// Returns current month billing stats with two-way profit share breakdown

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

  // Get billing config (includes agreement parameters)
  const { data: config } = await serviceClient
    .from('playhub_venue_billing_config')
    .select(
      'default_billable_amount, currency, daily_recording_target, fixed_cost_per_recording, venue_profit_share_pct'
    )
    .eq('organization_id', venueId)
    .maybeSingle()

  // Current month boundaries
  const now = new Date()
  const monthStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    1
  ).toISOString()
  const monthEnd = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
    23,
    59,
    59
  ).toISOString()

  // Today boundaries
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
    .select('id, billable_amount, collected_by, created_at')
    .eq('organization_id', venueId)
    .eq('is_billable', true)
    .gte('created_at', monthStart)
    .lte('created_at', monthEnd)

  // Query today's recordings (for daily target)
  const { data: todayRecordings } = await serviceClient
    .from('playhub_match_recordings')
    .select('id')
    .eq('organization_id', venueId)
    .eq('is_billable', true)
    .gte('created_at', todayStart)
    .lte('created_at', todayEnd)

  const recordings = monthRecordings || []
  const fixedCost = Number(config?.fixed_cost_per_recording) || 0
  const venuePct = Number(config?.venue_profit_share_pct) || 0

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

  // Profit share calculation (per agreement Section 6.3):
  // profit = revenue - fixed_costs
  // venue_keeps = profit * venue_pct%

  // Venue-collected: venue keeps their profit share, owes PLAYBACK the rest
  const venueProfit = Math.max(
    0,
    venueCollectedRevenue - fixedCost * venueCollectedCount
  )
  const venueKeeps = venueProfit * (venuePct / 100)
  const venueOwesPlayhub = venueCollectedRevenue - venueKeeps

  // PLAYHUB-collected: PLAYHUB owes venue their profit share
  const playhubProfit = Math.max(
    0,
    playhubCollectedRevenue - fixedCost * playhubCollectedCount
  )
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
    fixedCostPerRecording: fixedCost,
    venueProfitSharePct: venuePct,
    dailyTarget: config?.daily_recording_target || 0,
    todayCount: todayRecordings?.length || 0,
    monthStart,
    monthEnd,
  })
}
