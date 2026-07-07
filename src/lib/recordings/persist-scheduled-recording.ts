// Shared persistence for scheduled recordings, provider-agnostic.
// Handles billing-config resolution, the playhub_match_recordings insert,
// optional marketplace product creation, and access-rights grants.
// Providers (Spiideo, Clutch) call this after creating the recording on
// their side, passing the provider-specific IDs.

import { createServiceClient } from '@/lib/supabase/server'

// ── Types ───────────────────────────────────────────────────────────

export interface ScheduleRecordingInput {
  venueId: string
  sceneId: string
  sceneName: string
  durationMinutes: number
  title: string
  description: string
  email?: string
  createdBy?: string // user.id (venue management) or undefined (webhook)
  collectedBy: 'venue' | 'playhub'
  isBillable?: boolean
  billableAmount?: number
  accessEmails?: string[]
  sport?: string
  homeTeam?: string
  awayTeam?: string
  /** ms to add before recording starts. Default 60 000 (self-service). */
  startBufferMs?: number
  /** When provided the start/stop are used as-is (venue management). */
  scheduledStartTime?: string
  scheduledStopTime?: string
  /** Stripe payment intent ID for idempotency on webhook retries. */
  stripePaymentIntentId?: string
  /** When true, the recording will be listed on the org's marketplace page. */
  marketplaceEnabled?: boolean
  /** Price for marketplace purchase (requires marketplaceEnabled). */
  priceAmount?: number
  /** Currency for marketplace price. */
  priceCurrency?: string
  /** Graphic package to attach to the recording. */
  graphicPackageId?: string
  /** Override organization_id (for tenant orgs scheduling at a venue they don't own). */
  ownerOrgId?: string
}

export interface ProviderIds {
  spiideoGameId?: string
  spiideoProductionId?: string
  clutchVideoId?: string
  clutchDeviceId?: string
}

// ── Implementation ──────────────────────────────────────────────────

export async function persistScheduledRecording(
  input: ScheduleRecordingInput,
  providerIds: ProviderIds,
  startTime: string,
  _stopTime: string
): Promise<{ recordingId: string | null }> {
  const {
    venueId,
    sceneName,
    durationMinutes,
    title,
    description,
    email,
    createdBy,
    collectedBy,
    isBillable,
    billableAmount,
    accessEmails = [],
    homeTeam = 'Home',
    awayTeam = 'Away',
  } = input

  // 1. Fetch billing config from DB
  const serviceClient = createServiceClient() as any

  const { data: billingConfig } = await serviceClient
    .from('playhub_venue_billing_config')
    .select('default_billable_amount, currency')
    .eq('organization_id', venueId)
    .maybeSingle()

  // 2. Insert recording row.
  //
  // billable_amount precedence:
  //   1. Caller-supplied billableAmount (already-priced upstream — e.g. the QR
  //      flow that does pricePerHour × hours before calling here) → use as-is
  //   2. billingConfig.default_billable_amount → treated as PER-HOUR rate and
  //      scaled by recording duration. This matches /api/start/[cameraId] so
  //      admin-scheduled and QR-paid bookings price the same way.
  //   3. null when no config is set.
  const fallbackHourlyRate =
    billingConfig?.default_billable_amount != null
      ? Number(billingConfig.default_billable_amount)
      : null
  const scaledFallback =
    fallbackHourlyRate !== null
      ? Number(((fallbackHourlyRate * durationMinutes) / 60).toFixed(3))
      : null
  const resolvedBillableAmount = billableAmount ?? scaledFallback

  const { data: recording, error: recordingError } = await serviceClient
    .from('playhub_match_recordings')
    .insert({
      organization_id: input.ownerOrgId || venueId,
      venue_organization_id: venueId,
      ...(providerIds.spiideoGameId && {
        spiideo_game_id: providerIds.spiideoGameId,
      }),
      ...(providerIds.spiideoProductionId && {
        spiideo_production_id: providerIds.spiideoProductionId,
      }),
      ...(providerIds.clutchVideoId && {
        clutch_video_id: providerIds.clutchVideoId,
      }),
      ...(providerIds.clutchDeviceId && {
        clutch_device_id: providerIds.clutchDeviceId,
      }),
      title,
      description,
      match_date: startTime,
      home_team: homeTeam,
      away_team: awayTeam,
      pitch_name: sceneName || null,
      status: 'scheduled',
      access_type: 'private_link',
      created_by: createdBy || null,
      stripe_payment_intent_id: input.stripePaymentIntentId || null,
      // Callers that omit isBillable (e.g. the Stripe-paid QR flow, where
      // PLAYHUB already collected the money) must stay non-billable.
      is_billable: isBillable ?? false,
      billable_amount: resolvedBillableAmount,
      billable_currency: billingConfig?.currency ?? 'KWD',
      collected_by: collectedBy,
      duration_seconds: durationMinutes * 60,
      graphic_package_id: input.graphicPackageId || null,
    })
    .select('id')
    .single()

  if (recordingError) {
    console.error('Failed to create recording for booking:', recordingError)
    throw new Error(
      `Failed to create recording in database: ${recordingError.message}`
    )
  }

  // 2b. If marketplace-enabled, create a product row for purchasing
  if (input.marketplaceEnabled && recording?.id && input.priceAmount) {
    const { error: productError } = await serviceClient
      .from('playhub_products')
      .insert({
        match_recording_id: recording.id,
        name: title,
        description: description || null,
        price_amount: input.priceAmount,
        currency: input.priceCurrency || 'AED',
        is_available: true,
      })

    if (productError) {
      console.error('Failed to create marketplace product:', productError)
    }

    // Also flag the recording as marketplace-enabled
    await serviceClient
      .from('playhub_match_recordings')
      .update({ marketplace_enabled: true })
      .eq('id', recording.id)
  }

  // 3. Grant access via email(s)
  const allEmails = [...accessEmails]
  if (email && !allEmails.includes(email.toLowerCase().trim())) {
    allEmails.push(email.toLowerCase().trim())
  }

  if (recording?.id && allEmails.length > 0) {
    const accessInserts = allEmails.map((e) => ({
      match_recording_id: recording.id,
      invited_email: e.toLowerCase().trim(),
      granted_by: createdBy || null,
      granted_at: new Date().toISOString(),
      is_active: true,
      notes: collectedBy === 'playhub' ? 'Self-service QR booking' : undefined,
    }))

    await serviceClient.from('playhub_access_rights').insert(accessInserts)
  }

  return { recordingId: recording?.id ?? null }
}

/** Computes start/stop times from the shared scheduling input. */
export function resolveRecordingWindow(input: ScheduleRecordingInput): {
  startTime: string
  stopTime: string
} {
  if (input.scheduledStartTime && input.scheduledStopTime) {
    return {
      startTime: input.scheduledStartTime,
      stopTime: input.scheduledStopTime,
    }
  }

  const start = new Date(Date.now() + (input.startBufferMs ?? 60_000))
  const durationMs = input.durationMinutes * 60 * 1000
  return {
    startTime: start.toISOString(),
    stopTime: new Date(start.getTime() + durationMs).toISOString(),
  }
}
