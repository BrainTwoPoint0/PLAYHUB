// Live integration test against the real Clutch API.
// Validates the documented contract our client was built against:
// schedule → conflict detection → cancel, plus device/video reads.
// Skipped unless CLUTCH_EMAIL/CLUTCH_PASSWORD are set. Cleans up after itself.

import { describe, it, expect, afterAll } from 'vitest'
import {
  ClutchConflictError,
  cancelVideo,
  getDeviceStatus,
  getVideoStatus,
  isClutchConfigured,
  scheduleDeviceRecording,
} from '@/lib/clutch/client'

const TEST_DEVICE_ID = '56e08a79-bec1-486e-92bd-d62c962d7d77'

const scheduledVideoIds: string[] = []

describe.skipIf(!isClutchConfigured())('Clutch Integration', () => {
  afterAll(async () => {
    // Always cancel test bookings so the real camera never records for us
    for (const videoId of scheduledVideoIds) {
      await cancelVideo(videoId).catch(() => {})
    }
  })

  it('reads the test device status', async () => {
    const status = await getDeviceStatus(TEST_DEVICE_ID)
    expect(status.id).toBe(TEST_DEVICE_ID)
    expect(['available', 'unavailable', 'recording']).toContain(status.status)
  })

  it('schedules a recording and reads its status back', async () => {
    // Far enough out that cleanup always wins the race against recording start
    const start = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    const result = await scheduleDeviceRecording(TEST_DEVICE_ID, start, 10)
    scheduledVideoIds.push(result.videoId)

    expect(result.videoId).toBeTruthy()
    expect(result.deviceId).toBe(TEST_DEVICE_ID)

    const videoStatus = await getVideoStatus(result.videoId)
    expect(videoStatus).toBe('SCHEDULED')
  })

  it('rejects an overlapping schedule with ClutchConflictError', async () => {
    // Overlaps the 30-min-out booking from the previous test
    const overlapStart = new Date(Date.now() + 35 * 60 * 1000).toISOString()
    const err = await scheduleDeviceRecording(
      TEST_DEVICE_ID,
      overlapStart,
      10
    ).catch((e) => e)

    if (err instanceof ClutchConflictError) {
      expect(err.conflictingIds.length).toBeGreaterThan(0)
    } else if (err instanceof Error) {
      // Conflict without conflicting_ids payload would surface as plain Error;
      // both prove the API rejected the overlap.
      expect(err.message).toMatch(/conflict|400/i)
    } else {
      // No error means Clutch accepted the overlap — clean it up and fail.
      scheduledVideoIds.push(err.videoId)
      throw new Error('Expected a schedule conflict, got success')
    }
  })

  it('cancels the scheduled recording', async () => {
    const videoId = scheduledVideoIds[0]
    expect(videoId).toBeTruthy()
    await expect(cancelVideo(videoId)).resolves.toBeUndefined()
    scheduledVideoIds.shift()
  })
})
