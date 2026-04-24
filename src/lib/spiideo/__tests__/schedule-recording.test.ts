import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Stubs ───────────────────────────────────────────────────────────

vi.hoisted(() => {
  process.env.SPIIDEO_CLIENT_ID = 'test-id'
  process.env.SPIIDEO_CLIENT_SECRET = 'test-secret'
  process.env.SPIIDEO_CLIENT_NAME = 'playhub'
  process.env.SPIIDEO_PLAYBACK_ADMIN_USER_ID = 'admin-user'
  process.env.SPIIDEO_ACCOUNT_ID = 'test-acct'
  process.env.SPIIDEO_SCENE_ID = 'test-scene'
})

const mockCreateGame = vi.fn()
const mockCreateProduction = vi.fn()
const mockGetAccountConfig = vi.fn()

vi.mock('@/lib/spiideo/client', () => ({
  createGame: (...args: any[]) => mockCreateGame(...args),
  createProduction: (...args: any[]) => mockCreateProduction(...args),
  getAccountConfig: (...args: any[]) => mockGetAccountConfig(...args),
}))

// Chainable Supabase mock helper
function chainable(resolvedValue: { data: any; error: any }) {
  const chain: any = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.maybeSingle = vi.fn().mockResolvedValue(resolvedValue)
  chain.single = vi.fn().mockResolvedValue(resolvedValue)
  chain.insert = vi.fn().mockReturnValue(chain)
  chain.update = vi.fn().mockReturnValue(chain)
  return chain
}

const mockBillingChain = chainable({
  data: { default_billable_amount: 5, currency: 'KWD' },
  error: null,
})

const mockRecordingChain = chainable({
  data: { id: 'rec-123' },
  error: null,
})

const mockAccessChain = chainable({ data: null, error: null })
const mockProductChain = chainable({ data: null, error: null })

const mockServiceClient = {
  from: vi.fn((table: string) => {
    if (table === 'playhub_venue_billing_config') return mockBillingChain
    if (table === 'playhub_match_recordings') return mockRecordingChain
    if (table === 'playhub_access_rights') return mockAccessChain
    if (table === 'playhub_products') return mockProductChain
    return chainable({ data: null, error: null })
  }),
}

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => mockServiceClient,
}))

import { scheduleRecording } from '@/lib/spiideo/schedule-recording'

// ── Defaults ────────────────────────────────────────────────────────

const baseInput = {
  venueId: 'venue-1',
  sceneId: 'scene-1',
  sceneName: 'Pitch 1',
  durationMinutes: 60,
  title: 'Test Game',
  description: 'A test',
  email: 'player@example.com',
  collectedBy: 'playhub' as const,
}

// ── Tests ───────────────────────────────────────────────────────────

describe('scheduleRecording', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockGetAccountConfig.mockReturnValue({ accountId: 'test-acct' })
    mockCreateGame.mockResolvedValue({ id: 'game-1' })
    mockCreateProduction.mockResolvedValue({ id: 'prod-1' })

    // Reset chains
    mockBillingChain.maybeSingle.mockResolvedValue({
      data: { default_billable_amount: 5, currency: 'KWD' },
      error: null,
    })
    mockRecordingChain.single.mockResolvedValue({
      data: { id: 'rec-123' },
      error: null,
    })
    mockAccessChain.insert.mockReturnValue(mockAccessChain)
  })

  it('creates game with 1-min buffer for self-service (default)', async () => {
    const before = Date.now()
    await scheduleRecording(baseInput)

    const callArgs = mockCreateGame.mock.calls[0][0]
    const startMs = new Date(callArgs.scheduledStartTime).getTime()
    // Should be roughly now + 60 000
    expect(startMs).toBeGreaterThanOrEqual(before + 59_000)
    expect(startMs).toBeLessThanOrEqual(Date.now() + 61_000)
  })

  it('creates game with no buffer when startBufferMs = 0 and explicit times', async () => {
    const start = '2026-03-01T10:00:00Z'
    const stop = '2026-03-01T11:00:00Z'
    await scheduleRecording({
      ...baseInput,
      collectedBy: 'venue',
      startBufferMs: 0,
      scheduledStartTime: start,
      scheduledStopTime: stop,
    })

    const callArgs = mockCreateGame.mock.calls[0][0]
    expect(callArgs.scheduledStartTime).toBe(start)
    expect(callArgs.scheduledStopTime).toBe(stop)
  })

  it('creates production with single_game + live type', async () => {
    await scheduleRecording(baseInput)

    expect(mockCreateProduction).toHaveBeenCalledWith('game-1', {
      productionType: 'single_game',
      type: 'live',
    })
  })

  it('inserts recording with correct fields', async () => {
    await scheduleRecording({
      ...baseInput,
      createdBy: 'user-42',
      collectedBy: 'venue',
      isBillable: true,
    })

    const insertCall = mockRecordingChain.insert.mock.calls[0][0]
    expect(insertCall.organization_id).toBe('venue-1')
    expect(insertCall.spiideo_game_id).toBe('game-1')
    expect(insertCall.spiideo_production_id).toBe('prod-1')
    expect(insertCall.collected_by).toBe('venue')
    expect(insertCall.created_by).toBe('user-42')
    expect(insertCall.is_billable).toBe(false)
    expect(insertCall.status).toBe('scheduled')
  })

  it('grants access to email', async () => {
    await scheduleRecording(baseInput)

    expect(mockAccessChain.insert).toHaveBeenCalled()
    const accessInsert = mockAccessChain.insert.mock.calls[0][0]
    expect(accessInsert[0].invited_email).toBe('player@example.com')
    expect(accessInsert[0].match_recording_id).toBe('rec-123')
  })

  it('grants access to multiple emails', async () => {
    await scheduleRecording({
      ...baseInput,
      accessEmails: ['coach@example.com', 'scout@example.com'],
    })

    const accessInsert = mockAccessChain.insert.mock.calls[0][0]
    const emails = accessInsert.map((a: any) => a.invited_email)
    expect(emails).toContain('coach@example.com')
    expect(emails).toContain('scout@example.com')
    expect(emails).toContain('player@example.com')
  })

  it('returns all IDs on success', async () => {
    const result = await scheduleRecording(baseInput)

    expect(result.gameId).toBe('game-1')
    expect(result.productionId).toBe('prod-1')
    expect(result.recordingId).toBe('rec-123')
    expect(result.startTime).toBeDefined()
    expect(result.stopTime).toBeDefined()
  })

  it('throws when Spiideo API fails', async () => {
    mockCreateGame.mockRejectedValue(new Error('Spiideo 500'))

    await expect(scheduleRecording(baseInput)).rejects.toThrow('Spiideo 500')
  })

  it('throws on DB insert failure', async () => {
    mockRecordingChain.single.mockResolvedValue({
      data: null,
      error: { message: 'DB error' },
    })

    await expect(scheduleRecording(baseInput)).rejects.toThrow(
      'Failed to create recording in database: DB error'
    )
  })

  it('uses default billing config when billableAmount not provided', async () => {
    await scheduleRecording(baseInput)

    const insertCall = mockRecordingChain.insert.mock.calls[0][0]
    expect(insertCall.billable_amount).toBe(5)
    expect(insertCall.billable_currency).toBe('KWD')
  })

  it('uses explicit billableAmount when provided', async () => {
    await scheduleRecording({ ...baseInput, billableAmount: 10 })

    const insertCall = mockRecordingChain.insert.mock.calls[0][0]
    expect(insertCall.billable_amount).toBe(10)
  })

  it('creates marketplace product when marketplaceEnabled', async () => {
    mockProductChain.insert.mockReturnValue(mockProductChain)

    await scheduleRecording({
      ...baseInput,
      marketplaceEnabled: true,
      priceAmount: 25,
      priceCurrency: 'AED',
    })

    expect(mockServiceClient.from).toHaveBeenCalledWith('playhub_products')
    const insertCall = mockProductChain.insert.mock.calls[0][0]
    expect(insertCall.price_amount).toBe(25)
    expect(insertCall.currency).toBe('AED')
    expect(insertCall.match_recording_id).toBe('rec-123')

    // Also flags the recording
    expect(mockRecordingChain.update).toHaveBeenCalledWith({
      marketplace_enabled: true,
    })
  })

  it('does not create marketplace product when not enabled', async () => {
    await scheduleRecording(baseInput)

    // playhub_products should not have been called
    const productCalls = mockServiceClient.from.mock.calls.filter(
      (c: any) => c[0] === 'playhub_products'
    )
    expect(productCalls.length).toBe(0)
  })
})
