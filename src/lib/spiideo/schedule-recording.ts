// Shared helper: schedule a Spiideo recording and persist it in Supabase.
// Used by the Stripe webhook (self-service bookings) and the venue management API.

import {
  createGame,
  createProduction,
  getAccountConfig,
} from '@/lib/spiideo/client'
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
}

export interface ScheduleRecordingResult {
  gameId: string
  productionId: string
  recordingId: string | null
  startTime: string
  stopTime: string
}

// ── Implementation ──────────────────────────────────────────────────

export async function scheduleRecording(
  input: ScheduleRecordingInput
): Promise<ScheduleRecordingResult> {
  const {
    venueId,
    sceneId,
    sceneName,
    durationMinutes,
    title,
    description,
    email,
    createdBy,
    collectedBy,
    isBillable = true,
    billableAmount,
    accessEmails = [],
    sport = 'football',
    homeTeam = 'Home',
    awayTeam = 'Away',
    startBufferMs = 60_000,
  } = input

  // 1. Calculate start/stop times
  let startTime: string
  let stopTime: string

  if (input.scheduledStartTime && input.scheduledStopTime) {
    startTime = input.scheduledStartTime
    stopTime = input.scheduledStopTime
  } else {
    const now = new Date()
    const start = new Date(now.getTime() + startBufferMs)
    const durationMs = durationMinutes * 60 * 1000
    startTime = start.toISOString()
    stopTime = new Date(start.getTime() + durationMs).toISOString()
  }

  // 2. Create Spiideo game + production
  const spiideoConfig = getAccountConfig('kuwait')
  const game = await createGame({
    accountId: spiideoConfig.accountId!,
    title,
    description,
    sceneId,
    scheduledStartTime: startTime,
    scheduledStopTime: stopTime,
    sport: sport as any,
  })

  const production = await createProduction(game.id, {
    productionType: 'single_game',
    type: 'live',
  })

  // 3. Fetch billing config from DB
  const serviceClient = createServiceClient() as any

  const { data: billingConfig } = await serviceClient
    .from('playhub_venue_billing_config')
    .select('default_billable_amount, currency')
    .eq('organization_id', venueId)
    .maybeSingle()

  // 4. Insert recording row
  const { data: recording, error: recordingError } = await serviceClient
    .from('playhub_match_recordings')
    .insert({
      organization_id: venueId,
      spiideo_game_id: game.id,
      spiideo_production_id: production.id,
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
      is_billable: isBillable,
      billable_amount:
        billableAmount ?? billingConfig?.default_billable_amount ?? null,
      billable_currency: billingConfig?.currency ?? 'KWD',
      collected_by: collectedBy,
    })
    .select('id')
    .single()

  if (recordingError) {
    console.error('Failed to create recording for booking:', recordingError)
  }

  // 5. Grant access via email(s)
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

  return {
    gameId: game.id,
    productionId: production.id,
    recordingId: recording?.id ?? null,
    startTime,
    stopTime,
  }
}
