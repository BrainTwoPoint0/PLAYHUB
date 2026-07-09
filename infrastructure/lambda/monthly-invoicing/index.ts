// Lambda function to generate monthly invoices for all active venues
// Triggered by EventBridge on the 1st of every month at 9am UTC
// Invoices the PREVIOUS month (e.g. runs March 1st → invoices February)

import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
// Dependency-free shared modules (no `@/` aliases), safe to bundle into the Lambda.
import {
  resolveGroupId,
  isGroupTiered,
  computeSharePct,
  sportForBilling,
  grossForRecording,
  DEFAULT_SHARE_PCT,
  type Sport,
} from '../../../src/lib/billing/share-tier'
import { stripeMinorAmount } from '../../../src/lib/billing/currency'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY!
const RESEND_API_KEY = process.env.RESEND_API_KEY!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2025-02-24.acacia' as any,
})

const FROM_EMAIL = 'PLAYHUB <admin@playbacksports.ai>'

// Per-run memo for the portfolio tier %, keyed by (group, year, month, sport).
// The tier is a group-level property, so every sibling venue in one run shares
// it — this both avoids re-scanning the portfolio per venue and guarantees
// siblings snapshot the SAME tier for the month.
type TierCache = Map<string, number>
async function tierPct(
  cache: TierCache,
  groupId: string,
  year: number,
  month: number,
  sport: Sport
): Promise<number> {
  const key = `${groupId}:${year}:${month}:${sport}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const pct = await computeSharePct(supabase, groupId, year, month, sport)
  cache.set(key, pct)
  return pct
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
  const tierCache: TierCache = new Map()

  for (const config of configs as any[]) {
    const venueId = config.organization_id
    const venueName = config.organizations?.name || venueId

    try {
      const result = await generateInvoiceForVenue(
        venueId,
        year,
        month,
        config,
        tierCache
      )

      if (result) {
        results.push({
          venueId,
          venueName,
          status: 'created',
          netAmount: result.netAmount,
          recordingCount: result.recordingCount,
        })

        // Email is best-effort: a notification failure must NOT flip an
        // already-created invoice to 'error' (which would prompt a manual
        // re-run and risk a duplicate).
        try {
          await notifyAdmins(venueId, venueName, year, month, result)
        } catch (emailErr) {
          console.error(`Invoice emails failed for venue ${venueId}:`, emailErr)
        }
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
  config: any,
  tierCache: TierCache
): Promise<InvoiceBreakdown | null> {
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

  // Query billable recordings (provider ids drive the sport tier)
  const { data: recordings } = await supabase
    .from('playhub_match_recordings' as any)
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

  // Resolve the partner (group) share per the Li3ib annex: tiered groups get
  // 15%/5% of gross by monthly utilisation per sport; others a flat 5%.
  const groupId = await resolveGroupId(supabase, venueId)
  const tiered = await isGroupTiered(supabase, groupId)
  const footballPct = tiered
    ? await tierPct(tierCache, groupId, year, month, 'football')
    : DEFAULT_SHARE_PCT
  const padelPct = tiered
    ? await tierPct(tierCache, groupId, year, month, 'padel')
    : DEFAULT_SHARE_PCT

  const shareOf = (r: any) => {
    const gross = grossForRecording(r.billable_amount, defaultAmount)
    const sport = tiered ? sportForBilling(r) : null
    const pct =
      sport === 'football'
        ? footballPct
        : sport === 'padel'
          ? padelPct
          : DEFAULT_SHARE_PCT
    const partner = Number((gross * (pct / 100)).toFixed(3))
    return {
      gross: Number(gross.toFixed(3)),
      partner,
      playback: Number((gross - partner).toFixed(3)),
      // Anything not explicitly online-collected settles as venue-collected.
      online: r.collected_by === 'playhub',
    }
  }

  const lines = items.map(shareOf)
  const venueLines = lines.filter((l) => !l.online)
  const playhubLines = lines.filter((l) => l.online)

  const venueCollectedRevenue = venueLines.reduce((s, l) => s + l.gross, 0)
  const playhubCollectedRevenue = playhubLines.reduce((s, l) => s + l.gross, 0)
  // venue-collected → partner owes PLAYBACK the playback share;
  // online-collected → PLAYBACK owes the partner the partner share.
  const venueOwesPlayhub = venueLines.reduce((s, l) => s + l.playback, 0)
  const playhubOwesVenue = playhubLines.reduce((s, l) => s + l.partner, 0)
  const netAmount = venueOwesPlayhub - playhubOwesVenue

  const grossRevenue = venueCollectedRevenue + playhubCollectedRevenue
  const partnerShareTotal = lines.reduce((s, l) => s + l.partner, 0)
  const playbackShareTotal = lines.reduce((s, l) => s + l.playback, 0)

  // Create and finalize Stripe invoice. Round to a Stripe-valid minor amount
  // (3-decimal currencies must be multiples of 10) and guard on the rounded value.
  let stripeInvoiceId: string | null = null
  let stripeInvoiceUrl: string | null = null
  const stripeAmount = stripeMinorAmount(netAmount, venueCurrency)
  if (config.stripe_customer_id && stripeAmount > 0) {
    const periodLabel = new Date(periodStart).toLocaleDateString('en-GB', {
      month: 'long',
      year: 'numeric',
    })
    // Idempotency keys scoped to (venue, month) so an EventBridge retry that
    // re-enters this venue before its DB row exists resolves to the SAME Stripe
    // invoice instead of billing the customer twice.
    const idempotencyBase = `invoice:${venueId}:${year}:${String(month).padStart(2, '0')}`

    const stripeInvoice = await stripe.invoices.create(
      {
        customer: config.stripe_customer_id,
        collection_method: 'send_invoice',
        days_until_due: 30,
        currency: venueCurrency.toLowerCase(),
      },
      { idempotencyKey: `${idempotencyBase}:create` }
    )

    await stripe.invoiceItems.create(
      {
        customer: config.stripe_customer_id,
        invoice: stripeInvoice.id,
        amount: stripeAmount,
        currency: venueCurrency.toLowerCase(),
        description: `PLAYHUB net settlement - ${items.length} recording${items.length === 1 ? '' : 's'} (${periodLabel})`,
      },
      { idempotencyKey: `${idempotencyBase}:item` }
    )

    const finalized = await stripe.invoices.finalizeInvoice(
      stripeInvoice.id,
      undefined,
      { idempotencyKey: `${idempotencyBase}:finalize` }
    )
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
      venue_collected_count: venueLines.length,
      venue_collected_revenue: Number(venueCollectedRevenue.toFixed(3)),
      venue_owes_playhub: Number(venueOwesPlayhub.toFixed(3)),
      playhub_collected_count: playhubLines.length,
      playhub_collected_revenue: Number(playhubCollectedRevenue.toFixed(3)),
      playhub_owes_venue: Number(playhubOwesVenue.toFixed(3)),
      net_amount: Number(netAmount.toFixed(3)),
      currency: venueCurrency,
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
    tiered,
    sharePctFootball: footballPct,
    sharePctPadel: padelPct,
    grossRevenue,
    partnerShareTotal,
    playbackShareTotal,
    venueCollectedCount: venueLines.length,
    venueCollectedRevenue,
    venueOwesPlayhub,
    playhubCollectedCount: playhubLines.length,
    playhubCollectedRevenue,
    playhubOwesVenue,
    currency: venueCurrency,
  }
}

interface InvoiceBreakdown {
  netAmount: number
  recordingCount: number
  stripeInvoiceUrl: string | null
  tiered: boolean
  sharePctFootball: number
  sharePctPadel: number
  grossRevenue: number
  partnerShareTotal: number
  playbackShareTotal: number
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
  const totalRevenue = result.grossRevenue
  const shareLabel =
    !result.tiered || result.sharePctFootball === result.sharePctPadel
      ? `${result.sharePctFootball}%`
      : `${result.sharePctFootball}% football / ${result.sharePctPadel}% padel`

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
                  <p style="font-size:13px;font-weight:600;color:#b9baa3;margin:0 0 10px 0;text-transform:uppercase;letter-spacing:0.5px;">Revenue share</p>
                  <table style="width:100%;border-collapse:collapse;font-size:14px;">
                    <tr><td style="padding:4px 0;color:#b9baa3;">Gross revenue</td><td style="padding:4px 0;text-align:right;">${fmt(totalRevenue)}</td></tr>
                    <tr><td style="padding:4px 0;color:#d6d5c9;font-weight:500;">Your share (${shareLabel})</td><td style="padding:4px 0;text-align:right;font-weight:500;">${fmt(result.partnerShareTotal)}</td></tr>
                    <tr><td style="padding:4px 0;color:#b9baa3;">PLAYBACK share</td><td style="padding:4px 0;text-align:right;">${fmt(result.playbackShareTotal)}</td></tr>
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
