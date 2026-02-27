'use client'

import { Badge } from '@braintwopoint0/playback-commons/ui'
import { Lock } from 'lucide-react'
import type { RecordingEvent } from '@/lib/recordings/event-types'
import {
  EVENT_TYPE_LABELS,
  EVENT_TYPE_COLORS,
  formatTimestamp,
} from '@/lib/recordings/event-types'

const PRE_ROLL_SECONDS = 5

function seekToEvent(timestampSeconds: number) {
  const video = document.querySelector('video')
  if (video) {
    video.currentTime = Math.max(0, timestampSeconds - PRE_ROLL_SECONDS)
  }
}

interface EventTagsListProps {
  events: RecordingEvent[]
  homeTeam: string
  awayTeam: string
}

export function EventTagsList({
  events,
  homeTeam,
  awayTeam,
}: EventTagsListProps) {
  if (events.length === 0) return null

  return (
    <div className="space-y-1.5">
      {events.map((event) => (
        <div
          key={event.id}
          className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-white/[0.03] transition-colors group"
        >
          {/* Color dot */}
          <div
            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: EVENT_TYPE_COLORS[event.event_type] }}
          />

          {/* Timestamp — clickable */}
          <button
            onClick={() => seekToEvent(event.timestamp_seconds)}
            className="text-xs font-mono text-emerald-400 hover:text-emerald-300 w-14 text-left flex-shrink-0"
          >
            {formatTimestamp(event.timestamp_seconds)}
          </button>

          {/* Event type badge */}
          <Badge
            variant="outline"
            className="text-xs flex-shrink-0"
            style={{
              backgroundColor: EVENT_TYPE_COLORS[event.event_type] + '20',
              color: EVENT_TYPE_COLORS[event.event_type],
              borderColor: EVENT_TYPE_COLORS[event.event_type] + '40',
            }}
          >
            {EVENT_TYPE_LABELS[event.event_type]}
          </Badge>

          {/* Team */}
          {event.team && (
            <span className="text-xs text-[var(--ash-grey)]">
              {event.team === 'home' ? homeTeam : awayTeam}
            </span>
          )}

          {/* Label */}
          {event.label && (
            <span className="text-xs text-[var(--timberwolf)] truncate">
              {event.label}
            </span>
          )}

          {/* Visibility icon */}
          {event.visibility === 'private' && (
            <Lock className="w-3 h-3 text-[var(--ash-grey)] flex-shrink-0 ml-auto" />
          )}
        </div>
      ))}
    </div>
  )
}
