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
  const { getVeoSession, shutdownVeoSession } =
    await import('../src/lib/veo/auth')
  const s = await getVeoSession()
  // Direct call to club's teams endpoint
  for (const url of [
    '/api/app/clubs/?filter=own&fields=slug&fields=team_count&page_size=500',
    '/api/app/clubs/london-youth-league/teams/?page_size=500',
    '/api/app/clubs/london-youth-league/teams/',
  ]) {
    const res = await s.api('GET', url)
    console.log(`=== ${url} ===`)
    console.log(`status: ${res.status}`)
    console.log(
      `body (first 800 chars): ${typeof res.body === 'string' ? res.body.slice(0, 800) : JSON.stringify(res.body).slice(0, 800)}`
    )
    console.log()
  }
  await shutdownVeoSession()
})()
