// Fetch Spiideo's REAL projection mesh (scene.json + indices.bin + vertices.bin) for a game.
// The online cloud-control player loads it from stream.projectionParameters.variants[version==1],
// each entry carrying a direct {scene.json,indices.bin,vertices.bin}.url (signed CDN link).
//   node fetch_spiideo_mesh.mjs <gameId> [outDir]
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
const outDir =
  process.argv[3] ||
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    `spiideo-real-mesh-${gameId}`
  )
if (!gameId) {
  console.error('usage: node fetch_spiideo_mesh.mjs <gameId> [outDir]')
  process.exit(1)
}
const { SPIIDEO_PLAY_EMAIL, SPIIDEO_PLAY_PASSWORD } = process.env

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
const auth = { authorization: `Bearer ${jwt}` }

// Grab the game's streams (all types) and find the Spd panorama stream(s).
const TYPES = ['source', 'aggregated', 'intermediate', 'output']
const q = TYPES.map((t) => `type=${t}`).join('&')
const r = await fetch(`${B}/v1/streams?gameId=${gameId}&${q}`, {
  headers: auth,
})
if (!r.ok) {
  console.error(`streams HTTP ${r.status}`)
  process.exit(1)
}
const data = JSON.parse(await r.text())
const streams = data.content || data || []
console.log(`${streams.length} streams for game ${gameId}`)

const spd = streams.filter(
  (s) =>
    s.projection === 'SPD' ||
    s.projection === 'Spd' ||
    String(s.projection).toLowerCase() === 'spd'
)
console.log(`\nSpd (panorama) streams: ${spd.length}`)
for (const s of spd) {
  console.log(
    `  id=${s.id} name=${s.streamName ?? '-'} state=${s.state ?? '-'} hasProjParams=${!!s.projectionParameters}`
  )
}

// If projectionParameters isn't inline, fetch the stream detail.
async function withParams(s) {
  if (s.projectionParameters?.variants?.length) return s
  const d = await fetch(`${B}/v1/streams/${s.id}`, { headers: auth })
  if (!d.ok) {
    console.log(`   stream detail HTTP ${d.status} for ${s.id}`)
    return s
  }
  return JSON.parse(await d.text())
}

mkdirSync(outDir, { recursive: true })
let got = false
for (const s0 of spd) {
  const s = await withParams(s0)
  const variants = s.projectionParameters?.variants || []
  console.log(`\nstream ${s.id}: ${variants.length} projection variants`)
  for (const v of variants) {
    console.log(`  version=${v.version} keys=${Object.keys(v).join(',')}`)
  }
  // Prefer version==1 (the mesh the player selects).
  const v = variants.find((x) => parseInt(x.version, 10) === 1) || variants[0]
  if (!v) continue
  for (const key of ['scene.json', 'indices.bin', 'vertices.bin']) {
    const url = v[key]?.url
    if (!url) {
      console.log(`  MISSING ${key}.url`)
      continue
    }
    const resp = await fetch(url)
    if (!resp.ok) {
      console.log(`  ${key} download HTTP ${resp.status}`)
      continue
    }
    const buf = Buffer.from(await resp.arrayBuffer())
    const dest = resolve(outDir, key)
    writeFileSync(dest, buf)
    console.log(`  ✓ ${key}  ${buf.length} bytes  <- ${url.slice(0, 90)}...`)
    got = true
  }
  if (got) break // one good mesh is enough (scene mesh is shared across Nazwa games)
}
console.log(
  got
    ? `\nDONE -> ${outDir}`
    : '\nNo mesh variant URLs found in stream metadata.'
)
