import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ───────────────────────────────────────────────────
const {
  mockGetUser,
  mockCheckAccess,
  mockServiceFrom,
  mockGetJsonObject,
  mockGetPlaybackUrl,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockCheckAccess: vi.fn(),
  mockServiceFrom: vi.fn(),
  mockGetJsonObject: vi.fn(),
  mockGetPlaybackUrl: vi.fn(),
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
  checkRecordingAccess: (...args: any[]) => mockCheckAccess(...args),
}))

vi.mock('@/lib/s3/client', () => ({
  getJsonObject: (...args: any[]) => mockGetJsonObject(...args),
  getPlaybackUrl: (...args: any[]) => mockGetPlaybackUrl(...args),
}))

vi.mock('@/lib/security/origin-check', () => ({
  rejectCrossOrigin: vi.fn().mockReturnValue(null),
}))

import { GET, PATCH } from '@/app/api/recordings/[id]/clutch/route'

// ── Fixtures ────────────────────────────────────────────────────────

const REC_ID = '11111111-2222-3333-4444-555555555555'
const PREFIX = 'recordings/2026-06-13/clutch/vid-1'
const params = { params: Promise.resolve({ id: REC_ID }) }

const recordingRow = {
  id: REC_ID,
  s3_key: `${PREFIX}/match.mp4`,
  status: 'published',
  clutch_video_id: 'vid-1',
}

const matchJson = {
  match_stats: {
    match_time_minutes: 66,
    match_time_in_play_minutes: 15.7,
    avg_rally_shots: 6.2,
    avg_rally_seconds: 6.7,
    longest_rally_shots: 27,
    longest_rally_seconds: 29.27,
  },
  player_stats: {
    'player-1': {
      distance_run_meters: 4005.75,
      n_shots: 233,
      winner_shots: 10,
      error_shots: 8,
      rating: 11.87,
    },
  },
  player_ids_mapping_to_pair: { 'pair-1': ['player-1', 'player-2'] },
}

const playersIndex = {
  version: 1,
  players: [
    {
      playerId: 'player-1',
      isGroundTruth: true,
      cropKey: `${PREFIX}/crops/player-1.png`,
    },
    { playerId: 'player-2', isGroundTruth: true, cropKey: null },
  ],
}

const highlightsIndex = {
  version: 1,
  full: {
    clutch_landscape: {
      clip: `${PREFIX}/clips/clutch_landscape.mp4`,
      thumb: `${PREFIX}/clips/clutch_landscape.jpg`,
    },
  },
  selectors: {
    autopan: {
      longest_rally: [
        {
          clip: `${PREFIX}/clips/autopan/longest_rally_1.mp4`,
          thumb: null,
        },
      ],
      rating_based: [],
      pose_based: [],
    },
    landscape: { longest_rally: [], rating_based: [], pose_based: [] },
  },
}

function chain(resolved: { data: any; error: any }) {
  const c: any = {}
  c.select = vi.fn().mockReturnValue(c)
  c.eq = vi.fn().mockReturnValue(c)
  c.single = vi.fn().mockResolvedValue(resolved)
  c.maybeSingle = vi.fn().mockResolvedValue(resolved)
  c.upsert = vi.fn().mockResolvedValue({ data: null, error: null })
  c.delete = vi.fn().mockReturnValue(c)
  c.in = vi.fn().mockResolvedValue({ data: null, error: null })
  // label list query resolves the chain itself (await on .eq result)
  c.then = undefined
  return c
}

function setup(opts: {
  user?: any
  access?: boolean
  recording?: any
  indexes?: { players?: any; highlights?: any; match?: any }
  labels?: any[]
}) {
  mockGetUser.mockReturnValue(
    opts.user === undefined ? { id: 'user-1' } : opts.user
  )
  mockCheckAccess.mockResolvedValue({
    hasAccess: opts.access ?? true,
    reason: opts.access === false ? 'No access' : 'Granted',
  })

  const recordingChain = chain({
    data: opts.recording === undefined ? recordingRow : opts.recording,
    error: opts.recording === null ? { message: 'not found' } : null,
  })
  const labelsChain: any = chain({ data: null, error: null })
  // .eq() is awaited directly for the list query AND chained with .in() for
  // the delete path — return a thenable that supports both.
  labelsChain.in = vi.fn().mockResolvedValue({ data: null, error: null })
  labelsChain.eq = vi.fn().mockImplementation(() => ({
    then: (resolve: (v: any) => void) =>
      resolve({ data: opts.labels ?? [], error: null }),
    in: labelsChain.in,
  }))

  mockServiceFrom.mockImplementation((table: string) => {
    if (table === 'playhub_match_recordings') return recordingChain
    if (table === 'playhub_clutch_player_labels') return labelsChain
    return chain({ data: null, error: null })
  })

  mockGetJsonObject.mockImplementation(async (key: string) => {
    if (key.endsWith('players.index.json')) return opts.indexes?.players ?? null
    if (key.endsWith('highlights.index.json'))
      return opts.indexes?.highlights ?? null
    if (key.endsWith('match.json')) return opts.indexes?.match ?? null
    return null
  })
  mockGetPlaybackUrl.mockImplementation(
    async (key: string) => `https://signed.test/${key}`
  )

  return { recordingChain, labelsChain }
}

// Route handlers take NextRequest; a plain Request covers everything the
// handlers touch (headers/json), so cast rather than construct NextRequest.
function getRequest() {
  return new Request(
    `http://localhost:3001/api/recordings/${REC_ID}/clutch`
  ) as unknown as import('next/server').NextRequest
}

function patchRequest(body: any) {
  return new Request(`http://localhost:3001/api/recordings/${REC_ID}/clutch`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }) as unknown as import('next/server').NextRequest
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── GET ─────────────────────────────────────────────────────────────

describe('GET /api/recordings/[id]/clutch', () => {
  it('400s on a bad UUID', async () => {
    setup({})
    const res = await GET(getRequest(), {
      params: Promise.resolve({ id: 'nope' }),
    })
    expect(res.status).toBe(400)
  })

  it('401s when anonymous', async () => {
    setup({ user: null })
    const res = await GET(getRequest(), params)
    expect(res.status).toBe(401)
  })

  it('403s without recording access', async () => {
    setup({ access: false })
    const res = await GET(getRequest(), params)
    expect(res.status).toBe(403)
  })

  it('404s for non-clutch or unpublished recordings', async () => {
    setup({ recording: { ...recordingRow, clutch_video_id: null } })
    expect((await GET(getRequest(), params)).status).toBe(404)

    setup({ recording: { ...recordingRow, status: 'processing' } })
    expect((await GET(getRequest(), params)).status).toBe(404)
  })

  it('merges stats, crops, labels, and clips with signed URLs', async () => {
    setup({
      indexes: {
        players: playersIndex,
        highlights: highlightsIndex,
        match: matchJson,
      },
      labels: [{ provider_player_id: 'player-1', display_name: 'Karim' }],
    })

    const res = await GET(getRequest(), params)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')

    const body = await res.json()
    expect(body.stats.matchTimeMinutes).toBe(66)
    expect(body.stats.longestRallyShots).toBe(27)

    const p1 = body.players.find((p: any) => p.playerId === 'player-1')
    expect(p1.displayName).toBe('Karim')
    expect(p1.cropUrl).toBe(`https://signed.test/${PREFIX}/crops/player-1.png`)
    expect(p1.stats.nShots).toBe(233)
    expect(p1.pair).toBe('pair-1')

    const p2 = body.players.find((p: any) => p.playerId === 'player-2')
    expect(p2.displayName).toBeNull()
    expect(p2.cropUrl).toBeNull()
    expect(p2.stats).toBeNull()

    expect(body.clips.full.clutchLandscape.url).toContain('signed.test')
    expect(body.clips.full.clutchLandscape.thumbUrl).toContain('signed.test')
    expect(body.clips.selectors.autopan.longest_rally[0].thumbUrl).toBeNull()
  })

  it('degrades for pre-feature recordings (no index files)', async () => {
    setup({ indexes: { match: matchJson } })
    const res = await GET(getRequest(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.clips).toBeNull()
    // players derived from match.json stats only
    expect(
      body.players.find((p: any) => p.playerId === 'player-1').cropUrl
    ).toBeNull()
  })

  it('degrades when match.json is absent (empty court)', async () => {
    setup({ indexes: { players: playersIndex } })
    const res = await GET(getRequest(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stats).toBeNull()
    expect(
      body.players.find((p: any) => p.playerId === 'player-1').stats
    ).toBeNull()
  })
})

// ── PUT ─────────────────────────────────────────────────────────────

describe('PATCH /api/recordings/[id]/clutch', () => {
  it('401/403s like GET', async () => {
    setup({ user: null })
    expect(
      (
        await PATCH(
          patchRequest({
            labels: [{ playerId: 'player-1', displayName: 'K' }],
          }),
          params
        )
      ).status
    ).toBe(401)

    setup({ access: false })
    expect(
      (
        await PATCH(
          patchRequest({
            labels: [{ playerId: 'player-1', displayName: 'K' }],
          }),
          params
        )
      ).status
    ).toBe(403)
  })

  it('400s on unknown playerId, long names, and oversized payloads', async () => {
    setup({ indexes: { players: playersIndex, match: matchJson } })

    expect(
      (
        await PATCH(
          patchRequest({ labels: [{ playerId: 'ghost-9', displayName: 'X' }] }),
          params
        )
      ).status
    ).toBe(400)

    expect(
      (
        await PATCH(
          patchRequest({
            labels: [{ playerId: 'player-1', displayName: 'x'.repeat(61) }],
          }),
          params
        )
      ).status
    ).toBe(400)

    expect(
      (
        await PATCH(
          patchRequest({
            labels: Array.from({ length: 31 }, (_, i) => ({
              playerId: `player-${i}`,
              displayName: 'x',
            })),
          }),
          params
        )
      ).status
    ).toBe(400)

    expect(
      (
        await PATCH(
          patchRequest({
            labels: [
              { playerId: 'player-1', displayName: 'A' },
              { playerId: 'player-1', displayName: 'B' },
            ],
          }),
          params
        )
      ).status
    ).toBe(400)
  })

  it('upserts labels with labeled_by and deletes on null', async () => {
    const { labelsChain } = setup({
      indexes: { players: playersIndex, match: matchJson },
    })

    const res = await PATCH(
      patchRequest({
        labels: [
          { playerId: 'player-1', displayName: '  Karim  ' },
          { playerId: 'player-2', displayName: null },
        ],
      }),
      params
    )
    expect(res.status).toBe(200)

    const upsertArg = labelsChain.upsert.mock.calls[0][0]
    expect(upsertArg).toEqual([
      expect.objectContaining({
        match_recording_id: REC_ID,
        provider_player_id: 'player-1',
        display_name: 'Karim',
        labeled_by: 'user-1',
      }),
    ])
    expect(labelsChain.delete).toHaveBeenCalled()
    expect(labelsChain.in).toHaveBeenCalledWith('provider_player_id', [
      'player-2',
    ])
  })
})
