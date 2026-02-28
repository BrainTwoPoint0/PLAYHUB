// Shared invoice generation logic
// Used by the POST /api/venue/[venueId]/billing/invoices route
// and the monthly-invoicing Lambda

import Stripe from 'stripe'
import { sendInvoiceEmail } from '@/lib/email'
import { getKwdToEurRate } from '@/lib/fx/rates'

export interface InvoiceResult {
  invoice: any
  recordingCount: number
}

export interface GenerateInvoiceDeps {
  supabase: any
  stripe: Stripe
}

export async function generateMonthlyInvoice(
  venueId: string,
  year: number,
  month: number,
  deps: GenerateInvoiceDeps
): Promise<InvoiceResult | null> {
  const { supabase, stripe } = deps

  // Get billing config
  const { data: config } = await supabase
    .from('playhub_venue_billing_config')
    .select('*')
    .eq('organization_id', venueId)
    .single()

  if (!config) return null

  // Period boundaries
  const periodStart = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const periodEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  const periodStartTs = new Date(`${periodStart}T00:00:00Z`).toISOString()
  const periodEndTs = new Date(`${periodEnd}T23:59:59Z`).toISOString()

  // Check for duplicate
  const { data: existing } = await supabase
    .from('playhub_venue_invoices')
    .select('id')
    .eq('organization_id', venueId)
    .eq('period_start', periodStart)
    .eq('period_end', periodEnd)
    .maybeSingle()

  if (existing) return null

  // Query billable recordings for the period
  const { data: recordings } = await supabase
    .from('playhub_match_recordings')
    .select('id, title, billable_amount, collected_by')
    .eq('organization_id', venueId)
    .eq('is_billable', true)
    .gte('created_at', periodStartTs)
    .lte('created_at', periodEndTs)

  const items = recordings || []
  const fixedCostEur = Number(config.fixed_cost_eur || 0)
  const kwdToEurRate = await getKwdToEurRate()
  const fixedCostKwd = fixedCostEur > 0 ? fixedCostEur / kwdToEurRate : 0
  const venuePct = Number(config.venue_profit_share_pct || 30)
  const ambassadorPct = Number(config.ambassador_pct || 0)

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

  // Cost per set of recordings: fixed cost (EUR→KWD) + ambassador % of each price
  function totalCost(recs: any[]) {
    return recs.reduce((sum: number, r: any) => {
      const price = Number(r.billable_amount) || 0
      const ambassadorFee = price * (ambassadorPct / 100)
      return sum + fixedCostKwd + ambassadorFee
    }, 0)
  }

  // Venue-collected: deduct costs, then split profit
  const venueCosts = totalCost(venueCollected)
  const venueProfit = Math.max(0, venueCollectedRevenue - venueCosts)
  const venueKeeps = venueProfit * (venuePct / 100)
  const venueOwesPlayhub = venueCollectedRevenue - venueKeeps

  // PLAYHUB-collected: deduct costs, then split profit
  const playhubCosts = totalCost(playhubCollected)
  const playhubProfit = Math.max(0, playhubCollectedRevenue - playhubCosts)
  const playhubOwesVenue = playhubProfit * (venuePct / 100)

  // Net: positive = venue owes PLAYHUB, negative = PLAYHUB owes venue
  const netAmount = venueOwesPlayhub - playhubOwesVenue

  // Create and finalize Stripe invoice if customer is configured and venue owes
  let stripeInvoiceId: string | null = null
  let stripeInvoiceUrl: string | null = null
  if (config.stripe_customer_id && netAmount > 0) {
    try {
      const periodLabel = new Date(periodStart).toLocaleDateString('en-GB', {
        month: 'long',
        year: 'numeric',
      })

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
        description: `PLAYHUB net settlement - ${items.length} recording${items.length === 1 ? '' : 's'} (${periodLabel})`,
      })

      // Finalize so Stripe sends the payment request
      const finalized = await stripe.invoices.finalizeInvoice(stripeInvoice.id)

      stripeInvoiceId = stripeInvoice.id
      stripeInvoiceUrl = finalized.hosted_invoice_url || null
    } catch (err) {
      console.error('Stripe invoice creation failed:', err)
    }
  }

  // Insert invoice record
  const { data: invoice, error: insertError } = await supabase
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
    throw new Error(`Failed to insert invoice: ${insertError.message}`)
  }

  // Send email notification to venue admins
  try {
    await notifyVenueAdmins(supabase, venueId, {
      currency: config.currency,
      periodStart,
      stripeInvoiceUrl,
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
  } catch (err) {
    // Don't fail the invoice for email errors
    console.error('Failed to send invoice emails:', err)
  }

  return { invoice, recordingCount: items.length }
}

async function notifyVenueAdmins(
  supabase: any,
  venueId: string,
  details: {
    currency: string
    periodStart: string
    stripeInvoiceUrl: string | null
    fixedCostPerRecording: number
    ambassadorPct: number
    venueProfitSharePct: number
    venueCollectedCount: number
    venueCollectedRevenue: number
    venueOwesPlayhub: number
    playhubCollectedCount: number
    playhubCollectedRevenue: number
    playhubOwesVenue: number
    netAmount: number
  }
) {
  // Get venue name
  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', venueId)
    .single()

  const venueName = org?.name || 'Your venue'

  // Get admin profile IDs for this venue
  const { data: members } = await supabase
    .from('organization_members')
    .select('profile_id')
    .eq('organization_id', venueId)
    .in('role', ['club_admin', 'league_admin'])
    .eq('is_active', true)

  if (!members || members.length === 0) return

  const profileIds = members.map((m: any) => m.profile_id)

  // Get user_ids from profiles
  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id')
    .in('id', profileIds)

  if (!profiles || profiles.length === 0) return

  const userIds = profiles.map((p: any) => p.user_id).filter(Boolean)

  // Get emails from auth.users via admin API
  // Since we're using service client, we can list users
  const { data: usersData } = await supabase.auth.admin.listUsers()
  const adminEmails: string[] = []
  if (usersData?.users) {
    for (const u of usersData.users) {
      if (userIds.includes(u.id) && u.email) {
        adminEmails.push(u.email)
      }
    }
  }

  const periodLabel = new Date(details.periodStart).toLocaleDateString(
    'en-GB',
    { month: 'long', year: 'numeric' }
  )

  for (const email of adminEmails) {
    await sendInvoiceEmail({
      toEmail: email,
      venueName,
      periodLabel,
      currency: details.currency,
      stripeInvoiceUrl: details.stripeInvoiceUrl || undefined,
      fixedCostPerRecording: details.fixedCostPerRecording,
      ambassadorPct: details.ambassadorPct,
      venueProfitSharePct: details.venueProfitSharePct,
      venueCollectedCount: details.venueCollectedCount,
      venueCollectedRevenue: details.venueCollectedRevenue,
      venueOwesPlayhub: details.venueOwesPlayhub,
      playhubCollectedCount: details.playhubCollectedCount,
      playhubCollectedRevenue: details.playhubCollectedRevenue,
      playhubOwesVenue: details.playhubOwesVenue,
      netAmount: details.netAmount,
    })
  }
}
