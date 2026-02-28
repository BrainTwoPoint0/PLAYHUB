import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub env vars before the module loads (hoisted alongside vi.mock)
vi.hoisted(() => {
  process.env.SPIIDEO_CLIENT_ID = 'test-id'
  process.env.SPIIDEO_CLIENT_SECRET = 'test-secret'
  process.env.SPIIDEO_CLIENT_NAME = 'playhub'
  process.env.SPIIDEO_PLAYBACK_ADMIN_USER_ID = 'admin-user'
  process.env.SPIIDEO_ACCOUNT_ID = 'test-acct'
  process.env.SPIIDEO_SCENE_ID = 'test-scene'
})

import {
  buildRtmpUrl,
  getAccountConfig,
  testConnection,
} from '@/lib/spiideo/client'

// ─── buildRtmpUrl ───────────────────────────────────────────────

describe('buildRtmpUrl', () => {
  it('combines base URL and stream key', () => {
    expect(buildRtmpUrl('rtmp://live.example.com/app', 'stream123')).toBe(
      'rtmp://live.example.com/app/stream123'
    )
  })

  it('strips trailing slash from base URL', () => {
    expect(buildRtmpUrl('rtmp://live.example.com/app/', 'key')).toBe(
      'rtmp://live.example.com/app/key'
    )
  })

  it('handles empty stream key', () => {
    expect(buildRtmpUrl('rtmp://example.com', '')).toBe('rtmp://example.com/')
  })
})

// ─── getAccountConfig ───────────────────────────────────────────

describe('getAccountConfig', () => {
  it('returns config with correct clientId', () => {
    const config = getAccountConfig()
    expect(config.clientId).toBe('test-id')
  })

  it('returns config with accountId from env', () => {
    const config = getAccountConfig()
    expect(config.accountId).toBe('test-acct')
  })
})

// ─── testConnection (mocked fetch) ─────────────────────────────

describe('testConnection', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns failure when token fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 })
    )

    const result = await testConnection()
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('returns success when token fetch succeeds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'tok',
          token_type: 'bearer',
          expires_in: 3600,
        }),
        { status: 200 }
      )
    )

    const result = await testConnection()
    expect(result.success).toBe(true)
  })
})
