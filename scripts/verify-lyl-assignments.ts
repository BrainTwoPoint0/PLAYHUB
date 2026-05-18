import { readFileSync } from 'node:fs'
import { join } from 'node:path'
function loadEnv(p: string) {
  try {
    for (const l of readFileSync(p, 'utf8').split('\n')) {
      const t = l.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq < 0) continue
      const k = t.slice(0, eq).trim()
      let v = t.slice(eq + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (!(k in process.env)) process.env[k] = v
    }
  } catch {}
}
loadEnv(join(__dirname, '..', '.env'))
;(async () => {
  const veo = await import('../src/lib/veo/client')
  const teamsRes = await veo.listClubsAndTeams()
  if (!teamsRes.success) throw new Error(teamsRes.message)
  const lyl = teamsRes.data!.clubs.find(c => c.slug === 'london-youth-league')!
  const teamById = new Map(lyl.teams.map(t => [t.id, t]))
  console.log(`LYL has ${lyl.teams.length} teams\n`)

  const recRes = await veo.listRecordings('london-youth-league')
  if (!recRes.success) throw new Error(recRes.message)
  const recs = recRes.data!.recordings

  // Group by normalised title — collisions show "this match appears in N team folders"
  const byTitle = new Map<string, { recording_slug: string; team_slug: string }[]>()
  for (const r of recs) {
    const title = (r.title || '(untitled)').trim()
    const teamSlug = r.team ? (teamById.get(r.team)?.slug ?? `unknown:${r.team.slice(0,8)}`) : '(no team)'
    const arr = byTitle.get(title) ?? []
    arr.push({ recording_slug: r.slug, team_slug: teamSlug })
    byTitle.set(title, arr)
  }

  console.log(`${recs.length} recordings, grouped by title:\n`)
  // Sort: matches with 2+ team assignments first (the "both teams covered" case)
  const sorted = [...byTitle.entries()].sort((a, b) => b[1].length - a[1].length)
  for (const [title, items] of sorted) {
    if (items.length === 0) continue
    const teamSlugs = items.map(i => i.team_slug).sort()
    const marker = items.length >= 2 ? '✓' : ' '
    console.log(`  ${marker} ${items.length}× ${title.slice(0, 55).padEnd(55)} → ${teamSlugs.join(', ')}`)
  }
  const { shutdownVeoSession } = await import('../src/lib/veo/auth')
  await shutdownVeoSession()
})()
