// Writes mapped Veo highlight events into playhub_recording_events.
// Idempotent via UNIQUE (provider, provider_recording_id, provider_event_id):
// concurrent invocations may both upsert, but Postgres serialises on the
// constraint and the result is identical.

import { getSupabase } from './cache-writer'
import {
  mapVeoHighlightsToEvents,
  type VeoHighlightForMapping,
} from '../../../src/lib/recordings/veo-events-mapper'

export interface WriteResult {
  /** Goal-tagged highlights we tried to upsert. */
  mapped: number
  /**
   * Rows matched by the upsert. Supabase `count: 'exact'` returns total
   * matching rows after the write — re-syncs still report the full count.
   * Treat as "rows touched", NOT "rows newly inserted".
   */
  matched: number
}

export async function writeRecordingEventsForVeoMatch(
  veoMatchSlug: string,
  highlights: VeoHighlightForMapping[]
): Promise<WriteResult> {
  if (!veoMatchSlug) return { mapped: 0, matched: 0 }
  const events = mapVeoHighlightsToEvents(highlights, veoMatchSlug)
  if (events.length === 0) {
    return { mapped: 0, matched: 0 }
  }

  const supabase = getSupabase()
  const { error, count } = await supabase
    .from('playhub_recording_events')
    .upsert(events, {
      onConflict: 'provider,provider_recording_id,provider_event_id',
      count: 'exact',
    })

  if (error) {
    throw new Error(
      `Failed to upsert recording events for ${veoMatchSlug}: ${error.message}`
    )
  }

  return { mapped: events.length, matched: count ?? events.length }
}
