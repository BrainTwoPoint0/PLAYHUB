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
  const teamById = new Map(lyl.teams.map((t) => [t.id, t.slug]))
  const rr = await veo.listRecordings('london-youth-league')
  const recs = rr.data!.recordings
  console.log(`${lyl.teams.length} teams, ${recs.length} recordings\n`)
  // Group by normalized title
  const byTitle = new Map<string, { slug: string; team: string | null }[]>()
  for (const r of recs) {
    const t = (r.title || '(untitled)').trim()
    const arr = byTitle.get(t) ?? []
    arr.push({ slug: r.slug, team: r.team ?? null })
    byTitle.set(t, arr)
  }
  // Sort: most copies first
  const sorted = [...byTitle.entries()].sort(
    (a, b) => b[1].length - a[1].length
  )
  let triple = 0,
    double = 0,
    single = 0,
    none = 0
  for (const [title, items] of sorted) {
    const c = items.length
    if (c >= 3) triple++
    else if (c === 2) double++
    else single++
    if (c >= 3) {
      console.log(`  ${c}× ${title.slice(0, 60)}`)
      for (const i of items) {
        const teamSlug = i.team
          ? (teamById.get(i.team) ?? `??:${i.team.slice(0, 8)}`)
          : '(no team)'
        console.log(`        ${i.slug.slice(0, 60).padEnd(60)} → ${teamSlug}`)
      }
    }
  }
  console.log(
    `\nSummary: ${triple} titles with 3+ copies, ${double} with 2, ${single} with 1`
  )
  const { shutdownVeoSession } = await import('../src/lib/veo/auth')
  await shutdownVeoSession()
})()
