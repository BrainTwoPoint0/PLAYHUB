import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetUser, mockIsVenueAdmin, mockIsPlatformAdmin, mockServiceFrom } =
  vi.hoisted(() => ({
    mockGetUser: vi.fn(),
    mockIsVenueAdmin: vi.fn(),
    mockIsPlatformAdmin: vi.fn(),
    mockServiceFrom: vi.fn(),
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
  isVenueAdmin: (...args: any[]) => mockIsVenueAdmin(...args),
}))

vi.mock('@/lib/admin/auth', () => ({
  isPlatformAdmin: (...args: any[]) => mockIsPlatformAdmin(...args),
}))

import { GET } from '@/app/api/venue/[venueId]/clutch/summary/route'

const VENUE_ID = 'venue-1'
const params = { params: Promise.resolve({ venueId: VENUE_ID }) }
const request = new Request(
  `http://localhost:3001/api/venue/${VENUE_ID}/clutch/summary`
) as unknown as import('next/server').NextRequest

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

function recordingsChain(rows: any[], error: any = null) {
  const c: any = {}
  c.select = vi.fn().mockReturnValue(c)
  c.eq = vi.fn().mockReturnValue(c)
  c.in = vi.fn().mockReturnValue(c)
  c.not = vi.fn().mockReturnValue(c)
  c.order = vi.fn().mockReturnValue(c)
  c.limit = vi.fn().mockResolvedValue({ data: rows, error })
  return c
}

function orgChain(type = 'venue') {
  const c: any = {}
  c.select = vi.fn().mockReturnValue(c)
  c.eq = vi.fn().mockReturnValue(c)
  c.single = vi.fn().mockResolvedValue({ data: { type }, error: null })
  return c
}

function labelsChain(rows: any[] | null, error: any = null) {
  const c: any = {}
  c.select = vi.fn().mockReturnValue(c)
  c.in = vi.fn().mockResolvedValue({ data: rows, error })
  return c
}

function setup(opts: {
  user?: any
  venueAdmin?: boolean
  platformAdmin?: boolean
  recordings?: any[]
  labels?: any[] | null
  labelsError?: any
}) {
  mockGetUser.mockReturnValue(
    opts.user === undefined ? { id: 'user-1' } : opts.user
  )
  mockIsVenueAdmin.mockResolvedValue(opts.venueAdmin ?? true)
  mockIsPlatformAdmin.mockResolvedValue(opts.platformAdmin ?? false)

  const recChain = recordingsChain(opts.recordings ?? [])
  const lblChain = labelsChain(opts.labels ?? [], opts.labelsError ?? null)
  mockServiceFrom.mockImplementation((table: string) => {
    if (table === 'playhub_match_recordings') return recChain
    if (table === 'playhub_clutch_player_labels') return lblChain
    if (table === 'organizations') return orgChain()
    return recordingsChain([])
  })
  return { recChain, lblChain }
}

beforeEach(() => vi.clearAllMocks())

describe('GET /api/venue/[venueId]/clutch/summary', () => {
  it('401s when anonymous', async () => {
    setup({ user: null })
    expect((await GET(request, params)).status).toBe(401)
  })

  it('403s when neither venue admin nor platform admin', async () => {
    setup({ venueAdmin: false, platformAdmin: false })
    expect((await GET(request, params)).status).toBe(403)
  })

  it('allows platform admins who are not venue admins', async () => {
    setup({ venueAdmin: false, platformAdmin: true, recordings: [] })
    expect((await GET(request, params)).status).toBe(200)
  })

  it('returns a zeroed payload for venues with no clutch recordings', async () => {
    setup({ recordings: [] })
    const body = await (await GET(request, params)).json()
    expect(body).toMatchObject({
      totalRecordings: 0,
      withStats: 0,
      totalInPlayMinutes: 0,
      avgRallyShots: null,
      longestRally: null,
      namedPlayers: 0,
      courts: [],
    })
    expect(body.days).toHaveLength(30)
  })

  it('aggregates stats, excluding NULL-stats rows from averages but not totals', async () => {
    setup({
      recordings: [
        {
          id: 'r1',
          title: 'Match 1',
          match_date: daysAgo(1),
          pitch_name: 'Court 1',
          clutch_match_stats: {
            version: 1,
            match_time_in_play_minutes: 20,
            avg_rally_shots: 6,
            avg_rally_seconds: 10,
            longest_rally_shots: 27,
            longest_rally_seconds: 30,
            players: 4,
          },
        },
        {
          id: 'r2',
          title: 'Match 2',
          match_date: daysAgo(2),
          pitch_name: 'Court 1',
          clutch_match_stats: {
            version: 1,
            match_time_in_play_minutes: 10,
            avg_rally_shots: 8,
            avg_rally_seconds: 12,
            longest_rally_shots: 31,
            longest_rally_seconds: 45,
            players: 4,
          },
        },
        {
          id: 'r3',
          title: 'Practice',
          match_date: daysAgo(2),
          pitch_name: 'Court 2',
          clutch_match_stats: null,
        },
      ],
      labels: [
        { display_name: 'Karim' },
        { display_name: ' karim ' },
        { display_name: 'Omar' },
      ],
    })

    const body = await (await GET(request, params)).json()
    expect(body.totalRecordings).toBe(3)
    expect(body.withStats).toBe(2)
    expect(body.totalInPlayMinutes).toBe(30)
    expect(body.avgRallyShots).toBe(7)
    expect(body.avgRallySeconds).toBe(11)
    // longest rally attributed to its recording
    expect(body.longestRally).toMatchObject({
      shots: 31,
      seconds: 45,
      recordingId: 'r2',
      title: 'Match 2',
    })
    // case/trim-insensitive distinct names
    expect(body.namedPlayers).toBe(2)
    expect(body.courts.sort()).toEqual(['Court 1', 'Court 2'])
  })

  it('groups days by court over a zero-filled 30-day window', async () => {
    setup({
      recordings: [
        {
          id: 'r1',
          title: 'A',
          match_date: daysAgo(1),
          pitch_name: 'Court 1',
          clutch_match_stats: null,
        },
        {
          id: 'r2',
          title: 'B',
          match_date: daysAgo(1),
          pitch_name: null,
          clutch_match_stats: null,
        },
        {
          id: 'old',
          title: 'Too old',
          match_date: daysAgo(45),
          pitch_name: 'Court 1',
          clutch_match_stats: null,
        },
      ],
    })

    const body = await (await GET(request, params)).json()
    expect(body.days).toHaveLength(30)
    const busy = body.days.find((d: any) => d.total > 0)
    expect(busy.total).toBe(2)
    expect(busy.byCourt).toEqual({ 'Court 1': 1, Unknown: 1 })
    // 45-day-old recording outside window but in totals
    expect(body.totalRecordings).toBe(3)
  })

  it('degrades namedPlayers to 0 on a labels query error instead of 500', async () => {
    setup({
      recordings: [
        {
          id: 'r1',
          title: 'A',
          match_date: daysAgo(1),
          pitch_name: 'Court 1',
          clutch_match_stats: null,
        },
      ],
      labels: null,
      labelsError: { message: 'boom' },
    })
    const res = await GET(request, params)
    expect(res.status).toBe(200)
    expect((await res.json()).namedPlayers).toBe(0)
  })
})
