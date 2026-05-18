import { readFileSync } from 'node:fs'
import { join } from 'node:path'
for (const l of readFileSync(join(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const t = l.trim(); if (!t||t.startsWith('#'))continue; const eq=t.indexOf('=')
  if(eq<0)continue; const k=t.slice(0,eq).trim(); let v=t.slice(eq+1).trim()
  if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1)
  if(!(k in process.env))process.env[k]=v
}
;(async()=>{
  const veo=await import('../src/lib/veo/client')
  const r=await veo.listClubsAndTeams()
  console.log('success:', r.success)
  if (r.success && r.data) {
    for (const c of r.data.clubs) {
      console.log(`  ${c.slug.padEnd(35)} team_count=${c.team_count}  teams.length=${c.teams.length}`)
    }
  } else {
    console.log('message:', r.message)
  }
  const {shutdownVeoSession}=await import('../src/lib/veo/auth')
  await shutdownVeoSession()
})()
