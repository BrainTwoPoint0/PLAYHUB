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

/** Expand a GL triangle strip to a triangle list (skip degenerate restarts). */
function stripToTriangleList(u32) {
  const out = []
  for (let i = 0; i < u32.length - 2; i++) {
    const a = u32[i],
      b = u32[i + 1],
      c = u32[i + 2]
    if (a === b || b === c || a === c) continue
    if (i % 2 === 0) out.push(a, b, c)
    else out.push(b, a, c)
  }
  return Uint32Array.from(out)
}

function looksLikeStrip(u32) {
  if (u32.length < 3) return false
  if (u32.length % 3 !== 0) return true
  return u32[0] === u32[1]
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
  const files = {}
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
    files[key] = Buffer.from(await resp.arrayBuffer())
    console.log(
      `  ✓ ${key}  ${files[key].length} bytes  <- ${url.slice(0, 90)}...`
    )
    got = true
  }
  if (!got) continue
  // Spiideo ships triangle STRIPS; our player expects a triangle LIST.
  // Convert PER projection (HCT is 2-cam — whole-file convert left proj1 empty).
  if (files['indices.bin'] && files['scene.json']) {
    const I = new Uint32Array(
      files['indices.bin'].buffer,
      files['indices.bin'].byteOffset,
      files['indices.bin'].byteLength / 4
    )
    const sc = JSON.parse(files['scene.json'].toString('utf8'))
    const projs = sc.projections || []
    const outChunks = []
    let ioff = 0
    let any = false
    for (let pi = 0; pi < projs.length; pi++) {
      const nv = projs[pi].n_vertices
      const ni = projs[pi].n_indices
      const raw = I.subarray(ioff, ioff + ni)
      ioff += ni
      if (looksLikeStrip(raw)) {
        const list = stripToTriangleList(raw)
        outChunks.push(list)
        projs[pi].n_indices = list.length
        any = true
        console.log(
          `  ✓ proj${pi} strip→trilist  ${raw.length} → ${list.length} (${list.length / 3} tris, nv=${nv})`
        )
      } else {
        outChunks.push(raw)
        console.log(
          `  · proj${pi} already trilist  ${raw.length} indices (nv=${nv})`
        )
      }
    }
    if (any) {
      const total = outChunks.reduce((n, c) => n + c.length, 0)
      const merged = new Uint32Array(total)
      let o = 0
      for (const c of outChunks) {
        merged.set(c, o)
        o += c.length
      }
      files['indices.bin'] = Buffer.from(merged.buffer)
      sc.index_description = 'uint32'
      files['scene.json'] = Buffer.from(JSON.stringify(sc, null, 2) + '\n')
    }
  }
  for (const [key, buf] of Object.entries(files)) {
    writeFileSync(resolve(outDir, key), buf)
  }
  break // one good mesh is enough (scene mesh is shared across Nazwa games)
}
console.log(
  got
    ? `\nDONE -> ${outDir}`
    : '\nNo mesh variant URLs found in stream metadata.'
)
