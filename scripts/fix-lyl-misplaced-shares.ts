/**
 * One-shot cleanup: re-assign LYL share-copies that Veo placed in the
 * wrong team folder.
 *
 * Background: Veo's `acceptShareInvitation` accepts a `teamUUID` param but
 * empirically (2026-05-18) doesn't always honour it — many LYL share-copies
 * landed in the HOME team's folder instead of the requested AWAY team's,
 * so the LYL Library was showing two near-identical rows per match.
 *
 * The orchestrator now does a belt-and-braces `assignRecordingToTeam` after
 * every accept, but the existing data is already misplaced. This script
 * walks every `fully_assigned` row in playhub_recording_assignments,
 * checks the share-copy's CURRENT Veo team, and re-PATCHes it to the
 * intended `away_team_uuid` if they don't match.
 *
 * Defaults to dry-run. Pass `--apply` to actually write to Veo.
 *
 *   cd PLAYHUB && npx tsx scripts/fix-lyl-misplaced-shares.ts
 *   cd PLAYHUB && npx tsx scripts/fix-lyl-misplaced-shares.ts --apply
 *
 * Env: VEO_EMAIL, VEO_PASSWORD, NEXT_PUBLIC_SUPABASE_URL,
 *      SUPABASE_SERVICE_ROLE_KEY (auto-loaded from PLAYHUB/.env)
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

const APPLY = process.argv.includes('--apply')
const LEAGUE_CLUB_SLUG = 'lyl'
const VEO_CLUB_SLUG = 'london-youth-league'

async function main(): Promise<void> {
  // Dynamic imports so the env loader runs before module-init reads env.
  const { listRecordings, listClubsAndTeams, getMatchDetails, assignRecordingToTeam } = await import('../src/lib/veo/client')

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required')
  }
  const supabase = createClient(supabaseUrl, supabaseKey)

  console.log(`=== LYL misplaced-share cleanup (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`)

  // 1. Load all fully_assigned rows for LYL.
  const { data: assignments, error } = await supabase
    .from('playhub_recording_assignments')
    .select('recording_slug, recording_title, home_team_slug, home_team_uuid, away_team_slug, away_team_uuid, away_accepted_recording_uuid')
    .eq('league_club_slug', LEAGUE_CLUB_SLUG)
    .eq('status', 'fully_assigned')
    .not('away_accepted_recording_uuid', 'is', null)

  if (error) throw new Error(`Failed to load assignments: ${error.message}`)
  if (!assignments || assignments.length === 0) {
    console.log('No fully_assigned rows to check. Done.')
    return
  }
  console.log(`Loaded ${assignments.length} fully_assigned rows.\n`)

  // 2. Snapshot Veo's current recording list once. Cheaper than per-row
  //    getMatchDetails for the whole batch.
  console.log('Fetching current Veo recording list...')
  const listRes = await listRecordings(VEO_CLUB_SLUG)
  if (!listRes.success || !listRes.data) {
    throw new Error(`listRecordings failed: ${listRes.message}`)
  }
  const recordingBySlug = new Map<string, { slug: string; team: string | null }>()
  for (const r of listRes.data.recordings) {
    recordingBySlug.set(r.slug, { slug: r.slug, team: r.team ?? null })
  }
  console.log(`Found ${listRes.data.recordings.length} recordings in Veo.\n`)

  // 3. Resolve away_team_uuid → expected team NAME (Veo's listRecordings
  //    reports the team as a NAME, not UUID, so we need to map both sides
  //    to compare).
  const teamsRes = await listClubsAndTeams()
  if (!teamsRes.success || !teamsRes.data) {
    throw new Error(`listClubsAndTeams failed: ${teamsRes.message}`)
  }
  const teamNameByUuid = new Map<string, string>()
  for (const club of teamsRes.data.clubs) {
    if (club.slug !== VEO_CLUB_SLUG) continue
    for (const t of club.teams) teamNameByUuid.set(t.id, t.name)
  }

  // 4. For each row, compare current vs expected, queue the diff.
  type Action = {
    title: string
    shareSlug: string
    currentTeam: string | null
    expectedTeamUuid: string
    expectedTeamName: string
  }
  const actions: Action[] = []
  const notFound: string[] = []

  for (const a of assignments) {
    const shareSlug = a.away_accepted_recording_uuid as string
    const expectedTeamName = teamNameByUuid.get(a.away_team_uuid as string)
    if (!expectedTeamName) {
      console.warn(`  [warn ] ${shareSlug.slice(0, 64)} away_team_uuid ${a.away_team_uuid} not in Veo team list — skip`)
      continue
    }
    const current = recordingBySlug.get(shareSlug)
    if (!current) {
      notFound.push(shareSlug)
      continue
    }
    if (current.team === expectedTeamName) continue
    actions.push({
      title: a.recording_title as string,
      shareSlug,
      currentTeam: current.team,
      expectedTeamUuid: a.away_team_uuid as string,
      expectedTeamName,
    })
  }

  if (notFound.length) {
    console.warn(`${notFound.length} share-copy slug(s) not found in Veo listing (likely deleted or stale assignment row). Sample:`)
    for (const s of notFound.slice(0, 5)) console.warn(`  ${s}`)
    console.log()
  }

  if (actions.length === 0) {
    console.log('No misplaced share-copies — nothing to do.')
    return
  }

  console.log(`${actions.length} misplaced share-copy / copies detected:\n`)
  for (const a of actions) {
    console.log(`  [${APPLY ? 'MOVE  ' : 'plan  '}] ${a.title}`)
    console.log(`           slug=${a.shareSlug}`)
    console.log(`           current="${a.currentTeam ?? '<no team>'}" → target="${a.expectedTeamName}"`)
  }
  if (!APPLY) {
    console.log('\nDry-run only — pass --apply to execute.')
    return
  }

  console.log('\n=== Executing moves ===')
  for (const a of actions) {
    // Need the share-copy's UUID to PATCH it. Veo's /api/app/matches/{slug}/
    // endpoint returns the match object at the top level (not wrapped).
    const detailsRes = await getMatchDetails(a.shareSlug)
    if (!detailsRes.success || !detailsRes.data) {
      console.error(`  ✗ ${a.shareSlug.slice(0, 64)}: getMatchDetails failed: ${detailsRes.message}`)
      continue
    }
    const uuid = (detailsRes.data as { id?: string }).id
    if (!uuid) {
      console.error(`  ✗ ${a.shareSlug.slice(0, 64)}: response has no id field`)
      continue
    }
    const r = await assignRecordingToTeam(uuid, a.expectedTeamUuid)
    if (!r.success) {
      console.error(`  ✗ ${a.shareSlug.slice(0, 64)}: ${r.message}`)
      continue
    }
    console.log(`  ✓ ${a.title} → ${a.expectedTeamName}`)
  }

  console.log('\nDone.')
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
