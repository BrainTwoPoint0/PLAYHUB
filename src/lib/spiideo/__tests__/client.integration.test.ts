import { describe, it, expect } from 'vitest'
import {
  testConnection,
  getGames,
  getAccountConfig,
} from '@/lib/spiideo/client'

const hasCredentials =
  !!process.env.SPIIDEO_CLIENT_ID &&
  !!process.env.SPIIDEO_CLIENT_SECRET &&
  !!process.env.SPIIDEO_PLAYBACK_ADMIN_USER_ID

describe.skipIf(!hasCredentials)('Spiideo Integration', () => {
  it('connects to Spiideo account', async () => {
    const result = await testConnection()
    expect(result.success).toBe(true)
  })

  it('fetches games from account', async () => {
    const config = getAccountConfig()
    if (!config.accountId) {
      console.log('Skipping — SPIIDEO_ACCOUNT_ID not set')
      return
    }

    const response = await getGames(config.accountId)
    expect(response).toHaveProperty('content')
    expect(Array.isArray(response.content)).toBe(true)
  })
})
