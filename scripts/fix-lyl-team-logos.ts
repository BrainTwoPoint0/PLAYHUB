/**
 * Bulk-set the Veo team crest (logo) for every LYL team to its subclub's
 * logo from playhub_academy_subclubs.logo_url.
 *
 * Why: the LYL Veo sync (2026-05-17) created ~50 teams under the LYL
 * clubhouse, all inheriting the LYL club crest. The PLAYBACK academy
 * subscription page (/academy/lyl) already has the correct per-subclub
 * logos stored in playhub_academy_subclubs.logo_url. This script
 * propagates those into each Veo team's crest field.
 *
 * Algorithm:
 *   1. Read all active LYL subclubs (subclub_slug + display_name + logo_url).
 *   2. List Veo teams in the LYL clubhouse.
 *   3. For each Veo team, parse "<DisplayName> U<NN>" → identify the
 *      subclub by display_name match (longest match wins to handle e.g.
 *      "Barnes Eagles" vs "Barnes" — order subclubs by display_name desc).
 *   4. If matched, fetch the subclub logo from Supabase Storage as bytes.
 *   5. Upload via uploadTeamCrest() in the Veo client.
 *
 * Usage:
 *   Dry-run (default, prints plan, no Veo writes):
 *     cd PLAYHUB && npx tsx scripts/fix-lyl-team-logos.ts
 *   Execute for real:
 *     cd PLAYHUB && npx tsx scripts/fix-lyl-team-logos.ts --apply
 *   Limit to one team for first-test:
 *     cd PLAYHUB && npx tsx scripts/fix-lyl-team-logos.ts --apply --only=barnes-eagles-u10
 *
 * First-time validation flow:
 *   1. Run dry-run → review the proposed mappings + unmatched teams.
 *   2. Run with --only=<one-team-slug> --apply to test a single upload.
 *   3. Verify in Veo dashboard the crest is correct.
 *   4. Run without --only to do the bulk.
 *
 * Env required (auto-loaded from PLAYHUB/.env):
 *   VEO_EMAIL, VEO_PASSWORD,
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import {
  listClubsAndTeams,
  uploadTeamCrest,
} from '../src/lib/veo/client'
import { shutdownVeoSession } from '../src/lib/veo/auth'

const LEAGUE_CLUB_SLUG = 'lyl'
const VEO_CLUB_SLUG = 'london-youth-league'

function loadEnvFile(path: string): void {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    let value = t.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

loadEnvFile(join(__dirname, '..', '.env'))
loadEnvFile(join(__dirname, '..', '.env.local'))

const APPLY = process.argv.includes('--apply')
const ONLY = (() => {
  const a = process.argv.find((x) => x.startsWith('--only='))
  return a ? a.split('=')[1] : null
})()
// Comma-separated whitelist of team slugs (`--slugs=a,b,c`). Lets us
// re-run a targeted subset (e.g. fixing collision casualties without
// re-uploading every other team's crest).
const SLUGS = (() => {
  const a = process.argv.find((x) => x.startsWith('--slugs='))
  return a ? new Set(a.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean)) : null
})()
// Veo names uploaded crest assets by Unix-second timestamp
// (team_<unixSeconds>.png) — two uploads in the same second COLLIDE,
// silently overwriting the earlier upload with the latter file. First
// bulk run on 2026-05-17 had 3 collisions (jsfc-u9, london-thames-u9,
// rpt-u8). 1.1s sleep between uploads forces a fresh wallclock second
// per call. Sequential per-team is fine — we never have >50 teams.
const INTER_UPLOAD_DELAY_MS = 1100

// SSRF allowlist — logoUrl is a TEXT column with no schema constraint,
// so a future bad write could land an arbitrary URL there. Forbid
// fetching anything that isn't a public Supabase Storage object. Per
// 2026-05-17 security review.
const ALLOWED_LOGO_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
function isAllowedLogoUrl(url: string, supabaseUrl: string): boolean {
  // Require exact prefix match against the project's Supabase URL +
  // the public-storage path. Rejects redirects, IPs, metadata endpoints.
  return url.startsWith(`${supabaseUrl}/storage/v1/object/public/`)
}

interface SubclubRow {
  subclub_slug: string
  display_name: string
  logo_url: string | null
}

interface VeoTeamRow {
  slug: string
  name: string
  age_group?: string
}

/** Sniff MIME type from URL extension. Supabase Storage URLs end in .png/.jpg/.webp etc. */
function sniffMimeType(url: string): string {
  const lower = url.toLowerCase().split('?')[0]
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  // Default to PNG — Veo will reject if wrong (we'd rather fail loud than upload an unviewable asset).
  return 'image/png'
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in PLAYHUB/.env')
    process.exit(1)
  }
  if (!process.env.VEO_EMAIL || !process.env.VEO_PASSWORD) {
    console.error('Missing VEO_EMAIL / VEO_PASSWORD in PLAYHUB/.env')
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, supabaseKey)

  // 1. Load LYL subclubs from DB
  const { data: subclubsRaw, error: subErr } = await supabase
    .from('playhub_academy_subclubs')
    .select('subclub_slug, display_name, logo_url')
    .eq('club_slug', LEAGUE_CLUB_SLUG)
    .eq('is_active', true)
  if (subErr) {
    console.error('Failed to load subclubs:', subErr)
    process.exit(1)
  }
  const subclubs = (subclubsRaw ?? []) as SubclubRow[]
  console.log(`Loaded ${subclubs.length} active LYL subclubs from DB`)

  // Build a name-matching index sorted by display_name length DESC so
  // longest match wins (avoids "Barnes" matching "Barnes Eagles U10").
  const subclubsByLengthDesc = [...subclubs].sort(
    (a, b) => b.display_name.length - a.display_name.length
  )

  // 2. List Veo teams in the LYL clubhouse (filter from all clubs+teams)
  console.log(`\nFetching clubs+teams from Veo and filtering to "${VEO_CLUB_SLUG}"…`)
  const allClubsRes = await listClubsAndTeams()
  if (!allClubsRes.success) {
    console.error(`Failed to list Veo clubs+teams: ${allClubsRes.message}`)
    await shutdownVeoSession()
    process.exit(1)
  }
  const lylClub = allClubsRes.data?.clubs.find((c) => c.slug === VEO_CLUB_SLUG)
  if (!lylClub) {
    console.error(`Veo club "${VEO_CLUB_SLUG}" not found in account`)
    await shutdownVeoSession()
    process.exit(1)
  }
  const veoTeams = (lylClub.teams ?? []) as VeoTeamRow[]
  console.log(`Found ${veoTeams.length} teams in Veo club "${VEO_CLUB_SLUG}"`)

  // 3. Match each Veo team to a subclub by display_name prefix
  type Plan = {
    veo: VeoTeamRow
    matched: SubclubRow | null
    logoUrl: string | null
    reason?: string
  }
  const plan: Plan[] = veoTeams.map((veo) => {
    if (ONLY && veo.slug !== ONLY) {
      return { veo, matched: null, logoUrl: null, reason: 'filtered by --only' }
    }
    if (SLUGS && !SLUGS.has(veo.slug)) {
      return { veo, matched: null, logoUrl: null, reason: 'filtered by --slugs' }
    }
    // Try to match by display_name prefix (case-insensitive, dropping trailing age group).
    // The Veo team's name is "<DisplayName> U<NN>" so strip the suffix.
    const nameWithoutAge = veo.name.replace(/\s+U\d+\s*$/i, '').trim()
    const matched = subclubsByLengthDesc.find(
      (sc) => sc.display_name.toLowerCase() === nameWithoutAge.toLowerCase()
    )
    if (!matched) {
      return { veo, matched: null, logoUrl: null, reason: `no subclub matches "${nameWithoutAge}"` }
    }
    if (!matched.logo_url) {
      return { veo, matched, logoUrl: null, reason: `subclub "${matched.subclub_slug}" has no logo_url in DB` }
    }
    return { veo, matched, logoUrl: matched.logo_url }
  })

  // 4. Print plan summary
  const actionable = plan.filter((p) => p.logoUrl)
  const unmatched = plan.filter((p) => !p.logoUrl)
  console.log(`\n=== PLAN ===`)
  console.log(`  Actionable: ${actionable.length} teams will have their crest updated`)
  console.log(`  Skipped:    ${unmatched.length} teams (no match or no logo)`)
  if (actionable.length) {
    console.log(`\n  First 5 actionable:`)
    for (const p of actionable.slice(0, 5)) {
      console.log(`    ${p.veo.slug.padEnd(40)} → ${p.matched!.subclub_slug.padEnd(20)} (${p.logoUrl})`)
    }
  }
  if (unmatched.length) {
    console.log(`\n  Skipped:`)
    for (const p of unmatched) {
      console.log(`    ${p.veo.slug.padEnd(40)} — ${p.reason}`)
    }
  }

  if (!APPLY) {
    console.log(`\nDry-run. Pass --apply to execute (and ideally --only=<one-slug> for first-test).`)
    await shutdownVeoSession()
    return
  }

  // 5. Execute
  console.log(`\n=== APPLYING ===`)
  let successCount = 0
  let failCount = 0
  for (let i = 0; i < actionable.length; i++) {
    const p = actionable[i]
    // Sleep BEFORE each upload after the first one — Veo's asset
    // filename is generated from Unix wallclock-second, so back-to-back
    // calls within one second produce identical filenames and the
    // second silently overwrites the first.
    if (i > 0) {
      await new Promise((r) => setTimeout(r, INTER_UPLOAD_DELAY_MS))
    }
    process.stdout.write(`  ${p.veo.slug.padEnd(40)} `)
    try {
      // SSRF guard — refuse to fetch anything outside the project's
      // Supabase Storage. Cheap, eliminates the canonical fetch-from-DB-text-column class.
      if (!isAllowedLogoUrl(p.logoUrl!, supabaseUrl)) {
        console.log(`✗ refusing to fetch non-Supabase URL (SSRF guard)`)
        failCount++
        continue
      }
      // Download the image from Supabase Storage
      const imgResp = await fetch(p.logoUrl!)
      if (!imgResp.ok) {
        console.log(`✗ fetch failed (${imgResp.status})`)
        failCount++
        continue
      }
      const imgBytes = Buffer.from(await imgResp.arrayBuffer())
      const mimeType = imgResp.headers.get('content-type')?.split(';')[0]?.trim() || sniffMimeType(p.logoUrl!)
      // MIME allowlist at the boundary — uploadTeamCrest enforces this too,
      // but failing here gives a clearer log line.
      if (!ALLOWED_LOGO_MIME.has(mimeType)) {
        console.log(`✗ mime "${mimeType}" not in allowlist`)
        failCount++
        continue
      }

      // Upload to Veo
      const uploadRes = await uploadTeamCrest({
        clubSlug: VEO_CLUB_SLUG,
        teamSlug: p.veo.slug,
        imageBytes: imgBytes,
        mimeType,
        filename: `${p.matched!.subclub_slug}.${mimeType.split('/')[1] || 'png'}`,
      })
      if (uploadRes.success) {
        console.log(`✓ ${uploadRes.data?.crestUrl ?? '(no url returned)'}`)
        successCount++
      } else {
        console.log(`✗ ${uploadRes.message}`)
        failCount++
      }
    } catch (err) {
      console.log(`✗ exception: ${err instanceof Error ? err.message : String(err)}`)
      failCount++
    }
  }

  console.log(`\n=== DONE ===`)
  console.log(`  Successes: ${successCount}`)
  console.log(`  Failures:  ${failCount}`)
  console.log(`  Skipped:   ${unmatched.length}`)

  await shutdownVeoSession()
}

main().catch(async (err) => {
  console.error('Unhandled error:', err)
  try { await shutdownVeoSession() } catch {}
  process.exit(1)
})
