// Recording Event Types — constants, labels, colors, and TypeScript interfaces

export const EVENT_TYPES = [
  'goal',
  'shot',
  'save',
  'corner',
  'free_kick',
  'yellow_card',
  'red_card',
  'penalty',
  'kick_off',
  'half_time',
  'full_time',
  'foul',
  'substitution',
  'other',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  goal: 'Goal',
  shot: 'Shot',
  save: 'Save',
  corner: 'Corner',
  free_kick: 'Free Kick',
  yellow_card: 'Yellow Card',
  red_card: 'Red Card',
  penalty: 'Penalty',
  kick_off: 'Kick Off',
  half_time: 'Half Time',
  full_time: 'Full Time',
  foul: 'Foul',
  substitution: 'Substitution',
  other: 'Other',
}

export const EVENT_TYPE_COLORS: Record<EventType, string> = {
  goal: '#22c55e', // green
  shot: '#3b82f6', // blue
  save: '#a855f7', // purple
  corner: '#f59e0b', // amber
  free_kick: '#06b6d4', // cyan
  yellow_card: '#eab308', // yellow
  red_card: '#ef4444', // red
  penalty: '#f97316', // orange
  kick_off: '#6b7280', // gray
  half_time: '#6b7280', // gray
  full_time: '#6b7280', // gray
  foul: '#f43f5e', // rose
  substitution: '#8b5cf6', // violet
  other: '#9ca3af', // gray-400
}

export type EventVisibility = 'public' | 'private'
export type EventSource = 'manual' | 'ai_detected'
export type EventTeam = 'home' | 'away'

export interface RecordingEvent {
  id: string
  match_recording_id: string
  event_type: EventType
  timestamp_seconds: number
  team: EventTeam | null
  label: string | null
  visibility: EventVisibility
  source: EventSource
  confidence_score: number | null
  created_by: string
  created_at: string
  updated_at: string
}

/**
 * Format seconds into mm:ss or h:mm:ss
 */
export function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Validate that a value is a valid EventType
 */
export function isValidEventType(value: string): value is EventType {
  return EVENT_TYPES.includes(value as EventType)
}
