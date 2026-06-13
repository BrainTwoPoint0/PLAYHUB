// Shared helper: schedule a Clutch Cam recording and persist it in Supabase.
// Mirrors the Spiideo scheduleRecording flow; sceneId is the Clutch device_id.

import { cancelVideo, scheduleDeviceRecording } from '@/lib/clutch/client'
import {
  persistScheduledRecording,
  resolveRecordingWindow,
  type ScheduleRecordingInput,
} from '@/lib/recordings/persist-scheduled-recording'

export interface ScheduleClutchRecordingResult {
  videoId: string
  deviceId: string
  recordingId: string | null
  startTime: string
  stopTime: string
}

export async function scheduleClutchRecording(
  input: ScheduleRecordingInput
): Promise<ScheduleClutchRecordingResult> {
  const deviceId = input.sceneId

  // 1. Calculate start/stop times (same buffer semantics as Spiideo)
  const { startTime, stopTime } = resolveRecordingWindow(input)

  // 2. Schedule on the Clutch camera. ClutchConflictError propagates to the
  // caller so the API layer can surface a 409.
  const scheduled = await scheduleDeviceRecording(
    deviceId,
    startTime,
    input.durationMinutes
  )

  // 3. Persist recording + product + access grants. If this fails we must
  // cancel the Clutch booking: with no list-videos endpoint, an orphaned
  // schedule is undiscoverable and blocks the device slot.
  try {
    const { recordingId } = await persistScheduledRecording(
      input,
      { clutchVideoId: scheduled.videoId, clutchDeviceId: deviceId },
      startTime,
      stopTime
    )

    return {
      videoId: scheduled.videoId,
      deviceId,
      recordingId,
      startTime,
      stopTime,
    }
  } catch (persistError) {
    try {
      await cancelVideo(scheduled.videoId)
    } catch (cancelError) {
      console.error(
        `Failed to cancel orphaned Clutch recording ${scheduled.videoId}:`,
        cancelError
      )
    }
    throw persistError
  }
}
