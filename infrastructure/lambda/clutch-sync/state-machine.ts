// Pure decision logic for the Clutch sync Lambda.
// Maps a Clutch video status onto our recording row lifecycle:
//   scheduled → recording → processing → published / failed

export type ClutchVideoStatus =
  | 'SCHEDULED'
  | 'QUEUED'
  | 'RECORDING'
  | 'PROCESSING'
  | 'DELAYED_PROCESSING'
  | 'COMPLETED'
  | 'COMPLETED_EMPTY_COURT'
  | 'OK'
  | 'OK_EMPTY_COURT'
  | 'FAILED'
  | 'FAILED_DEVICE_OCCUPIED'
  | 'FAILED_DEVICE_OFFLINE'

export interface RecordingRow {
  id: string
  clutch_video_id: string
  status: string
  sync_attempts: number
  last_sync_error: string | null
  match_date: string
  duration_seconds: number | null
}

export type SyncAction =
  | {
      kind: 'set_status'
      status: 'scheduled' | 'recording' | 'processing'
      alert: boolean
    }
  | { kind: 'publish'; includeHighlights: boolean }
  | { kind: 'fail'; reason: string; alert: boolean }

// FAILED means Clutch's pipeline will auto-reprocess (delayed processing can
// take hours). Only give up after the recording has been stuck well past any
// plausible reprocessing window.
const FAILED_ALERT_AFTER_MS = 24 * 60 * 60 * 1000
const FAILED_GIVE_UP_AFTER_MS = 48 * 60 * 60 * 1000

function msSinceMatchEnd(row: RecordingRow, nowMs: number): number {
  const matchStart = new Date(row.match_date).getTime()
  const durationMs = (row.duration_seconds ?? 0) * 1000
  return nowMs - (matchStart + durationMs)
}

export function decideSyncAction(
  clutchStatus: ClutchVideoStatus,
  row: RecordingRow,
  nowMs: number
): SyncAction {
  switch (clutchStatus) {
    case 'SCHEDULED':
    case 'QUEUED':
      return { kind: 'set_status', status: 'scheduled', alert: false }

    case 'RECORDING':
      return { kind: 'set_status', status: 'recording', alert: false }

    // COMPLETED means highlights/stats exist but the full video hasn't been
    // uploaded to Clutch storage yet (20min–2h). v1 waits for OK so the
    // recording publishes with the full match video in one transition.
    case 'PROCESSING':
    case 'DELAYED_PROCESSING':
    case 'COMPLETED':
    case 'COMPLETED_EMPTY_COURT':
      return { kind: 'set_status', status: 'processing', alert: false }

    case 'OK':
      return { kind: 'publish', includeHighlights: true }

    // Practice session — Clutch outputs no highlights or stats.
    case 'OK_EMPTY_COURT':
      return { kind: 'publish', includeHighlights: false }

    case 'FAILED': {
      const stuckMs = msSinceMatchEnd(row, nowMs)
      if (stuckMs >= FAILED_GIVE_UP_AFTER_MS) {
        return {
          kind: 'fail',
          reason: 'Clutch processing FAILED and did not recover within 48h',
          alert: true,
        }
      }
      return {
        kind: 'set_status',
        status: 'processing',
        alert: stuckMs >= FAILED_ALERT_AFTER_MS,
      }
    }

    case 'FAILED_DEVICE_OCCUPIED':
    case 'FAILED_DEVICE_OFFLINE':
      return {
        kind: 'fail',
        reason: `Clutch recording never started: ${clutchStatus}`,
        alert: true,
      }

    // The API can return statuses outside our compile-time union (e.g. a
    // cancellation made directly in the Clutch app). Without this, the row
    // would loop on a TypeError forever and never alert.
    default:
      return {
        kind: 'fail',
        reason: `Unrecognized Clutch status: ${clutchStatus}`,
        alert: true,
      }
  }
}

export interface ClutchS3Keys {
  prefix: string
  video: string
  highlight: string
  matchJson: string
  highlightManifest: string
  shotsCsv: string
  playerCrops: string
  // Rewritten index docs (S3 keys, not URLs) read by the /clutch API route.
  highlightsIndex: string
  playersIndex: string
}

export function generateClutchS3Keys(
  videoId: string,
  matchDateIso: string
): ClutchS3Keys {
  const date = new Date(matchDateIso).toISOString().slice(0, 10)
  const prefix = `recordings/${date}/clutch/${videoId}`
  return {
    prefix,
    highlightsIndex: `${prefix}/highlights.index.json`,
    playersIndex: `${prefix}/players.index.json`,
    video: `${prefix}/match.mp4`,
    highlight: `${prefix}/highlight-landscape.mp4`,
    matchJson: `${prefix}/match.json`,
    highlightManifest: `${prefix}/highlight_urls.json`,
    // Raw shot-by-shot events (type/subtype, court x/y, speed, WPR rating,
    // winner/error, bounces) — the heat-map-grade analytics data.
    shotsCsv: `${prefix}/detected_shots_v3.csv`,
    playerCrops: `${prefix}/player_crop_urls.json`,
  }
}
