import { describe, it, expect } from 'vitest'
import {
  testConnection,
  getGames,
  getAccountConfig,
} from '@/lib/spiideo/client'

const hasCredentials =
  !!process.env.SPIIDEO_KUWAIT_CLIENT_ID &&
  !!process.env.SPIIDEO_KUWAIT_CLIENT_SECRET &&
  !!process.env.SPIIDEO_PLAYBACK_ADMIN_USER_ID

describe.skipIf(!hasCredentials)('Spiideo Integration', () => {
  it('connects to Kuwait account', async () => {
    const result = await testConnection('kuwait')
    expect(result.success).toBe(true)
    expect(result.account).toBe('kuwait')
  })

  it('connects to Dubai account', async () => {
    const hasDubai =
      !!process.env.SPIIDEO_PERFORM_DUBAI_CLIENT_ID &&
      !!process.env.SPIIDEO_PERFORM_DUBAI_CLIENT_SECRET

    if (!hasDubai) {
      console.log('Skipping Dubai test — credentials not set')
      return
    }

    const result = await testConnection('dubai')
    expect(result.success).toBe(true)
    expect(result.account).toBe('dubai')
  })

  it('fetches games from Kuwait account', async () => {
    const config = getAccountConfig('kuwait')
    if (!config.accountId) {
      console.log('Skipping — SPIIDEO_KUWAIT_ACCOUNT_ID not set')
      return
    }

    const response = await getGames(config.accountId)
    expect(response).toHaveProperty('content')
    expect(Array.isArray(response.content)).toBe(true)
  })
})
