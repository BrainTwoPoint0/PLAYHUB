/**
 * Backfill provider goal events from cached Veo content.
 *
 * Walks playhub_veo_match_content_cache, maps each highlight blob to
 * InsertRecordingEvent rows via mapVeoHighlightsToEvents, and upserts into
 * playhub_recording_events keyed by (provider, provider_event_id). Idempotent
 * — re-runs leave the row count unchanged once everything is ingested.
 *
 * Usage:
 *   cd PLAYHUB && npx tsx scripts/backfill-veo-events.ts
 *
 * Env required (loaded from .env):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import {
  mapVeoHighlightsToEvents,
  type VeoHighlightForMapping,
} from '../src/lib/recordings/veo-events-mapper'
import type { InsertRecordingEvent } from '../src/lib/recordings/event-types'

function loadEnvFile(path: string): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

loadEnvFile(join(__dirname, '..', '.env'))

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const BATCH_SIZE = 100

interface PendingEvent {
  row: InsertRecordingEvent
  cacheSlug: string
}

async function upsertBatch(
  supabase: ReturnType<typeof createClient>,
  pending: PendingEvent[]
): Promise<{ ok: number; failedRows: PendingEvent[] }> {
  if (pending.length === 0) return { ok: 0, failedRows: [] }
  const { error } = await supabase.from('playhub_recording_events').upsert(
    pending.map((p) => p.row),
    { onConflict: 'provider,provider_recording_id,provider_event_id' }
  )
  if (!error) return { ok: pending.length, failedRows: [] }

  // Per the code review: don't lose per-row error context on batch failure.
  // Retry one-by-one so a single bad highlight doesn't poison the batch
  // and so the offending provider_event_id surfaces in logs.
  console.warn(
    `Batch upsert failed (${error.message}); retrying one-by-one to isolate.`
  )
  let ok = 0
  const failedRows: PendingEvent[] = []
  for (const p of pending) {
    const { error: rowErr } = await supabase
      .from('playhub_recording_events')
      .upsert([p.row], {
        onConflict: 'provider,provider_recording_id,provider_event_id',
      })
    if (rowErr) {
      console.warn(
        `  cache=${p.cacheSlug} provider_event_id=${p.row.provider_event_id}: ${rowErr.message}`
      )
      failedRows.push(p)
    } else {
      ok += 1
    }
  }
  return { ok, failedRows }
}

async function main() {
  const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE!)

  let totalCacheRows = 0
  let totalMapped = 0
  let totalUpserted = 0
  let totalFailed = 0
  let from = 0

  console.log('Starting Veo events backfill...')

  // Batch pagination invariant: `match_slug` is the PK on
  // playhub_veo_match_content_cache (one row per Veo match) so range+order
  // is stable. If we ever pageinate by a non-unique key, switch to
  // keyset pagination to avoid skipped/duplicated rows.
  while (true) {
    const { data, error } = await supabase
      .from('playhub_veo_match_content_cache')
      .select('match_slug, highlights')
      .not('highlights', 'is', null)
      .range(from, from + BATCH_SIZE - 1)
      .order('match_slug', { ascending: true })

    if (error) {
      console.error('Failed to read cache:', error.message)
      process.exit(1)
    }
    if (!data || data.length === 0) break

    const pending: PendingEvent[] = []
    for (const row of data) {
      totalCacheRows++
      const highlights = (row.highlights as VeoHighlightForMapping[]) || []
      if (highlights.length === 0) continue
      const mapped = mapVeoHighlightsToEvents(highlights, row.match_slug)
      for (const r of mapped) {
        pending.push({ row: r, cacheSlug: row.match_slug })
      }
      totalMapped += mapped.length
    }

    if (pending.length > 0) {
      const { ok, failedRows } = await upsertBatch(supabase, pending)
      totalUpserted += ok
      totalFailed += failedRows.length
      console.log(
        `Batch from=${from}: ${ok}/${pending.length} ok, ${failedRows.length} failed`
      )
    }

    if (data.length < BATCH_SIZE) break
    from += BATCH_SIZE
  }

  console.log('\n=== BACKFILL COMPLETE ===')
  console.log(`Cache rows processed:   ${totalCacheRows}`)
  console.log(`Goal events mapped:     ${totalMapped}`)
  console.log(`Rows upserted:          ${totalUpserted}`)
  console.log(`Individual row errors:  ${totalFailed}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
