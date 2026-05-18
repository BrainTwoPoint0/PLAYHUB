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
  const r = await veo.deleteTeam('london-youth-league', 'capture-test-team')
  console.log(r.success ? `✓ ${r.message}` : `✗ ${r.message}`)
  const { shutdownVeoSession } = await import('../src/lib/veo/auth')
  await shutdownVeoSession()
})()
