// GET /api/venue/[venueId]/billing/marketplace — Marketplace revenue summary

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'

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

  const isAdmin = await isVenueAdmin(user.id, venueId)
  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const serviceClient = createServiceClient() as any

  // Get billing config for revenue split
  const { data: billingConfig } = await serviceClient
    .from('playhub_venue_billing_config')
    .select('marketplace_revenue_split_pct')
    .eq('organization_id', venueId)
    .maybeSingle()

  const splitPct = billingConfig?.marketplace_revenue_split_pct ?? 20

  // Get all completed marketplace purchases for this org
  const { data: purchases, error: purchaseError } = await serviceClient
    .from('playhub_purchases')
    .select(
      `
      id,
      amount_paid,
      currency,
      purchased_at,
      match_recording_id,
      playhub_match_recordings!match_recording_id (
        id,
        title,
        home_team,
        away_team,
        match_date
      )
    `
    )
    .eq('organization_id', venueId)
    .eq('status', 'completed')
    .order('purchased_at', { ascending: false })

  if (purchaseError) {
    console.error('Failed to fetch marketplace purchases:', purchaseError)
    return NextResponse.json({ error: 'Failed to fetch data' }, { status: 500 })
  }

  const allPurchases = purchases || []

  // Calculate totals
  const totalSales = allPurchases.length
  const totalRevenue = allPurchases.reduce(
    (sum: number, p: any) => sum + (p.amount_paid || 0),
    0
  )
  const playhubShare = totalRevenue * (splitPct / 100)
  const orgShare = totalRevenue - playhubShare

  // Group by recording
  const byRecording: Record<
    string,
    { title: string; matchDate: string; sales: number; revenue: number }
  > = {}

  for (const p of allPurchases) {
    const rec = (p as any).playhub_match_recordings
    const recId = p.match_recording_id || 'unknown'
    if (!byRecording[recId]) {
      byRecording[recId] = {
        title: rec?.title || 'Unknown',
        matchDate: rec?.match_date || '',
        sales: 0,
        revenue: 0,
      }
    }
    byRecording[recId].sales += 1
    byRecording[recId].revenue += p.amount_paid || 0
  }

  const perRecording = Object.entries(byRecording)
    .map(([id, data]) => ({
      recordingId: id,
      ...data,
      orgShare: data.revenue * ((100 - splitPct) / 100),
    }))
    .sort((a, b) => b.revenue - a.revenue)

  // Currency from first purchase or default
  const currency = allPurchases[0]?.currency || 'AED'

  return NextResponse.json({
    totalSales,
    totalRevenue,
    playhubShare,
    orgShare,
    splitPct,
    currency,
    perRecording,
  })
}
