import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ───────────────────────────────────────────────────
const {
  mockGetUser,
  mockCheckRecordingAccess,
  mockServiceFrom,
  mockGetPlaybackUrl,
  mockNotFound,
  mockRedirect,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockCheckRecordingAccess: vi.fn(),
  mockServiceFrom: vi.fn(),
  mockGetPlaybackUrl: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
}))

vi.mock('next/navigation', () => ({
  notFound: () => mockNotFound(),
  redirect: (url: string) => mockRedirect(url),
}))

vi.mock('@/lib/supabase/server', () => ({
  getAuthUser: vi.fn().mockImplementation(async () => {
    const result = await mockGetUser()
    return { user: result?.data?.user ?? null, supabase: {} }
  }),
  createServiceClient: vi.fn().mockReturnValue({
    from: (...args: any[]) => mockServiceFrom(...args),
  }),
}))

vi.mock('@/lib/recordings/access-control', () => ({
  checkRecordingAccess: (...args: any[]) => mockCheckRecordingAccess(...args),
}))

vi.mock('@/lib/s3/client', () => ({
  getPlaybackUrl: (...args: any[]) => mockGetPlaybackUrl(...args),
}))

// Render the result page through a stub so we don't have to drag in a full
// React renderer — we only care about which control-flow branch executes.
vi.mock('@/app/watch/[id]/WatchClient', () => ({
  default: (props: any) => ({ __watchClientProps: props }),
}))

import WatchPage from '@/app/watch/[id]/page'

const VALID_UUID = '4e36fe2d-755a-4f23-9c61-2d07baf73c55'
const SHARE_TOKEN = '53a914e6ee20dfc20ebbeab561d8f0fc'

// ── Helpers ─────────────────────────────────────────────────────────

function setupRecordingLookup(
  recording: any,
  shareTokenLookup?: { id: string } | null
) {
  // Permissive chainable: every method returns the chain itself; the few
  // terminal nodes (.maybeSingle, .order resolving to data:[]) return values
  // shaped enough for the route to keep running. Only the recording-by-id
  // and recording-by-share_token lookups need real data.
  mockServiceFrom.mockImplementation((table: string) => {
    const chain: any = {}
    chain.select = () => chain
    chain.eq = (col: string, val: string) => {
      // Recording lookup terminates at .maybeSingle() right after the .eq
      // that pinned id or share_token.
      if (table === 'playhub_match_recordings' && col === 'id') {
        return {
          ...chain,
          maybeSingle: () =>
            val === recording?.id
              ? Promise.resolve({ data: recording, error: null })
              : Promise.resolve({ data: null, error: null }),
        }
      }
      if (table === 'playhub_match_recordings' && col === 'share_token') {
        return {
          ...chain,
          maybeSingle: () =>
            Promise.resolve({ data: shareTokenLookup ?? null, error: null }),
        }
      }
      return chain
    }
    chain.order = () => Promise.resolve({ data: [], error: null })
    chain.maybeSingle = () => Promise.resolve({ data: null, error: null })
    return chain
  })
}

// ── Tests ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
  mockCheckRecordingAccess.mockResolvedValue({ hasAccess: false })
  mockGetPlaybackUrl.mockResolvedValue('https://signed.example/video.mp4')
})

describe('/watch/[id] access resolution', () => {
  // Happy paths: assert the page didn't 404 or redirect. We deliberately
  // don't inspect the rendered JSX — that requires a React runtime which
  // adds noise to a unit test focused on access resolution.

  it('grants access to an authenticated buyer with access_rights', async () => {
    setupRecordingLookup({
      id: VALID_UUID,
      status: 'published',
      s3_key: 'k',
      share_token: SHARE_TOKEN,
    })
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    mockCheckRecordingAccess.mockResolvedValueOnce({
      hasAccess: true,
      reason: 'Access granted',
    })

    // The page calls JSX at the end which needs a React runtime; we don't
    // care about that here, only the access-resolution gate. Catch the
    // expected ReferenceError from JSX evaluation and assert no 404/redirect
    // happened on the way in.
    try {
      await WatchPage({
        params: Promise.resolve({ id: VALID_UUID }),
        searchParams: Promise.resolve({}),
      })
    } catch (err: any) {
      // Anything except NEXT_NOT_FOUND / NEXT_REDIRECT is OK — the access
      // gate let us through, only the JSX render then tripped on missing
      // React in the test runtime.
      expect(err.message).not.toMatch(/^NEXT_(NOT_FOUND|REDIRECT)/)
    }
    expect(mockNotFound).not.toHaveBeenCalled()
    expect(mockRedirect).not.toHaveBeenCalled()
    expect(mockCheckRecordingAccess).toHaveBeenCalledWith(VALID_UUID, 'user-1')
  })

  it('grants access to anonymous viewer with valid ?token=', async () => {
    setupRecordingLookup({
      id: VALID_UUID,
      status: 'published',
      s3_key: 'k',
      share_token: SHARE_TOKEN,
    })

    try {
      await WatchPage({
        params: Promise.resolve({ id: VALID_UUID }),
        searchParams: Promise.resolve({ token: SHARE_TOKEN }),
      })
    } catch (err: any) {
      expect(err.message).not.toMatch(/^NEXT_(NOT_FOUND|REDIRECT)/)
    }
    expect(mockNotFound).not.toHaveBeenCalled()
    expect(mockRedirect).not.toHaveBeenCalled()
    // Token short-circuit means we never consult checkRecordingAccess.
    expect(mockCheckRecordingAccess).not.toHaveBeenCalled()
  })

  it('404s anonymous viewer with no token', async () => {
    setupRecordingLookup({
      id: VALID_UUID,
      status: 'published',
      s3_key: 'k',
      share_token: SHARE_TOKEN,
    })

    await expect(
      WatchPage({
        params: Promise.resolve({ id: VALID_UUID }),
        searchParams: Promise.resolve({}),
      })
    ).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('404s authenticated user without grant + without token', async () => {
    setupRecordingLookup({
      id: VALID_UUID,
      status: 'published',
      s3_key: 'k',
      share_token: SHARE_TOKEN,
    })
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user-no-access' } },
      error: null,
    })
    mockCheckRecordingAccess.mockResolvedValueOnce({ hasAccess: false })

    await expect(
      WatchPage({
        params: Promise.resolve({ id: VALID_UUID }),
        searchParams: Promise.resolve({}),
      })
    ).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('404s when ?token= mismatches the recording share_token', async () => {
    setupRecordingLookup({
      id: VALID_UUID,
      status: 'published',
      s3_key: 'k',
      share_token: SHARE_TOKEN,
    })

    await expect(
      WatchPage({
        params: Promise.resolve({ id: VALID_UUID }),
        searchParams: Promise.resolve({ token: 'wrong-token' }),
      })
    ).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('redirects legacy /watch/<share-token> to canonical /watch/<id>?token=...', async () => {
    setupRecordingLookup(
      { id: 'unused', status: 'published' },
      { id: VALID_UUID }
    )

    await expect(
      WatchPage({
        params: Promise.resolve({ id: SHARE_TOKEN }),
        searchParams: Promise.resolve({}),
      })
    ).rejects.toThrow(`NEXT_REDIRECT:/watch/${VALID_UUID}?token=${SHARE_TOKEN}`)
  })

  it('404s when legacy path segment is not a UUID and no share_token matches', async () => {
    setupRecordingLookup({ id: 'x' }, null)

    await expect(
      WatchPage({
        params: Promise.resolve({ id: 'not-a-uuid-or-token' }),
        searchParams: Promise.resolve({}),
      })
    ).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('404s an unpublished recording even if access would otherwise pass', async () => {
    setupRecordingLookup({
      id: VALID_UUID,
      status: 'draft',
      s3_key: 'k',
      share_token: SHARE_TOKEN,
    })

    await expect(
      WatchPage({
        params: Promise.resolve({ id: VALID_UUID }),
        searchParams: Promise.resolve({ token: SHARE_TOKEN }),
      })
    ).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
