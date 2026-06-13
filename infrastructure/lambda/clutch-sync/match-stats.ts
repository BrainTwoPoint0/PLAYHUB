// Whitelisted extraction of headline padel stats from Clutch's match.json,
// persisted to playhub_match_recordings.clutch_match_stats at publish so
// venue aggregates are pure Postgres (never N×S3 reads).
//
// Tolerance contract (same as manifest.ts): malformed input produces null,
// never a throw. Whitelisting protects the row against Clutch adding large
// or unexpected fields — never store their doc verbatim.

const STAT_KEYS = [
  'match_time_minutes',
  'match_time_in_play_minutes',
  'avg_rally_shots',
  'avg_rally_seconds',
  'longest_rally_shots',
  'longest_rally_seconds',
] as const

/**
 * Returns the flat, version-stamped stats object for the recording row, or
 * null when the doc contains nothing worth storing (column stays NULL).
 */
export function extractMatchStats(doc: unknown): Record<string, number> | null {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return null
  }
  const d = doc as Record<string, any>

  const stats: Record<string, number> = {}
  const matchStats =
    typeof d.match_stats === 'object' && d.match_stats !== null
      ? d.match_stats
      : {}
  for (const key of STAT_KEYS) {
    const value = matchStats[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      stats[key] = value
    }
  }

  const playerStats =
    typeof d.player_stats === 'object' && d.player_stats !== null
      ? d.player_stats
      : null
  const players = playerStats ? Object.keys(playerStats).length : 0

  // An all-empty doc must leave the column NULL, not write {version, players: 0}
  if (Object.keys(stats).length === 0 && players === 0) {
    return null
  }

  return { version: 1, ...stats, players }
}
