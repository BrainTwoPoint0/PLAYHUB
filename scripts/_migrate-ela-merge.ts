/**
 * ONE-OFF migration (2026-05-17): merge `elite-london-academy` subclub
 * → `ela` subclub. Underscore-prefixed = not part of the cron rotation.
 *
 * Discovered state (probe ran before this):
 *   - DB has both `ela` (correct, has logo) and `elite-london-academy` (no logo)
 *   - Veo has 4 ELA-related teams: ela-u11, ela-u8 (correct), elite-london-academy-u7, elite-london-academy-u8 (duplicates)
 *   - elite-london-academy-u7: 1 recording. elite-london-academy-u8: 1 recording.
 *   - playhub_recording_assignments: 0 rows reference elite-london-academy (cron hasn't run yet)
 *
 * Migration steps (in order so each can be re-run safely):
 *   1. List recordings under each elite-london-academy-* Veo team.
 *   2. Create `ela-u7` in Veo if missing (ela-u8 already exists).
 *   3. PATCH each recording's `team` field from elite-london-academy-* → ela-*.
 *   4. Delete the two elite-london-academy-* Veo teams.
 *   5. Upload ELA logo to ela-u7 (newly created).
 *   6. Delete `elite-london-academy` from playhub_academy_subclubs.
 *
 * Parser code already updated in orchestrator.ts to treat "Elite London
 * Academy" as an alias of subclub `ela`, so future cron runs won't recreate.
 *
 * Usage:
 *   Dry-run:  npx tsx scripts/_migrate-ela-merge.ts
 *   Apply:    npx tsx scripts/_migrate-ela-merge.ts --apply
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import {
  listClubsAndTeams,
  listRecordings,
  createTeam,
  assignRecordingToTeam,
  deleteTeam,
  uploadTeamCrest,
} from '../src/lib/veo/client'
import { shutdownVeoSession } from '../src/lib/veo/auth'

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
    )
      value = value.slice(1, -1)
    if (!(key in process.env)) process.env[key] = value
  }
}
loadEnvFile(join(__dirname, '..', '.env'))
loadEnvFile(join(__dirname, '..', '.env.local'))

const APPLY = process.argv.includes('--apply')
const VEO_CLUB_SLUG = 'london-youth-league'
const LEAGUE_CLUB_SLUG = 'lyl'
const ELA_LOGO_URL =
  'https://zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/graphic-packages/lyl/lyl-ela.png'

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // === Step 1: read current Veo state ===
  console.log('Reading Veo state…')
  const allClubs = await listClubsAndTeams()
  if (!allClubs.success) {
    console.error(`Failed to list clubs: ${allClubs.message}`)
    process.exit(1)
  }
  const lylClub = allClubs.data!.clubs.find((c) => c.slug === VEO_CLUB_SLUG)
  if (!lylClub) {
    console.error(`Veo club "${VEO_CLUB_SLUG}" not found`)
    process.exit(1)
  }
  const teams = lylClub.teams as Array<{
    slug: string
    id: string
    name: string
  }>
  const elaU7 = teams.find((t) => t.slug === 'ela-u7')
  const elaU8 = teams.find((t) => t.slug === 'ela-u8')
  const dupU7 = teams.find((t) => t.slug === 'elite-london-academy-u7')
  const dupU8 = teams.find((t) => t.slug === 'elite-london-academy-u8')

  if (!dupU7 && !dupU8) {
    console.log(
      'No elite-london-academy-* teams found in Veo. Already migrated?'
    )
  }
  if (!elaU8) {
    console.error('ela-u8 not found in Veo — unexpected; aborting.')
    process.exit(1)
  }

  console.log(
    `  ela-u7: ${elaU7 ? `${elaU7.id} (exists)` : '(missing — will create)'}`
  )
  console.log(`  ela-u8: ${elaU8.id}`)
  console.log(`  elite-london-academy-u7: ${dupU7?.id ?? '(missing)'}`)
  console.log(`  elite-london-academy-u8: ${dupU8?.id ?? '(missing)'}`)

  // === Step 2: list recordings to migrate ===
  console.log(
    '\nListing all LYL recordings to find ones under elite-london-academy-*…'
  )
  const recsRes = await listRecordings(VEO_CLUB_SLUG)
  if (!recsRes.success) {
    console.error(`Failed to list recordings: ${recsRes.message}`)
    process.exit(1)
  }
  const allRecs = recsRes.data!.recordings as Array<{
    slug: string
    uuid?: string
    title: string
    team?: string | null // team NAME not UUID
  }>
  // r.team returns team NAME — match against the display names of dup teams.
  const dupU7Name = dupU7?.name
  const dupU8Name = dupU8?.name
  const toMoveU7 = allRecs.filter((r) => dupU7Name && r.team === dupU7Name)
  const toMoveU8 = allRecs.filter((r) => dupU8Name && r.team === dupU8Name)
  console.log(
    `  ${toMoveU7.length} recordings to move from elite-london-academy-u7 → ela-u7`
  )
  console.log(
    `  ${toMoveU8.length} recordings to move from elite-london-academy-u8 → ela-u8`
  )
  for (const r of [...toMoveU7, ...toMoveU8]) {
    console.log(`    ${r.slug.padEnd(45)} "${r.title}"`)
  }

  // === Step 3: subclub DB delete check ===
  const { data: subRow } = await supabase
    .from('playhub_academy_subclubs')
    .select('id, subclub_slug')
    .eq('club_slug', LEAGUE_CLUB_SLUG)
    .eq('subclub_slug', 'elite-london-academy')
    .maybeSingle()

  // === Plan summary ===
  console.log('\n=== MIGRATION PLAN ===')
  if (!elaU7) console.log('  1. CREATE Veo team "ela-u7" (name "ELA U7")')
  if (toMoveU7.length)
    console.log(`  2. PATCH ${toMoveU7.length} recordings: team → ela-u7`)
  if (toMoveU8.length)
    console.log(`  3. PATCH ${toMoveU8.length} recordings: team → ela-u8`)
  if (dupU7)
    console.log(`  4. DELETE Veo team elite-london-academy-u7 (${dupU7.id})`)
  if (dupU8)
    console.log(`  5. DELETE Veo team elite-london-academy-u8 (${dupU8.id})`)
  if (!elaU7) console.log('  6. UPLOAD ELA logo to ela-u7 (after creation)')
  if (subRow)
    console.log(
      `  7. DELETE playhub_academy_subclubs row for elite-london-academy (id=${subRow.id})`
    )
  console.log('')

  if (!APPLY) {
    console.log('Dry-run. Pass --apply to execute.')
    await shutdownVeoSession()
    return
  }

  // === EXECUTE ===
  let newElaU7Id: string | undefined = elaU7?.id

  // Step 1: create ela-u7 if missing
  if (!elaU7) {
    console.log('Creating Veo team "ela-u7"…')
    const createRes = await createTeam({
      clubSlug: VEO_CLUB_SLUG,
      name: 'ELA U7',
      ageGroup: 'U7',
      gender: 'male',
      shortName: 'ELA',
    })
    if (!createRes.success) {
      console.error(`✗ ${createRes.message}`)
      await shutdownVeoSession()
      process.exit(1)
    }
    newElaU7Id = createRes.data!.team.id
    console.log(`✓ Created ela-u7 (id=${newElaU7Id})`)
  }

  // Step 2/3: move recordings. Veo recording uuid is NOT in the basic
  // listRecordings response — we need to fetch each one to resolve uuid
  // from slug. The orchestrator already has this pattern via session.api,
  // but for a 2-record migration the simpler approach is: PATCH using
  // the existing assignRecordingToTeam helper which takes a UUID.
  // Sniff the uuid from listRecordings response if present, else fetch
  // detail.
  const moves: Array<{
    rec: (typeof allRecs)[0]
    targetTeamId: string
    targetTeamName: string
  }> = [
    ...toMoveU7.map((rec) => ({
      rec,
      targetTeamId: newElaU7Id!,
      targetTeamName: 'ela-u7',
    })),
    ...toMoveU8.map((rec) => ({
      rec,
      targetTeamId: elaU8.id,
      targetTeamName: 'ela-u8',
    })),
  ]
  for (const m of moves) {
    const uuid = m.rec.uuid
    if (!uuid) {
      console.error(
        `✗ ${m.rec.slug}: missing uuid in listRecordings response, skipping`
      )
      continue
    }
    process.stdout.write(
      `  PATCH ${m.rec.slug.padEnd(45)} → ${m.targetTeamName}: `
    )
    const assignRes = await assignRecordingToTeam(uuid, m.targetTeamId)
    if (assignRes.success) console.log('✓')
    else console.log(`✗ ${assignRes.message}`)
  }

  // Step 4/5: delete duplicate teams (only after recordings are moved)
  if (dupU7) {
    process.stdout.write(`Deleting Veo team elite-london-academy-u7: `)
    const delRes = await deleteTeam(VEO_CLUB_SLUG, 'elite-london-academy-u7')
    console.log(delRes.success ? '✓' : `✗ ${delRes.message}`)
  }
  if (dupU8) {
    process.stdout.write(`Deleting Veo team elite-london-academy-u8: `)
    const delRes = await deleteTeam(VEO_CLUB_SLUG, 'elite-london-academy-u8')
    console.log(delRes.success ? '✓' : `✗ ${delRes.message}`)
  }

  // Step 6: upload ELA logo to newly-created ela-u7
  if (!elaU7 && newElaU7Id) {
    process.stdout.write('Uploading ELA logo to ela-u7: ')
    const imgResp = await fetch(ELA_LOGO_URL)
    if (!imgResp.ok) {
      console.log(`✗ logo fetch failed (${imgResp.status})`)
    } else {
      const imgBytes = Buffer.from(await imgResp.arrayBuffer())
      const mimeType =
        imgResp.headers.get('content-type')?.split(';')[0]?.trim() ||
        'image/png'
      const upRes = await uploadTeamCrest({
        clubSlug: VEO_CLUB_SLUG,
        teamSlug: 'ela-u7',
        imageBytes: imgBytes,
        mimeType,
        filename: 'ela.png',
      })
      console.log(
        upRes.success ? `✓ ${upRes.data?.crestUrl}` : `✗ ${upRes.message}`
      )
    }
  }

  // Step 7: delete the duplicate subclub row
  if (subRow) {
    process.stdout.write(`Deleting subclub elite-london-academy from DB: `)
    const { error } = await supabase
      .from('playhub_academy_subclubs')
      .delete()
      .eq('id', subRow.id)
    console.log(error ? `✗ ${error.message}` : '✓')
  }

  console.log('\n=== DONE ===')
  await shutdownVeoSession()
}

main().catch(async (e) => {
  console.error('Unhandled:', e)
  try {
    await shutdownVeoSession()
  } catch {}
  process.exit(1)
})
