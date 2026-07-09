// Shared invoice generation logic
// Used by the POST /api/venue/[venueId]/billing/invoices route
// and the monthly-invoicing Lambda
//
// Ordering invariant (read this before changing the function):
//   1. Compute amounts + per-recording line items
//   2. Insert invoice row as 'draft' with stripe_invoice_id = null
//   3. Insert one playhub_invoice_line_items row per recording (cost basis snapshot)
//   4. If a Stripe customer is set and net > 0, create + finalize a Stripe invoice
//      using idempotency keys derived from (venueId, year, month)
//   5. On Stripe success, update invoice row to 'pending' + stripe_invoice_id
//   6. On Stripe failure, leave row as 'draft' — no orphan finalized invoice
//
// This guarantees: a finalized Stripe invoice never exists without a matching
// PLAYHUB DB row, and per-recording cost is frozen at generation time so future
// edits to billing config or recording prices do not move closed periods.

import Stripe from 'stripe'
import { sendInvoiceEmail } from '@/lib/email'
import { stripeMinorAmount } from '@/lib/billing/currency'
import {
  resolveGroupId,
  isGroupTiered,
  computeSharePct,
  sportForBilling,
  grossForRecording,
  DEFAULT_SHARE_PCT,
  type Sport,
} from '@/lib/billing/share-tier'

export interface InvoiceResult {
  invoice: any
  recordingCount: number
}

export interface GenerateInvoiceDeps {
  supabase: any
  stripe: Stripe
}

interface LineItemSnapshot {
  recording_id: string
  recording_title: string | null
  recording_match_date: string | null
  duration_seconds: number
  sport: Sport | null
  gross_amount: number
  partner_share_pct: number
  partner_share: number
  playback_share: number
  currency: string
  collected_by: 'venue' | 'playhub'
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
    .select(
      'id, title, match_date, billable_amount, collected_by, duration_seconds, spiideo_game_id, clutch_video_id'
    )
    .eq('organization_id', venueId)
    .eq('is_billable', true)
    .eq('status', 'published')
    .gte('created_at', periodStartTs)
    .lte('created_at', periodEndTs)

  const items = recordings || []
  const venueCurrency = (config.currency || 'KWD').trim().toUpperCase()
  const defaultAmount = Number(config.default_billable_amount) || 5

  // Resolve the partner (group) revenue share per the Li3ib annex. Tiered groups
  // get 15%/5% of gross by monthly utilisation per sport; non-tiered groups get
  // a flat 5%. Tier %s are computed ONCE for the whole month (portfolio-level) so
  // every recording in this invoice snapshots a consistent rate.
  const groupId = await resolveGroupId(supabase, venueId)
  const tiered = await isGroupTiered(supabase, groupId)
  const tierPctBySport: Record<Sport, number> | null = tiered
    ? {
        football: await computeSharePct(
          supabase,
          groupId,
          year,
          month,
          'football'
        ),
        padel: await computeSharePct(supabase, groupId, year, month, 'padel'),
      }
    : null

  // Build per-recording snapshots in a single pass. Each line item freezes the
  // gross amount, the sport, the partner share % that applied this month, and
  // the resulting split. Future edits to camera counts or recordings cannot move
  // these once persisted.
  // Bad collected_by values throw rather than silently coercing to 'playhub' —
  // a typo or null in the source row would otherwise misallocate revenue
  // between the venue-collected and PLAYHUB-collected ledgers.
  const lineItems: LineItemSnapshot[] = items.map((r: any) => {
    if (r.collected_by !== 'venue' && r.collected_by !== 'playhub') {
      throw new Error(
        `Recording ${r.id} has invalid collected_by value: ${JSON.stringify(r.collected_by)}. Expected 'venue' or 'playhub'.`
      )
    }
    const seconds = r.duration_seconds ?? 3600
    // Explicit 0 stays 0 (free recording); only null/undefined falls back.
    const gross = grossForRecording(r.billable_amount, defaultAmount)
    // Sport is only needed to pick a tier; non-tiered groups (and recordings
    // with no provider discriminator, e.g. hosted/YouTube) apply the flat rate.
    const sport = tiered ? sportForBilling(r) : null
    const pct = tiered && sport ? tierPctBySport![sport] : DEFAULT_SHARE_PCT
    // Round each split to the currency's 3-decimal precision so the persisted
    // line items sum exactly to the header totals (round-then-sum).
    const partnerShare = Number((gross * (pct / 100)).toFixed(3))
    return {
      recording_id: r.id,
      recording_title: r.title ?? null,
      recording_match_date: r.match_date ?? null,
      duration_seconds: Number(seconds) || 3600,
      sport,
      gross_amount: Number(gross.toFixed(3)),
      partner_share_pct: pct,
      partner_share: partnerShare,
      playback_share: Number((gross - partnerShare).toFixed(3)),
      currency: venueCurrency,
      collected_by: r.collected_by,
    }
  })

  // Aggregate from line items so totals reconcile exactly with the persisted snapshots.
  const venueLines = lineItems.filter((l) => l.collected_by === 'venue')
  const playhubLines = lineItems.filter((l) => l.collected_by === 'playhub')

  const venueCollectedRevenue = venueLines.reduce(
    (s, l) => s + l.gross_amount,
    0
  )
  const playhubCollectedRevenue = playhubLines.reduce(
    (s, l) => s + l.gross_amount,
    0
  )

  // Settlement (share of gross, no cost deduction):
  //  - venue-collected: partner holds the cash, so owes PLAYBACK the playback share
  //  - online-collected: PLAYBACK holds the cash, so owes the partner the partner share
  const venueOwesPlayhub = venueLines.reduce((s, l) => s + l.playback_share, 0)
  const playhubOwesVenue = playhubLines.reduce((s, l) => s + l.partner_share, 0)

  // Net: positive = venue owes PLAYHUB, negative = PLAYHUB owes venue
  const netAmount = venueOwesPlayhub - playhubOwesVenue

  // Totals for the email template.
  const grossRevenue = venueCollectedRevenue + playhubCollectedRevenue
  const partnerShareTotal = lineItems.reduce((s, l) => s + l.partner_share, 0)
  const playbackShareTotal = lineItems.reduce((s, l) => s + l.playback_share, 0)
  const sharePctFootball = tierPctBySport?.football ?? DEFAULT_SHARE_PCT
  const sharePctPadel = tierPctBySport?.padel ?? DEFAULT_SHARE_PCT

  // ─── DB-FIRST ORDERING ───────────────────────────────────────────────
  // 1. Insert invoice row as 'draft' with no Stripe ID. If Stripe creation
  //    fails later, the row stays as draft and no orphaned Stripe invoice
  //    exists. Idempotent retry on the next run is blocked by the duplicate
  //    check above; manual retry can clear the draft and re-run.
  const { data: invoice, error: insertError } = await supabase
    .from('playhub_venue_invoices')
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
      stripe_invoice_id: null,
      status: 'draft',
    })
    .select()
    .single()

  if (insertError) {
    throw new Error(`Failed to insert invoice: ${insertError.message}`)
  }

  // 2. Persist line-item snapshots. Failure is fatal: an invoice without its
  //    breakdown is a silent data-corruption time bomb (admin opens the detail
  //    page weeks later, no rows). Roll back the invoice insert and throw so
  //    the caller (route or Lambda) sees a clear failure and can retry.
  if (lineItems.length > 0) {
    const { error: lineItemsError } = await supabase
      .from('playhub_invoice_line_items')
      .insert(
        lineItems.map((l) => ({
          invoice_id: invoice.id,
          recording_id: l.recording_id,
          recording_title: l.recording_title,
          recording_match_date: l.recording_match_date,
          duration_seconds: l.duration_seconds,
          // billable_amount == gross under the share-of-gross model; keep it
          // populated so the historical column stays meaningful.
          billable_amount: Number(l.gross_amount.toFixed(3)),
          sport: l.sport,
          gross_amount: Number(l.gross_amount.toFixed(3)),
          partner_share_pct: Number(l.partner_share_pct.toFixed(2)),
          partner_share: Number(l.partner_share.toFixed(3)),
          playback_share: Number(l.playback_share.toFixed(3)),
          currency: l.currency,
          collected_by: l.collected_by,
          // Legacy cost-recovery columns — not applicable under this model.
          fixed_cost_local: null,
          ambassador_fee: null,
          fixed_cost_eur_per_hour: null,
          fx_rate: null,
        }))
      )

    if (lineItemsError) {
      console.error(
        `[invoice ${invoice.id}] line-items insert failed for venue=${venueId} period=${periodStart} count=${lineItems.length}:`,
        lineItemsError
      )
      // Roll back the invoice header — cascading FK on line_items is moot
      // since we never inserted any. Stripe has not been called yet.
      await supabase
        .from('playhub_venue_invoices')
        .delete()
        .eq('id', invoice.id)
      throw new Error(
        `Failed to insert invoice line items for venue ${venueId} period ${periodStart}: ${lineItemsError.message}`
      )
    }
  }

  // 3. Optionally create + finalize a Stripe invoice. Idempotency keys are
  //    derived from (venueId, year, month) so retries resolve to the same
  //    Stripe invoice rather than creating duplicates.
  let stripeInvoiceId: string | null = null
  let stripeInvoiceUrl: string | null = null
  // Guard on the rounded minor-unit amount, not the raw float: a sub-milli net
  // (0 < net < 0.0005 KWD) rounds to 0 minor units and must not create a
  // zero-amount Stripe invoice.
  const stripeAmount = stripeMinorAmount(netAmount, venueCurrency)
  if (config.stripe_customer_id && stripeAmount > 0) {
    try {
      const periodLabel = new Date(periodStart).toLocaleDateString('en-GB', {
        month: 'long',
        year: 'numeric',
      })
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

      // 4. On Stripe success, promote draft → pending and store the Stripe ID.
      const { error: updateError } = await supabase
        .from('playhub_venue_invoices')
        .update({
          stripe_invoice_id: stripeInvoiceId,
          status: 'pending',
        })
        .eq('id', invoice.id)

      if (updateError) {
        // Recovery surface: the Stripe invoice is finalised and will be sent
        // to the customer. The PLAYHUB DB row is stuck as 'draft' with
        // stripe_invoice_id = null. Manually run:
        //   UPDATE playhub_venue_invoices
        //   SET stripe_invoice_id = '<stripeInvoiceId>', status = 'pending'
        //   WHERE id = '<invoice.id>';
        console.error(
          `[invoice ${invoice.id}] Stripe finalised but DB update failed — manual recovery required. ` +
            `venue=${venueId} period=${periodStart} stripe_invoice_id=${stripeInvoiceId} url=${stripeInvoiceUrl}`,
          updateError
        )
      } else {
        invoice.stripe_invoice_id = stripeInvoiceId
        invoice.status = 'pending'
      }
    } catch (err) {
      console.error('Stripe invoice creation failed:', err)
      // Row remains as draft — caller can manually retry or void the row.
    }
  }

  // Send email notification to venue admins
  try {
    await notifyVenueAdmins(supabase, venueId, {
      currency: venueCurrency,
      periodStart,
      stripeInvoiceUrl,
      tiered,
      sharePctFootball,
      sharePctPadel,
      grossRevenue,
      partnerShareTotal,
      playbackShareTotal,
      venueCollectedCount: venueLines.length,
      venueCollectedRevenue,
      venueOwesPlayhub,
      playhubCollectedCount: playhubLines.length,
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
    .in('role', ['admin', 'manager', 'club_admin', 'league_admin'])
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
      tiered: details.tiered,
      sharePctFootball: details.sharePctFootball,
      sharePctPadel: details.sharePctPadel,
      grossRevenue: details.grossRevenue,
      partnerShareTotal: details.partnerShareTotal,
      playbackShareTotal: details.playbackShareTotal,
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
