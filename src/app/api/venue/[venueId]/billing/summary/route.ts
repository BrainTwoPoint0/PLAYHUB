// GET /api/venue/[venueId]/billing/summary
// Returns current month billing stats with two-way profit share breakdown

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { isPlatformAdmin } from '@/lib/admin/auth'
import {
  resolveGroupId,
  isGroupTiered,
  computeSharePct,
  sportForBilling,
  grossForRecording,
  DEFAULT_SHARE_PCT,
  type Sport,
} from '@/lib/billing/share-tier'

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

  // Get billing config
  const { data: config } = await serviceClient
    .from('playhub_venue_billing_config')
    .select('default_billable_amount, currency, daily_recording_target')
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
    .select(
      'id, billable_amount, collected_by, created_at, spiideo_game_id, clutch_video_id'
    )
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

  // Resolve the partner (group) revenue share per the Li3ib annex — tiered
  // 15%/5% by monthly utilisation, or a flat default for non-tiered groups.
  // This is a mid-month ESTIMATE: the tier reflects utilisation so far and is
  // finalised only when the monthly invoice is generated after the period closes.
  // This is a mid-month estimate. If tier resolution fails (e.g. a venue not yet
  // under a group, or a sport with revenue but no camera count configured),
  // degrade to the flat default rather than 500-ing the admin's dashboard —
  // the authoritative split is computed at invoice generation.
  const targetMonth1 = targetMonth + 1 // computeSharePct expects a 1-based month
  let tiered = false
  let tierPctBySport: Record<Sport, number> | null = null
  let tierEstimateOk = true
  try {
    const groupId = await resolveGroupId(serviceClient, venueId)
    tiered = await isGroupTiered(serviceClient, groupId)
    if (tiered) {
      tierPctBySport = {
        football: await computeSharePct(
          serviceClient,
          groupId,
          targetYear,
          targetMonth1,
          'football'
        ),
        padel: await computeSharePct(
          serviceClient,
          groupId,
          targetYear,
          targetMonth1,
          'padel'
        ),
      }
    }
  } catch {
    tiered = false
    tierPctBySport = null
    tierEstimateOk = false
  }

  const shareOf = (r: any): { gross: number; partner: number } => {
    const gross = grossForRecording(r.billable_amount, defaultAmount)
    const sport = tiered ? sportForBilling(r) : null
    const pct = tiered && sport ? tierPctBySport![sport] : DEFAULT_SHARE_PCT
    return { gross, partner: gross * (pct / 100) }
  }

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

  const sumBy = (
    recs: any[],
    pick: (s: { gross: number; partner: number }) => number
  ) => recs.reduce((acc: number, r: any) => acc + pick(shareOf(r)), 0)

  const totalRevenue = sumBy(recordings, (s) => s.gross)
  const venueCollectedRevenue = sumBy(venueRecordings, (s) => s.gross)
  const playhubCollectedRevenue = sumBy(playhubRecordings, (s) => s.gross)

  // Settlement (share of gross):
  //  - venue-collected: partner holds the cash, owes PLAYBACK the playback share
  //  - online-collected: PLAYBACK holds the cash, owes the partner the partner share
  const venueOwesPlayhub = sumBy(venueRecordings, (s) => s.gross - s.partner)
  const playhubOwesVenue = sumBy(playhubRecordings, (s) => s.partner)
  const netBalance = venueOwesPlayhub - playhubOwesVenue

  const partnerShareTotal = sumBy(recordings, (s) => s.partner)
  const playbackShareTotal = sumBy(recordings, (s) => s.gross - s.partner)

  return NextResponse.json({
    totalRevenue: Number(totalRevenue.toFixed(3)),
    count,
    currency: config?.currency || 'KWD',
    venueCollectedCount,
    venueCollectedRevenue: Number(venueCollectedRevenue.toFixed(3)),
    venueOwesPlayhub: Number(venueOwesPlayhub.toFixed(3)),
    playhubCollectedCount,
    playhubCollectedRevenue: Number(playhubCollectedRevenue.toFixed(3)),
    playhubOwesVenue: Number(playhubOwesVenue.toFixed(3)),
    netBalance: Number(netBalance.toFixed(3)),
    tiered,
    partnerSharePctFootball: tierPctBySport?.football ?? DEFAULT_SHARE_PCT,
    partnerSharePctPadel: tierPctBySport?.padel ?? DEFAULT_SHARE_PCT,
    partnerShareTotal: Number(partnerShareTotal.toFixed(3)),
    playbackShareTotal: Number(playbackShareTotal.toFixed(3)),
    isEstimate: isCurrentMonth,
    tierEstimateOk,
    dailyTarget: config?.daily_recording_target || 0,
    todayCount: todayRecordings?.length || 0,
    monthStart,
    monthEnd,
  })
}
