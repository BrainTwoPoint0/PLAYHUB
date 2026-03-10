// GET /api/admin/email-preview?template=invoice&venueId=xxx&year=2026&month=2
// Pass venueId to auto-calculate from real data (year/month default to current)
// Or pass manual params for sample preview
// Platform admin only

import { getAuthUserStrict, createServiceClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { NextRequest, NextResponse } from 'next/server'
import { renderInvoiceEmailHtml } from '@/lib/email'
import { getKwdToEurRate } from '@/lib/fx/rates'

export async function GET(request: NextRequest) {
  const { user } = await getAuthUserStrict()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const isPlatform = await isPlatformAdmin(user.id)
  if (!isPlatform) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const template = request.nextUrl.searchParams.get('template')

  if (template === 'invoice') {
    const p = request.nextUrl.searchParams
    const venueId = p.get('venueId')

    // If venueId is provided, calculate from real data
    if (venueId) {
      return await renderLiveInvoicePreview(venueId, p)
    }

    // Otherwise use manual params
    const html = renderInvoiceEmailHtml({
      venueName: p.get('venueName') || 'CFA Indoor Arena',
      periodLabel: p.get('period') || 'February 2026',
      currency: p.get('currency') || 'KWD',
      stripeInvoiceUrl:
        p.get('stripeUrl') || 'https://invoice.stripe.com/example',
      fixedCostPerRecording: Number(p.get('fixedCost') || '4.15'),
      ambassadorPct: Number(p.get('ambassadorPct') || '10'),
      venueProfitSharePct: Number(p.get('sharePct') || '30'),
      venueCollectedCount: Number(p.get('venueCount') || '18'),
      venueCollectedRevenue: Number(p.get('venueRevenue') || '90'),
      venueOwesPlayhub: Number(p.get('venueOwes') || '63'),
      playhubCollectedCount: Number(p.get('playhubCount') || '6'),
      playhubCollectedRevenue: Number(p.get('playhubRevenue') || '30'),
      playhubOwesVenue: Number(p.get('playhubOwes') || '9'),
      netAmount: Number(p.get('amount') || '54'),
    })

    return new NextResponse(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  return NextResponse.json(
    {
      error: 'Unknown template. Available: invoice',
      usage:
        '/api/admin/email-preview?template=invoice&venueId=xxx or /api/admin/email-preview?template=invoice with manual params',
    },
    { status: 400 }
  )
}

async function renderLiveInvoicePreview(
  venueId: string,
  p: URLSearchParams
): Promise<NextResponse> {
  const serviceClient = createServiceClient()

  // Get venue name
  const { data: org } = await (serviceClient as any)
    .from('organizations')
    .select('name')
    .eq('id', venueId)
    .single()

  if (!org) {
    return NextResponse.json({ error: 'Venue not found' }, { status: 404 })
  }

  // Get billing config
  const { data: config } = await (serviceClient as any)
    .from('playhub_venue_billing_config')
    .select('*')
    .eq('organization_id', venueId)
    .single()

  if (!config) {
    return NextResponse.json(
      { error: 'No billing config for this venue' },
      { status: 404 }
    )
  }

  // Determine period (default to current month)
  const now = new Date()
  const year = Number(p.get('year') || now.getFullYear())
  const month = Number(p.get('month') || now.getMonth() + 1)

  const periodStart = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const periodEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  const periodStartTs = new Date(`${periodStart}T00:00:00Z`).toISOString()
  const periodEndTs = new Date(`${periodEnd}T23:59:59Z`).toISOString()

  // Query billable recordings
  const { data: recordings } = await (serviceClient as any)
    .from('playhub_match_recordings')
    .select('id, title, billable_amount, collected_by')
    .eq('organization_id', venueId)
    .eq('is_billable', true)
    .eq('status', 'published')
    .gte('created_at', periodStartTs)
    .lte('created_at', periodEndTs)

  const items = (recordings || []) as any[]
  const fixedCostEur = Number(config.fixed_cost_eur || 0)
  const kwdToEurRate = await getKwdToEurRate()
  const fixedCostKwd = fixedCostEur > 0 ? fixedCostEur / kwdToEurRate : 0
  const venuePct = Number(config.venue_profit_share_pct || 30)
  const ambassadorPct = Number(config.ambassador_pct || 0)

  const venueCollected = items.filter((r) => r.collected_by === 'venue')
  const playhubCollected = items.filter((r) => r.collected_by === 'playhub')

  const venueCollectedRevenue = venueCollected.reduce(
    (sum, r) => sum + (Number(r.billable_amount) || 0),
    0
  )
  const playhubCollectedRevenue = playhubCollected.reduce(
    (sum, r) => sum + (Number(r.billable_amount) || 0),
    0
  )

  // Cost per set of recordings: fixed cost (EUR→KWD) + ambassador % of each price
  function totalCost(recs: any[]) {
    return recs.reduce((sum, r) => {
      const price = Number(r.billable_amount) || 0
      const ambassadorFee = price * (ambassadorPct / 100)
      return sum + fixedCostKwd + ambassadorFee
    }, 0)
  }

  const venueCosts = totalCost(venueCollected)
  const venueProfit = Math.max(0, venueCollectedRevenue - venueCosts)
  const venueKeeps = venueProfit * (venuePct / 100)
  const venueOwesPlayhub = venueCollectedRevenue - venueKeeps

  const playhubCosts = totalCost(playhubCollected)
  const playhubProfit = Math.max(0, playhubCollectedRevenue - playhubCosts)
  const playhubOwesVenue = playhubProfit * (venuePct / 100)

  const netAmount = venueOwesPlayhub - playhubOwesVenue

  const periodLabel = new Date(year, month - 1).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
  })

  const html = renderInvoiceEmailHtml({
    venueName: org.name,
    periodLabel,
    currency: config.currency || 'KWD',
    fixedCostPerRecording: fixedCostKwd,
    ambassadorPct,
    venueProfitSharePct: venuePct,
    venueCollectedCount: venueCollected.length,
    venueCollectedRevenue,
    venueOwesPlayhub,
    playhubCollectedCount: playhubCollected.length,
    playhubCollectedRevenue,
    playhubOwesVenue,
    netAmount,
  })

  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
