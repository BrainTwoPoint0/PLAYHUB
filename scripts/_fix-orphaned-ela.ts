/**
 * ONE-OFF: re-assign the 2 ELA recordings whose home-team was deleted
 * by the (partially-broken) _migrate-ela-merge.ts run on 2026-05-17.
 *
 * State after the broken run:
 *   - elite-london-academy-u7 + -u8 Veo teams DELETED ✓
 *   - 2 recordings now point at the deleted team names (orphaned):
 *       - 20260517-elite-london-academy-u7-vs-... → wants ela-u7
 *       - 20260517-elite-london-academy-u8-vs-... → wants ela-u8
 *   - ela-u7 + ela-u8 Veo teams EXIST with correct logos
 *
 * Fix: resolve each orphan's UUID via getMatchDetails(slug), then
 * assignRecordingToTeam(uuid, targetTeamId).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  listClubsAndTeams,
  getMatchDetails,
  assignRecordingToTeam,
} from '../src/lib/veo/client'
import { shutdownVeoSession } from '../src/lib/veo/auth'

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (!(key in process.env)) process.env[key] = value
  }
}
loadEnvFile(join(__dirname, '..', '.env'))
loadEnvFile(join(__dirname, '..', '.env.local'))

const VEO_CLUB_SLUG = 'london-youth-league'
const ORPHANS = [
  { slug: '20260517-elite-london-academy-u7-vs-roehampton-elite-u7-v7ed782b', targetTeamSlug: 'ela-u7' },
  { slug: '20260517-elite-london-academy-u8-vs-roehampton-elite-u8-v115e326', targetTeamSlug: 'ela-u8' },
]

async function main() {
  // Resolve ela-u7 + ela-u8 UUIDs from Veo
  const r = await listClubsAndTeams()
  if (!r.success) { console.error(r.message); process.exit(1) }
  const lyl = r.data!.clubs.find((c) => c.slug === VEO_CLUB_SLUG)
  if (!lyl) { console.error('lyl not found'); process.exit(1) }
  const teams = lyl.teams as Array<{ slug: string; id: string }>
  const targetIds = new Map(teams.map((t) => [t.slug, t.id]))

  for (const orphan of ORPHANS) {
    const targetTeamId = targetIds.get(orphan.targetTeamSlug)
    if (!targetTeamId) {
      console.error(`Target team ${orphan.targetTeamSlug} not found in Veo, skipping ${orphan.slug}`)
      continue
    }
    process.stdout.write(`Resolving ${orphan.slug} → uuid… `)
    let uuid: string
    try {
      const detail = await getMatchDetails(orphan.slug)
      if (!detail.success || !detail.data) {
        console.log(`✗ ${detail.message}`)
        continue
      }
      uuid = (detail.data as { id: string }).id
      console.log(`uuid=${uuid}`)
    } catch (e) {
      console.log(`✗ ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    process.stdout.write(`  PATCH ${orphan.slug} → ${orphan.targetTeamSlug}: `)
    const assign = await assignRecordingToTeam(uuid, targetTeamId)
    console.log(assign.success ? '✓' : `✗ ${assign.message}`)
  }

  await shutdownVeoSession()
}

main().catch(async (e) => { console.error(e); await shutdownVeoSession(); process.exit(1) })
