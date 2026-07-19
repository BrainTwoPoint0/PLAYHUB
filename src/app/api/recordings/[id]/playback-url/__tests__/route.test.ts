import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock auth + data + signer to exercise the access gate (token OR grant),
// the 404-parity semantics, no-store, and the sign path.
vi.mock('@/lib/supabase/server', () => ({
  getAuthUser: vi.fn(),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/recordings/access-control', () => ({
  checkRecordingAccess: vi.fn(),
}))
vi.mock('@/lib/s3/client', () => ({ getPlaybackUrl: vi.fn() }))

import { GET } from '../route'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { checkRecordingAccess } from '@/lib/recordings/access-control'
import { getPlaybackUrl } from '@/lib/s3/client'

const mockAuth = getAuthUser as unknown as ReturnType<typeof vi.fn>
const mockAccess = checkRecordingAccess as unknown as ReturnType<typeof vi.fn>
const mockService = createServiceClient as unknown as ReturnType<typeof vi.fn>
const mockSign = getPlaybackUrl as unknown as ReturnType<typeof vi.fn>

const ID = '11111111-1111-4111-8111-111111111111'
const rec = (over: Record<string, unknown> = {}) => ({
  id: ID,
  status: 'published',
  share_token: 'sekret',
  s3_key: 'recordings/2026/x.mp4',
  ...over,
})

function stubSupabase(recording: any) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: recording, error: null }),
        }),
      }),
    }),
  }
}

function getReq({
  id = ID,
  token,
  origin,
}: { id?: string; token?: string; origin?: string } = {}) {
  const url = `http://localhost/api/recordings/${id}/playback-url`
  const headers = new Headers()
  if (origin) headers.set('origin', origin)
  // Token rides the x-share-token HEADER (out of query-string access logs).
  if (token) headers.set('x-share-token', token)
  return { nextUrl: new URL(url), url, headers } as any
}

const call = (req: any, id = ID) =>
  GET(req, { params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ user: null })
  mockAccess.mockResolvedValue({ hasAccess: false })
  mockSign.mockResolvedValue('https://cdn/x.mp4?Expires=999&Signature=s')
})

describe('GET playback-url', () => {
  it('400 on a non-UUID id', async () => {
    const res = await call(getReq({ id: 'nope' }), 'nope')
    expect(res.status).toBe(400)
  })

  it('403 on cross-origin', async () => {
    const res = await call(getReq({ origin: 'http://evil.example' }))
    expect(res.status).toBe(403)
  })

  it('404 when the recording is missing or unpublished', async () => {
    mockService.mockReturnValue(stubSupabase(null))
    expect((await call(getReq())).status).toBe(404)
    mockService.mockReturnValue(stubSupabase(rec({ status: 'draft' })))
    expect((await call(getReq())).status).toBe(404)
  })

  it('404 (not 403) when no token and no grant — no existence leak', async () => {
    mockService.mockReturnValue(stubSupabase(rec()))
    const res = await call(getReq())
    expect(res.status).toBe(404)
    expect(mockSign).not.toHaveBeenCalled()
  })

  it('signs + no-store on a matching share token', async () => {
    mockService.mockReturnValue(stubSupabase(rec()))
    const res = await call(getReq({ token: 'sekret' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      url: 'https://cdn/x.mp4?Expires=999&Signature=s',
    })
  })

  it('rejects a wrong share token (404)', async () => {
    mockService.mockReturnValue(stubSupabase(rec()))
    expect((await call(getReq({ token: 'wrong' }))).status).toBe(404)
  })

  it('signs for an authenticated grant holder (no token)', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1' } })
    mockAccess.mockResolvedValue({ hasAccess: true })
    mockService.mockReturnValue(stubSupabase(rec()))
    const res = await call(getReq())
    expect(res.status).toBe(200)
    expect(mockAccess).toHaveBeenCalledWith(ID, 'u1')
  })

  it('404 when the recording has no video key', async () => {
    mockService.mockReturnValue(stubSupabase(rec({ s3_key: null })))
    expect((await call(getReq({ token: 'sekret' }))).status).toBe(404)
  })

  it('500 when signing throws (still no-store)', async () => {
    mockService.mockReturnValue(stubSupabase(rec()))
    mockSign.mockRejectedValue(new Error('kms down'))
    const res = await call(getReq({ token: 'sekret' }))
    expect(res.status).toBe(500)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})
