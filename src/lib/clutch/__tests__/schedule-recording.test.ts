import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockScheduleDeviceRecording = vi.fn()
const mockCancelVideo = vi.fn()

vi.mock('@/lib/clutch/client', () => ({
  scheduleDeviceRecording: (...args: any[]) =>
    mockScheduleDeviceRecording(...args),
  cancelVideo: (...args: any[]) => mockCancelVideo(...args),
  ClutchConflictError: class ClutchConflictError extends Error {
    conflictingIds: string[] = []
  },
}))

// Chainable Supabase mock helper (same shape as the spiideo tests)
function chainable(resolvedValue: { data: any; error: any }) {
  const chain: any = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.maybeSingle = vi.fn().mockResolvedValue(resolvedValue)
  chain.single = vi.fn().mockResolvedValue(resolvedValue)
  chain.insert = vi.fn().mockReturnValue(chain)
  chain.update = vi.fn().mockReturnValue(chain)
  return chain
}

const mockBillingChain = chainable({
  data: { default_billable_amount: 5, currency: 'KWD' },
  error: null,
})
const mockRecordingChain = chainable({ data: { id: 'rec-9' }, error: null })
const mockAccessChain = chainable({ data: null, error: null })
const mockProductChain = chainable({ data: null, error: null })

const mockServiceClient = {
  from: vi.fn((table: string) => {
    if (table === 'playhub_venue_billing_config') return mockBillingChain
    if (table === 'playhub_match_recordings') return mockRecordingChain
    if (table === 'playhub_access_rights') return mockAccessChain
    if (table === 'playhub_products') return mockProductChain
    return chainable({ data: null, error: null })
  }),
}

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => mockServiceClient,
}))

import { scheduleClutchRecording } from '@/lib/clutch/schedule-recording'

const DEVICE_ID = '56e08a79-bec1-486e-92bd-d62c962d7d77'
const VIDEO_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const baseInput = {
  venueId: 'venue-1',
  sceneId: DEVICE_ID,
  sceneName: 'Masaha Court 1',
  durationMinutes: 90,
  title: 'Padel Session',
  description: 'Evening doubles',
  email: 'player@example.com',
  collectedBy: 'venue' as const,
}

describe('scheduleClutchRecording', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockScheduleDeviceRecording.mockResolvedValue({
      videoId: VIDEO_ID,
      deviceId: DEVICE_ID,
      status: 'SCHEDULED',
      recordingStartsAt: '2026-06-12T18:00:00Z',
    })
    mockBillingChain.maybeSingle.mockResolvedValue({
      data: { default_billable_amount: 5, currency: 'KWD' },
      error: null,
    })
    mockRecordingChain.single.mockResolvedValue({
      data: { id: 'rec-9' },
      error: null,
    })
  })

  it('schedules on the device with computed window and duration', async () => {
    await scheduleClutchRecording({
      ...baseInput,
      scheduledStartTime: '2026-06-12T18:00:00Z',
      scheduledStopTime: '2026-06-12T19:30:00Z',
    })

    expect(mockScheduleDeviceRecording).toHaveBeenCalledWith(
      DEVICE_ID,
      '2026-06-12T18:00:00Z',
      90
    )
  })

  it('inserts row with clutch ids, scheduled status, scaled billing', async () => {
    await scheduleClutchRecording(baseInput)

    const insertCall = mockRecordingChain.insert.mock.calls[0][0]
    expect(insertCall.clutch_video_id).toBe(VIDEO_ID)
    expect(insertCall.clutch_device_id).toBe(DEVICE_ID)
    expect(insertCall.spiideo_game_id).toBeUndefined()
    expect(insertCall.status).toBe('scheduled')
    expect(insertCall.pitch_name).toBe('Masaha Court 1')
    // 5 KWD/hr × 90 min = 7.5
    expect(insertCall.billable_amount).toBe(7.5)
  })

  it('grants access and returns ids', async () => {
    const result = await scheduleClutchRecording(baseInput)

    expect(result.videoId).toBe(VIDEO_ID)
    expect(result.recordingId).toBe('rec-9')
    const accessInsert = mockAccessChain.insert.mock.calls[0][0]
    expect(accessInsert[0].invited_email).toBe('player@example.com')
  })

  it('cancels the Clutch booking when the DB insert fails, then rethrows', async () => {
    mockRecordingChain.single.mockResolvedValue({
      data: null,
      error: { message: 'DB down' },
    })

    await expect(scheduleClutchRecording(baseInput)).rejects.toThrow('DB down')
    expect(mockCancelVideo).toHaveBeenCalledWith(VIDEO_ID)
  })

  it('rethrows the original error even when the compensating cancel fails', async () => {
    mockRecordingChain.single.mockResolvedValue({
      data: null,
      error: { message: 'DB down' },
    })
    mockCancelVideo.mockRejectedValue(new Error('cancel failed'))

    await expect(scheduleClutchRecording(baseInput)).rejects.toThrow('DB down')
  })

  it('propagates schedule conflicts without inserting a row', async () => {
    const conflict = Object.assign(new Error('Schedule conflict'), {
      name: 'ClutchConflictError',
      conflictingIds: ['other-video'],
    })
    mockScheduleDeviceRecording.mockRejectedValue(conflict)

    await expect(scheduleClutchRecording(baseInput)).rejects.toThrow(
      'Schedule conflict'
    )
    expect(mockRecordingChain.insert).not.toHaveBeenCalled()
    expect(mockCancelVideo).not.toHaveBeenCalled()
  })
})
