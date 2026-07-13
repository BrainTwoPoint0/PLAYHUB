// Probe ALL Spiideo stream types for a game — looking for the AutoFollow driver:
// object_data / object / tag / aggregated tracking. If grassroots recordings carry
// ball/player tracking (like the demo's "AutoData"), we can fetch it directly instead
// of imitating the render.
//   node probe_streams.mjs <gameId>
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

function loadEnv() {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const f of [
    resolve(here, '../../.env'),
    resolve(here, '../../../.env'),
  ]) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (!m) continue
      let v = m[2].replace(/\s+#.*$/, '').trim()
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      )
        v = v.slice(1, -1)
      if (!process.env[m[1]]) process.env[m[1]] = v
    }
  }
}
loadEnv()
const B = 'https://api.spiideo.com'
const gameId = process.argv[2]
const { SPIIDEO_PLAY_EMAIL, SPIIDEO_PLAY_PASSWORD, SPIIDEO_ACCOUNT_ID } =
  process.env

async function signIn() {
  const res = await fetch(`${B}/v1/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: SPIIDEO_PLAY_EMAIL,
      password: SPIIDEO_PLAY_PASSWORD,
      rolesToAssume: ['ROLE_USER'],
    }),
  })
  if (!res.ok) throw new Error(`sign-in HTTP ${res.status}`)
  return (await res.json()).jwt
}

const jwt = await signIn()
const TYPES = [
  'source',
  'aggregated',
  'intermediate',
  'output',
  'object',
  'object_data',
  'tag',
  'tracklet',
  'autodata',
]
const q = TYPES.map((t) => `type=${t}`).join('&')
const r = await fetch(`${B}/v1/streams?gameId=${gameId}&${q}`, {
  headers: { authorization: `Bearer ${jwt}` },
})
const txt = await r.text()
console.log(
  `HTTP ${r.status} for gameId=${gameId} with types [${TYPES.join(',')}]`
)
let data
try {
  data = JSON.parse(txt)
} catch {
  console.log(txt.slice(0, 800))
  process.exit(0)
}
const streams = data.content || data || []
console.log(`\n${streams.length} streams:`)
for (const s of streams) {
  console.log(
    `  type=${s.type} name=${s.streamName ?? '-'} projection=${s.projection ?? '-'} state=${s.state ?? '-'} format=${s.format ?? s.contentType ?? '-'} id=${s.id}`
  )
}
// also hit the api.spiideo.net Perform endpoint (where object_data showed up in recon)
console.log('\n--- api.spiideo.net object_data probe ---')
const r2 = await fetch(
  `https://api.spiideo.net/v1/streams?gameId=${gameId}&type=object_data&type=object&type=aggregated&type=tag`,
  { headers: { authorization: `Bearer ${jwt}` } }
).catch((e) => ({ ok: false, status: e.message }))
if (r2.ok) {
  const d2 = JSON.parse(await r2.text())
  const ss = d2.content || []
  console.log(`  ${ss.length} streams on .net`)
  for (const s of ss)
    console.log(
      `    type=${s.type} name=${s.streamName ?? '-'} projection=${s.projection ?? '-'} state=${s.state ?? '-'}`
    )
} else {
  console.log('  .net probe:', r2.status)
}
