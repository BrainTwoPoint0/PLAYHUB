import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isClaimable,
  sweepPanoramaCaptures,
  CAPTURE_STUCK_MS,
  ERROR_COOLDOWN_MS,
  MAX_ATTEMPTS,
  SWEEP_MAX_PER_RUN,
  type PanoramaCandidate,
} from '../panorama-sweep'

const NOW = Date.parse('2026-07-07T12:00:00Z')

function row(overrides: Partial<PanoramaCandidate> = {}): PanoramaCandidate {
  return {
    id: 'rec-1',
    spiideo_game_id: 'game-1',
    panorama_capture_status: null,
    panorama_capture_started_at: null,
    panorama_capture_attempts: 0,
    panorama_s3_key: null,
    ...overrides,
  }
}

describe('isClaimable', () => {
  it('claims a never-attempted row', () => {
    expect(isClaimable(row(), NOW)).toBe(true)
  })

  it('never claims a row that already has its panorama', () => {
    expect(isClaimable(row({ panorama_s3_key: 'panoramas/x.mp4' }), NOW)).toBe(
      false
    )
    expect(isClaimable(row({ panorama_capture_status: 'ready' }), NOW)).toBe(
      false
    )
  })

  it('never claims a row without a spiideo game', () => {
    expect(isClaimable(row({ spiideo_game_id: null }), NOW)).toBe(false)
  })

  it('leaves a fresh pending claim alone (another claimer owns it)', () => {
    expect(
      isClaimable(
        row({
          panorama_capture_status: 'pending',
          panorama_capture_started_at: new Date(
            NOW - CAPTURE_STUCK_MS / 2
          ).toISOString(),
        }),
        NOW
      )
    ).toBe(false)
  })

  it('reclaims a STUCK pending (job died without terminal write)', () => {
    expect(
      isClaimable(
        row({
          panorama_capture_status: 'pending',
          panorama_capture_started_at: new Date(
            NOW - CAPTURE_STUCK_MS - 1000
          ).toISOString(),
        }),
        NOW
      )
    ).toBe(true)
  })

  it('retries a cooled-down error under the attempts cap', () => {
    expect(
      isClaimable(
        row({
          panorama_capture_status: 'error',
          panorama_capture_attempts: 1,
          panorama_capture_started_at: new Date(
            NOW - ERROR_COOLDOWN_MS - 1000
          ).toISOString(),
        }),
        NOW
      )
    ).toBe(true)
  })

  it('does NOT retry an error still cooling down', () => {
    expect(
      isClaimable(
        row({
          panorama_capture_status: 'error',
          panorama_capture_attempts: 1,
          panorama_capture_started_at: new Date(
            NOW - ERROR_COOLDOWN_MS / 2
          ).toISOString(),
        }),
        NOW
      )
    ).toBe(false)
  })

  it('never reclaims a stuck pending at the attempts cap (no infinite resubmit loop)', () => {
    expect(
      isClaimable(
        row({
          panorama_capture_status: 'pending',
          panorama_capture_attempts: MAX_ATTEMPTS,
          panorama_capture_started_at: new Date(
            NOW - CAPTURE_STUCK_MS * 10
          ).toISOString(),
        }),
        NOW
      )
    ).toBe(false)
  })

  it('gives up permanently at the attempts cap', () => {
    expect(
      isClaimable(
        row({
          panorama_capture_status: 'error',
          panorama_capture_attempts: MAX_ATTEMPTS,
          panorama_capture_started_at: new Date(
            NOW - ERROR_COOLDOWN_MS * 10
          ).toISOString(),
        }),
        NOW
      )
    ).toBe(false)
  })
})

/**
 * Chainable supabase stub for the sweep's three query shapes:
 *  1. candidate select (thenable builder ending in .limit)
 *  2. in-flight count  (select with head: true)
 *  3. claim / rollback updates (update().eq()[.or()], thenable)
 * Claim updates resolve from `claimCounts` in call order; rollback updates
 * (no count option) are recorded in `rollbacks`.
 */
function stubSupabase(opts: {
  candidates: PanoramaCandidate[]
  inFlight?: number
  claimCounts?: number[]
}) {
  const claimCounts = [...(opts.claimCounts ?? [])]
  const rollbacks: Array<Record<string, unknown>> = []
  const claims: Array<Record<string, unknown>> = []

  function makeBuilder(result: unknown, onResolve?: () => unknown) {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'not', 'is', 'or', 'gte', 'order', 'limit'])
      b[m] = vi.fn(() => b)
    b.then = (res: (v: unknown) => unknown) =>
      Promise.resolve(onResolve ? onResolve() : result).then(res)
    return b
  }

  const client = {
    from: vi.fn(() => ({
      select: vi.fn((_cols: string, sopts?: { head?: boolean }) => {
        if (sopts?.head)
          return makeBuilder({ count: opts.inFlight ?? 0, error: null })
        return makeBuilder({ data: opts.candidates, error: null })
      }),
      update: vi.fn(
        (values: Record<string, unknown>, uopts?: { count?: string }) => {
          if (uopts?.count === 'exact') {
            claims.push(values)
            return makeBuilder(null, () => ({
              count: claimCounts.length ? claimCounts.shift() : 1,
              error: null,
            }))
          }
          rollbacks.push(values)
          return makeBuilder({ error: null })
        }
      ),
    })),
  } as unknown as SupabaseClient
  return { client, rollbacks, claims }
}

describe('sweepPanoramaCaptures', () => {
  const twoRows = [row({ id: 'rec-1' }), row({ id: 'rec-2', spiideo_game_id: 'game-2' })]
  const manyRows = Array.from({ length: 6 }, (_, i) =>
    row({ id: `rec-${i}`, spiideo_game_id: `game-${i}` })
  )

  it('submits claimable rows up to the per-run budget', async () => {
    const { client } = stubSupabase({ candidates: manyRows })
    const submit = vi.fn(async (id: string) => `job-${id}`)
    const out = await sweepPanoramaCaptures(client, submit, NOW)
    expect(submit).toHaveBeenCalledTimes(SWEEP_MAX_PER_RUN)
    expect(out.submitted).toBe(SWEEP_MAX_PER_RUN)
    expect(out.candidates).toBe(manyRows.length)
  })

  it('budget counts submit ATTEMPTS: persistent failure stops after the budget, not after 25 rollbacks', async () => {
    const { client, rollbacks } = stubSupabase({ candidates: manyRows })
    const submit = vi.fn(async () => {
      throw new Error('AccessDeniedException')
    })
    const out = await sweepPanoramaCaptures(client, submit, NOW)
    expect(submit).toHaveBeenCalledTimes(SWEEP_MAX_PER_RUN)
    expect(out.submitted).toBe(0)
    expect(rollbacks).toHaveLength(SWEEP_MAX_PER_RUN)
  })

  it('rollback restores the pre-claim attempt count (plumbing failures must not burn capture budget)', async () => {
    const rows = [
      row({ id: 'rec-1', panorama_capture_attempts: 1, panorama_capture_status: 'error', panorama_capture_started_at: new Date(NOW - ERROR_COOLDOWN_MS * 2).toISOString() }),
    ]
    const { client, claims, rollbacks } = stubSupabase({ candidates: rows })
    const submit = vi.fn(async () => undefined) // "no jobId returned"
    await sweepPanoramaCaptures(client, submit, NOW)
    expect(claims[0].panorama_capture_attempts).toBe(2) // claim increments
    expect(rollbacks[0].panorama_capture_attempts).toBe(1) // rollback restores
    expect(rollbacks[0].panorama_capture_status).toBe('error')
  })

  it('a lost claim race consumes neither budget nor a submit', async () => {
    const { client, rollbacks } = stubSupabase({
      candidates: twoRows,
      claimCounts: [0, 1], // rec-1 lost to the route, rec-2 won
    })
    const submit = vi.fn(async (id: string) => `job-${id}`)
    const out = await sweepPanoramaCaptures(client, submit, NOW)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith('rec-2', 'game-2')
    expect(out.submitted).toBe(1)
    expect(rollbacks).toHaveLength(0)
  })

  it('respects the global in-flight cap', async () => {
    const { client } = stubSupabase({ candidates: manyRows, inFlight: 5 })
    const submit = vi.fn(async (id: string) => `job-${id}`)
    const out = await sweepPanoramaCaptures(client, submit, NOW)
    expect(submit).not.toHaveBeenCalled()
    expect(out.submitted).toBe(0)
  })

  it('filters unclaimable rows client-side (fresh pending stays untouched)', async () => {
    const rows = [
      row({
        id: 'rec-fresh',
        panorama_capture_status: 'pending',
        panorama_capture_started_at: new Date(NOW - 60_000).toISOString(),
      }),
      row({ id: 'rec-idle' }),
    ]
    const { client } = stubSupabase({ candidates: rows })
    const submit = vi.fn(async (id: string) => `job-${id}`)
    const out = await sweepPanoramaCaptures(client, submit, NOW)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith('rec-idle', 'game-1')
    expect(out.candidates).toBe(1)
  })
})
