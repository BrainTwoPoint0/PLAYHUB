import { readFileSync } from 'node:fs'
import { join } from 'node:path'
for (const l of readFileSync(join(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const t=l.trim(); if(!t||t.startsWith('#'))continue; const eq=t.indexOf('='); if(eq<0)continue
  const k=t.slice(0,eq).trim(); let v=t.slice(eq+1).trim()
  if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1)
  if(!(k in process.env))process.env[k]=v
}
;(async()=>{
  const veo = await import('../src/lib/veo/client')
  const tr = await veo.listClubsAndTeams()
  const lyl = tr.data!.clubs.find(c => c.slug === 'london-youth-league')!
  const teamById = new Map<string, string>(lyl.teams.map(t => [t.id, t.slug]))
  const rr = await veo.listRecordings('london-youth-league')
  const recs = rr.data!.recordings

  // Recordings grouped by their assigned team slug
  const byTeam = new Map<string, typeof recs>()
  for (const r of recs) {
    if (!r.team) continue
    const slug = teamById.get(r.team) ?? `unknown:${r.team.slice(0,8)}`
    const arr = byTeam.get(slug) ?? []
    arr.push(r)
    byTeam.set(slug, arr)
  }
  // The 4 teams of interest: 2 pairs
  const teamsOfInterest = ['taa-u9', 'the-a-academy-u9', 'london-thames-u9', 'london-thames-fc', 'london-thames-fc-u9']
  for (const slug of teamsOfInterest) {
    const items = byTeam.get(slug) ?? []
    console.log(`\n=== ${slug} (${items.length} recordings) ===`)
    if (items.length === 0) continue
    for (const r of items) {
      const dur = `${Math.round(r.duration / 60)}m`.padStart(5)
      const date = (r.match_date ?? '').slice(0, 10).padEnd(10)
      console.log(`  ${date}  ${dur}  ${r.slug.slice(0,60).padEnd(60)} → "${(r.title||'').slice(0,55)}"`)
    }
  }
  const {shutdownVeoSession}=await import('../src/lib/veo/auth')
  await shutdownVeoSession()
})()
