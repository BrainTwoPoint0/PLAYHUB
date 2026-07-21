import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isClaimable,
  isAimClaimable,
  sweepPanoramaCaptures,
  sweepAimTracks,
  CAPTURE_STUCK_MS,
  ERROR_COOLDOWN_MS,
  MAX_ATTEMPTS,
  SWEEP_MAX_PER_RUN,
  AIM_SWEEP_MAX_PER_RUN,
  AIM_INFLIGHT_CAP,
  AIM_STUCK_MS,
  sweepPortraitRenders,
  PORTRAIT_SWEEP_MAX_PER_RUN,
  isTrackletsClaimable,
  sweepPlayerTracklets,
  TRK_SWEEP_MAX_PER_RUN,
  TRK_INFLIGHT_CAP,
  TRK_STUCK_MS,
  isJerseyClaimable,
  sweepJerseyLabels,
  JERSEY_STUCK_MS,
  isGoalDetectClaimable,
  sweepGoalDetect,
  GOAL_DETECT_STUCK_MS,
  type PanoramaCandidate,
  type AimTrackCandidate,
  type TrackletsCandidate,
  type JerseyCandidate,
  type GoalDetectCandidate,
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
    for (const m of [
      'select',
      'eq',
      'in',
      'not',
      'is',
      'or',
      'gte',
      'order',
      'limit',
    ])
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
  const twoRows = [
    row({ id: 'rec-1' }),
    row({ id: 'rec-2', spiideo_game_id: 'game-2' }),
  ]
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
      row({
        id: 'rec-1',
        panorama_capture_attempts: 1,
        panorama_capture_status: 'error',
        panorama_capture_started_at: new Date(
          NOW - ERROR_COOLDOWN_MS * 2
        ).toISOString(),
      }),
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

function aimRow(overrides: Partial<AimTrackCandidate> = {}): AimTrackCandidate {
  return {
    id: 'rec-1',
    spiideo_game_id: 'game-1',
    s3_key: 'recordings/2026-07-01/game-1/prod.mp4',
    panorama_s3_key: 'panoramas/game-1/vp.mp4',
    aim_track_status: null,
    aim_track_started_at: null,
    aim_track_attempts: 0,
    ...overrides,
  }
}

describe('isAimClaimable', () => {
  it('claims a never-attempted row with both inputs present', () => {
    expect(isAimClaimable(aimRow(), NOW)).toBe(true)
  })

  it('requires BOTH the produced mp4 and the preserved panorama', () => {
    expect(isAimClaimable(aimRow({ s3_key: null }), NOW)).toBe(false)
    expect(isAimClaimable(aimRow({ panorama_s3_key: null }), NOW)).toBe(false)
    expect(isAimClaimable(aimRow({ spiideo_game_id: null }), NOW)).toBe(false)
  })

  it('never reclaims ready, fresh pending, or attempts-capped rows', () => {
    expect(isAimClaimable(aimRow({ aim_track_status: 'ready' }), NOW)).toBe(
      false
    )
    expect(
      isAimClaimable(
        aimRow({
          aim_track_status: 'pending',
          aim_track_started_at: new Date(NOW - 60_000).toISOString(),
        }),
        NOW
      )
    ).toBe(false)
    expect(
      isAimClaimable(
        aimRow({
          aim_track_status: 'error',
          aim_track_attempts: MAX_ATTEMPTS,
          aim_track_started_at: new Date(
            NOW - ERROR_COOLDOWN_MS * 10
          ).toISOString(),
        }),
        NOW
      )
    ).toBe(false)
  })

  it('reclaims a heartbeat-dead pending under the cap (aim threshold is HOURS)', () => {
    // A 4-7h job merely queued/running is NOT stale at the panorama's 30 min…
    expect(
      isAimClaimable(
        aimRow({
          aim_track_status: 'pending',
          aim_track_attempts: 1,
          aim_track_started_at: new Date(
            NOW - CAPTURE_STUCK_MS - 1000
          ).toISOString(),
        }),
        NOW
      )
    ).toBe(false)
    // …only after AIM_STUCK_MS of heartbeat silence.
    expect(
      isAimClaimable(
        aimRow({
          aim_track_status: 'pending',
          aim_track_attempts: 1,
          aim_track_started_at: new Date(
            NOW - AIM_STUCK_MS - 1000
          ).toISOString(),
        }),
        NOW
      )
    ).toBe(true)
  })
})

describe('sweepAimTracks', () => {
  const manyAimRows = Array.from({ length: 5 }, (_, i) =>
    aimRow({ id: `rec-${i}`, spiideo_game_id: `game-${i}` })
  )

  it('submits at most AIM_SWEEP_MAX_PER_RUN per run', async () => {
    const { client } = stubSupabase({
      candidates: manyAimRows as unknown as PanoramaCandidate[],
    })
    const submit = vi.fn(async (id: string) => `job-${id}`)
    const out = await sweepAimTracks(client, submit, NOW)
    expect(submit).toHaveBeenCalledTimes(AIM_SWEEP_MAX_PER_RUN)
    expect(out.submitted).toBe(AIM_SWEEP_MAX_PER_RUN)
    expect(out.candidates).toBe(manyAimRows.length)
  })

  it('budget counts attempts: a failing submit rolls back once and stops', async () => {
    const { client, rollbacks } = stubSupabase({
      candidates: manyAimRows as unknown as PanoramaCandidate[],
    })
    const submit = vi.fn(async () => {
      throw new Error('AccessDeniedException')
    })
    const out = await sweepAimTracks(client, submit, NOW)
    expect(submit).toHaveBeenCalledTimes(AIM_SWEEP_MAX_PER_RUN)
    expect(out.submitted).toBe(0)
    expect(rollbacks).toHaveLength(AIM_SWEEP_MAX_PER_RUN)
    expect(rollbacks[0].aim_track_status).toBe('error')
    expect(rollbacks[0].aim_track_attempts).toBe(0)
  })

  it('respects the aim in-flight cap on the shared CE', async () => {
    const { client } = stubSupabase({
      candidates: manyAimRows as unknown as PanoramaCandidate[],
      inFlight: AIM_INFLIGHT_CAP,
    })
    const submit = vi.fn(async (id: string) => `job-${id}`)
    const out = await sweepAimTracks(client, submit, NOW)
    expect(submit).not.toHaveBeenCalled()
    expect(out.submitted).toBe(0)
  })
})

describe('sweepPortraitRenders', () => {
  const matches = [
    { club_slug: 'cfa', match_slug: 'match-a', goal_events: 5, renders: 0 },
    { club_slug: 'cfa', match_slug: 'match-b', goal_events: 3, renders: 1 },
    { club_slug: 'cfa', match_slug: 'match-c', goal_events: 2, renders: 0 },
  ]

  it('does nothing when the club allowlist is empty (pilot off)', async () => {
    const { client } = stubSupabase({
      candidates: matches as unknown as PanoramaCandidate[],
    })
    const submit = vi.fn(async () => 'job-1')
    const out = await sweepPortraitRenders(client, [], submit)
    expect(submit).not.toHaveBeenCalled()
    expect(out).toEqual({ submitted: 0, candidates: 0 })
  })

  it('submits at most PORTRAIT_SWEEP_MAX_PER_RUN matches per run', async () => {
    const { client } = stubSupabase({
      candidates: matches as unknown as PanoramaCandidate[],
    })
    const submit = vi.fn(async (slug: string) => `job-${slug}`)
    const out = await sweepPortraitRenders(client, ['cfa'], submit)
    expect(submit).toHaveBeenCalledTimes(PORTRAIT_SWEEP_MAX_PER_RUN)
    expect(submit).toHaveBeenCalledWith('match-a', 'cfa')
    expect(out.submitted).toBe(PORTRAIT_SWEEP_MAX_PER_RUN)
    expect(out.candidates).toBe(matches.length)
  })

  it('a duplicate-guard skip (undefined jobId) consumes the budget without counting as submitted', async () => {
    const { client } = stubSupabase({
      candidates: matches as unknown as PanoramaCandidate[],
    })
    const submit = vi.fn(async () => undefined) // active job already running
    const out = await sweepPortraitRenders(client, ['cfa'], submit)
    expect(submit).toHaveBeenCalledTimes(PORTRAIT_SWEEP_MAX_PER_RUN)
    expect(out.submitted).toBe(0)
  })

  it('a submit failure is non-fatal and bounded by the budget', async () => {
    const { client } = stubSupabase({
      candidates: matches as unknown as PanoramaCandidate[],
    })
    const submit = vi.fn(async () => {
      throw new Error('AccessDeniedException')
    })
    const out = await sweepPortraitRenders(client, ['cfa'], submit)
    expect(submit).toHaveBeenCalledTimes(PORTRAIT_SWEEP_MAX_PER_RUN)
    expect(out.submitted).toBe(0)
  })
})

// ── Player-tracklets sweep ───────────────────────────────────────────────────

const MESH_SCENES = new Set(['scene-1', 'scene-2'])

function trkRow(
  overrides: Partial<TrackletsCandidate> = {}
): TrackletsCandidate {
  return {
    id: 'rec-1',
    spiideo_game_id: 'game-1',
    spiideo_scene_id: 'scene-1',
    tracklets_status: null,
    tracklets_started_at: null,
    tracklets_attempts: 0,
    ...overrides,
  }
}

/** Table-aware stub: the tracklets sweep reads the scene-mesh registry first,
 *  then recordings — the shared stubSupabase is single-table. */
function stubTrkSupabase(opts: {
  scenes?: string[]
  candidates: TrackletsCandidate[]
  inFlight?: number
  claimCounts?: number[]
}) {
  const claimCounts = [...(opts.claimCounts ?? [])]
  const rollbacks: Array<Record<string, unknown>> = []
  const claims: Array<Record<string, unknown>> = []

  function makeBuilder(result: unknown, onResolve?: () => unknown) {
    const b: Record<string, unknown> = {}
    for (const m of [
      'select',
      'eq',
      'in',
      'not',
      'is',
      'or',
      'gte',
      'order',
      'limit',
    ])
      b[m] = vi.fn(() => b)
    b.then = (res: (v: unknown) => unknown) =>
      Promise.resolve(onResolve ? onResolve() : result).then(res)
    return b
  }

  const client = {
    from: vi.fn((table: string) => {
      if (table === 'playhub_panorama_scene_meshes') {
        return {
          select: vi.fn(() =>
            makeBuilder({
              data: (opts.scenes ?? Array.from(MESH_SCENES)).map((s) => ({
                scene_id: s,
              })),
              error: null,
            })
          ),
        }
      }
      return {
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
      }
    }),
  } as unknown as SupabaseClient
  return { client, rollbacks, claims }
}

describe('isTrackletsClaimable', () => {
  it('claims a never-attempted row on a mesh scene', () => {
    expect(isTrackletsClaimable(trkRow(), MESH_SCENES, NOW)).toBe(true)
  })

  it('requires game id AND a mesh-bearing scene', () => {
    expect(
      isTrackletsClaimable(trkRow({ spiideo_game_id: null }), MESH_SCENES, NOW)
    ).toBe(false)
    expect(
      isTrackletsClaimable(trkRow({ spiideo_scene_id: null }), MESH_SCENES, NOW)
    ).toBe(false)
    expect(
      isTrackletsClaimable(
        trkRow({ spiideo_scene_id: 'scene-without-mesh' }),
        MESH_SCENES,
        NOW
      )
    ).toBe(false)
  })

  it('never reclaims ready, fresh pending, or attempts-capped rows', () => {
    expect(
      isTrackletsClaimable(
        trkRow({ tracklets_status: 'ready' }),
        MESH_SCENES,
        NOW
      )
    ).toBe(false)
    expect(
      isTrackletsClaimable(
        trkRow({
          tracklets_status: 'pending',
          tracklets_started_at: new Date(NOW - 60_000).toISOString(),
        }),
        MESH_SCENES,
        NOW
      )
    ).toBe(false)
    expect(
      isTrackletsClaimable(
        trkRow({
          tracklets_status: 'error',
          tracklets_attempts: MAX_ATTEMPTS,
          tracklets_started_at: new Date(
            NOW - ERROR_COOLDOWN_MS * 10
          ).toISOString(),
        }),
        MESH_SCENES,
        NOW
      )
    ).toBe(false)
  })

  it('reclaims a heartbeat-dead pending only past TRK_STUCK_MS', () => {
    expect(
      isTrackletsClaimable(
        trkRow({
          tracklets_status: 'pending',
          tracklets_attempts: 1,
          tracklets_started_at: new Date(
            NOW - TRK_STUCK_MS + 60_000
          ).toISOString(),
        }),
        MESH_SCENES,
        NOW
      )
    ).toBe(false)
    expect(
      isTrackletsClaimable(
        trkRow({
          tracklets_status: 'pending',
          tracklets_attempts: 1,
          tracklets_started_at: new Date(
            NOW - TRK_STUCK_MS - 1000
          ).toISOString(),
        }),
        MESH_SCENES,
        NOW
      )
    ).toBe(true)
  })
})

describe('sweepPlayerTracklets', () => {
  const manyTrkRows = Array.from({ length: 5 }, (_, i) =>
    trkRow({ id: `rec-${i}`, spiideo_game_id: `game-${i}` })
  )

  it('submits at most TRK_SWEEP_MAX_PER_RUN per run', async () => {
    const { client } = stubTrkSupabase({ candidates: manyTrkRows })
    const submit = vi.fn(async (id: string) => `job-${id}`)
    const out = await sweepPlayerTracklets(client, submit, null, NOW)
    expect(submit).toHaveBeenCalledTimes(TRK_SWEEP_MAX_PER_RUN)
    expect(out.submitted).toBe(TRK_SWEEP_MAX_PER_RUN)
    expect(out.candidates).toBe(manyTrkRows.length)
  })

  it('does nothing when the scene registry is empty', async () => {
    const { client } = stubTrkSupabase({ scenes: [], candidates: manyTrkRows })
    const submit = vi.fn(async (id: string) => `job-${id}`)
    const out = await sweepPlayerTracklets(client, submit, null, NOW)
    expect(submit).not.toHaveBeenCalled()
    expect(out.candidates).toBe(0)
  })

  it('skips recordings whose scene has no mesh', async () => {
    const { client } = stubTrkSupabase({
      candidates: [trkRow({ spiideo_scene_id: 'scene-without-mesh' })],
    })
    const submit = vi.fn(async (id: string) => `job-${id}`)
    const out = await sweepPlayerTracklets(client, submit, null, NOW)
    expect(submit).not.toHaveBeenCalled()
    expect(out.candidates).toBe(0)
  })

  it('budget counts attempts: a failing submit rolls back once and stops', async () => {
    const { client, rollbacks } = stubTrkSupabase({ candidates: manyTrkRows })
    const submit = vi.fn(async () => {
      throw new Error('AccessDeniedException')
    })
    const out = await sweepPlayerTracklets(client, submit, null, NOW)
    expect(submit).toHaveBeenCalledTimes(TRK_SWEEP_MAX_PER_RUN)
    expect(out.submitted).toBe(0)
    expect(rollbacks).toHaveLength(TRK_SWEEP_MAX_PER_RUN)
    expect(rollbacks[0].tracklets_status).toBe('error')
    expect(rollbacks[0].tracklets_attempts).toBe(0)
  })

  it('respects the tracklets in-flight cap on the shared CE', async () => {
    const { client } = stubTrkSupabase({
      candidates: manyTrkRows,
      inFlight: TRK_INFLIGHT_CAP,
    })
    const submit = vi.fn(async (id: string) => `job-${id}`)
    const out = await sweepPlayerTracklets(client, submit, null, NOW)
    expect(submit).not.toHaveBeenCalled()
    expect(out.submitted).toBe(0)
  })

  it('a lost claim race consumes neither budget nor a submit', async () => {
    const { client, rollbacks } = stubTrkSupabase({
      candidates: [
        trkRow({ id: 'rec-1' }),
        trkRow({ id: 'rec-2', spiideo_game_id: 'game-2' }),
      ],
      claimCounts: [0, 1],
    })
    const submit = vi.fn(async (id: string) => `job-${id}`)
    const out = await sweepPlayerTracklets(client, submit, null, NOW)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith('rec-2', 'game-2')
    expect(out.submitted).toBe(1)
    expect(rollbacks).toHaveLength(0)
  })

  it('skips (without claiming) games whose per-game mesh is missing', async () => {
    const { client, claims } = stubTrkSupabase({
      candidates: [
        trkRow({ id: 'rec-1', spiideo_game_id: 'no-mesh-game' }),
        trkRow({ id: 'rec-2', spiideo_game_id: 'game-2' }),
      ],
    })
    const submit = vi.fn(async (id: string) => `job-${id}`)
    const hasGameMesh = vi.fn(async (gameId: string) => gameId === 'game-2')
    const out = await sweepPlayerTracklets(client, submit, hasGameMesh, NOW)
    expect(hasGameMesh).toHaveBeenCalledWith('no-mesh-game')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith('rec-2', 'game-2')
    // rec-1 was never CAS-claimed — no attempt burned
    expect(claims).toHaveLength(1)
    expect(out.submitted).toBe(1)
  })

  it('a mesh-check failure skips the row unclaimed (retry next tick)', async () => {
    const { client, claims } = stubTrkSupabase({
      candidates: [trkRow({ id: 'rec-1' })],
    })
    const submit = vi.fn(async (id: string) => `job-${id}`)
    const hasGameMesh = vi.fn(async () => {
      throw new Error('storage 500')
    })
    const out = await sweepPlayerTracklets(client, submit, hasGameMesh, NOW)
    expect(submit).not.toHaveBeenCalled()
    expect(claims).toHaveLength(0)
    expect(out.submitted).toBe(0)
  })
})

// ── Jersey-labels sweep ──────────────────────────────────────────────────────

const JERSEY_VENUES = new Set(['scene-1'])

function jerseyRow(overrides: Partial<JerseyCandidate> = {}): JerseyCandidate {
  return {
    id: 'rec-1',
    spiideo_game_id: 'game-1',
    spiideo_scene_id: 'scene-1',
    panorama_s3_key: 'panoramas/game-1/rec-1.mp4',
    tracklets_status: 'ready',
    jersey_status: null,
    jersey_started_at: null,
    jersey_attempts: null,
    ...overrides,
  }
}

describe('isJerseyClaimable', () => {
  it('claims a never-attempted ready-tracklets row on an allowlisted venue', () => {
    expect(isJerseyClaimable(jerseyRow(), JERSEY_VENUES, NOW)).toBe(true)
  })

  it('requires game id, allowlisted scene, ready tracklets, and a panorama', () => {
    expect(
      isJerseyClaimable(
        jerseyRow({ spiideo_game_id: null }),
        JERSEY_VENUES,
        NOW
      )
    ).toBe(false)
    expect(
      isJerseyClaimable(
        jerseyRow({ spiideo_scene_id: 'scene-2' }),
        JERSEY_VENUES,
        NOW
      )
    ).toBe(false)
    expect(
      isJerseyClaimable(
        jerseyRow({ tracklets_status: 'pending' }),
        JERSEY_VENUES,
        NOW
      )
    ).toBe(false)
    expect(
      isJerseyClaimable(
        jerseyRow({ panorama_s3_key: null }),
        JERSEY_VENUES,
        NOW
      )
    ).toBe(false)
  })

  it('never reclaims ready, fresh pending, or attempts-capped rows', () => {
    expect(
      isJerseyClaimable(
        jerseyRow({ jersey_status: 'ready' }),
        JERSEY_VENUES,
        NOW
      )
    ).toBe(false)
    expect(
      isJerseyClaimable(
        jerseyRow({
          jersey_status: 'pending',
          jersey_started_at: new Date(NOW - 60_000).toISOString(),
        }),
        JERSEY_VENUES,
        NOW
      )
    ).toBe(false)
    expect(
      isJerseyClaimable(
        jerseyRow({
          jersey_status: 'error',
          jersey_attempts: MAX_ATTEMPTS,
          jersey_started_at: new Date(
            NOW - ERROR_COOLDOWN_MS * 10
          ).toISOString(),
        }),
        JERSEY_VENUES,
        NOW
      )
    ).toBe(false)
  })

  it('reclaims an error row only past the cooldown', () => {
    expect(
      isJerseyClaimable(
        jerseyRow({
          jersey_status: 'error',
          jersey_attempts: 1,
          jersey_started_at: new Date(
            NOW - ERROR_COOLDOWN_MS + 5000
          ).toISOString(),
        }),
        JERSEY_VENUES,
        NOW
      )
    ).toBe(false)
    expect(
      isJerseyClaimable(
        jerseyRow({
          jersey_status: 'error',
          jersey_attempts: 1,
          jersey_started_at: new Date(
            NOW - ERROR_COOLDOWN_MS - 5000
          ).toISOString(),
        }),
        JERSEY_VENUES,
        NOW
      )
    ).toBe(true)
  })

  it('reclaims a dead pending only past JERSEY_STUCK_MS (5h > job timeout)', () => {
    expect(
      isJerseyClaimable(
        jerseyRow({
          jersey_status: 'pending',
          jersey_attempts: 1,
          jersey_started_at: new Date(
            NOW - JERSEY_STUCK_MS + 60_000
          ).toISOString(),
        }),
        JERSEY_VENUES,
        NOW
      )
    ).toBe(false)
    expect(
      isJerseyClaimable(
        jerseyRow({
          jersey_status: 'pending',
          jersey_attempts: 1,
          jersey_started_at: new Date(
            NOW - JERSEY_STUCK_MS - 1000
          ).toISOString(),
        }),
        JERSEY_VENUES,
        NOW
      )
    ).toBe(true)
  })
})

describe('sweepJerseyLabels', () => {
  it('is a no-op with an empty allowlist (feature disabled)', async () => {
    const from = vi.fn()
    const client = { from } as unknown as SupabaseClient
    const submit = vi.fn(async () => 'job-1')
    const out = await sweepJerseyLabels(client, [], submit, NOW)
    expect(out).toEqual({ submitted: 0, candidates: 0 })
    expect(from).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })
})

// ── Goal-detect sweep ────────────────────────────────────────────────────────

const GOAL_DETECT_SCENES = new Set(['scene-1'])

function goalRow(
  overrides: Partial<GoalDetectCandidate> = {}
): GoalDetectCandidate {
  return {
    id: 'rec-1',
    spiideo_game_id: 'game-1',
    spiideo_scene_id: 'scene-1',
    s3_key: 'recordings/game-1/rec-1.mp4',
    tracklets_status: 'ready',
    goal_detect_status: null,
    goal_detect_started_at: null,
    goal_detect_attempts: null,
    ...overrides,
  }
}

describe('isGoalDetectClaimable', () => {
  it('claims a never-attempted ready-tracklets row on an allowlisted scene', () => {
    expect(isGoalDetectClaimable(goalRow(), GOAL_DETECT_SCENES, NOW)).toBe(true)
  })

  it('requires game id, allowlisted scene, ready tracklets, and a produced video', () => {
    expect(
      isGoalDetectClaimable(
        goalRow({ spiideo_game_id: null }),
        GOAL_DETECT_SCENES,
        NOW
      )
    ).toBe(false)
    expect(
      isGoalDetectClaimable(
        goalRow({ spiideo_scene_id: 'scene-2' }),
        GOAL_DETECT_SCENES,
        NOW
      )
    ).toBe(false)
    expect(
      isGoalDetectClaimable(
        goalRow({ tracklets_status: 'pending' }),
        GOAL_DETECT_SCENES,
        NOW
      )
    ).toBe(false)
    // s3_key gate: clips are cut from the produced mp4 — a missing video
    // would claim-and-die three times.
    expect(
      isGoalDetectClaimable(goalRow({ s3_key: null }), GOAL_DETECT_SCENES, NOW)
    ).toBe(false)
  })

  it('never reclaims ready, fresh pending, or attempts-capped rows', () => {
    expect(
      isGoalDetectClaimable(
        goalRow({ goal_detect_status: 'ready' }),
        GOAL_DETECT_SCENES,
        NOW
      )
    ).toBe(false)
    expect(
      isGoalDetectClaimable(
        goalRow({
          goal_detect_status: 'pending',
          goal_detect_started_at: new Date(NOW - 60_000).toISOString(),
        }),
        GOAL_DETECT_SCENES,
        NOW
      )
    ).toBe(false)
    expect(
      isGoalDetectClaimable(
        goalRow({
          goal_detect_status: 'error',
          goal_detect_attempts: MAX_ATTEMPTS,
          goal_detect_started_at: new Date(
            NOW - ERROR_COOLDOWN_MS * 10
          ).toISOString(),
        }),
        GOAL_DETECT_SCENES,
        NOW
      )
    ).toBe(false)
  })

  it('NULL status is claimable regardless of attempts (operator reset)', () => {
    expect(
      isGoalDetectClaimable(
        goalRow({ goal_detect_status: null, goal_detect_attempts: 3 }),
        GOAL_DETECT_SCENES,
        NOW
      )
    ).toBe(true)
  })

  it('reclaims an error row only past the cooldown', () => {
    expect(
      isGoalDetectClaimable(
        goalRow({
          goal_detect_status: 'error',
          goal_detect_attempts: 1,
          goal_detect_started_at: new Date(
            NOW - ERROR_COOLDOWN_MS + 5000
          ).toISOString(),
        }),
        GOAL_DETECT_SCENES,
        NOW
      )
    ).toBe(false)
    expect(
      isGoalDetectClaimable(
        goalRow({
          goal_detect_status: 'error',
          goal_detect_attempts: 1,
          goal_detect_started_at: new Date(
            NOW - ERROR_COOLDOWN_MS - 5000
          ).toISOString(),
        }),
        GOAL_DETECT_SCENES,
        NOW
      )
    ).toBe(true)
  })

  it('reclaims a dead pending only past GOAL_DETECT_STUCK_MS (3h > job timeout)', () => {
    expect(
      isGoalDetectClaimable(
        goalRow({
          goal_detect_status: 'pending',
          goal_detect_attempts: 1,
          goal_detect_started_at: new Date(
            NOW - GOAL_DETECT_STUCK_MS + 60_000
          ).toISOString(),
        }),
        GOAL_DETECT_SCENES,
        NOW
      )
    ).toBe(false)
    expect(
      isGoalDetectClaimable(
        goalRow({
          goal_detect_status: 'pending',
          goal_detect_attempts: 1,
          goal_detect_started_at: new Date(
            NOW - GOAL_DETECT_STUCK_MS - 1000
          ).toISOString(),
        }),
        GOAL_DETECT_SCENES,
        NOW
      )
    ).toBe(true)
  })
})

describe('sweepGoalDetect', () => {
  it('is a no-op with an empty allowlist (feature disabled)', async () => {
    const from = vi.fn()
    const client = { from } as unknown as SupabaseClient
    const submit = vi.fn(async () => 'job-1')
    const out = await sweepGoalDetect(client, [], submit, NOW)
    expect(out).toEqual({ submitted: 0, candidates: 0 })
    expect(from).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('gates out scenes with no active calibration before touching recordings', async () => {
    // The job hard-requires a calibration — without this gate an allowlisted
    // scene missing one would claim-and-burn 3 attempts per recording.
    const tables: string[] = []
    const calBuilder = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn(async () => ({ data: [], error: null })),
    }
    const from = vi.fn((table: string) => {
      tables.push(table)
      return calBuilder
    })
    const client = { from } as unknown as SupabaseClient
    const submit = vi.fn(async () => 'job-1')
    const out = await sweepGoalDetect(client, ['scene-1'], submit, NOW)
    expect(out).toEqual({ submitted: 0, candidates: 0 })
    expect(tables).toEqual(['playhub_pitch_calibrations'])
    expect(submit).not.toHaveBeenCalled()
  })
})
