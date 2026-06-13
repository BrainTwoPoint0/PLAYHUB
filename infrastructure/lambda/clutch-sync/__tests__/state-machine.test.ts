import { describe, it, expect } from 'vitest'
import {
  decideSyncAction,
  generateClutchS3Keys,
  type ClutchVideoStatus,
} from '../state-machine'

const HOUR_MS = 60 * 60 * 1000

// A recording whose match ended `hoursAgo` hours ago
function row(hoursAgo: number, overrides: Record<string, unknown> = {}) {
  const durationSeconds = 90 * 60
  return {
    id: 'rec-1',
    clutch_video_id: 'vid-1',
    status: 'scheduled',
    sync_attempts: 0,
    last_sync_error: null as string | null,
    match_date: new Date(
      Date.now() - hoursAgo * HOUR_MS - durationSeconds * 1000
    ).toISOString(),
    duration_seconds: durationSeconds,
    ...overrides,
  }
}

const now = () => Date.now()

describe('decideSyncAction — exhaustive status mapping', () => {
  const cases: Array<[ClutchVideoStatus, string]> = [
    ['SCHEDULED', 'set_status:scheduled'],
    ['QUEUED', 'set_status:scheduled'],
    ['RECORDING', 'set_status:recording'],
    ['PROCESSING', 'set_status:processing'],
    ['DELAYED_PROCESSING', 'set_status:processing'],
    ['COMPLETED', 'set_status:processing'],
    ['COMPLETED_EMPTY_COURT', 'set_status:processing'],
    ['OK', 'publish:with-highlights'],
    ['OK_EMPTY_COURT', 'publish:video-only'],
    ['FAILED_DEVICE_OCCUPIED', 'fail'],
    ['FAILED_DEVICE_OFFLINE', 'fail'],
  ]

  it.each(cases)('%s → %s', (status, expected) => {
    const action = decideSyncAction(status, row(1), now())
    const label =
      action.kind === 'set_status'
        ? `set_status:${action.status}`
        : action.kind === 'publish'
          ? `publish:${action.includeHighlights ? 'with-highlights' : 'video-only'}`
          : action.kind
    expect(label).toBe(expected)
  })

  it('covers every Clutch status', () => {
    const allStatuses: ClutchVideoStatus[] = [
      'SCHEDULED',
      'QUEUED',
      'RECORDING',
      'PROCESSING',
      'DELAYED_PROCESSING',
      'COMPLETED',
      'COMPLETED_EMPTY_COURT',
      'OK',
      'OK_EMPTY_COURT',
      'FAILED',
      'FAILED_DEVICE_OCCUPIED',
      'FAILED_DEVICE_OFFLINE',
    ]
    for (const status of allStatuses) {
      expect(() => decideSyncAction(status, row(1), now())).not.toThrow()
    }
  })
})

describe('decideSyncAction — FAILED is recoverable', () => {
  it('keeps processing without alert under 24h after match end', () => {
    const action = decideSyncAction('FAILED', row(2), now())
    expect(action).toMatchObject({
      kind: 'set_status',
      status: 'processing',
      alert: false,
    })
  })

  it('keeps processing but alerts after 24h stuck', () => {
    const action = decideSyncAction('FAILED', row(30), now())
    expect(action).toMatchObject({
      kind: 'set_status',
      status: 'processing',
      alert: true,
    })
  })

  it('marks failed terminally after 48h stuck', () => {
    const action = decideSyncAction('FAILED', row(50), now())
    expect(action).toMatchObject({ kind: 'fail', alert: true })
  })

  it('terminal device failures carry an alert and reason', () => {
    const action = decideSyncAction('FAILED_DEVICE_OFFLINE', row(1), now())
    expect(action).toMatchObject({ kind: 'fail', alert: true })
    if (action.kind === 'fail') {
      expect(action.reason).toContain('FAILED_DEVICE_OFFLINE')
    }
  })
})

describe('decideSyncAction — unknown statuses', () => {
  it('fails with alert on a status outside the known union', () => {
    const action = decideSyncAction(
      'CANCELLED' as ClutchVideoStatus,
      row(1),
      now()
    )
    expect(action).toMatchObject({ kind: 'fail', alert: true })
    if (action.kind === 'fail') {
      expect(action.reason).toContain('CANCELLED')
    }
  })
})

describe('decideSyncAction — publish variants', () => {
  it('OK publishes with highlights and stats', () => {
    const action = decideSyncAction('OK', row(1), now())
    expect(action).toEqual({ kind: 'publish', includeHighlights: true })
  })

  it('OK_EMPTY_COURT publishes video only (practice session)', () => {
    const action = decideSyncAction('OK_EMPTY_COURT', row(1), now())
    expect(action).toEqual({ kind: 'publish', includeHighlights: false })
  })
})

describe('generateClutchS3Keys', () => {
  it('is deterministic per video id and dated by match date', () => {
    const keys = generateClutchS3Keys('vid-abc', '2026-06-12T18:00:00Z')
    expect(keys).toEqual({
      prefix: 'recordings/2026-06-12/clutch/vid-abc',
      highlightsIndex:
        'recordings/2026-06-12/clutch/vid-abc/highlights.index.json',
      playersIndex: 'recordings/2026-06-12/clutch/vid-abc/players.index.json',
      video: 'recordings/2026-06-12/clutch/vid-abc/match.mp4',
      highlight: 'recordings/2026-06-12/clutch/vid-abc/highlight-landscape.mp4',
      matchJson: 'recordings/2026-06-12/clutch/vid-abc/match.json',
      highlightManifest:
        'recordings/2026-06-12/clutch/vid-abc/highlight_urls.json',
      shotsCsv: 'recordings/2026-06-12/clutch/vid-abc/detected_shots_v3.csv',
      playerCrops: 'recordings/2026-06-12/clutch/vid-abc/player_crop_urls.json',
    })
  })

  it('uses the UTC date of the match', () => {
    const keys = generateClutchS3Keys('vid-x', '2026-06-12T23:30:00Z')
    expect(keys.video).toContain('/2026-06-12/')
  })
})
