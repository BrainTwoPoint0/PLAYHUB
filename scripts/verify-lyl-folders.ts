/**
 * Read-only verifier: prints the current Veo team-folder breakdown for
 * LYL and flags any share-copy that doesn't match its expected
 * away_team_uuid in playhub_recording_assignments.
 *
 * Use after fix-lyl-misplaced-shares.ts --apply to confirm Veo accepted
 * every move. Does NOT write to Veo or Supabase.
 *
 *   cd PLAYHUB && npx tsx scripts/verify-lyl-folders.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

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

const LEAGUE_CLUB_SLUG = 'lyl'
const VEO_CLUB_SLUG = 'london-youth-league'

async function main(): Promise<void> {
  const { listRecordings, listClubsAndTeams } = await import('../src/lib/veo/client')
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  console.log(`=== LYL folder verification (live Veo, read-only) ===\n`)

  const [listRes, teamsRes, assignmentsRes] = await Promise.all([
    listRecordings(VEO_CLUB_SLUG),
    listClubsAndTeams(),
    supabase
      .from('playhub_recording_assignments')
      .select('recording_slug, recording_title, home_team_uuid, away_team_uuid, away_accepted_recording_uuid, status')
      .eq('league_club_slug', LEAGUE_CLUB_SLUG)
      .eq('status', 'fully_assigned')
      .not('away_accepted_recording_uuid', 'is', null),
  ])

  if (!listRes.success || !listRes.data) throw new Error(`listRecordings: ${listRes.message}`)
  if (!teamsRes.success || !teamsRes.data) throw new Error(`listClubsAndTeams: ${teamsRes.message}`)
  if (assignmentsRes.error) throw new Error(`assignments: ${assignmentsRes.error.message}`)

  const recordings = listRes.data.recordings
  const assignments = assignmentsRes.data ?? []
  const teamNameByUuid = new Map<string, string>()
  for (const club of teamsRes.data.clubs) {
    if (club.slug !== VEO_CLUB_SLUG) continue
    for (const t of club.teams) teamNameByUuid.set(t.id, t.name)
  }

  // Group recordings by team.
  const byTeam = new Map<string, Array<{ slug: string; isShare: boolean }>>()
  for (const r of recordings) {
    const team = r.team ?? '<unassigned>'
    if (!byTeam.has(team)) byTeam.set(team, [])
    const isShare = r.slug.startsWith(`${VEO_CLUB_SLUG}-`)
    byTeam.get(team)!.push({ slug: r.slug, isShare })
  }

  // Per-team summary.
  const teamNames = [...byTeam.keys()].sort()
  console.log(`Total recordings: ${recordings.length}\n`)
  for (const team of teamNames) {
    const items = byTeam.get(team)!
    const originals = items.filter((i) => !i.isShare).length
    const shares = items.filter((i) => i.isShare).length
    console.log(`  ${team.padEnd(28)} ${String(items.length).padStart(3)} total  (${originals} orig + ${shares} share)`)
  }

  // Mismatch detection: for every fully_assigned row, does the share-copy
  // sit in the team we asked for?
  console.log(`\n--- Share-copy placement audit (${assignments.length} fully_assigned rows) ---\n`)
  const recordingBySlug = new Map(recordings.map((r) => [r.slug, r]))
  const mismatches: string[] = []
  for (const a of assignments) {
    const shareSlug = a.away_accepted_recording_uuid as string
    const r = recordingBySlug.get(shareSlug)
    if (!r) {
      mismatches.push(`MISSING: ${shareSlug} (assignment exists but no recording in Veo)`)
      continue
    }
    const expectedName = teamNameByUuid.get(a.away_team_uuid as string)
    if (!expectedName) {
      mismatches.push(`UNKNOWN TEAM: ${shareSlug} → away_team_uuid=${a.away_team_uuid} not in Veo team list`)
      continue
    }
    if (r.team !== expectedName) {
      mismatches.push(`MISPLACED: ${a.recording_title}\n           slug=${shareSlug}\n           current="${r.team ?? '<none>'}" expected="${expectedName}"`)
    }
  }

  if (mismatches.length === 0) {
    console.log(`  ✓ ALL ${assignments.length} share-copies are in the correct away-team folder.\n`)
  } else {
    console.log(`  ✗ ${mismatches.length} mismatch(es):\n`)
    for (const m of mismatches) console.log(`    ${m}`)
  }
}

main()
  .catch((err) => {
    console.error('Unhandled:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    const { shutdownVeoSession } = await import('../src/lib/veo/auth')
    await shutdownVeoSession().catch(() => {})
  })
