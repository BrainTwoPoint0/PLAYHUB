/**
 * One-shot probe: list everything in the LYL Veo clubhouse and group
 * recordings into buckets so we can plan the team-creation + assignment
 * pass. Read-only — no mutations.
 *
 * Buckets:
 *   - eligible: ≤60 min, parseable home/away teams (most matches)
 *   - long:     >60 min, likely contains multiple matches (skip per user)
 *   - missing-teams: no home_team or away_team set
 *   - other: anything that doesn't fit
 *
 * Usage:
 *   cd PLAYHUB && npx tsx scripts/probe-lyl-recordings.ts
 *
 * Env: VEO_EMAIL, VEO_PASSWORD (auto-loaded from PLAYHUB/.env)
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

const TARGET_CLUB = 'london-youth-league'
const LONG_RECORDING_SECONDS = 60 * 60 // 60 minutes

async function main() {
  const { listRecordings } = await import('../src/lib/veo/client')

  console.log(`Probing recordings in Veo club "${TARGET_CLUB}"…\n`)
  const result = await listRecordings(TARGET_CLUB)
  if (!result.success) {
    console.error(`✗ listRecordings failed: ${result.message}`)
    process.exit(1)
  }
  const all = result.data?.recordings ?? []
  console.log(`Total recordings: ${all.length}\n`)

  if (all.length === 0) {
    console.log('(No recordings in the LYL Veo clubhouse.)')
    return
  }

  // Sort newest first if match_date is present.
  all.sort((a, b) => (b.match_date ?? '').localeCompare(a.match_date ?? ''))

  const long: typeof all = []
  const missingTeams: typeof all = []
  const eligible: typeof all = []

  for (const r of all) {
    if (r.duration > LONG_RECORDING_SECONDS) {
      long.push(r)
    } else if (!r.home_team || !r.away_team) {
      missingTeams.push(r)
    } else {
      eligible.push(r)
    }
  }

  function format(r: (typeof all)[number]) {
    const dur = `${Math.round(r.duration / 60)}m`.padStart(5)
    const date = (r.match_date ?? '').slice(0, 10).padEnd(10)
    const home = (r.home_team ?? '—').slice(0, 28).padEnd(28)
    const away = (r.away_team ?? '—').slice(0, 28).padEnd(28)
    const title = (r.title ?? '(untitled)').slice(0, 50)
    return `  ${date}  ${dur}  ${home} vs ${away}   "${title}"`
  }

  console.log(`▶ Eligible (≤60min, has both teams): ${eligible.length}`)
  for (const r of eligible) console.log(format(r))

  console.log(`\n▶ Missing teams (need manual review): ${missingTeams.length}`)
  for (const r of missingTeams) console.log(format(r))

  console.log(
    `\n▶ Long recordings (>60min — skip per user instruction): ${long.length}`
  )
  for (const r of long) console.log(format(r))

  // Aggregate unique team names so we can plan which teams to create.
  const teamNames = new Set<string>()
  for (const r of eligible) {
    if (r.home_team) teamNames.add(r.home_team.trim())
    if (r.away_team) teamNames.add(r.away_team.trim())
  }

  console.log(
    `\n▶ Unique team names across eligible recordings: ${teamNames.size}`
  )
  const sortedTeams = [...teamNames].sort()
  for (const name of sortedTeams) {
    console.log(`  - ${name}`)
  }
}

main().catch((err) => {
  console.error('Unhandled:', err)
  process.exit(1)
})
