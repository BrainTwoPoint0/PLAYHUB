import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub env vars before the module loads (hoisted alongside vi.mock)
vi.hoisted(() => {
  process.env.SPIIDEO_KUWAIT_CLIENT_ID = 'kw-id'
  process.env.SPIIDEO_KUWAIT_CLIENT_SECRET = 'kw-secret'
  process.env.SPIIDEO_KUWAIT_CLIENT_NAME = 'playhub'
  process.env.SPIIDEO_PLAYBACK_ADMIN_USER_ID = 'admin-user'
  process.env.SPIIDEO_KUWAIT_ACCOUNT_ID = 'kw-acct'
  process.env.SPIIDEO_KUWAIT_SCENE_ID = 'kw-scene'
  process.env.SPIIDEO_PERFORM_DUBAI_CLIENT_ID = 'dxb-id'
  process.env.SPIIDEO_PERFORM_DUBAI_CLIENT_SECRET = 'dxb-secret'
  process.env.SPIIDEO_PERFORM_DUBAI_CLIENT_NAME = 'playhub'
  process.env.SPIIDEO_PERFORM_DUBAI_ACCOUNT_ID = 'dxb-acct'
})

import {
  buildRtmpUrl,
  setActiveAccount,
  getActiveAccount,
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

// ─── setActiveAccount / getActiveAccount ────────────────────────

describe('account switching', () => {
  beforeEach(() => {
    setActiveAccount('kuwait') // reset to default
  })

  it('defaults to kuwait', () => {
    expect(getActiveAccount()).toBe('kuwait')
  })

  it('switches to dubai', () => {
    setActiveAccount('dubai')
    expect(getActiveAccount()).toBe('dubai')
  })

  it('switches back to kuwait', () => {
    setActiveAccount('dubai')
    setActiveAccount('kuwait')
    expect(getActiveAccount()).toBe('kuwait')
  })
})

// ─── getAccountConfig ───────────────────────────────────────────

describe('getAccountConfig', () => {
  it('returns kuwait config with correct type', () => {
    const config = getAccountConfig('kuwait')
    expect(config.type).toBe('play')
    expect(config.clientId).toBe('kw-id')
  })

  it('returns dubai config with correct type', () => {
    const config = getAccountConfig('dubai')
    expect(config.type).toBe('perform')
    expect(config.clientId).toBe('dxb-id')
  })
})

// ─── testConnection (mocked fetch) ─────────────────────────────

describe('testConnection', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
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

    const result = await testConnection('kuwait')
    expect(result.success).toBe(true)
    expect(result.account).toBe('kuwait')
  })

  it('returns failure when token fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 })
    )

    // Use 'dubai' to avoid hitting the cached token from the success test
    const result = await testConnection('dubai')
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })
})
