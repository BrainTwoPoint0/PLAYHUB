import { readFileSync } from 'node:fs'
import { join } from 'node:path'
for (const l of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(
  '\n'
)) {
  const t = l.trim()
  if (!t || t.startsWith('#')) continue
  const eq = t.indexOf('=')
  if (eq < 0) continue
  const k = t.slice(0, eq).trim()
  let v = t.slice(eq + 1).trim()
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  )
    v = v.slice(1, -1)
  if (!(k in process.env)) process.env[k] = v
}
;(async () => {
  const veo = await import('../src/lib/veo/client')
  const tr = await veo.listClubsAndTeams()
  const lyl = tr.data!.clubs.find((c) => c.slug === 'london-youth-league')!
  // Build slug-by-id from teams listing
  const teamSlugById = new Map(lyl.teams.map((t) => [t.id, t.slug]))
  // Also print all team slugs we have
  console.log(
    `Team slugs in listClubsAndTeams output (${lyl.teams.length} teams):`
  )
  for (const t of lyl.teams)
    console.log(
      `  id=${t.id.slice(0, 8)} slug=${t.slug.padEnd(35)} name="${t.name}"`
    )
  // Get recordings + count by team UUID
  const rr = await veo.listRecordings('london-youth-league')
  const recs = rr.data!.recordings
  const countByTeam = new Map<string, number>()
  for (const r of recs) {
    if (!r.team) {
      countByTeam.set('(no team)', (countByTeam.get('(no team)') ?? 0) + 1)
      continue
    }
    countByTeam.set(r.team, (countByTeam.get(r.team) ?? 0) + 1)
  }
  console.log(
    `\nRecording counts by team UUID (resolved through teamSlugById):`
  )
  for (const [uuid, count] of [...countByTeam.entries()].sort(
    (a, b) => b[1] - a[1]
  )) {
    const slug =
      uuid === '(no team)'
        ? uuid
        : (teamSlugById.get(uuid) ?? `??UNKNOWN:${uuid.slice(0, 12)}`)
    console.log(`  ${count.toString().padStart(3)} → ${slug}`)
  }
  const { shutdownVeoSession } = await import('../src/lib/veo/auth')
  await shutdownVeoSession()
})()
