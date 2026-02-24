import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub env vars before the module loads
vi.hoisted(() => {
  process.env.PLAYERDATA_CLIENT_ID = 'pd-client-id'
  process.env.PLAYERDATA_CLIENT_SECRET = 'pd-client-secret'
  process.env.NEXT_PUBLIC_BASE_URL = 'https://playhub.test'
})

// Mock commons playerdata module
const mockGenerateAuthUrl = vi.fn()
const mockExchangeCode = vi.fn()
const mockRefreshToken = vi.fn()
const mockGetServiceToken = vi.fn()
const mockExecuteQuery = vi.fn()

vi.mock('@braintwopoint0/playback-commons/playerdata', () => ({
  generateAuthUrl: (...args: unknown[]) => mockGenerateAuthUrl(...args),
  exchangeCode: (...args: unknown[]) => mockExchangeCode(...args),
  refreshToken: (...args: unknown[]) => mockRefreshToken(...args),
  getServiceToken: (...args: unknown[]) => mockGetServiceToken(...args),
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
}))

// Mock supabase service client
const mockFrom = vi.fn()
const mockSelect = vi.fn()
const mockEq = vi.fn()
const mockSingle = vi.fn()
const mockUpdate = vi.fn()
const mockUpsert = vi.fn()
const mockDelete = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (...args: unknown[]) => {
      mockFrom(...args)
      return {
        select: (...sArgs: unknown[]) => {
          mockSelect(...sArgs)
          return {
            eq: (...eArgs: unknown[]) => {
              mockEq(...eArgs)
              return {
                eq: (...eArgs2: unknown[]) => {
                  mockEq(...eArgs2)
                  return { single: () => mockSingle() }
                },
                single: () => mockSingle(),
              }
            },
          }
        },
        update: (...uArgs: unknown[]) => {
          mockUpdate(...uArgs)
          return {
            eq: (...eArgs: unknown[]) => {
              mockEq(...eArgs)
              return { eq: () => Promise.resolve() }
            },
          }
        },
        upsert: (...uArgs: unknown[]) => {
          mockUpsert(...uArgs)
          return Promise.resolve({ error: null })
        },
        delete: () => {
          mockDelete()
          return {
            eq: () => Promise.resolve({ error: null }),
          }
        },
      }
    },
  }),
}))

import { playerdata, clearServiceTokenCache } from '@/lib/playerdata/client'

beforeEach(() => {
  vi.clearAllMocks()
  clearServiceTokenCache()
})

describe('playerdata.getConnectUrl', () => {
  it('passes credentials and redirect URI to generateAuthUrl', () => {
    mockGenerateAuthUrl.mockReturnValue(
      'https://playerdata.co.uk/oauth/authorize?...'
    )

    const url = playerdata.getConnectUrl('test-state')

    expect(mockGenerateAuthUrl).toHaveBeenCalledWith(
      { clientId: 'pd-client-id', clientSecret: 'pd-client-secret' },
      'https://playhub.test/api/auth/playerdata/callback',
      'test-state'
    )
    expect(url).toBe('https://playerdata.co.uk/oauth/authorize?...')
  })
})

describe('playerdata.handleCallback', () => {
  it('exchanges code and stores tokens', async () => {
    mockExchangeCode.mockResolvedValue({
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
      expiresAt: Date.now() + 3600000,
    })
    mockUpsert.mockReturnValue(Promise.resolve({ error: null }))

    await playerdata.handleCallback('auth-code', 'user-123')

    expect(mockExchangeCode).toHaveBeenCalledWith(
      { clientId: 'pd-client-id', clientSecret: 'pd-client-secret' },
      'auth-code',
      'https://playhub.test/api/auth/playerdata/callback'
    )
    expect(mockFrom).toHaveBeenCalledWith('playerdata_connections')
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-123',
        access_token: 'access-123',
        refresh_token: 'refresh-456',
        is_active: true,
      }),
      { onConflict: 'user_id' }
    )
  })
})

describe('playerdata.queryAsService', () => {
  it('fetches service token and executes query', async () => {
    mockGetServiceToken.mockResolvedValue({
      accessToken: 'service-token',
      refreshToken: '',
      expiresAt: Date.now() + 3600000,
    })
    mockExecuteQuery.mockResolvedValue({ sessions: [] })

    const result = await playerdata.queryAsService('{ sessions { id } }')

    expect(mockGetServiceToken).toHaveBeenCalled()
    expect(mockExecuteQuery).toHaveBeenCalledWith(
      'service-token',
      '{ sessions { id } }',
      undefined
    )
    expect(result).toEqual({ sessions: [] })
  })

  it('caches service token across calls', async () => {
    mockGetServiceToken.mockResolvedValue({
      accessToken: 'service-token',
      refreshToken: '',
      expiresAt: Date.now() + 3600000,
    })
    mockExecuteQuery.mockResolvedValue({ data: true })

    await playerdata.queryAsService('{ q1 }')
    await playerdata.queryAsService('{ q2 }')

    // Only one token fetch
    expect(mockGetServiceToken).toHaveBeenCalledTimes(1)
    // Two queries
    expect(mockExecuteQuery).toHaveBeenCalledTimes(2)
  })
})

describe('playerdata.queryAsUser', () => {
  it('reads token from DB and executes query', async () => {
    mockSingle.mockResolvedValue({
      data: {
        id: 'conn-1',
        user_id: 'user-1',
        access_token: 'user-token',
        refresh_token: 'user-refresh',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        is_active: true,
      },
      error: null,
    })
    mockExecuteQuery.mockResolvedValue({ metrics: {} })

    const result = await playerdata.queryAsUser('user-1', '{ metrics }', {
      id: '1',
    })

    expect(mockFrom).toHaveBeenCalledWith('playerdata_connections')
    expect(mockExecuteQuery).toHaveBeenCalledWith('user-token', '{ metrics }', {
      id: '1',
    })
    expect(result).toEqual({ metrics: {} })
  })

  it('refreshes expired token and stores new pair', async () => {
    // Return expired token from DB
    mockSingle.mockResolvedValue({
      data: {
        id: 'conn-1',
        user_id: 'user-1',
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        expires_at: new Date(Date.now() - 1000).toISOString(), // expired
        is_active: true,
      },
      error: null,
    })

    // Refresh returns new tokens
    mockRefreshToken.mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: Date.now() + 3600000,
    })

    mockExecuteQuery.mockResolvedValue({ data: true })

    await playerdata.queryAsUser('user-1', '{ q }')

    expect(mockRefreshToken).toHaveBeenCalledWith(
      { clientId: 'pd-client-id', clientSecret: 'pd-client-secret' },
      'old-refresh'
    )
    // Should store both new tokens
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
      })
    )
    expect(mockExecuteQuery).toHaveBeenCalledWith(
      'new-access',
      '{ q }',
      undefined
    )
  })

  it('marks connection inactive when refresh fails', async () => {
    mockSingle.mockResolvedValue({
      data: {
        id: 'conn-1',
        user_id: 'user-1',
        access_token: 'old',
        refresh_token: 'used-refresh',
        expires_at: new Date(Date.now() - 1000).toISOString(),
        is_active: true,
      },
      error: null,
    })

    mockRefreshToken.mockRejectedValue(new Error('invalid_grant'))

    await expect(playerdata.queryAsUser('user-1', '{ q }')).rejects.toThrow(
      'PlayerData connection expired'
    )

    // Should mark inactive
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ is_active: false })
    )
  })

  it('throws when no active connection exists', async () => {
    mockSingle.mockResolvedValue({
      data: null,
      error: { message: 'not found' },
    })

    await expect(playerdata.queryAsUser('user-1', '{ q }')).rejects.toThrow(
      'No active PlayerData connection'
    )
  })
})

describe('playerdata.isConnected', () => {
  it('returns true when active connection exists', async () => {
    mockSingle.mockResolvedValue({ data: { id: 'conn-1' }, error: null })

    const result = await playerdata.isConnected('user-1')
    expect(result).toBe(true)
  })

  it('returns false when no connection exists', async () => {
    mockSingle.mockResolvedValue({
      data: null,
      error: { message: 'not found' },
    })

    const result = await playerdata.isConnected('user-1')
    expect(result).toBe(false)
  })
})

describe('playerdata.disconnect', () => {
  it('deletes the connection row', async () => {
    await playerdata.disconnect('user-1')
    expect(mockFrom).toHaveBeenCalledWith('playerdata_connections')
    expect(mockDelete).toHaveBeenCalled()
  })
})
