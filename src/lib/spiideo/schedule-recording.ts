// Shared helper: schedule a Spiideo recording and persist it in Supabase.
// Used by the Stripe webhook (self-service bookings) and the venue management API.
// Persistence (billing, recording row, marketplace product, access grants)
// lives in the provider-agnostic persistScheduledRecording.

import {
  createGame,
  createProduction,
  getAccountConfig,
} from '@/lib/spiideo/client'
import {
  persistScheduledRecording,
  resolveRecordingWindow,
  type ScheduleRecordingInput,
} from '@/lib/recordings/persist-scheduled-recording'

// Re-export for existing importers
export type { ScheduleRecordingInput } from '@/lib/recordings/persist-scheduled-recording'

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
  const { sceneId, title, description, sport = 'football' } = input

  // 1. Calculate start/stop times
  const { startTime, stopTime } = resolveRecordingWindow(input)

  // 2. Create Spiideo game + production
  const spiideoConfig = getAccountConfig()
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

  // 3. Persist recording + product + access grants
  const { recordingId } = await persistScheduledRecording(
    input,
    { spiideoGameId: game.id, spiideoProductionId: production.id },
    startTime,
    stopTime
  )

  return {
    gameId: game.id,
    productionId: production.id,
    recordingId,
    startTime,
    stopTime,
  }
}
