// Zombie recordings: rows whose spiideo_game_id appears in the
// playhub_deleted_spiideo_games tombstone table. The app's DELETE flow is
// tombstone → Spiideo stop/delete → S3 delete → row delete; if the request
// dies mid-way (Netlify's 26s cap), the tombstone survives but the row does
// too. A row + tombstone coexisting is a contradiction — deletion was
// requested but never completed — so the sync Lambda finishes the job.

export interface ZombieCandidate {
  id: string
  spiideo_game_id: string | null
  s3_key: string | null
  s3_bucket: string | null
  status: string
}

export function findZombieRecordings<T extends ZombieCandidate>(
  recordings: T[],
  tombstonedGameIds: Set<string>
): T[] {
  return recordings.filter(
    (r) =>
      r.spiideo_game_id !== null && tombstonedGameIds.has(r.spiideo_game_id)
  )
}

// Dependency-injected so the orchestration is unit-testable without AWS or
// Spiideo mocks (sibling convention: clutch-sync/state-machine.ts).
export interface SweepDeps {
  /** Returns the Spiideo game state (e.g. 'recording', 'finished'); throw on error. */
  getGameState: (gameId: string) => Promise<string>
  /** Reschedule the game's stop time to now(+60s) — stops a live camera. */
  stopGame: (gameId: string) => Promise<void>
  /** Unschedule/delete the game on Spiideo. */
  deleteGame: (gameId: string) => Promise<void>
  deleteS3Object: (bucket: string, key: string) => Promise<void>
  deleteRow: (id: string) => Promise<void>
}

/**
 * Finish one interrupted deletion. Spiideo cleanup is best-effort (the
 * tombstone already excludes the game from sync forever), but the row
 * delete is GATED on the S3 delete succeeding: the row's s3_key is the
 * only pointer to the object, so deleting the row after a failed S3
 * delete would orphan the object permanently. Returning 'retry' leaves
 * the row in place — the tombstone guarantees the next run re-finds it.
 */
export async function sweepZombie(
  zombie: ZombieCandidate,
  deps: SweepDeps
): Promise<'swept' | 'retry'> {
  if (zombie.spiideo_game_id) {
    // A zombie is exactly the case where the app's stop/delete likely never
    // ran — if the camera is still rolling, stop it before unscheduling
    // (Spiideo's DELETE alone does not stop a live recording).
    try {
      const state = await deps.getGameState(zombie.spiideo_game_id)
      if (state === 'recording') {
        try {
          await deps.stopGame(zombie.spiideo_game_id)
        } catch (stopErr) {
          console.error(
            `Zombie sweep: failed to stop live game ${zombie.spiideo_game_id}:`,
            stopErr
          )
        }
      }
    } catch (stateErr) {
      console.error(
        `Zombie sweep: could not read game state for ${zombie.spiideo_game_id} (continuing):`,
        stateErr
      )
    }

    try {
      await deps.deleteGame(zombie.spiideo_game_id)
    } catch (deleteErr) {
      console.error(
        `Zombie sweep: Spiideo delete failed for game ${zombie.spiideo_game_id} (continuing):`,
        deleteErr
      )
    }
  }

  if (zombie.s3_key && zombie.s3_bucket) {
    try {
      await deps.deleteS3Object(zombie.s3_bucket, zombie.s3_key)
    } catch (s3Err) {
      console.error(
        `Zombie sweep: S3 delete failed for ${zombie.id} — keeping row so next run retries:`,
        s3Err
      )
      return 'retry'
    }
  }

  try {
    await deps.deleteRow(zombie.id)
  } catch (rowErr) {
    console.error(
      `Zombie sweep: row delete failed for ${zombie.id} — will retry next run:`,
      rowErr
    )
    return 'retry'
  }

  console.log(
    `Zombie sweep: completed interrupted deletion of recording ${zombie.id} (game ${zombie.spiideo_game_id}, status was '${zombie.status}')`
  )
  return 'swept'
}
