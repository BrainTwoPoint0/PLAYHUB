import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ───────────────────────────────────────────────────
const {
  mockGetUser,
  mockIsVenueAdmin,
  mockServiceFrom,
  mockStopGame,
  mockDeleteGame,
  mockCancelVideo,
  mockS3Send,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockIsVenueAdmin: vi.fn(),
  mockServiceFrom: vi.fn(),
  mockStopGame: vi.fn(),
  mockDeleteGame: vi.fn(),
  mockCancelVideo: vi.fn(),
  mockS3Send: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  getAuthUser: vi.fn().mockImplementation(async () => ({
    user: mockGetUser(),
    supabase: {},
  })),
  createServiceClient: vi.fn().mockReturnValue({
    from: (...args: any[]) => mockServiceFrom(...args),
  }),
}))

vi.mock('@/lib/recordings/access-control', () => ({
  checkRecordingAccess: vi.fn(),
  isVenueAdmin: (...args: any[]) => mockIsVenueAdmin(...args),
}))

vi.mock('@/lib/s3/client', () => ({
  getPlaybackUrl: vi.fn(),
}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mockS3Send
  },
  DeleteObjectCommand: class {
    constructor(public input: unknown) {}
  },
}))

vi.mock('@/lib/spiideo/client', () => ({
  stopGame: (...args: any[]) => mockStopGame(...args),
  deleteGame: (...args: any[]) => mockDeleteGame(...args),
}))

vi.mock('@/lib/clutch/client', () => ({
  cancelVideo: (...args: any[]) => mockCancelVideo(...args),
}))

import { DELETE } from '@/app/api/recordings/[id]/route'

// ── Fixtures ────────────────────────────────────────────────────────

const REC_ID = '11111111-2222-3333-4444-555555555555'
const GAME_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const params = { params: Promise.resolve({ id: REC_ID }) }

const HOUR = 3600

function makeRecording(overrides: Record<string, any> = {}) {
  return {
    organization_id: 'org-1',
    s3_key: null,
    s3_bucket: null,
    spiideo_game_id: GAME_ID,
    clutch_video_id: null,
    status: 'scheduled',
    match_date: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // started 30 min ago
    duration_seconds: HOUR, // ends 30 min from now → live
    ...overrides,
  }
}

const tombstoneUpsert = vi.fn()
const rowDelete = vi.fn()

function wireTables(recording: any, { tombstoneError = null as any } = {}) {
  tombstoneUpsert.mockResolvedValue({ error: tombstoneError })
  const deleteEq = vi.fn().mockResolvedValue({ error: null })
  rowDelete.mockReturnValue({ eq: deleteEq })

  mockServiceFrom.mockImplementation((table: string) => {
    if (table === 'playhub_match_recordings') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: recording }),
          }),
        }),
        delete: rowDelete,
      }
    }
    if (table === 'playhub_deleted_spiideo_games') {
      return { upsert: tombstoneUpsert }
    }
    return {}
  })
}

function makeRequest() {
  return new Request(`http://localhost:3001/api/recordings/${REC_ID}`, {
    method: 'DELETE',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetUser.mockReturnValue({ id: 'user-1' })
  mockIsVenueAdmin.mockResolvedValue(true)
  mockStopGame.mockResolvedValue({})
  mockDeleteGame.mockResolvedValue(undefined)
})

// ── Tests ───────────────────────────────────────────────────────────

describe('DELETE /api/recordings/[id] — Spiideo stop + delete', () => {
  it('stops a currently-live recording before deleting the game', async () => {
    wireTables(makeRecording())

    const res = await DELETE(makeRequest(), params)

    expect(res.status).toBe(200)
    expect(mockStopGame).toHaveBeenCalledWith(GAME_ID, { timeoutMs: 8000 })
    expect(mockDeleteGame).toHaveBeenCalledWith(GAME_ID, { timeoutMs: 8000 })
    expect(mockStopGame.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteGame.mock.invocationCallOrder[0]
    )
    expect(rowDelete).toHaveBeenCalled()
  })

  it('treats a null duration as a 3-hour window (Lambda-created rows have no duration)', async () => {
    wireTables(
      makeRecording({
        match_date: new Date(Date.now() - 2 * HOUR * 1000).toISOString(),
        duration_seconds: null, // 2h in < 3h fallback → still live
      })
    )

    const res = await DELETE(makeRequest(), params)

    expect(res.status).toBe(200)
    expect(mockStopGame).toHaveBeenCalledWith(GAME_ID, { timeoutMs: 8000 })
  })

  it('skips the stop when match_date is missing', async () => {
    wireTables(makeRecording({ match_date: null }))

    const res = await DELETE(makeRequest(), params)

    expect(res.status).toBe(200)
    expect(mockStopGame).not.toHaveBeenCalled()
    expect(mockDeleteGame).toHaveBeenCalled()
  })

  it('does not stop a recording that already finished', async () => {
    wireTables(
      makeRecording({
        match_date: new Date(Date.now() - 2 * HOUR * 1000).toISOString(),
        status: 'processing',
      })
    )

    const res = await DELETE(makeRequest(), params)

    expect(res.status).toBe(200)
    expect(mockStopGame).not.toHaveBeenCalled()
    expect(mockDeleteGame).toHaveBeenCalledWith(GAME_ID, expect.anything())
  })

  it('does not stop a recording that has not started yet (unschedule is enough)', async () => {
    wireTables(
      makeRecording({
        match_date: new Date(Date.now() + HOUR * 1000).toISOString(),
      })
    )

    const res = await DELETE(makeRequest(), params)

    expect(res.status).toBe(200)
    expect(mockStopGame).not.toHaveBeenCalled()
    expect(mockDeleteGame).toHaveBeenCalled()
  })

  it('still deletes the row when Spiideo stop and delete both fail', async () => {
    wireTables(makeRecording())
    mockStopGame.mockRejectedValue(new Error('spiideo down'))
    mockDeleteGame.mockRejectedValue(new Error('spiideo down'))

    const res = await DELETE(makeRequest(), params)

    expect(res.status).toBe(200)
    expect(rowDelete).toHaveBeenCalled()
  })

  it('writes the tombstone before any Spiideo call and aborts on tombstone failure', async () => {
    wireTables(makeRecording(), {
      tombstoneError: { message: 'insert failed' },
    })

    const res = await DELETE(makeRequest(), params)

    expect(res.status).toBe(500)
    expect(mockStopGame).not.toHaveBeenCalled()
    expect(mockDeleteGame).not.toHaveBeenCalled()
    expect(rowDelete).not.toHaveBeenCalled()
  })

  it('skips Spiideo entirely for recordings without a spiideo_game_id', async () => {
    wireTables(makeRecording({ spiideo_game_id: null }))

    const res = await DELETE(makeRequest(), params)

    expect(res.status).toBe(200)
    expect(tombstoneUpsert).not.toHaveBeenCalled()
    expect(mockStopGame).not.toHaveBeenCalled()
    expect(mockDeleteGame).not.toHaveBeenCalled()
    expect(rowDelete).toHaveBeenCalled()
  })
})
