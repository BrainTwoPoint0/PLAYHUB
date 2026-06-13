import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub env vars before the module loads (hoisted alongside vi.mock)
vi.hoisted(() => {
  process.env.CLUTCH_EMAIL = 'test@playback.test'
  process.env.CLUTCH_PASSWORD = 'test-password'
})

import {
  ClutchConflictError,
  cancelVideo,
  clearTokenCache,
  getClutchConfig,
  getDeviceStatus,
  getVideoResults,
  getVideoStatus,
  isClutchConfigured,
  scheduleDeviceRecording,
} from '@/lib/clutch/client'

const DEVICE_ID = '56e08a79-bec1-486e-92bd-d62c962d7d77'
const VIDEO_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function loginResponse(token = 'token-1') {
  return new Response(JSON.stringify({ data: { id: 'user-1', token } }), {
    status: 200,
  })
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

beforeEach(() => {
  vi.restoreAllMocks()
  clearTokenCache()
})

// ─── config ─────────────────────────────────────────────────────

describe('getClutchConfig', () => {
  it('returns email and password from env', () => {
    expect(getClutchConfig()).toEqual({
      email: 'test@playback.test',
      password: 'test-password',
    })
  })

  it('isClutchConfigured is true when env is set', () => {
    expect(isClutchConfigured()).toBe(true)
  })

  it('throws when credentials are missing', () => {
    const saved = process.env.CLUTCH_EMAIL
    delete process.env.CLUTCH_EMAIL
    try {
      expect(() => getClutchConfig()).toThrow(/not configured/i)
      expect(isClutchConfigured()).toBe(false)
    } finally {
      process.env.CLUTCH_EMAIL = saved
    }
  })
})

// ─── auth / token caching ───────────────────────────────────────

describe('token caching', () => {
  it('logs in once and reuses the token across calls', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(
        jsonResponse({ data: { id: VIDEO_ID, status: 'PROCESSING' } })
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: { id: VIDEO_ID, status: 'OK' } })
      )

    await getVideoStatus(VIDEO_ID)
    await getVideoStatus(VIDEO_ID)

    const loginCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes('/auth/login')
    )
    expect(loginCalls).toHaveLength(1)
    // API calls carry the bearer token
    const apiCall = fetchSpy.mock.calls[1]
    expect((apiCall[1]?.headers as Record<string, string>).Authorization).toBe(
      'Bearer token-1'
    )
  })

  it('re-logs-in exactly once when a call returns 401, then retries', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(loginResponse('stale-token'))
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(loginResponse('fresh-token'))
      .mockResolvedValueOnce(
        jsonResponse({ data: { id: VIDEO_ID, status: 'OK' } })
      )

    const status = await getVideoStatus(VIDEO_ID)
    expect(status).toBe('OK')

    const loginCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes('/auth/login')
    )
    expect(loginCalls).toHaveLength(2)
    const retryCall = fetchSpy.mock.calls[3]
    expect(
      (retryCall[1]?.headers as Record<string, string>).Authorization
    ).toBe('Bearer fresh-token')
  })

  it('does not retry more than once on repeated 401', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))

    await expect(getVideoStatus(VIDEO_ID)).rejects.toThrow(/401/)
  })
})

// ─── scheduleDeviceRecording ────────────────────────────────────

describe('scheduleDeviceRecording', () => {
  it('POSTs start_time + max_recording_duration_min and parses video_id', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            id: DEVICE_ID,
            name: 'Court 1',
            status: 'SCHEDULED',
            video_id: VIDEO_ID,
            sport: 'padel',
            recording_starts_at: '2026-06-12T18:00:00Z',
            recording_duration: 90,
          },
        })
      )

    const result = await scheduleDeviceRecording(
      DEVICE_ID,
      '2026-06-12T18:00:00Z',
      90
    )

    expect(result.videoId).toBe(VIDEO_ID)
    expect(result.deviceId).toBe(DEVICE_ID)
    expect(result.status).toBe('SCHEDULED')

    const scheduleCall = fetchSpy.mock.calls[1]
    expect(String(scheduleCall[0])).toContain(
      `/clutchcam/device/${DEVICE_ID}/schedule`
    )
    expect(JSON.parse(scheduleCall[1]?.body as string)).toEqual({
      start_time: '2026-06-12T18:00:00Z',
      max_recording_duration_min: 90,
    })
  })

  it('throws ClutchConflictError with conflicting ids on 400 conflict', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: 'Schedule conflict for start time: 2026-06-12T18:00:00Z.',
            data: { conflicting_ids: ['conflict-1', 'conflict-2'] },
          },
          400
        )
      )

    const err = await scheduleDeviceRecording(
      DEVICE_ID,
      '2026-06-12T18:00:00Z',
      90
    ).catch((e) => e)

    expect(err).toBeInstanceOf(ClutchConflictError)
    expect(err.conflictingIds).toEqual(['conflict-1', 'conflict-2'])
  })

  it('throws a plain error on non-conflict 400', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(jsonResponse({ error: 'bad start_time' }, 400))

    await expect(
      scheduleDeviceRecording(DEVICE_ID, 'invalid', 90)
    ).rejects.toThrow(/bad start_time|400/)
  })
})

// ─── device + video reads ───────────────────────────────────────

describe('getDeviceStatus', () => {
  it('parses device status payload', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            id: DEVICE_ID,
            name: 'Court 1',
            status: 'available',
            video_id: null,
            sport: 'padel',
          },
        })
      )

    const status = await getDeviceStatus(DEVICE_ID)
    expect(status).toEqual({
      id: DEVICE_ID,
      name: 'Court 1',
      status: 'available',
      videoId: null,
    })
  })
})

describe('getVideoResults', () => {
  it('maps output keys to URLs', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            id: VIDEO_ID,
            device_id: DEVICE_ID,
            outputs: [
              { key: 'video', url: 'https://cdn.test/full.mp4' },
              {
                key: 'highlight-landscape',
                url: 'https://cdn.test/highlight.mp4',
              },
              { key: 'match.json', url: 'https://cdn.test/match.json' },
            ],
          },
        })
      )

    const results = await getVideoResults(VIDEO_ID)
    expect(results).toEqual({
      video: 'https://cdn.test/full.mp4',
      'highlight-landscape': 'https://cdn.test/highlight.mp4',
      'match.json': 'https://cdn.test/match.json',
    })
  })

  it('returns null when the video is still processing (202)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(
        jsonResponse({ message: 'Video is not yet processed.' }, 202)
      )

    expect(await getVideoResults(VIDEO_ID)).toBeNull()
  })
})

describe('cancelVideo', () => {
  it('DELETEs the cancel endpoint', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          message: 'Video has been successfully cancelled.',
          video_id: VIDEO_ID,
        })
      )

    await cancelVideo(VIDEO_ID)

    const cancelCall = fetchSpy.mock.calls[1]
    expect(String(cancelCall[0])).toContain(`/video/${VIDEO_ID}/cancel`)
    expect(cancelCall[1]?.method).toBe('DELETE')
  })
})
