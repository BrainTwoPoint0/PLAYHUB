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
  const rr = await veo.listRecordings('london-youth-league')
  const recs = rr.data!.recordings
  // 4 teams of interest by NAME (note the double-space in "The A Academy  U9")
  const targets = [
    'TAA U9',
    'The A Academy  U9',
    'London Thames U9',
    'London Thames FC U9',
  ]
  for (const name of targets) {
    const items = recs.filter((r) => r.team === name)
    console.log(`\n=== "${name}" (${items.length} recordings) ===`)
    for (const r of items) {
      const dur = `${Math.round(r.duration / 60)}m`.padStart(5)
      const date = (r.match_date ?? '').slice(0, 10).padEnd(10)
      console.log(
        `  ${date}  ${dur}  ${r.slug.slice(0, 72).padEnd(72)} → "${(r.title || '').slice(0, 55)}"`
      )
    }
  }
  const { shutdownVeoSession } = await import('../src/lib/veo/auth')
  await shutdownVeoSession()
})()
