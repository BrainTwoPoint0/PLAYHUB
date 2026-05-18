/**
 * Dry-run planner for the LYL Veo team-assignment pass.
 *
 * Reads every recording in the `london-youth-league` Veo clubhouse,
 * parses each title for (home subclub, away subclub, age group), and
 * emits a plan:
 *   - which teams need to be created in Veo (subclub + age-group pairs)
 *   - which recordings get assigned to which two teams
 *   - which recordings are unparseable (left untouched)
 *   - which recordings are >60min (multi-match dumps, skipped)
 *
 * Read-only — NO Veo writes happen here. Output is the input to the
 * later execute step once the Veo createTeam/assignRecording endpoints
 * are captured + wired into the client.
 *
 * Usage:
 *   cd PLAYHUB && npx tsx scripts/plan-lyl-team-assignment.ts
 *
 * Env: VEO_EMAIL, VEO_PASSWORD (auto-loaded from PLAYHUB/.env)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function loadEnvFile(path: string): void {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}
loadEnvFile(join(__dirname, '..', '.env'))

const TARGET_CLUB = 'london-youth-league'
const LONG_RECORDING_SECONDS = 60 * 60
const PLAN_OUTPUT = '/tmp/lyl-team-assignment-plan.json'

/** Maps casual / abbreviated team mentions in titles → canonical subclub
 *  slug we use in playhub_academy_subclubs. Order matters: longer / more-
 *  specific keys are checked first so "The A Academy" wins over "TAA"
 *  for a "The A Academy" mention.
 *
 *  Build new entries by adding ALL the spellings that appear in titles
 *  (case-insensitive substring match) on the left. */
const TEAM_LOOKUP: Array<{ patterns: string[]; subclubSlug: string }> = [
  // 18 LYL subclubs (16 originals + 2 we just added).
  { patterns: ['Barnes Eagles'], subclubSlug: 'barnes-eagles' },
  { patterns: ['Champs FC', 'Champs'], subclubSlug: 'champs-fc' },
  { patterns: ['Chosen one FC', 'Chosen One', 'Chosen one'], subclubSlug: 'chosen-one' },
  { patterns: ['DBX'], subclubSlug: 'dbx' },
  { patterns: ['Elite London Academy', 'Elite London academy'], subclubSlug: 'elite-london-academy' },
  { patterns: ['ELA'], subclubSlug: 'ela' },
  { patterns: ['FC Juniors'], subclubSlug: 'fc-juniors' },
  // "Forza skillz" (with space) → forzaskillz. Order before generic words.
  { patterns: ['Forzaskillz', 'Forza skillz', 'Forza Skillz'], subclubSlug: 'forzaskillz' },
  { patterns: ['JSFC'], subclubSlug: 'jsfc' },
  { patterns: ['LFS'], subclubSlug: 'lfs' },
  { patterns: ['London Thames'], subclubSlug: 'london-thames' },
  { patterns: ['National Harrow', 'National Harr'], subclubSlug: 'national-harrow' },
  { patterns: ['N.S.F.C', 'NSFC'], subclubSlug: 'nsfc' },
  { patterns: ['Project 1v1'], subclubSlug: 'project-1v1' },
  { patterns: ['Roehampton Elite', 'Roehampton'], subclubSlug: 'roehampton-elite' },
  { patterns: ['Rockslane Chiswick'], subclubSlug: 'rockslane-chiswick' },
  { patterns: ['Rugby Portobello Trust', 'RPT'], subclubSlug: 'rpt' },
  { patterns: ['Storm Elite'], subclubSlug: 'storm-elite' },
  { patterns: ['The A Academy', 'The A academy', 'TAA'], subclubSlug: 'taa' },
]

/** Strip the prefixes Veo titles often start with so the " vs " split is
 *  clean. Date prefixes ("10/05", "Match 10 May 2026 - ") get removed. */
function stripPrefix(title: string): string {
  return title
    .replace(/^\s*Match\s+\d{1,2}\s+\w+\s+\d{4}\s*[-:–]\s*/i, '')
    .replace(/^\s*\d{1,2}\/\d{1,2}\s*[-:–]?\s*/, '')
}

/** Strip parenthetical kit colours / age qualifiers from a team mention.
 *  "Roehampton Elite (Green)" → "Roehampton Elite"
 *  "LFS (baby blue)" → "LFS"
 *  Also normalises smart-quote and trailing apostrophe-s plurals like
 *  "Eagles (U10's)". */
function cleanTeamSide(side: string): string {
  return side
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/U\s*\d+\s*['’]?s?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function findSubclub(side: string): string | null {
  const lower = side.toLowerCase()
  // Prefer longest patterns so "The A Academy" wins over "TAA".
  const flat = TEAM_LOOKUP.flatMap((row) =>
    row.patterns.map((p) => ({ pattern: p, slug: row.subclubSlug }))
  ).sort((a, b) => b.pattern.length - a.pattern.length)
  for (const { pattern, slug } of flat) {
    if (lower.includes(pattern.toLowerCase())) return slug
  }
  return null
}

/** Pull the FIRST age group (U\d+) out of an arbitrary chunk of text.
 *  Returns 'u7'…'u18' or null. Sanity-bounds to 5..21 to avoid grabbing
 *  random "U2" / "U99" matches from typos. */
function findAgeIn(text: string): string | null {
  const normalised = text.replace(/[‘’]/g, "'")
  const m = normalised.match(/\bU\s*(\d{1,2})\b/i)
  if (!m) return null
  const n = parseInt(m[1], 10)
  if (n < 5 || n > 21) return null
  return `u${n}`
}

interface ParsedSide {
  rawSide: string
  subclubSlug: string
  ageGroup: string
}

interface ParsedRecording {
  slug: string
  title: string
  duration: number
  match_date: string | null
  raw: { home?: string; away?: string }
  // Per-side age means "Roehampton (U10) vs ELA (U11)" assigns the
  // recording to roehampton-elite-u10 AND ela-u11 (each team's own
  // age-group folder) rather than incorrectly forcing both to one age.
  home: ParsedSide | null
  away: ParsedSide | null
  status:
    | 'eligible'         // both teams + age resolved → can assign
    | 'partial_resolve'  // only one team resolved
    | 'no_age'           // teams ok but age missing
    | 'unparseable'      // can't even split on vs
    | 'too_long'         // >60min, skip
}

function parseRecording(r: {
  slug: string
  title: string
  duration: number
  match_date?: string
  home_team?: string | null
  away_team?: string | null
}): ParsedRecording {
  const base: Omit<ParsedRecording, 'status' | 'home' | 'away'> = {
    slug: r.slug,
    title: r.title || '',
    duration: r.duration,
    match_date: r.match_date ?? null,
    raw: {},
  }

  if (r.duration > LONG_RECORDING_SECONDS) {
    return { ...base, home: null, away: null, status: 'too_long' }
  }

  const cleaned = stripPrefix(base.title)
  // Split tolerantly: " vs ", " VS ", " v ", and the period variants
  // "vs." / "v." that some LYL admins type out of habit.
  const parts = cleaned.split(/\s+vs?\.?\s+/i)
  if (parts.length !== 2) {
    return { ...base, home: null, away: null, status: 'unparseable' }
  }
  const [homeRaw, awayRaw] = parts
  const homeSide = cleanTeamSide(homeRaw)
  const awaySide = cleanTeamSide(awayRaw)
  base.raw = { home: homeSide, away: awaySide }

  const homeSlug = findSubclub(homeSide)
  const awaySlug = findSubclub(awaySide)

  // Per-side age extraction. Search the side's RAW text (which still has
  // its kit-colour parens and trailing "(U10)" qualifiers) for an age.
  // If a side has no explicit age, fall back to (a) the other side's age
  // (most matches are same-age, the qualifier just appears on one side)
  // or (b) the title-overall age (handles "NSFC vs National Harrow - U7"
  // where neither side has parens).
  const homeAgeExplicit = findAgeIn(homeRaw)
  const awayAgeExplicit = findAgeIn(awayRaw)
  // Title-overall age: scan the WHOLE title; only used when neither side
  // resolves on its own. Same regex bounds as findAgeIn.
  const titleAge = findAgeIn(base.title)

  const homeAge = homeAgeExplicit ?? awayAgeExplicit ?? titleAge
  const awayAge = awayAgeExplicit ?? homeAgeExplicit ?? titleAge

  const home: ParsedSide | null =
    homeSlug && homeAge
      ? { rawSide: homeSide, subclubSlug: homeSlug, ageGroup: homeAge }
      : null
  const away: ParsedSide | null =
    awaySlug && awayAge
      ? { rawSide: awaySide, subclubSlug: awaySlug, ageGroup: awayAge }
      : null

  // Classification:
  // - both sides resolved (slug + age) → eligible
  // - both slugs missing → unparseable
  // - any slug missing OR any age missing → partial_resolve OR no_age
  const noAge = (homeSlug && !homeAge) || (awaySlug && !awayAge)
  let status: ParsedRecording['status']
  if (home && away) status = 'eligible'
  else if (!homeSlug && !awaySlug) status = 'unparseable'
  else if (noAge && !homeAge && !awayAge && !titleAge) status = 'no_age'
  else status = 'partial_resolve'

  return { ...base, home, away, status }
}

async function main() {
  const { listRecordings } = await import('../src/lib/veo/client')
  const result = await listRecordings(TARGET_CLUB)
  if (!result.success) {
    console.error(`✗ listRecordings failed: ${result.message}`)
    process.exit(1)
  }
  const all = result.data?.recordings ?? []

  // Skip share-accepted copies created by a previous execute pass. Those
  // copies have slugs prefixed with the source club slug (e.g.
  // `london-youth-league-20260510-...`) because Veo prepends the
  // originating club when minting the accepted-side slug. Without this
  // filter, the planner re-plans them as fresh assignments and a naive
  // --apply would reassign them away from their intended away team.
  const beforeFilter = all.length
  const filtered = all.filter((r) => !r.slug.startsWith(`${TARGET_CLUB}-`))
  const skipped = beforeFilter - filtered.length
  console.log(
    `Loaded ${beforeFilter} recordings from ${TARGET_CLUB} (${skipped} share-accepted copies skipped).\n`
  )

  const parsed: ParsedRecording[] = filtered.map(parseRecording)

  const byStatus = {
    eligible: parsed.filter((p) => p.status === 'eligible'),
    no_age: parsed.filter((p) => p.status === 'no_age'),
    partial_resolve: parsed.filter((p) => p.status === 'partial_resolve'),
    unparseable: parsed.filter((p) => p.status === 'unparseable'),
    too_long: parsed.filter((p) => p.status === 'too_long'),
  }

  // Aggregate the set of (subclub, age-group) team pairs we'd need to
  // create in Veo. Per-side ages mean a mixed-age fixture like U10 vs U11
  // contributes BOTH teams (not just one age) — matches user instruction:
  // each team's age-group folder gets the recording.
  const teamsToCreate = new Set<string>()
  for (const p of byStatus.eligible) {
    teamsToCreate.add(`${p.home!.subclubSlug}-${p.home!.ageGroup}`)
    teamsToCreate.add(`${p.away!.subclubSlug}-${p.away!.ageGroup}`)
  }

  console.log(`▶ Eligible (will be assigned to BOTH teams): ${byStatus.eligible.length}`)
  for (const p of byStatus.eligible) {
    const a = `${p.home!.subclubSlug}-${p.home!.ageGroup}`
    const b = `${p.away!.subclubSlug}-${p.away!.ageGroup}`
    console.log(`  ${(p.match_date ?? '').slice(0, 10).padEnd(10)} → ${a.padEnd(28)} + ${b.padEnd(28)}  "${p.title.slice(0, 60)}"`)
  }

  console.log(`\n▶ Partial resolve (one team matched, one didn't — needs lookup-table tweak): ${byStatus.partial_resolve.length}`)
  for (const p of byStatus.partial_resolve) {
    const h = p.home ? p.home.subclubSlug : `?? "${p.raw.home}"`
    const a = p.away ? p.away.subclubSlug : `?? "${p.raw.away}"`
    console.log(`  ${(p.match_date ?? '').slice(0, 10).padEnd(10)}  home=${h.padEnd(20)} away=${a.padEnd(20)}  "${p.title.slice(0, 60)}"`)
  }

  console.log(`\n▶ No age group parseable (will skip): ${byStatus.no_age.length}`)
  for (const p of byStatus.no_age) {
    console.log(`  ${(p.match_date ?? '').slice(0, 10).padEnd(10)}  "${p.title}"`)
  }

  console.log(`\n▶ Unparseable (no " vs " split — will skip): ${byStatus.unparseable.length}`)
  for (const p of byStatus.unparseable) {
    console.log(`  ${(p.match_date ?? '').slice(0, 10).padEnd(10)}  "${p.title}"`)
  }

  console.log(`\n▶ Too long (>60min — skipped per user instruction): ${byStatus.too_long.length}`)
  for (const p of byStatus.too_long) {
    console.log(`  ${(p.match_date ?? '').slice(0, 10).padEnd(10)}  ${Math.round(p.duration / 60)}m  "${p.title}"`)
  }

  console.log(`\n▶ Teams that need to be created in Veo (${teamsToCreate.size}):`)
  for (const t of [...teamsToCreate].sort()) console.log(`  - ${t}`)

  // Persist a machine-readable plan that the Stage-3 executor will consume.
  const plan = {
    generated_at: new Date().toISOString(),
    target_club: TARGET_CLUB,
    summary: {
      total: parsed.length,
      eligible: byStatus.eligible.length,
      partial_resolve: byStatus.partial_resolve.length,
      no_age: byStatus.no_age.length,
      unparseable: byStatus.unparseable.length,
      too_long: byStatus.too_long.length,
      teams_to_create: teamsToCreate.size,
    },
    teams_to_create: [...teamsToCreate].sort(),
    assignments: byStatus.eligible.map((p) => ({
      recording_slug: p.slug,
      title: p.title,
      match_date: p.match_date,
      home_team_slug: `${p.home!.subclubSlug}-${p.home!.ageGroup}`,
      away_team_slug: `${p.away!.subclubSlug}-${p.away!.ageGroup}`,
    })),
    skipped: {
      partial_resolve: byStatus.partial_resolve.map((p) => ({
        slug: p.slug,
        title: p.title,
        raw_home: p.raw.home,
        raw_away: p.raw.away,
        matched_home: p.home?.subclubSlug ?? null,
        matched_away: p.away?.subclubSlug ?? null,
      })),
      no_age: byStatus.no_age.map((p) => ({ slug: p.slug, title: p.title })),
      unparseable: byStatus.unparseable.map((p) => ({ slug: p.slug, title: p.title })),
      too_long: byStatus.too_long.map((p) => ({ slug: p.slug, title: p.title, duration: p.duration })),
    },
  }
  writeFileSync(PLAN_OUTPUT, JSON.stringify(plan, null, 2))
  console.log(`\n✓ Plan written to ${PLAN_OUTPUT}`)
}

main().catch((err) => {
  console.error('Unhandled:', err)
  process.exit(1)
})
