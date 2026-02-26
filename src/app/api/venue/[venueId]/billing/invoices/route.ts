// GET/POST /api/venue/[venueId]/billing/invoices
// List invoices and generate invoice for a given month

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { isPlatformAdmin } from '@/lib/admin/auth'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
})

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

  const { data: invoices, error } = await serviceClient
    .from('playhub_venue_invoices')
    .select('*')
    .eq('organization_id', venueId)
    .order('period_start', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ invoices: invoices || [] })
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { venueId } = await params
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Platform admin only
  const isPlatform = await isPlatformAdmin(user.id)
  if (!isPlatform) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json()
  const { year, month } = body // month is 1-12

  if (!year || !month) {
    return NextResponse.json(
      { error: 'year and month are required' },
      { status: 400 }
    )
  }

  const serviceClient = createServiceClient() as any

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

  // Period boundaries
  const periodStart = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const periodEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  const periodStartTs = new Date(`${periodStart}T00:00:00Z`).toISOString()
  const periodEndTs = new Date(`${periodEnd}T23:59:59Z`).toISOString()

  // Check for duplicate
  const { data: existing } = await serviceClient
    .from('playhub_venue_invoices')
    .select('id')
    .eq('organization_id', venueId)
    .eq('period_start', periodStart)
    .eq('period_end', periodEnd)
    .maybeSingle()

  if (existing) {
    return NextResponse.json(
      { error: 'Invoice already exists for this period' },
      { status: 409 }
    )
  }

  // Query billable recordings for the period (include collected_by)
  const { data: recordings } = await serviceClient
    .from('playhub_match_recordings')
    .select('id, title, billable_amount, collected_by')
    .eq('organization_id', venueId)
    .eq('is_billable', true)
    .gte('created_at', periodStartTs)
    .lte('created_at', periodEndTs)

  const items = recordings || []
  const fixedCost = Number(config.fixed_cost_per_recording || 0)
  const venuePct = Number(config.venue_profit_share_pct || 30)

  // Split by collector
  const venueCollected = items.filter((r: any) => r.collected_by === 'venue')
  const playhubCollected = items.filter(
    (r: any) => r.collected_by === 'playhub'
  )

  const venueCollectedRevenue = venueCollected.reduce(
    (sum: number, r: any) => sum + (Number(r.billable_amount) || 0),
    0
  )
  const playhubCollectedRevenue = playhubCollected.reduce(
    (sum: number, r: any) => sum + (Number(r.billable_amount) || 0),
    0
  )

  // Venue-collected: venue owes PLAYHUB (revenue minus venue's profit share)
  const venueProfit = Math.max(
    0,
    venueCollectedRevenue - fixedCost * venueCollected.length
  )
  const venueKeeps = venueProfit * (venuePct / 100)
  const venueOwesPlayhub = venueCollectedRevenue - venueKeeps

  // PLAYHUB-collected: PLAYHUB owes venue (venue's profit share)
  const playhubProfit = Math.max(
    0,
    playhubCollectedRevenue - fixedCost * playhubCollected.length
  )
  const playhubOwesVenue = playhubProfit * (venuePct / 100)

  // Net: positive = venue owes PLAYHUB, negative = PLAYHUB owes venue
  const netAmount = venueOwesPlayhub - playhubOwesVenue

  // Create Stripe invoice if customer is configured and venue owes PLAYHUB
  let stripeInvoiceId: string | null = null
  if (config.stripe_customer_id && netAmount > 0) {
    try {
      const stripeInvoice = await stripe.invoices.create({
        customer: config.stripe_customer_id,
        collection_method: 'send_invoice',
        days_until_due: 30,
        currency: config.currency.toLowerCase(),
      })

      await stripe.invoiceItems.create({
        customer: config.stripe_customer_id,
        invoice: stripeInvoice.id,
        amount: Math.round(netAmount * 1000), // KWD uses 3 decimals
        currency: config.currency.toLowerCase(),
        description: `PLAYHUB net settlement - ${items.length} recording${items.length === 1 ? '' : 's'} (${new Date(periodStart).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })})`,
      })

      stripeInvoiceId = stripeInvoice.id
    } catch (err) {
      console.error('Stripe invoice creation failed:', err)
    }
  }

  // Insert invoice record
  const { data: invoice, error: insertError } = await serviceClient
    .from('playhub_venue_invoices')
    .insert({
      organization_id: venueId,
      period_start: periodStart,
      period_end: periodEnd,
      venue_collected_count: venueCollected.length,
      venue_collected_revenue: Number(venueCollectedRevenue.toFixed(3)),
      venue_owes_playhub: Number(venueOwesPlayhub.toFixed(3)),
      playhub_collected_count: playhubCollected.length,
      playhub_collected_revenue: Number(playhubCollectedRevenue.toFixed(3)),
      playhub_owes_venue: Number(playhubOwesVenue.toFixed(3)),
      net_amount: Number(netAmount.toFixed(3)),
      currency: config.currency,
      stripe_invoice_id: stripeInvoiceId,
      status: stripeInvoiceId ? 'pending' : 'draft',
    })
    .select()
    .single()

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  return NextResponse.json({ invoice, recordingCount: items.length })
}
