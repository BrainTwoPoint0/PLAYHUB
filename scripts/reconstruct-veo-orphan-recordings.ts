/**
 * Reconstruct orphaned Veo recordings into playhub_veo_recordings_cache.
 *
 * Diagnosed 2026-05-16: cache-writer's "if recordings.length === 0, delete
 * all" branch (now fixed) silently wiped legitimate data whenever Veo
 * returned a transient empty response. Per-match content blobs survived
 * in playhub_veo_match_content_cache, so we can rehydrate the recordings
 * cache from those orphans without re-fetching from Veo.
 *
 * Reconstructed fields:
 *   - match_slug, club_slug, veo_club_slug (passed via CLI)
 *   - match_date    parsed from leading YYYYMMDD in slug
 *   - title         humanised from the slug body
 *   - home_team / away_team — split on "-vs-"
 *   - thumbnail     videos[0].thumbnail (highest-quality), falls back to
 *                   highlights[0].thumbnail
 *   - duration      NULL (not in cached payload — UI tolerates this)
 *   - privacy       'public' (matches the rest of CFA — best-effort default)
 *   - processing_status 'published' (content blobs exist → must have been
 *                   processed at some point)
 *   - last_synced_at content blob's last_fetched_at (honest provenance)
 *
 * Usage:
 *   cd PLAYHUB && npx tsx scripts/reconstruct-veo-orphan-recordings.ts \
 *     --club-slug cfa --veo-club-slug playback-15fdc44b
 *
 * Idempotent via the (veo_club_slug, match_slug) UNIQUE constraint.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

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
    const k = t.slice(0, eq).trim()
    let v = t.slice(eq + 1).trim()
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1)
    }
    if (!(k in process.env)) process.env[k] = v
  }
}
loadEnvFile(join(__dirname, '..', '.env'))

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const CLUB_SLUG = arg('club-slug')
const VEO_CLUB_SLUG = arg('veo-club-slug')
const DRY_RUN = process.argv.includes('--dry-run')

if (!CLUB_SLUG || !VEO_CLUB_SLUG) {
  console.error(
    'Usage: --club-slug <slug> --veo-club-slug <veo-slug> [--dry-run]'
  )
  process.exit(1)
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE)

// ── Slug parsing ───────────────────────────────────────────────────────────
function parseDate(slug: string): string | null {
  const m = slug.match(/^(\d{4})(\d{2})(\d{2})-/)
  return m ? `${m[1]}-${m[2]}-${m[3]}T00:00:00Z` : null
}

function humanize(tokens: string): string {
  return tokens
    .split('-')
    .filter(Boolean)
    .map((w) => {
      if (/^u\d+$/i.test(w)) return w.toUpperCase() // U9, U10, U11
      if (w.length <= 3) return w.toUpperCase() // CFA, FC, JPL
      return w.charAt(0).toUpperCase() + w.slice(1)
    })
    .join(' ')
}

interface ParsedSlug {
  match_date: string | null
  title: string
  home_team: string | null
  away_team: string | null
}

function parseSlug(slug: string): ParsedSlug {
  const match_date = parseDate(slug)

  // Strip leading YYYYMMDD- and trailing -<hash> (hash is 6-8 hex chars,
  // optionally v-prefixed).
  let body = slug.replace(/^\d{8}-/, '')
  body = body.replace(/-v?[a-f0-9]{6,}$/, '')

  // Split on -vs- (case-insensitive); first match only — Veo uses lowercase.
  const vsIdx = body.search(/-vs-/i)
  if (vsIdx >= 0) {
    const home = body.slice(0, vsIdx)
    const away = body.slice(vsIdx + 4) // skip "-vs-"
    return {
      match_date,
      title: `${humanize(home)} vs ${humanize(away)}`,
      home_team: humanize(home),
      away_team: humanize(away),
    }
  }
  return {
    match_date,
    title: humanize(body),
    home_team: null,
    away_team: null,
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
interface OrphanRow {
  match_slug: string
  videos: unknown[] | null
  highlights: unknown[] | null
  last_fetched_at: string
}

async function main() {
  // Pull every content-cache row that looks like it belongs to this club by
  // slug prefix. We deliberately don't filter by club_slug at this point —
  // the content cache is keyed by match_slug only, with no club FK.
  // Heuristic: match_slug contains the club_slug or a known historical alias.
  // For CFA: 'cfa' captures 'cfa-' AND 'cfamezzie-' prefixes.
  const slugFilter = CLUB_SLUG!.toLowerCase()
  const { data: content, error: contentErr } = await (supabase as any)
    .from('playhub_veo_match_content_cache')
    .select('match_slug, videos, highlights, last_fetched_at')
    .ilike('match_slug', `%${slugFilter}%`)
  if (contentErr) {
    console.error('Failed to read content cache:', contentErr.message)
    process.exit(1)
  }

  // Pull existing recording rows to exclude.
  const { data: existing, error: existingErr } = await (supabase as any)
    .from('playhub_veo_recordings_cache')
    .select('match_slug')
    .eq('veo_club_slug', VEO_CLUB_SLUG)
  if (existingErr) {
    console.error('Failed to read recordings cache:', existingErr.message)
    process.exit(1)
  }
  const existingSet = new Set(
    (existing ?? []).map((r: { match_slug: string }) => r.match_slug)
  )

  const orphans = (content as OrphanRow[]).filter(
    (r) => !existingSet.has(r.match_slug)
  )

  console.log(
    `Found ${content.length} content blobs matching '${slugFilter}'; ` +
      `${existingSet.size} already in recordings cache; ` +
      `${orphans.length} orphans to reconstruct.`
  )
  if (DRY_RUN) {
    for (const o of orphans.slice(0, 5)) {
      const p = parseSlug(o.match_slug)
      console.log(`  [dry] ${o.match_slug} → "${p.title}" @ ${p.match_date}`)
    }
    if (orphans.length > 5) console.log(`  ... and ${orphans.length - 5} more`)
    return
  }

  // Build the upsert payload.
  const rows = orphans
    .map((o) => {
      const parsed = parseSlug(o.match_slug)
      const firstVideo = Array.isArray(o.videos)
        ? (o.videos as Record<string, unknown>[])[0]
        : null
      const firstHighlight = Array.isArray(o.highlights)
        ? (o.highlights as Record<string, unknown>[])[0]
        : null
      const thumbnail =
        (firstVideo?.thumbnail as string | undefined) ??
        (firstHighlight?.thumbnail as string | undefined) ??
        null
      return {
        club_slug: CLUB_SLUG,
        veo_club_slug: VEO_CLUB_SLUG,
        match_slug: o.match_slug,
        title: parsed.title,
        duration: null,
        privacy: 'public',
        thumbnail,
        uuid: null,
        match_date: parsed.match_date,
        home_team: parsed.home_team,
        away_team: parsed.away_team,
        home_score: null,
        away_score: null,
        processing_status: 'published',
        team: null,
        last_synced_at: o.last_fetched_at,
      }
    })
    .filter((r) => r.match_date) // require a parseable date for ordering

  console.log(
    `Reconstructing ${rows.length} recordings (filtered out ${orphans.length - rows.length} unparseable).`
  )

  // Batches of 100 to match the existing writer.
  const BATCH = 100
  let inserted = 0
  let failed = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH)
    const { error } = await (supabase as any)
      .from('playhub_veo_recordings_cache')
      .upsert(slice, {
        onConflict: 'veo_club_slug,match_slug',
        ignoreDuplicates: false,
      })
    if (error) {
      console.warn(
        `Batch from=${i} failed (${error.message}); retrying one-by-one`
      )
      for (const row of slice) {
        const { error: rowErr } = await (supabase as any)
          .from('playhub_veo_recordings_cache')
          .upsert([row], { onConflict: 'veo_club_slug,match_slug' })
        if (rowErr) {
          console.warn(`  ${row.match_slug}: ${rowErr.message}`)
          failed++
        } else inserted++
      }
    } else {
      inserted += slice.length
      console.log(`Batch from=${i}: ${slice.length} reconstructed`)
    }
  }

  console.log('\n=== RECONSTRUCTION COMPLETE ===')
  console.log(`Reconstructed: ${inserted}`)
  console.log(`Failed:        ${failed}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
