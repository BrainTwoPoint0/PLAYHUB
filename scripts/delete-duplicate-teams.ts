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
  for (const slug of ['the-a-academy-u9', 'london-thames-fc']) {
    const r = await veo.deleteTeam('london-youth-league', slug)
    console.log(r.success ? `✓ ${r.message}` : `✗ ${r.message}`)
  }
  const {shutdownVeoSession}=await import('../src/lib/veo/auth')
  await shutdownVeoSession()
})()
