import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock auth + data + upstream so we can exercise the security/cost-load-bearing
// branches: gate parity, the capability split (view vs trigger), the fast path,
// the error-attempt cap, and the atomic claim → Batch SubmitJob.
vi.mock('@/lib/supabase/server', () => ({
  getAuthUser: vi.fn(),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/recordings/access-control', () => ({
  checkRecordingAccess: vi.fn(),
}))
vi.mock('@/lib/s3/client', () => ({ getPlaybackUrl: vi.fn() }))
vi.mock('@/lib/panorama/mesh', () => ({ meshExists: vi.fn() }))
const { mockBatchSend } = vi.hoisted(() => ({ mockBatchSend: vi.fn() }))
vi.mock('@aws-sdk/client-batch', () => ({
  BatchClient: class {
    send = mockBatchSend
  },
  SubmitJobCommand: class {
    constructor(public input: unknown) {}
  },
}))

import { POST } from '../route'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { checkRecordingAccess } from '@/lib/recordings/access-control'
import { getPlaybackUrl } from '@/lib/s3/client'
import { meshExists } from '@/lib/panorama/mesh'

const mockAuth = getAuthUser as unknown as ReturnType<typeof vi.fn>
const mockAccess = checkRecordingAccess as unknown as ReturnType<typeof vi.fn>
const mockService = createServiceClient as unknown as ReturnType<typeof vi.fn>
const mockSign = getPlaybackUrl as unknown as ReturnType<typeof vi.fn>
const mockMeshExists = meshExists as unknown as ReturnType<typeof vi.fn>

const ID = '11111111-1111-4111-8111-111111111111'
const rec = (over: Record<string, unknown> = {}) => ({
  id: ID,
  status: 'published',
  share_token: 'sekret',
  content_type: 'panorama',
  spiideo_game_id: 'game-1',
  panorama_s3_key: null,
  panorama_capture_status: null,
  panorama_capture_started_at: null,
  panorama_capture_attempts: null,
  ...over,
})

// Chainable supabase stub: the recording fetch + rollback update resolve via
// maybeSingle(); the CAS returns `claimed`; awaiting the chain directly (the
// in-flight COUNT) resolves { count }.
function stubSupabase({ recording = null as any, claimed = null as any, inflight = 0 } = {}) {
  const from = () => {
    let isUpdate = false
    const chain: any = {
      select: () => chain,
      update: () => {
        isUpdate = true
        return chain
      },
      eq: () => chain,
      or: () => chain,
      gt: () => chain,
      maybeSingle: async () => ({ data: isUpdate ? claimed : recording, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ count: inflight, error: null }),
    }
    return chain
  }
  return { from }
}

function postReq({ token, origin }: { token?: string; origin?: string } = {}) {
  const url = `http://localhost/api/recordings/${ID}/panorama-source${token ? `?token=${token}` : ''}`
  const headers = new Headers()
  if (origin) headers.set('origin', origin)
  return { nextUrl: new URL(url), url, headers, json: async () => ({}) } as any
}
const params = { params: Promise.resolve({ id: ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ user: null })
  mockAccess.mockResolvedValue({ hasAccess: false })
  mockSign.mockResolvedValue('https://signed.example/vp.mp4')
  mockMeshExists.mockResolvedValue(true) // a published mesh exists by default
  mockBatchSend.mockResolvedValue({ jobId: 'job-1' })
  process.env.VP_MATERIALIZE_JOB_QUEUE = 'q'
  process.env.VP_MATERIALIZE_JOB_DEFINITION = 'jd'
  process.env.SNAPSHOT_INVOKE_AWS_ACCESS_KEY_ID = 'k'
  process.env.SNAPSHOT_INVOKE_AWS_SECRET_ACCESS_KEY = 's'
})

describe('panorama-source — request validation', () => {
  it('400 on a non-UUID id', async () => {
    const res = await POST(postReq(), { params: Promise.resolve({ id: 'nope' }) })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('bad_request')
  })
  it('403 cross-origin', async () => {
    mockService.mockReturnValue(stubSupabase({ recording: rec() }))
    const res = await POST(postReq({ origin: 'https://evil.example' }), params)
    expect(res.status).toBe(403)
  })
  it('always sets Cache-Control: no-store', async () => {
    mockService.mockReturnValue(stubSupabase({ recording: rec({ panorama_s3_key: 'k' }) }))
    mockAuth.mockResolvedValue({ user: { id: 'u' } })
    mockAccess.mockResolvedValue({ hasAccess: true })
    const res = await POST(postReq(), params)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('panorama-source — gate parity (mirrors the watch page)', () => {
  it('404 when unpublished', async () => {
    mockService.mockReturnValue(stubSupabase({ recording: rec({ status: 'draft' }) }))
    const res = await POST(postReq(), params)
    expect(res.status).toBe(404)
  })
  it('404 with neither a valid token nor a grant', async () => {
    mockService.mockReturnValue(stubSupabase({ recording: rec() }))
    const res = await POST(postReq({ token: 'wrong' }), params)
    expect(res.status).toBe(404)
  })
  it('a matching share token passes the gate (serves fast-path)', async () => {
    mockService.mockReturnValue(stubSupabase({ recording: rec({ panorama_s3_key: 'key' }) }))
    const res = await POST(postReq({ token: 'sekret' }), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ready', url: 'https://signed.example/vp.mp4' })
  })
})

describe('panorama-source — capability split', () => {
  it('a token-only viewer can VIEW a ready panorama', async () => {
    mockService.mockReturnValue(stubSupabase({ recording: rec({ panorama_s3_key: 'key' }) }))
    const res = await POST(postReq({ token: 'sekret' }), params)
    expect((await res.json()).status).toBe('ready')
    expect(mockBatchSend).not.toHaveBeenCalled()
  })
  it('a token-only viewer CANNOT trigger a capture (unavailable)', async () => {
    mockService.mockReturnValue(stubSupabase({ recording: rec() })) // no s3_key
    const res = await POST(postReq({ token: 'sekret' }), params)
    expect((await res.json()).status).toBe('unavailable')
    expect(mockBatchSend).not.toHaveBeenCalled()
  })
  it('a grant-holder triggers a capture (claims → SubmitJob → pending)', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u' } })
    mockAccess.mockResolvedValue({ hasAccess: true })
    mockService.mockReturnValue(stubSupabase({ recording: rec(), claimed: { id: ID } }))
    const res = await POST(postReq(), params)
    expect((await res.json()).status).toBe('pending')
    expect(mockBatchSend).toHaveBeenCalledTimes(1)
  })
})

describe('panorama-source — availability keys off the Spiideo game, not content_type', () => {
  it('a hosted_video Spiideo recording (default Play production) can still trigger', async () => {
    // Real Spiideo recordings sync as 'hosted_video' (the hosted Play production
    // is the default view); the raw panorama is still de-warpable.
    mockAuth.mockResolvedValue({ user: { id: 'u' } })
    mockAccess.mockResolvedValue({ hasAccess: true })
    mockService.mockReturnValue(
      stubSupabase({
        recording: rec({ content_type: 'hosted_video' }),
        claimed: { id: ID },
      })
    )
    const res = await POST(postReq(), params)
    expect((await res.json()).status).toBe('pending')
    expect(mockBatchSend).toHaveBeenCalledTimes(1)
  })
  it('a recording with no Spiideo game is unavailable (nothing to materialize)', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u' } })
    mockAccess.mockResolvedValue({ hasAccess: true })
    mockService.mockReturnValue(
      stubSupabase({ recording: rec({ spiideo_game_id: null }) })
    )
    const res = await POST(postReq(), params)
    expect((await res.json()).status).toBe('unavailable')
    expect(mockBatchSend).not.toHaveBeenCalled()
  })
  it('does NOT trigger a capture when no de-warp mesh is published (un-renderable)', async () => {
    // Route/page eligibility parity: without a mesh the raw VP can't be de-warped,
    // so a grant-holder POST must not actuate a multi-GB Batch job.
    mockAuth.mockResolvedValue({ user: { id: 'u' } })
    mockAccess.mockResolvedValue({ hasAccess: true })
    mockMeshExists.mockResolvedValue(false)
    mockService.mockReturnValue(stubSupabase({ recording: rec(), claimed: { id: ID } }))
    const res = await POST(postReq(), params)
    expect((await res.json()).status).toBe('unavailable')
    expect(mockBatchSend).not.toHaveBeenCalled()
  })
})

describe('panorama-source — cost guards', () => {
  it('does NOT re-submit once an error exhausts the attempt cap', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u' } })
    mockAccess.mockResolvedValue({ hasAccess: true })
    mockService.mockReturnValue(
      stubSupabase({
        recording: rec({ panorama_capture_status: 'error', panorama_capture_attempts: 3 }),
      })
    )
    const res = await POST(postReq(), params)
    expect((await res.json()).status).toBe('unavailable')
    expect(mockBatchSend).not.toHaveBeenCalled()
  })
  it('polls (no trigger) while a capture is freshly in flight', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u' } })
    mockAccess.mockResolvedValue({ hasAccess: true })
    mockService.mockReturnValue(
      stubSupabase({
        recording: rec({
          panorama_capture_status: 'pending',
          panorama_capture_started_at: new Date().toISOString(),
        }),
      })
    )
    const res = await POST(postReq(), params)
    expect((await res.json()).status).toBe('pending')
    expect(mockBatchSend).not.toHaveBeenCalled()
  })
  it('returns pending (not terminal) when the global in-flight cap is hit', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u' } })
    mockAccess.mockResolvedValue({ hasAccess: true })
    mockService.mockReturnValue(stubSupabase({ recording: rec(), inflight: 5 }))
    const res = await POST(postReq(), params)
    expect((await res.json()).status).toBe('pending')
    expect(mockBatchSend).not.toHaveBeenCalled()
  })
  it('rolls the claim back to error when SubmitJob fails', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u' } })
    mockAccess.mockResolvedValue({ hasAccess: true })
    mockBatchSend.mockRejectedValue(new Error('batch down'))
    mockService.mockReturnValue(stubSupabase({ recording: rec(), claimed: { id: ID } }))
    const res = await POST(postReq(), params)
    expect(res.status).toBe(502)
    expect((await res.json()).code).toBe('submit_failed')
  })
})
