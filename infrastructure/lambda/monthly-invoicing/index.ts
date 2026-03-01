// Lambda function to generate monthly invoices for all active venues
// Triggered by EventBridge on the 1st of every month at 9am UTC
// Invoices the PREVIOUS month (e.g. runs March 1st → invoices February)

import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY!
const RESEND_API_KEY = process.env.RESEND_API_KEY!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2025-02-24.acacia' as any,
})

const FROM_EMAIL = 'PLAYHUB <admin@playbacksports.ai>'

// FX rate helper (matches src/lib/fx/rates.ts logic)
const FALLBACK_KWD_TO_EUR = 2.75
async function getKwdToEurRate(): Promise<number> {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/KWD', {
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json()
    return data.result === 'success' && data.rates?.EUR
      ? data.rates.EUR
      : FALLBACK_KWD_TO_EUR
  } catch {
    return FALLBACK_KWD_TO_EUR
  }
}

interface InvoiceResult {
  venueId: string
  venueName: string
  status: 'created' | 'skipped' | 'error'
  netAmount?: number
  recordingCount?: number
  error?: string
}

export async function handler() {
  // Calculate previous month
  const now = new Date()
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const year = prevMonth.getFullYear()
  const month = prevMonth.getMonth() + 1 // 1-indexed

  console.log(
    `Generating invoices for ${year}-${String(month).padStart(2, '0')}`
  )

  // Get all active venues with billing config and Stripe customer
  const { data: configs, error: configError } = await supabase
    .from('playhub_venue_billing_config' as any)
    .select('*, organizations!inner(id, name)')
    .not('stripe_customer_id', 'is', null)

  if (configError) {
    console.error('Failed to fetch billing configs:', configError)
    throw configError
  }

  if (!configs || configs.length === 0) {
    console.log('No venues with billing config found')
    return { results: [], month: `${year}-${String(month).padStart(2, '0')}` }
  }

  const results: InvoiceResult[] = []

  for (const config of configs as any[]) {
    const venueId = config.organization_id
    const venueName = config.organizations?.name || venueId

    try {
      const result = await generateInvoiceForVenue(venueId, year, month, config)

      if (result) {
        results.push({
          venueId,
          venueName,
          status: 'created',
          netAmount: result.netAmount,
          recordingCount: result.recordingCount,
        })

        // Send email notifications
        await notifyAdmins(venueId, venueName, year, month, result)
      } else {
        results.push({ venueId, venueName, status: 'skipped' })
      }
    } catch (err: any) {
      console.error(`Invoice failed for venue ${venueId}:`, err)
      results.push({
        venueId,
        venueName,
        status: 'error',
        error: err.message,
      })
    }
  }

  const summary = {
    month: `${year}-${String(month).padStart(2, '0')}`,
    total: results.length,
    created: results.filter((r) => r.status === 'created').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    errors: results.filter((r) => r.status === 'error').length,
    results,
  }

  console.log('Invoice generation complete:', JSON.stringify(summary, null, 2))
  return summary
}

async function generateInvoiceForVenue(
  venueId: string,
  year: number,
  month: number,
  config: any
): Promise<{
  netAmount: number
  recordingCount: number
  stripeInvoiceUrl: string | null
} | null> {
  // Period boundaries
  const periodStart = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const periodEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  const periodStartTs = new Date(`${periodStart}T00:00:00Z`).toISOString()
  const periodEndTs = new Date(`${periodEnd}T23:59:59Z`).toISOString()

  // Check for duplicate
  const { data: existing } = await supabase
    .from('playhub_venue_invoices' as any)
    .select('id')
    .eq('organization_id', venueId)
    .eq('period_start', periodStart)
    .eq('period_end', periodEnd)
    .maybeSingle()

  if (existing) return null

  // Query billable recordings
  const { data: recordings } = await supabase
    .from('playhub_match_recordings' as any)
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

  function totalCost(recs: any[]) {
    return recs.reduce((sum: number, r: any) => {
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

  // Create and finalize Stripe invoice
  let stripeInvoiceId: string | null = null
  let stripeInvoiceUrl: string | null = null
  if (config.stripe_customer_id && netAmount > 0) {
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
      amount: Math.round(netAmount * 1000),
      currency: config.currency.toLowerCase(),
      description: `PLAYHUB net settlement - ${items.length} recording${items.length === 1 ? '' : 's'} (${periodLabel})`,
    })

    const finalized = await stripe.invoices.finalizeInvoice(stripeInvoice.id)
    stripeInvoiceId = stripeInvoice.id
    stripeInvoiceUrl = finalized.hosted_invoice_url || null
  }

  // Insert invoice record
  const { error: insertError } = await supabase
    .from('playhub_venue_invoices' as any)
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
    } as any)

  if (insertError) {
    throw new Error(`Insert failed: ${insertError.message}`)
  }

  return {
    netAmount,
    recordingCount: items.length,
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
    currency: config.currency as string,
  }
}

interface InvoiceBreakdown {
  netAmount: number
  recordingCount: number
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
  currency: string
}

async function notifyAdmins(
  venueId: string,
  venueName: string,
  year: number,
  month: number,
  result: InvoiceBreakdown
) {
  // Get admin profile IDs
  const { data: members } = await supabase
    .from('organization_members')
    .select('profile_id')
    .eq('organization_id', venueId)
    .in('role', ['club_admin', 'league_admin'])
    .eq('is_active', true)

  if (!members || members.length === 0) return

  const profileIds = members.map((m: any) => m.profile_id)

  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id')
    .in('id', profileIds)

  if (!profiles || profiles.length === 0) return

  const userIds = profiles.map((p: any) => p.user_id).filter(Boolean)

  // Get emails via admin API
  const { data: usersData } = await supabase.auth.admin.listUsers()
  const emails: string[] = []
  if (usersData?.users) {
    for (const u of usersData.users) {
      if (userIds.includes(u.id) && u.email) {
        emails.push(u.email)
      }
    }
  }

  if (emails.length === 0) return

  const periodLabel = new Date(year, month - 1).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
  })

  const currency = result.currency || 'KWD'
  const fmt = (n: number) =>
    new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(n)

  const totalCount = result.venueCollectedCount + result.playhubCollectedCount
  const totalRevenue =
    result.venueCollectedRevenue + result.playhubCollectedRevenue
  const totalFixedCosts = result.fixedCostPerRecording * totalCount
  const totalAmbassadorCost = totalRevenue * (result.ambassadorPct / 100)
  const totalProfit = Math.max(
    0,
    totalRevenue - totalFixedCosts - totalAmbassadorCost
  )

  // Build collector breakdown rows
  let venueSection = ''
  if (result.venueCollectedCount > 0) {
    venueSection = `
      <tr><td colspan="2" style="padding:8px 0 4px 0;font-weight:600;font-size:13px;color:#d6d5c9;">Venue-collected</td></tr>
      <tr><td style="padding:4px 0 4px 12px;color:#b9baa3;">Recordings</td><td style="padding:4px 0;text-align:right;">${result.venueCollectedCount}</td></tr>
      <tr><td style="padding:4px 0 4px 12px;color:#b9baa3;">Revenue</td><td style="padding:4px 0;text-align:right;">${fmt(result.venueCollectedRevenue)}</td></tr>
      <tr><td style="padding:4px 0 4px 12px;color:#b9baa3;">Venue owes PLAYHUB</td><td style="padding:4px 0;text-align:right;font-weight:500;">${fmt(result.venueOwesPlayhub)}</td></tr>`
  }
  let playhubSection = ''
  if (result.playhubCollectedCount > 0) {
    playhubSection = `
      <tr><td colspan="2" style="padding:12px 0 4px 0;font-weight:600;font-size:13px;color:#d6d5c9;">PLAYHUB-collected</td></tr>
      <tr><td style="padding:4px 0 4px 12px;color:#b9baa3;">Recordings</td><td style="padding:4px 0;text-align:right;">${result.playhubCollectedCount}</td></tr>
      <tr><td style="padding:4px 0 4px 12px;color:#b9baa3;">Revenue</td><td style="padding:4px 0;text-align:right;">${fmt(result.playhubCollectedRevenue)}</td></tr>
      <tr><td style="padding:4px 0 4px 12px;color:#b9baa3;">PLAYHUB owes venue</td><td style="padding:4px 0;text-align:right;font-weight:500;">-${fmt(result.playhubOwesVenue)}</td></tr>`
  }

  // Send via Resend
  for (const email of emails) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: email,
          subject: `Your PLAYHUB invoice for ${periodLabel}`,
          html: `
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
            <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background-color:#0a100d;color:#d6d5c9;padding:40px 20px;margin:0;">
              <div style="max-width:500px;margin:0 auto;">
                <h1 style="color:#d6d5c9;font-size:24px;margin-bottom:24px;">PLAYHUB</h1>
                <p style="font-size:16px;line-height:1.6;margin-bottom:16px;">Your monthly invoice for <strong>${venueName}</strong> is ready.</p>

                <div style="background-color:#1a1f1c;padding:16px;border-radius:8px;margin-bottom:16px;">
                  <p style="font-size:14px;color:#b9baa3;margin:0 0 12px 0;">${periodLabel}</p>
                  <table style="width:100%;border-collapse:collapse;font-size:14px;">
                    <tr><td style="padding:6px 0;color:#b9baa3;">Total recordings</td><td style="padding:6px 0;text-align:right;font-weight:500;">${totalCount}</td></tr>
                    <tr><td style="padding:6px 0;color:#b9baa3;">Total revenue</td><td style="padding:6px 0;text-align:right;font-weight:500;">${fmt(totalRevenue)}</td></tr>
                  </table>
                </div>

                <div style="background-color:#1a1f1c;padding:16px;border-radius:8px;margin-bottom:16px;">
                  <p style="font-size:13px;font-weight:600;color:#b9baa3;margin:0 0 10px 0;text-transform:uppercase;letter-spacing:0.5px;">Costs</p>
                  <table style="width:100%;border-collapse:collapse;font-size:14px;">
                    <tr><td style="padding:4px 0;color:#b9baa3;">Fixed cost (${totalCount} &times; ${fmt(result.fixedCostPerRecording)})</td><td style="padding:4px 0;text-align:right;">-${fmt(totalFixedCosts)}</td></tr>
                    ${result.ambassadorPct > 0 ? `<tr><td style="padding:4px 0;color:#b9baa3;">Ambassador (${result.ambassadorPct}%)</td><td style="padding:4px 0;text-align:right;">-${fmt(totalAmbassadorCost)}</td></tr>` : ''}
                    <tr><td style="padding:8px 0 4px 0;color:#d6d5c9;font-weight:500;">Profit</td><td style="padding:8px 0 4px 0;text-align:right;font-weight:500;">${fmt(totalProfit)}</td></tr>
                    <tr><td style="padding:4px 0;color:#b9baa3;">Venue share (${result.venueProfitSharePct}%)</td><td style="padding:4px 0;text-align:right;">${fmt(totalProfit * (result.venueProfitSharePct / 100))}</td></tr>
                  </table>
                </div>

                ${
                  venueSection || playhubSection
                    ? `
                <div style="background-color:#1a1f1c;padding:16px;border-radius:8px;margin-bottom:16px;">
                  <p style="font-size:13px;font-weight:600;color:#b9baa3;margin:0 0 10px 0;text-transform:uppercase;letter-spacing:0.5px;">Collection breakdown</p>
                  <table style="width:100%;border-collapse:collapse;font-size:14px;">
                    ${venueSection}
                    ${playhubSection}
                  </table>
                </div>`
                    : ''
                }

                <div style="background-color:#1a1f1c;padding:16px;border-radius:8px;margin-bottom:24px;">
                  <table style="width:100%;border-collapse:collapse;">
                    <tr><td style="font-size:14px;color:#b9baa3;padding:0;">Net settlement</td><td style="font-size:20px;font-weight:600;text-align:right;padding:0;">${fmt(result.netAmount)}</td></tr>
                  </table>
                </div>

                ${result.stripeInvoiceUrl ? `<a href="${result.stripeInvoiceUrl}" style="display:inline-block;background-color:#d6d5c9;color:#0a100d;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:500;">View &amp; pay invoice</a>` : ''}
                <p style="font-size:14px;color:#b9baa3;margin-top:24px;">Payment is due within 30 days.</p>
                <hr style="border:none;border-top:1px solid #333;margin:32px 0;">
                <p style="font-size:12px;color:#b9baa3;">This email was sent by PLAYHUB.</p>
              </div>
            </body>
            </html>
          `,
        }),
      })
    } catch (err) {
      console.error(`Failed to email ${email}:`, err)
    }
  }
}
