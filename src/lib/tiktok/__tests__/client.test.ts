import { describe, it, expect, vi, beforeEach } from 'vitest'

// Env must exist before the module under test reads it.
vi.hoisted(() => {
  process.env.TIKTOK_CLIENT_KEY = 'test_client_key'
  process.env.TIKTOK_CLIENT_SECRET = 'test_client_secret'
  process.env.NEXT_PUBLIC_APP_URL = 'https://playhub.playbacksports.ai'
  delete process.env.TIKTOK_REDIRECT_URI
})

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { createServiceClient } from '@/lib/supabase/server'
import { tiktok, TIKTOK_SCOPES } from '@/lib/tiktok/client'
import { getUserInfo, listVideos } from '@/lib/tiktok/api'
import { uploadVideoToInbox } from '@/lib/tiktok/publish'
import { TikTokAuthError } from '@/lib/tiktok/errors'

/**
 * Chainable Supabase builder mock. Every builder method returns the builder;
 * `single()`/`upsert()` return real promises; the builder itself is thenable so
 * `await update().eq()` and `await delete().eq()` resolve. `calls` exposes the
 * mutation args for assertions.
 */
function makeClient(
  singleResult: { data: unknown; error: unknown },
  thenResult: { error: unknown } = { error: null }
) {
  const calls = {
    upsert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    from: vi.fn(),
    eq: vi.fn(),
  }
  const builder: any = {
    select: () => builder,
    eq: (col: unknown, val: unknown) => {
      calls.eq(col, val)
      return builder
    },
    delete: () => {
      calls.delete()
      return builder
    },
    update: (obj: unknown) => {
      calls.update(obj)
      return builder
    },
    upsert: (obj: unknown, opts: unknown) => {
      calls.upsert(obj, opts)
      return Promise.resolve({ error: null })
    },
    single: () => Promise.resolve(singleResult),
    then: (resolve: (v: unknown) => void) => resolve(thenResult),
  }
  const client = {
    from: (t: string) => {
      calls.from(t)
      return builder
    },
  }
  return { client, calls }
}

function fetchOnce(status: number, body: unknown, ok = status < 300) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

const ACTIVE_CONN = {
  id: 'conn-1',
  user_id: 'user-1',
  open_id: 'open-123',
  access_token: 'stored-access',
  refresh_token: 'stored-refresh',
  // valid for another day → no refresh
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  is_active: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('tiktok.getConnectUrl', () => {
  it('builds the authorize URL with client_key, comma scopes, redirect and state', () => {
    const url = new URL(tiktok.getConnectUrl('csrf-state-xyz'))
    expect(url.origin + url.pathname).toBe(
      'https://www.tiktok.com/v2/auth/authorize/'
    )
    expect(url.searchParams.get('client_key')).toBe('test_client_key')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).toBe('csrf-state-xyz')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://playhub.playbacksports.ai/api/auth/tiktok/callback'
    )
    // comma-separated, all five scopes
    expect(url.searchParams.get('scope')).toBe(TIKTOK_SCOPES.join(','))
  })
})

describe('tiktok.handleCallback', () => {
  it('exchanges the code and stores both tokens + open_id with is_active', async () => {
    const { client, calls } = makeClient({ data: null, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        fetchOnce(200, {
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          open_id: 'open-123',
          scope: 'user.info.basic,video.upload',
          expires_in: 86400,
          refresh_expires_in: 31536000,
          token_type: 'Bearer',
        })
      )
    )

    await tiktok.handleCallback('auth-code', 'user-1')

    expect(calls.upsert).toHaveBeenCalledTimes(1)
    const [row, opts] = calls.upsert.mock.calls[0]
    expect(row).toMatchObject({
      user_id: 'user-1',
      open_id: 'open-123',
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      is_active: true,
    })
    expect(opts).toEqual({ onConflict: 'user_id' })
  })

  it('posts form-urlencoded authorization_code params to the token endpoint', async () => {
    const { client } = makeClient({ data: null, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    const fetchMock = vi.fn().mockResolvedValueOnce(
      fetchOnce(200, {
        access_token: 'a',
        refresh_token: 'r',
        open_id: 'o',
        expires_in: 86400,
        refresh_expires_in: 31536000,
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await tiktok.handleCallback('the-code', 'user-1')

    const [urlArg, init] = fetchMock.mock.calls[0]
    expect(urlArg).toBe('https://open.tiktokapis.com/v2/oauth/token/')
    expect(init.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded'
    )
    const params = new URLSearchParams(init.body as string)
    expect(params.get('grant_type')).toBe('authorization_code')
    expect(params.get('client_key')).toBe('test_client_key')
    expect(params.get('client_secret')).toBe('test_client_secret')
    expect(params.get('code')).toBe('the-code')
  })
})

describe('tiktok.getAccessToken', () => {
  it('returns the stored token without refreshing when still valid', async () => {
    const { client } = makeClient({ data: ACTIVE_CONN, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const token = await tiktok.getAccessToken('user-1')

    expect(token).toBe('stored-access')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes and atomically stores BOTH rotated tokens when expired', async () => {
    const expired = {
      ...ACTIVE_CONN,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }
    const { client, calls } = makeClient({ data: expired, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        fetchOnce(200, {
          access_token: 'rotated-access',
          refresh_token: 'rotated-refresh',
          open_id: 'open-123',
          scope: 'user.info.basic',
          expires_in: 86400,
          refresh_expires_in: 31536000,
        })
      )
    )

    const token = await tiktok.getAccessToken('user-1')

    expect(token).toBe('rotated-access')
    expect(calls.update).toHaveBeenCalledTimes(1)
    const updateArg = calls.update.mock.calls[0][0]
    // Both the new access AND the new (rotated) refresh token are persisted,
    // and the row is (re)activated so a concurrent loser's deactivate is undone.
    expect(updateArg.access_token).toBe('rotated-access')
    expect(updateArg.refresh_token).toBe('rotated-refresh')
    expect(updateArg.is_active).toBe(true)
  })

  it('marks the connection inactive and throws when refresh fails', async () => {
    const expired = {
      ...ACTIVE_CONN,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }
    const { client, calls } = makeClient({ data: expired, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        fetchOnce(400, { error: 'invalid_grant' }, false)
      )
    )

    await expect(tiktok.getAccessToken('user-1')).rejects.toThrow(/reconnect/i)
    expect(calls.update).toHaveBeenCalledWith(
      expect.objectContaining({ is_active: false })
    )
  })

  it('throws when the user has no active connection', async () => {
    const { client } = makeClient({ data: null, error: { message: 'none' } })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    await expect(tiktok.getAccessToken('user-1')).rejects.toThrow(
      /no active tiktok connection/i
    )
  })
})

describe('getUserInfo', () => {
  it('maps profile + stats fields from the user/info envelope', async () => {
    const { client } = makeClient({ data: ACTIVE_CONN, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        fetchOnce(200, {
          data: {
            user: {
              open_id: 'open-123',
              display_name: 'PLAYBACK FC',
              avatar_url: 'https://cdn/x.jpg',
              follower_count: 1200,
              following_count: 30,
              likes_count: 45000,
              video_count: 88,
            },
          },
          error: { code: 'ok' },
        })
      )
    )

    const p = await getUserInfo('user-1')
    expect(p.displayName).toBe('PLAYBACK FC')
    expect(p.followerCount).toBe(1200)
    expect(p.likesCount).toBe(45000)
    expect(p.videoCount).toBe(88)
  })

  it('throws on a non-ok error envelope even with HTTP 200', async () => {
    const { client } = makeClient({ data: ACTIVE_CONN, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        fetchOnce(200, {
          data: {},
          error: { code: 'scope_not_authorized', message: 'nope' },
        })
      )
    )
    await expect(getUserInfo('user-1')).rejects.toThrow(/scope_not_authorized/)
  })
})

describe('uploadVideoToInbox', () => {
  it('inits (FILE_UPLOAD single chunk), PUTs the bytes, and returns status', async () => {
    const { client } = makeClient({ data: ACTIVE_CONN, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    const bytes = new Uint8Array(1024 * 1024) // 1 MB
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        fetchOnce(200, {
          data: { publish_id: 'pub-1', upload_url: 'https://upload/x' },
          error: { code: 'ok' },
        })
      )
      .mockResolvedValueOnce(fetchOnce(200, {}, true)) // PUT
      .mockResolvedValueOnce(
        fetchOnce(200, {
          data: { status: 'SEND_TO_USER_INBOX' },
          error: { code: 'ok' },
        })
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await uploadVideoToInbox('user-1', bytes)

    expect(result.publishId).toBe('pub-1')
    expect(result.status).toBe('SEND_TO_USER_INBOX')

    // init body advertises a single whole-file chunk
    const initBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(initBody.source_info).toEqual({
      source: 'FILE_UPLOAD',
      video_size: bytes.byteLength,
      chunk_size: bytes.byteLength,
      total_chunk_count: 1,
    })
    // PUT carries the correct single-chunk Content-Range
    const putInit = fetchMock.mock.calls[1][1]
    expect(putInit.method).toBe('PUT')
    expect(putInit.headers['Content-Range']).toBe(
      `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`
    )
  })

  it('rejects an empty buffer', async () => {
    const { client } = makeClient({ data: ACTIVE_CONN, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    await expect(
      uploadVideoToInbox('user-1', new Uint8Array(0))
    ).rejects.toThrow(/empty/i)
  })

  it('rejects a file over the single-chunk ceiling', async () => {
    const { client } = makeClient({ data: ACTIVE_CONN, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    const huge = new Uint8Array(65 * 1024 * 1024)
    await expect(uploadVideoToInbox('user-1', huge)).rejects.toThrow(/limit/i)
  })

  it('throws when the chunk PUT fails', async () => {
    const { client } = makeClient({ data: ACTIVE_CONN, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        fetchOnce(200, {
          data: { publish_id: 'p', upload_url: 'https://u' },
          error: { code: 'ok' },
        })
      )
      .mockResolvedValueOnce(fetchOnce(403, { message: 'expired url' }, false))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      uploadVideoToInbox('user-1', new Uint8Array(1024))
    ).rejects.toThrow(/chunk upload failed/i)
  })

  it('returns PROCESSING_UPLOAD if the trailing status fetch fails (best-effort)', async () => {
    const { client } = makeClient({ data: ACTIVE_CONN, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        fetchOnce(200, {
          data: { publish_id: 'p2', upload_url: 'https://u' },
          error: { code: 'ok' },
        })
      )
      .mockResolvedValueOnce(fetchOnce(200, {}, true)) // PUT ok
      .mockResolvedValueOnce(fetchOnce(500, {}, false)) // status fetch fails
    vi.stubGlobal('fetch', fetchMock)
    // Bytes are committed, so a failed status read must not throw.
    const res = await uploadVideoToInbox('user-1', new Uint8Array(1024))
    expect(res.publishId).toBe('p2')
    expect(res.status).toBe('PROCESSING_UPLOAD')
  })
})

/**
 * Sequential single() mock — each `.single()` returns the next queued result
 * (last result repeats once drained). Lets us model the rotation race where the
 * initial read and the post-failure re-read return different rows.
 */
function makeClientSeq(
  results: Array<{ data: unknown; error: unknown }>,
  thenResult: { error: unknown } = { error: null }
) {
  const queue = [...results]
  const calls = { update: vi.fn(), upsert: vi.fn(), eq: vi.fn() }
  const builder: any = {
    select: () => builder,
    eq: (col: unknown, val: unknown) => {
      calls.eq(col, val)
      return builder
    },
    update: (obj: unknown) => {
      calls.update(obj)
      return builder
    },
    upsert: (obj: unknown, opts: unknown) => {
      calls.upsert(obj, opts)
      return Promise.resolve({ error: null })
    },
    single: () =>
      Promise.resolve(queue.length > 1 ? queue.shift() : queue[0]),
    then: (resolve: (v: unknown) => void) => resolve(thenResult),
  }
  return { client: { from: () => builder }, calls }
}

describe('tiktok.getAccessToken — refresh failure handling', () => {
  const expired = {
    ...ACTIVE_CONN,
    expires_at: new Date(Date.now() - 1000).toISOString(),
  }

  it('does NOT deactivate on a transient (5xx) refresh failure', async () => {
    const { client, calls } = makeClient({ data: expired, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fetchOnce(500, {}, false)))

    await expect(tiktok.getAccessToken('user-1')).rejects.toThrow(
      /temporarily unavailable/i
    )
    const deactivated = calls.update.mock.calls.some(
      ([arg]) => arg && (arg as { is_active?: boolean }).is_active === false
    )
    expect(deactivated).toBe(false)
  })

  it('deactivates with a needs_reconnect code when the refresh token is dead', async () => {
    const { client } = makeClient({ data: expired, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fetchOnce(400, { error: 'invalid_grant' }, false))
    )
    await expect(tiktok.getAccessToken('user-1')).rejects.toMatchObject({
      code: 'needs_reconnect',
    })
  })

  it('returns the token a concurrent request already refreshed (rotation race)', async () => {
    // First read = expired row; the post-failure re-read = a row another request
    // already refreshed (different access_token, still active).
    const { client, calls } = makeClientSeq([
      { data: expired, error: null },
      {
        data: { access_token: 'concurrently-refreshed', is_active: true },
        error: null,
      },
    ])
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    // Our own refresh fails: the single-use refresh token was already consumed.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fetchOnce(400, { error: 'invalid_grant' }, false))
    )

    const token = await tiktok.getAccessToken('user-1')
    expect(token).toBe('concurrently-refreshed')
    const deactivated = calls.update.mock.calls.some(
      ([arg]) => arg && (arg as { is_active?: boolean }).is_active === false
    )
    expect(deactivated).toBe(false)
  })

  it('surfaces not_connected code when there is no connection', async () => {
    const { client } = makeClient({ data: null, error: { message: 'none' } })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    await expect(tiktok.getAccessToken('user-1')).rejects.toMatchObject({
      code: 'not_connected',
    })
    expect(TikTokAuthError).toBeDefined()
  })

  it('guards the deactivate on refresh_token so the pre-persist race is a no-op', async () => {
    // Loser path: our refresh gets invalid_grant, and the re-read still shows the
    // ORIGINAL token (the concurrent winner has refreshed at TikTok but not yet
    // persisted). We must still deactivate, but the write is guarded on the
    // unchanged refresh_token so the winner's later persist wins.
    const { client, calls } = makeClientSeq([
      { data: expired, error: null },
      // re-read: unchanged access_token → race-return guard is NOT taken
      {
        data: { access_token: expired.access_token, is_active: true },
        error: null,
      },
    ])
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fetchOnce(400, { error: 'invalid_grant' }, false))
    )

    await expect(tiktok.getAccessToken('user-1')).rejects.toMatchObject({
      code: 'needs_reconnect',
    })
    // The deactivate must be guarded on the refresh_token we read.
    expect(calls.update).toHaveBeenCalledWith(
      expect.objectContaining({ is_active: false })
    )
    expect(calls.eq).toHaveBeenCalledWith('refresh_token', expired.refresh_token)
  })

  it('does NOT deactivate on a malformed 2xx refresh body (treated as transient)', async () => {
    const { client, calls } = makeClient({ data: expired, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    // 200 OK but missing access_token/refresh_token/open_id, no error envelope.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fetchOnce(200, { token_type: 'Bearer' }))
    )
    await expect(tiktok.getAccessToken('user-1')).rejects.toThrow(
      /temporarily unavailable/i
    )
    const deactivated = calls.update.mock.calls.some(
      ([arg]) => arg && (arg as { is_active?: boolean }).is_active === false
    )
    expect(deactivated).toBe(false)
  })

  it('throws a retryable error when persisting the refreshed tokens fails', async () => {
    // Refresh succeeds at TikTok, but the DB write of the rotated tokens fails.
    const { client } = makeClient(
      { data: expired, error: null },
      { error: { message: 'db write failed' } }
    )
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        fetchOnce(200, {
          access_token: 'a',
          refresh_token: 'r',
          open_id: 'o',
          expires_in: 86400,
          refresh_expires_in: 31536000,
        })
      )
    )
    await expect(tiktok.getAccessToken('user-1')).rejects.toThrow(
      /could not save/i
    )
  })
})

describe('exchangeCode via handleCallback', () => {
  it('throws on a 200 response carrying a token error envelope', async () => {
    const { client } = makeClient({ data: null, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        fetchOnce(200, {
          error: 'invalid_request',
          error_description: 'bad code',
        })
      )
    )
    await expect(tiktok.handleCallback('code', 'user-1')).rejects.toThrow(
      /exchange failed/i
    )
  })
})

describe('listVideos', () => {
  it('maps videos + pagination from the envelope', async () => {
    const { client } = makeClient({ data: ACTIVE_CONN, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        fetchOnce(200, {
          data: {
            videos: [
              {
                id: 'v1',
                title: 'Goal',
                cover_image_url: 'c',
                share_url: 's',
                view_count: 900,
                like_count: 12,
                comment_count: 3,
                share_count: 1,
                create_time: 100,
              },
            ],
            cursor: 42,
            has_more: true,
          },
          error: { code: 'ok' },
        })
      )
    )
    const page = await listVideos('user-1')
    expect(page.videos).toHaveLength(1)
    expect(page.videos[0]).toMatchObject({
      id: 'v1',
      viewCount: 900,
      likeCount: 12,
    })
    expect(page.cursor).toBe(42)
    expect(page.hasMore).toBe(true)
  })

  it('throws on a non-ok error envelope', async () => {
    const { client } = makeClient({ data: ACTIVE_CONN, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as any)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        fetchOnce(200, {
          data: {},
          error: { code: 'access_token_invalid', message: 'bad' },
        })
      )
    )
    await expect(listVideos('user-1')).rejects.toThrow(/access_token_invalid/)
  })
})
