import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ───────────────────────────────────────────────────────────

const mockServiceFrom = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (...args: any[]) => mockServiceFrom(...args),
  }),
}))

import { persistScheduledRecording } from '@/lib/recordings/persist-scheduled-recording'

// ── Helpers ─────────────────────────────────────────────────────────

const recordingInsert = vi.fn()

function makeChains() {
  const billingChain: any = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi
      .fn()
      .mockResolvedValue({ data: { default_billable_amount: 5, currency: 'KWD' }, error: null }),
  }
  const recordingsChain: any = {
    insert: recordingInsert.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        single: vi
          .fn()
          .mockResolvedValue({ data: { id: 'rec-1' }, error: null }),
      }),
    })),
  }
  const genericChain: any = {
    insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  }
  return { billingChain, recordingsChain, genericChain }
}

function baseInput(overrides: Record<string, any> = {}) {
  return {
    venueId: 'venue-1',
    sceneName: 'Pitch A',
    durationMinutes: 60,
    title: 'Test Match',
    description: '',
    email: '',
    createdBy: 'user-1',
    collectedBy: 'venue',
    ...overrides,
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
  const { billingChain, recordingsChain, genericChain } = makeChains()
  mockServiceFrom.mockImplementation((table: string) => {
    if (table === 'playhub_venue_billing_config') return billingChain
    if (table === 'playhub_match_recordings') return recordingsChain
    return genericChain
  })
})

// ── Tests ───────────────────────────────────────────────────────────

describe('persistScheduledRecording — is_billable', () => {
  it('persists is_billable: true when the caller sends isBillable: true', async () => {
    await persistScheduledRecording(
      baseInput({ isBillable: true }),
      { spiideoGameId: 'game-1', spiideoProductionId: 'prod-1' },
      '2026-07-06T22:00:00Z',
      '2026-07-06T23:00:00Z'
    )

    expect(recordingInsert).toHaveBeenCalledWith(
      expect.objectContaining({ is_billable: true })
    )
  })

  it('persists is_billable: false when the caller sends isBillable: false', async () => {
    await persistScheduledRecording(
      baseInput({ isBillable: false }),
      { spiideoGameId: 'game-1', spiideoProductionId: 'prod-1' },
      '2026-07-06T22:00:00Z',
      '2026-07-06T23:00:00Z'
    )

    expect(recordingInsert).toHaveBeenCalledWith(
      expect.objectContaining({ is_billable: false })
    )
  })

  it('defaults is_billable to false when isBillable is omitted (e.g. QR-paid flow)', async () => {
    await persistScheduledRecording(
      baseInput(),
      { spiideoGameId: 'game-1', spiideoProductionId: 'prod-1' },
      '2026-07-06T22:00:00Z',
      '2026-07-06T23:00:00Z'
    )

    expect(recordingInsert).toHaveBeenCalledWith(
      expect.objectContaining({ is_billable: false })
    )
  })
})
