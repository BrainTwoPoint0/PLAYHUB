/**
 * One-shot: unassign the two LYL recordings that are still labelled
 * `capture-test-team` on Veo. The team was deleted during the initial
 * API reverse-engineering work but the recording metadata retained the
 * dead team name as a string, so Veo's `listClubRecordings` still
 * reports `team: "capture-test-team"` for them. Setting team=null moves
 * them into Veo's "uncategorised" bucket — visible under "All recordings"
 * but no longer pretending to belong to a deleted team.
 *
 * Dry-run by default. Pass --apply to write.
 *
 *   cd PLAYHUB && npx tsx scripts/unassign-capture-test-orphans.ts
 *   cd PLAYHUB && npx tsx scripts/unassign-capture-test-orphans.ts --apply
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

const APPLY = process.argv.includes('--apply')
const VEO_CLUB_SLUG = 'london-youth-league'
const GHOST_TEAM_NAME = 'capture-test-team'

async function main(): Promise<void> {
  const { listRecordings, getMatchDetails, assignRecordingToTeam } =
    await import('../src/lib/veo/client')

  console.log(
    `=== Unassign capture-test orphans (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`
  )

  const listRes = await listRecordings(VEO_CLUB_SLUG)
  if (!listRes.success || !listRes.data)
    throw new Error(`listRecordings: ${listRes.message}`)

  const orphans = listRes.data.recordings.filter(
    (r) => r.team === GHOST_TEAM_NAME
  )
  if (orphans.length === 0) {
    console.log('No orphans found. Done.')
    return
  }

  console.log(`${orphans.length} orphan(s) labelled "${GHOST_TEAM_NAME}":\n`)
  for (const o of orphans) {
    console.log(`  [${APPLY ? 'UNASSIGN' : 'plan    '}] ${o.slug}`)
    console.log(`              title="${o.title}"`)
  }

  if (!APPLY) {
    console.log('\nDry-run only — pass --apply to execute.')
    return
  }

  console.log('\n=== Executing ===')
  for (const o of orphans) {
    const detailsRes = await getMatchDetails(o.slug)
    if (!detailsRes.success || !detailsRes.data) {
      console.error(
        `  ✗ ${o.slug}: getMatchDetails failed: ${detailsRes.message}`
      )
      continue
    }
    const uuid = (detailsRes.data as { id?: string }).id
    if (!uuid) {
      console.error(`  ✗ ${o.slug}: no id field in details response`)
      continue
    }
    const r = await assignRecordingToTeam(uuid, null)
    if (!r.success) {
      console.error(`  ✗ ${o.slug}: ${r.message}`)
      continue
    }
    console.log(`  ✓ ${o.title} → <unassigned>`)
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
