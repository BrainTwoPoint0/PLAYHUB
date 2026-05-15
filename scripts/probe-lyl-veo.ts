/**
 * One-shot probe: confirm the LYL Veo club ('london-youth-league') is
 * reachable via the existing Veo client + dump the team list so we can
 * seed playhub_academy_teams with the right (subclub_slug, veo_team_slug)
 * mappings for the E.2 pilot.
 *
 * Usage:
 *   cd PLAYHUB && npx tsx scripts/probe-lyl-veo.ts
 *
 * Env required (loaded from .env):
 *   VEO_EMAIL, VEO_PASSWORD (Playwright auth)
 *
 * NOTE: Uses Playwright headless browser for auth (per the Veo client).
 * Locally that's fine — chromium is installed via the playwright npm pkg.
 * NEVER run this from PLAYHUB Netlify (no Playwright binary there).
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

const TARGET_SLUG = 'london-youth-league'

async function main() {
  // Lazy import — the Veo client touches Playwright on import in some
  // paths; loading after env is set keeps the auth side-effects deterministic.
  const { listClubsAndTeams } = await import('../src/lib/veo/client')

  console.log(`Probing Veo for club slug "${TARGET_SLUG}"…\n`)
  const result = await listClubsAndTeams()

  if (!result.success) {
    console.error(`✗ listClubsAndTeams failed: ${result.message}`)
    process.exit(1)
  }

  const all = result.data?.clubs ?? []
  console.log(`Veo returned ${all.length} clubs total.\n`)

  const lyl = all.find((c) => c.slug === TARGET_SLUG)
  if (!lyl) {
    console.error(
      `✗ "${TARGET_SLUG}" is NOT in the authenticated user's "own" clubs list.`
    )
    console.log('\nAvailable own-clubs:')
    for (const c of all) {
      console.log(`  - ${c.slug.padEnd(40)} (${c.name})`)
    }
    process.exit(1)
  }

  console.log(`✓ Reachable: ${lyl.name} (slug=${lyl.slug})`)
  console.log(`  Team count reported by Veo: ${lyl.team_count}`)
  console.log(`  is_club_admin: ${lyl.is_club_admin}`)
  console.log(`  Teams returned: ${lyl.teams.length}\n`)

  if (lyl.teams.length === 0) {
    console.log('(No teams in this Veo club yet.)')
    return
  }

  console.log('--- Veo teams (paste into LYL seed once subclub mapping is decided) ---\n')
  for (const t of lyl.teams) {
    console.log(`  ${t.slug.padEnd(50)} ${t.name}  [members: ${t.member_count}]`)
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err)
  process.exit(1)
})
