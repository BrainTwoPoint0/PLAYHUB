import { describe, it, expect } from 'vitest'
import { extractMatchStats } from '../match-stats'

const fullDoc = {
  match_stats: {
    match_time_minutes: 66.0,
    match_time_in_play_minutes: 15.7,
    avg_rally_shots: 6.2,
    avg_rally_seconds: 6.7,
    longest_rally_shots: 27,
    longest_rally_seconds: 29.27,
  },
  player_stats: {
    'player-1': { n_shots: 233 },
    'player-2': { n_shots: 190 },
    'player-3': { n_shots: 201 },
    'player-4': { n_shots: 175 },
  },
}

describe('extractMatchStats', () => {
  it('extracts the whitelisted stats with version and player count', () => {
    expect(extractMatchStats(fullDoc)).toEqual({
      version: 1,
      match_time_minutes: 66.0,
      match_time_in_play_minutes: 15.7,
      avg_rally_shots: 6.2,
      avg_rally_seconds: 6.7,
      longest_rally_shots: 27,
      longest_rally_seconds: 29.27,
      players: 4,
    })
  })

  it('returns null when there is nothing valid to store', () => {
    expect(extractMatchStats({})).toBeNull()
    expect(extractMatchStats({ match_stats: {}, player_stats: {} })).toBeNull()
    expect(extractMatchStats({ match_stats: 'nope' })).toBeNull()
  })

  it('drops non-finite and non-numeric values per key', () => {
    const result = extractMatchStats({
      match_stats: {
        match_time_minutes: 'sixty',
        match_time_in_play_minutes: NaN,
        avg_rally_shots: Infinity,
        longest_rally_shots: 27,
      },
      player_stats: {},
    })
    expect(result).toEqual({
      version: 1,
      longest_rally_shots: 27,
      players: 0,
    })
  })

  it('never copies unknown match_stats keys', () => {
    const result = extractMatchStats({
      match_stats: {
        longest_rally_shots: 10,
        some_giant_future_blob: 999,
        nested: { evil: true },
      },
    })
    expect(result).toEqual({
      version: 1,
      longest_rally_shots: 10,
      players: 0,
    })
  })

  it('handles player_stats-only docs', () => {
    expect(
      extractMatchStats({ player_stats: { 'player-1': {}, 'player-2': {} } })
    ).toEqual({ version: 1, players: 2 })
  })

  it('returns null for non-object input', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      expect(extractMatchStats(bad)).toBeNull()
    }
  })
})
