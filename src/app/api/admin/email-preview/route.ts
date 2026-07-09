// GET /api/admin/email-preview?template=invoice&venueId=xxx&year=2026&month=2
// Pass venueId to auto-calculate from real data (year/month default to current)
// Or pass manual params for sample preview
// Platform admin only

import { getAuthUserStrict, createServiceClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { NextRequest, NextResponse } from 'next/server'
import { renderInvoiceEmailHtml } from '@/lib/email'
import {
  resolveGroupId,
  isGroupTiered,
  computeSharePct,
  sportForBilling,
  grossForRecording,
  DEFAULT_SHARE_PCT,
  type Sport,
} from '@/lib/billing/share-tier'

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
    const sharePct = Number(p.get('sharePct') || String(DEFAULT_SHARE_PCT))
    const grossRevenue = Number(p.get('grossRevenue') || '120')
    const partnerShareTotal = Number(
      p.get('partnerShare') || (grossRevenue * (sharePct / 100)).toFixed(3)
    )
    const html = renderInvoiceEmailHtml({
      venueName: p.get('venueName') || 'CFA Indoor Arena',
      periodLabel: p.get('period') || 'February 2026',
      currency: p.get('currency') || 'KWD',
      stripeInvoiceUrl:
        p.get('stripeUrl') || 'https://invoice.stripe.com/example',
      tiered: p.get('tiered') === 'true',
      sharePctFootball: Number(p.get('sharePctFootball') || String(sharePct)),
      sharePctPadel: Number(p.get('sharePctPadel') || String(sharePct)),
      grossRevenue,
      partnerShareTotal,
      playbackShareTotal: grossRevenue - partnerShareTotal,
      venueCollectedCount: Number(p.get('venueCount') || '18'),
      venueCollectedRevenue: Number(p.get('venueRevenue') || '90'),
      venueOwesPlayhub: Number(p.get('venueOwes') || '85.5'),
      playhubCollectedCount: Number(p.get('playhubCount') || '6'),
      playhubCollectedRevenue: Number(p.get('playhubRevenue') || '30'),
      playhubOwesVenue: Number(p.get('playhubOwes') || '1.5'),
      netAmount: Number(p.get('amount') || '84'),
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
  const serviceClient = createServiceClient() as any

  // Get venue name
  const { data: org } = await serviceClient
    .from('organizations')
    .select('name')
    .eq('id', venueId)
    .single()

  if (!org) {
    return NextResponse.json({ error: 'Venue not found' }, { status: 404 })
  }

  // Get billing config
  const { data: config } = await serviceClient
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
  const { data: recordings } = await serviceClient
    .from('playhub_match_recordings')
    .select(
      'id, title, billable_amount, collected_by, spiideo_game_id, clutch_video_id'
    )
    .eq('organization_id', venueId)
    .eq('is_billable', true)
    .eq('status', 'published')
    .gte('created_at', periodStartTs)
    .lte('created_at', periodEndTs)

  const items = (recordings || []) as any[]
  const venueCurrency = (config.currency || 'KWD').trim().toUpperCase()
  const defaultAmount = Number(config.default_billable_amount) || 5

  // Resolve partner share via the shared tiering module (matches generate-invoice).
  const groupId = await resolveGroupId(serviceClient, venueId)
  const tiered = await isGroupTiered(serviceClient, groupId)
  const tierPctBySport: Record<Sport, number> | null = tiered
    ? {
        football: await computeSharePct(
          serviceClient,
          groupId,
          year,
          month,
          'football'
        ),
        padel: await computeSharePct(
          serviceClient,
          groupId,
          year,
          month,
          'padel'
        ),
      }
    : null

  const shareOf = (r: any): { gross: number; partner: number } => {
    const gross = grossForRecording(r.billable_amount, defaultAmount)
    const sport = tiered ? sportForBilling(r) : null
    const pct = tiered && sport ? tierPctBySport![sport] : DEFAULT_SHARE_PCT
    return { gross, partner: gross * (pct / 100) }
  }

  const venueCollected = items.filter((r) => r.collected_by !== 'playhub')
  const playhubCollected = items.filter((r) => r.collected_by === 'playhub')

  const sum = (recs: any[], pick: (s: { gross: number; partner: number }) => number) =>
    recs.reduce((acc, r) => acc + pick(shareOf(r)), 0)

  const venueCollectedRevenue = sum(venueCollected, (s) => s.gross)
  const playhubCollectedRevenue = sum(playhubCollected, (s) => s.gross)
  // venue-collected: partner owes PLAYBACK the playback share (gross - partner)
  const venueOwesPlayhub = sum(venueCollected, (s) => s.gross - s.partner)
  // online-collected: PLAYBACK owes partner the partner share
  const playhubOwesVenue = sum(playhubCollected, (s) => s.partner)
  const netAmount = venueOwesPlayhub - playhubOwesVenue

  const grossRevenue = venueCollectedRevenue + playhubCollectedRevenue
  const partnerShareTotal = sum(items, (s) => s.partner)
  const playbackShareTotal = sum(items, (s) => s.gross - s.partner)

  const periodLabel = new Date(year, month - 1).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
  })

  const html = renderInvoiceEmailHtml({
    venueName: org.name,
    periodLabel,
    currency: venueCurrency,
    tiered,
    sharePctFootball: tierPctBySport?.football ?? DEFAULT_SHARE_PCT,
    sharePctPadel: tierPctBySport?.padel ?? DEFAULT_SHARE_PCT,
    grossRevenue,
    partnerShareTotal,
    playbackShareTotal,
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
