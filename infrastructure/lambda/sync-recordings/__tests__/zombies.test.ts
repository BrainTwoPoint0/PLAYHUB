import { describe, it, expect, vi, beforeEach } from 'vitest'
import { findZombieRecordings, sweepZombie, type SweepDeps } from '../zombies'

function row(
  overrides: Partial<Parameters<typeof findZombieRecordings>[0][number]> = {}
) {
  return {
    id: 'rec-1',
    spiideo_game_id: 'game-1',
    s3_key: null,
    s3_bucket: null,
    status: 'scheduled',
    ...overrides,
  }
}

describe('findZombieRecordings', () => {
  it('flags a row whose game is tombstoned (delete flow died mid-way)', () => {
    const zombies = findZombieRecordings(
      [row({ id: 'rec-1', spiideo_game_id: 'game-1' })],
      new Set(['game-1'])
    )
    expect(zombies.map((z) => z.id)).toEqual(['rec-1'])
  })

  it('ignores rows whose game is not tombstoned', () => {
    const zombies = findZombieRecordings(
      [
        row({ id: 'rec-1', spiideo_game_id: 'game-1' }),
        row({ id: 'rec-2', spiideo_game_id: 'game-2' }),
      ],
      new Set(['game-2'])
    )
    expect(zombies.map((z) => z.id)).toEqual(['rec-2'])
  })

  it('ignores rows without a spiideo_game_id', () => {
    const zombies = findZombieRecordings(
      [row({ id: 'rec-1', spiideo_game_id: null })],
      new Set(['game-1'])
    )
    expect(zombies).toEqual([])
  })

  it('returns empty when there are no tombstones', () => {
    const zombies = findZombieRecordings([row()], new Set())
    expect(zombies).toEqual([])
  })

  it('flags zombies regardless of status or synced state (deletion intent is proven by the tombstone)', () => {
    const zombies = findZombieRecordings(
      [
        row({
          id: 'rec-1',
          status: 'published',
          s3_key: 'recordings/a.mp4',
          s3_bucket: 'bkt',
        }),
        row({ id: 'rec-2', status: 'processing', spiideo_game_id: 'game-2' }),
      ],
      new Set(['game-1', 'game-2'])
    )
    expect(zombies.map((z) => z.id)).toEqual(['rec-1', 'rec-2'])
  })
})

describe('sweepZombie', () => {
  let deps: { [K in keyof SweepDeps]: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    deps = {
      getGameState: vi.fn().mockResolvedValue('finished'),
      stopGame: vi.fn().mockResolvedValue(undefined),
      deleteGame: vi.fn().mockResolvedValue(undefined),
      deleteS3Object: vi.fn().mockResolvedValue(undefined),
      deleteRow: vi.fn().mockResolvedValue(undefined),
    }
  })

  it('deletes S3 object then row for a synced zombie', async () => {
    const result = await sweepZombie(
      row({ s3_key: 'recordings/a.mp4', s3_bucket: 'bkt' }),
      deps
    )
    expect(result).toBe('swept')
    expect(deps.deleteS3Object).toHaveBeenCalledWith('bkt', 'recordings/a.mp4')
    expect(deps.deleteRow).toHaveBeenCalledWith('rec-1')
  })

  it('keeps the row (retry) when the S3 delete fails — the row is the only pointer to the object', async () => {
    deps.deleteS3Object.mockRejectedValue(new Error('AccessDenied'))
    const result = await sweepZombie(
      row({ s3_key: 'recordings/a.mp4', s3_bucket: 'bkt' }),
      deps
    )
    expect(result).toBe('retry')
    expect(deps.deleteRow).not.toHaveBeenCalled()
  })

  it('deletes the row directly when there is no S3 object', async () => {
    const result = await sweepZombie(row(), deps)
    expect(result).toBe('swept')
    expect(deps.deleteS3Object).not.toHaveBeenCalled()
    expect(deps.deleteRow).toHaveBeenCalledWith('rec-1')
  })

  it('stops a still-recording game before deleting it on Spiideo', async () => {
    deps.getGameState.mockResolvedValue('recording')
    await sweepZombie(row(), deps)
    expect(deps.stopGame).toHaveBeenCalledWith('game-1')
    expect(deps.deleteGame).toHaveBeenCalledWith('game-1')
    expect(deps.stopGame.mock.invocationCallOrder[0]).toBeLessThan(
      deps.deleteGame.mock.invocationCallOrder[0]
    )
  })

  it('does not stop a finished game', async () => {
    deps.getGameState.mockResolvedValue('finished')
    await sweepZombie(row(), deps)
    expect(deps.stopGame).not.toHaveBeenCalled()
    expect(deps.deleteGame).toHaveBeenCalledWith('game-1')
  })

  it('continues to S3/row cleanup when every Spiideo call fails', async () => {
    deps.getGameState.mockRejectedValue(new Error('spiideo down'))
    deps.deleteGame.mockRejectedValue(new Error('spiideo down'))
    const result = await sweepZombie(
      row({ s3_key: 'recordings/a.mp4', s3_bucket: 'bkt' }),
      deps
    )
    expect(result).toBe('swept')
    expect(deps.deleteS3Object).toHaveBeenCalled()
    expect(deps.deleteRow).toHaveBeenCalled()
  })

  it('skips Spiideo calls for rows without a game id', async () => {
    await sweepZombie(row({ spiideo_game_id: null }), deps)
    expect(deps.getGameState).not.toHaveBeenCalled()
    expect(deps.deleteGame).not.toHaveBeenCalled()
    expect(deps.deleteRow).toHaveBeenCalled()
  })

  it('returns retry when the row delete fails', async () => {
    deps.deleteRow.mockRejectedValue(new Error('db down'))
    const result = await sweepZombie(row(), deps)
    expect(result).toBe('retry')
  })
})
