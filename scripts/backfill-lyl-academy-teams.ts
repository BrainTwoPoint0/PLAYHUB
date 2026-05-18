/**
 * Backfill playhub_academy_teams for LYL by reading the authoritative
 * Veo team list under the `london-youth-league` clubhouse and writing
 * one row per (subclub, age_group) pair into the DB. This is what the
 * /academy/lyl subscription page reads to render the per-age picker
 * under each subclub.
 *
 * Idempotent: re-runs upsert by (club_slug, team_slug); won't duplicate.
 *
 * Why this exists separately from the cron: the cron writes to
 * playhub_recording_assignments (per-recording state), not to
 * playhub_academy_teams (per-(subclub,age) catalog the subscription page
 * needs). Adding the upsert to the orchestrator is the right follow-up;
 * this script unblocks the subscription page TODAY without touching the
 * cron path.
 *
 * Algorithm:
 *   1. Load active LYL subclubs from DB (subclub_slug + display_name + logo_url).
 *   2. List Veo teams under london-youth-league.
 *   3. For each Veo team, parse `{subclub-slug-with-hyphens}-u{age}`:
 *      - longest-prefix match against subclub_slug
 *      - extract age from trailing `-u\d+`
 *   4. Build team row: team_slug=veo team slug, display_name=`U{age}`,
 *      subclub_slug from match, veo_team_slug=veo team slug,
 *      logo_url=null (inherits from subclub via picker fallback).
 *   5. Upsert.
 *
 * Usage:
 *   Dry-run (default):  cd PLAYHUB && npx tsx scripts/backfill-lyl-academy-teams.ts
 *   Apply:              ... --apply
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { listClubsAndTeams } from '../src/lib/veo/client'
import { shutdownVeoSession } from '../src/lib/veo/auth'

function loadEnv(p: string): void {
  let raw: string
  try { raw = readFileSync(p, 'utf8') } catch { return }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    let value = t.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (!(key in process.env)) process.env[key] = value
  }
}
loadEnv(join(__dirname, '..', '.env'))
loadEnv(join(__dirname, '..', '.env.local'))

const APPLY = process.argv.includes('--apply')
const CLUB_SLUG = 'lyl'
const VEO_CLUB_SLUG = 'london-youth-league'
const AGE_RE = /^(.+)-u(\d{1,2})$/

interface SubclubRow {
  subclub_slug: string
  display_name: string
  logo_url: string | null
}

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Load subclubs
  const { data: subsRaw, error: subErr } = await supabase
    .from('playhub_academy_subclubs')
    .select('subclub_slug, display_name, logo_url')
    .eq('club_slug', CLUB_SLUG)
    .eq('is_active', true)
  if (subErr) { console.error(subErr); process.exit(1) }
  const subclubs = (subsRaw ?? []) as SubclubRow[]
  // Sort longest slug first so e.g. `rockslane-chiswick` wins over `rockslane`.
  const subclubsByLengthDesc = [...subclubs].sort((a, b) => b.subclub_slug.length - a.subclub_slug.length)
  console.log(`Loaded ${subclubs.length} LYL subclubs`)

  // Veo teams
  const allClubs = await listClubsAndTeams()
  if (!allClubs.success) { console.error(allClubs.message); process.exit(1) }
  const lyl = allClubs.data!.clubs.find((c) => c.slug === VEO_CLUB_SLUG)
  if (!lyl) { console.error('lyl Veo club not found'); process.exit(1) }
  const veoTeams = lyl.teams as Array<{ slug: string; name: string }>
  console.log(`Found ${veoTeams.length} Veo teams under ${VEO_CLUB_SLUG}\n`)

  type Plan = {
    teamSlug: string
    subclubSlug: string | null
    ageGroup: string | null
    displayName: string
    veoName: string
    logoUrl?: string | null
    reason?: string
  }
  const plan: Plan[] = veoTeams.map((veo) => {
    const m = veo.slug.match(AGE_RE)
    if (!m) return { teamSlug: veo.slug, subclubSlug: null, ageGroup: null, displayName: '', veoName: veo.name, reason: 'no -u\\d+ suffix' }
    const prefix = m[1]
    const age = `u${m[2]}`
    // Longest-prefix match: the Veo slug prefix should EQUAL a subclub_slug
    // (not just include it) to avoid `rpt` accidentally matching `rocks…`.
    const match = subclubsByLengthDesc.find((sc) => sc.subclub_slug === prefix)
    if (!match) return { teamSlug: veo.slug, subclubSlug: null, ageGroup: age, displayName: '', veoName: veo.name, reason: `no subclub matches prefix "${prefix}"` }
    return {
      teamSlug: veo.slug,
      subclubSlug: match.subclub_slug,
      ageGroup: age,
      displayName: age.toUpperCase(),
      veoName: veo.name,
      logoUrl: match.logo_url ?? null,
    }
  })

  const actionable = plan.filter((p) => p.subclubSlug && p.ageGroup)
  const skipped = plan.filter((p) => !p.subclubSlug || !p.ageGroup)
  console.log(`=== PLAN ===`)
  console.log(`  Actionable: ${actionable.length} team rows will be upserted`)
  console.log(`  Skipped:    ${skipped.length}`)
  for (const p of actionable.slice(0, 10)) {
    console.log(`    ${p.teamSlug.padEnd(35)} → subclub=${p.subclubSlug?.padEnd(20)} display="${p.displayName}"  (veo "${p.veoName}")`)
  }
  if (actionable.length > 10) console.log(`    … and ${actionable.length - 10} more`)
  if (skipped.length) {
    console.log(`\n  Skipped:`)
    for (const p of skipped) console.log(`    ${p.teamSlug.padEnd(35)} — ${p.reason}`)
  }

  if (!APPLY) {
    console.log(`\nDry-run. Pass --apply to upsert.`)
    await shutdownVeoSession()
    return
  }

  console.log(`\n=== APPLYING ===`)
  // Build rows: sort_order = age × 10 so U7 < U10 < U11 numerically.
  const rows = actionable.map((p) => ({
    club_slug: CLUB_SLUG,
    subclub_slug: p.subclubSlug,
    team_slug: p.teamSlug,
    display_name: p.displayName,
    // Mirror the parent subclub's logo onto every (subclub, age) team.
    // The picker doesn't fall back from team → subclub at render time,
    // so empty-string logos render as ugly placeholders.
    logo_url: p.logoUrl ?? null,
    veo_team_slug: p.teamSlug,
    sort_order: parseInt(p.ageGroup!.slice(1), 10) * 10,
    is_active: true,
  }))
  // The hierarchical unique index is PARTIAL (`WHERE subclub_slug IS NOT NULL`),
  // and Supabase JS's upsert can't spell the predicate in ON CONFLICT —
  // Postgres rejects it. For this one-off backfill the simpler move is
  // DELETE-then-INSERT scoped to the rows we manage (hierarchical only,
  // never touch flat-style legacy rows). Safe because:
  //   (a) we own every (club=lyl, subclub IS NOT NULL) row — they only
  //       exist because of this very script,
  //   (b) academy_subscriptions FKs to (club_slug, subclub_slug) on
  //       playhub_academy_subclubs, not on playhub_academy_teams, so
  //       cascading subscriptions can't be orphaned by this delete.
  const { error: delErr } = await supabase
    .from('playhub_academy_teams')
    .delete()
    .eq('club_slug', CLUB_SLUG)
    .not('subclub_slug', 'is', null)
  if (delErr) {
    console.error('delete failed:', delErr)
    await shutdownVeoSession()
    process.exit(1)
  }
  const { error } = await supabase
    .from('playhub_academy_teams')
    .insert(rows)
  if (error) {
    console.error('upsert failed:', error)
    await shutdownVeoSession()
    process.exit(1)
  }
  console.log(`✓ Upserted ${rows.length} team rows`)

  await shutdownVeoSession()
}
main().catch(async (e) => { console.error(e); await shutdownVeoSession(); process.exit(1) })
