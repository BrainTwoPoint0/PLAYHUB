import { describe, it, expect, beforeEach, vi } from 'vitest'

// GET mapping tests for the goal-candidates list route — the load-bearing
// bit is the sub-anchor passthrough (episode-split hybrid): PostgREST
// serializes numeric[] as JSON numbers (the string-tolerant Number() wrap is
// defensive); pre-hybrid NULL rows must degrade to [] (no hint chips), and
// NULL elements must be dropped, never coerced to an actionable 0.
vi.mock('@/lib/supabase/server', () => ({
  getAuthUser: vi.fn(),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/admin/auth', () => ({ isPlatformAdmin: vi.fn() }))

import { GET } from '../route'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'

const mockAuth = getAuthUser as unknown as ReturnType<typeof vi.fn>
const mockService = createServiceClient as unknown as ReturnType<typeof vi.fn>
const mockAdmin = isPlatformAdmin as unknown as ReturnType<typeof vi.fn>

const REC = '00000000-0000-4000-8000-000000000001'
const ADMIN = '00000000-0000-4000-8000-0000000000ad'

const baseRow = {
  id: '00000000-0000-4000-8000-000000000002',
  t0_s: '1134.0',
  t1_s: '1684.0',
  anchor_s: '1134.0',
  // PostgREST serializes numeric[] as bare JSON numbers
  sub_anchors_s: null as (number | null)[] | null,
  pko: '0.9',
  deadctx: '0.99',
  status: 'draft',
  error: null,
  clip_path: null,
  clip_span_s: null as string | number | null,
  approved_event_id: null,
  detector_version: 'freeze-2026-07-21-floor080-subanchors',
  reviewed_at: null,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
}

/** Awaitable chain stub: every filter method returns the chain; awaiting it
 * resolves the next scripted response. storage signs nothing (no clips). */
function stubService(script: { data: unknown; error: null }[]) {
  const queue = [...script]
  const from = () => {
    const chain: Record<string, unknown> = {}
    const self = () => chain
    Object.assign(chain, {
      select: self,
      eq: self,
      in: self,
      order: self,
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        const nextResp = queue.shift()
        if (!nextResp) reject(new Error('script exhausted'))
        else resolve(nextResp)
      },
    })
    return chain
  }
  return {
    from,
    storage: {
      from: () => ({
        createSignedUrls: async () => ({ data: [], error: null }),
      }),
    },
  }
}

async function runGet(rows: unknown[], cycleRows: unknown[] = []) {
  // scripted responses 2 + 3 = the links query, then the cycle-verdicts
  // query (both run whenever rows exist)
  const script = [
    { data: rows, error: null },
    { data: [], error: null },
    { data: cycleRows, error: null },
  ].slice(0, rows.length > 0 ? 3 : 1)
  mockService.mockReturnValue(stubService(script))
  const res = await GET({} as never, {
    params: Promise.resolve({ id: REC }),
  })
  const json = (await res.json()) as {
    candidates: {
      subAnchorsS: number[]
      anchorS: number
      clipSpanS: number | null
      cycleReviews: { cycleAnchorS: number; verdict: string }[]
    }[]
  }
  return { res, json }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: ADMIN } })
  mockAdmin.mockResolvedValue(true)
})

describe('GET goal-candidates — subAnchorsS mapping', () => {
  it('passes sub_anchors_s through as numbers', async () => {
    const { json } = await runGet([
      { ...baseRow, sub_anchors_s: [1134, 1371, 1628] },
    ])
    expect(json.candidates[0].subAnchorsS).toEqual([1134, 1371, 1628])
  })

  it('degrades NULL (pre-hybrid rows) to an empty array', async () => {
    const { json } = await runGet([{ ...baseRow, sub_anchors_s: null }])
    expect(json.candidates[0].subAnchorsS).toEqual([])
  })

  it('drops NULL elements instead of coercing them to an actionable 0', async () => {
    const { json } = await runGet([
      { ...baseRow, sub_anchors_s: [1134, null, 1371] },
    ])
    expect(json.candidates[0].subAnchorsS).toEqual([1134, 1371])
  })

  it('keeps the no-store cache header (payload carries signed clip URLs)', async () => {
    const { res } = await runGet([{ ...baseRow }])
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('passes clip_span_s through as a number and NULL as null (legacy rows)', async () => {
    const { json } = await runGet([{ ...baseRow, clip_span_s: '480.0' }])
    expect(json.candidates[0].clipSpanS).toBe(480)
    const legacy = await runGet([{ ...baseRow, clip_span_s: null }])
    expect(legacy.json.candidates[0].clipSpanS).toBeNull()
  })

  it('maps cycle verdicts onto their candidate and defaults to []', async () => {
    const { json } = await runGet(
      [{ ...baseRow }],
      [
        {
          candidate_id: baseRow.id,
          cycle_anchor_s: '1371.02',
          verdict: 'no_goal',
        },
        {
          candidate_id: '00000000-0000-4000-8000-00000000ffff',
          cycle_anchor_s: '99.0',
          verdict: 'goal',
        },
      ]
    )
    expect(json.candidates[0].cycleReviews).toEqual([
      { cycleAnchorS: 1371.02, verdict: 'no_goal' },
    ])
    const none = await runGet([{ ...baseRow }])
    expect(none.json.candidates[0].cycleReviews).toEqual([])
  })
})
