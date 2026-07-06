'use client'

import { useTranslations } from 'next-intl'
import { EVENT_TYPES, type EventType } from './event-types'

// Locale-aware replacement for the static EVENT_TYPE_LABELS map. The
// English strings live in messages/en.json under `events.*` now; the
// static map in event-types.ts remains for non-React/server contexts.
export function useEventTypeLabels(): Record<EventType, string> {
  const t = useTranslations('events')
  return Object.fromEntries(
    EVENT_TYPES.map((type) => [type, t(type)])
  ) as Record<EventType, string>
}
