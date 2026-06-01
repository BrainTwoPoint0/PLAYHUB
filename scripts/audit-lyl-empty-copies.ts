/**
 * Audit (and optionally clean up) "entry-without-content" share-copies in the
 * LYL Veo clubhouse.
 *
 * Background: the weekly LYL sync shares each recording into the away team's
 * Veo folder. If the share fired before the source finished processing, Veo
 * created an away-folder copy with no playable video — an empty "NOT SET"
 * entry with no thumbnail. The orchestrator now PREVENTS new ones (it defers
 * the share until the source is content-ready); this script finds + fixes any
 * that already exist.
 *
 * What it reports (via lib/lyl-sync/audit.ts):
 *   - Empty share-copies   — broken away copies to delete + re-share.
 *   - Deferred originals    — home filed, away waiting on Veo processing (OK).
 *   - Stuck originals       — source ready but away never landed (investigate).
 *
 * Usage:
 *   Dry-run (default — report only, no deletes):
 *     cd PLAYHUB && npx tsx scripts/audit-lyl-empty-copies.ts
 *   Apply (delete empty copies + re-arm their originals for the next cron):
 *     cd PLAYHUB && npx tsx scripts/audit-lyl-empty-copies.ts --apply
 *
 * Env required (auto-loaded from PLAYHUB/.env[.local]):
 *   VEO_EMAIL, VEO_PASSWORD,
 *   NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import {
  listRecordings as veoListRecordings,
  deleteRecording as veoDeleteRecording,
  getRecordingContentCounts as veoContentCounts,
} from '../src/lib/veo/client'
import { shutdownVeoSession } from '../src/lib/veo/auth'
import { runContentCleanup, type CleanupVeo } from '../src/lib/lyl-sync/cleanup'
import type { VeoRecording } from '../src/lib/lyl-sync/orchestrator'

const LEAGUE_CLUB_SLUG = 'lyl'
const VEO_CLUB_SLUG = 'london-youth-league'

function loadEnvFile(path: string): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    let value = t.slice(eq + 1).trim()
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
loadEnvFile(join(__dirname, '..', '.env.local'))

const APPLY = process.argv.includes('--apply')
// Validate the (unverified) DELETE endpoint on exactly ONE copy before any
// bulk run: --only=<copySlug>. Implies minAgeMs=0 so an orphan can be used as
// a pure endpoint test, and bypasses the maxDeletes cap (single target).
const ONLY = (() => {
  const a = process.argv.find((x) => x.startsWith('--only='))
  return a ? a.split('=')[1] : null
})()
// Override the delete grace window (minutes). The window guards against
// deleting a freshly-created copy whose thumbnail is still rendering — but the
// detector now uses real content counts (videos=0/periods=0), so for a
// human-approved sweep of known-old broken copies `--min-age=0` is safe.
const MIN_AGE_MIN = (() => {
  const a = process.argv.find((x) => x.startsWith('--min-age='))
  return a ? Number(a.split('=')[1]) : null
})()

// Adapter: map the rich Veo client onto the narrow surface cleanup needs.
// NOTE: runContentCleanup passes our DB slug ('lyl'); Veo's club slug is
// 'london-youth-league'. This script is LYL-specific, so translate at the
// boundary (the Lambda adapter does the same via VEO_CLUB_SLUG env).
const veo: CleanupVeo = {
  listRecordings: async (_clubSlug: string): Promise<VeoRecording[]> => {
    const r = await veoListRecordings(VEO_CLUB_SLUG)
    if (!r.success) throw new Error(`listRecordings: ${r.message}`)
    return r.data!.recordings.map((rec) => ({
      slug: rec.slug,
      title: rec.title,
      duration: rec.duration,
      team: rec.team ?? null,
      match_date: rec.match_date,
      processing_status: rec.processing_status ?? null,
      thumbnail: rec.thumbnail ?? null,
    }))
  },
  deleteRecording: async (slug: string): Promise<void> => {
    const r = await veoDeleteRecording(slug)
    if (!r.success) throw new Error(`deleteRecording: ${r.message}`)
  },
  getRecordingContent: async (slug: string) => {
    const r = await veoContentCounts(slug)
    if (!r.success || !r.data)
      throw new Error(`getRecordingContentCounts: ${r.message}`)
    return r.data
  },
}

async function main() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    console.error(
      'Missing NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'
    )
    process.exit(1)
  }
  const supabase = createClient(supabaseUrl, serviceKey)

  console.log(
    `\nLYL content audit — mode: ${APPLY ? 'APPLY (will delete)' : 'DRY-RUN'}${ONLY ? ` · scoped to ${ONLY}` : ''}\n`
  )

  const result = await runContentCleanup(
    {
      leagueClubSlug: LEAGUE_CLUB_SLUG,
      veoClubSlug: VEO_CLUB_SLUG,
      apply: APPLY,
      // Also surface empty ORIGINALS (failed/pending camera uploads) — report
      // only, never deleted. Off in the cron path (expensive); on for this
      // human-run sweep.
      probeOriginals: true,
      // Single-copy validation: scope to one slug + drop the grace window so a
      // chosen (even orphan) copy can be deleted as a pure endpoint test.
      ...(ONLY ? { onlyCopySlug: ONLY, minAgeMs: 0 } : {}),
      // Operator grace-window override (minutes).
      ...(MIN_AGE_MIN != null ? { minAgeMs: MIN_AGE_MIN * 60 * 1000 } : {}),
    },
    { supabase, veo }
  )

  const { emptyShareCopies, awayPending, emptyOriginals } = result.audit

  console.log(
    `Empty share-copies (broken — verified 0 videos + 0 periods): ${emptyShareCopies.length}`
  )
  for (const c of emptyShareCopies) {
    console.log(
      `  • ${c.title}  [${c.copySlug}]  videos=${c.videos} periods=${c.periods}  → original: ${c.originalRecordingSlug ?? '(orphan)'}`
    )
  }
  console.log(
    `\nEmpty ORIGINALS (failed/pending camera upload — REPORT ONLY, never deleted): ${emptyOriginals.length}`
  )
  for (const o of emptyOriginals) {
    console.log(`  • ${o.title}  [${o.recordingSlug}]`)
  }
  console.log(
    `\nAway-share pending (home filed, away not yet completed): ${awayPending.length}`
  )
  for (const a of awayPending) {
    console.log(`  • ${a.title}  [${a.recordingSlug}]`)
  }

  if (APPLY) {
    if (result.abortedTooMany) {
      console.log(
        `\n⛔ ABORTED — ${emptyShareCopies.length} empty copies exceed the safety cap. Nothing deleted. Investigate (possible Veo outage / audit misfire) before re-running.`
      )
    }
    console.log(`\nCleaned (deleted + re-armed): ${result.cleaned.length}`)
    for (const c of result.cleaned) {
      console.log(
        `  ✓ ${c.copySlug}  (reset original ${c.originalRecordingSlug ?? '(orphan)'})`
      )
    }
    if (result.skippedNotEligible.length) {
      console.log(
        `\nSkipped (not eligible — grace window / orphan): ${result.skippedNotEligible.length}`
      )
      for (const s of result.skippedNotEligible)
        console.log(`  – ${s.copySlug} — ${s.reason}`)
    }
    if (result.failed.length) {
      console.log(`\nFailed deletes: ${result.failed.length}`)
      for (const f of result.failed)
        console.log(`  ✗ ${f.copySlug} — ${f.error}`)
    }
    if (result.skippedDueToDeadline.length) {
      console.log(
        `\n⏱ Skipped (deadline): ${result.skippedDueToDeadline.length} — re-run to finish.`
      )
    }
  } else if (emptyShareCopies.length) {
    console.log(
      `\nRe-run with --apply to delete the ${emptyShareCopies.length} empty copies and re-arm their originals.`
    )
  }

  console.log('')
}

main()
  .catch((err) => {
    console.error('audit-lyl-empty-copies failed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await shutdownVeoSession().catch(() => {})
  })
