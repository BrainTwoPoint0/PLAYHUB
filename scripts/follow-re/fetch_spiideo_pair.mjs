// Phase 1 (player-centroid follow): fetch the residual° validation pair for ONE
// Spiideo game — the raw VP (projection "spd") and the Spiideo Play FOLLOW-render
// (projection "plain") — via the same JWT path vp-materialize uses. Read-only w.r.t.
// Spiideo (sign-in + stream list + playlist); writes only local mp4s.
//
//   node fetch_spiideo_pair.mjs <gameId> [--list] [--seconds 180] [--start 600] [--out DIR]
//
// --list        : just print the streams (discovery), fetch nothing.
// default       : remux the "plain" (Play follow) stream to <out>/play_<gameId>.mp4.
// Env: SPIIDEO_PLAY_EMAIL, SPIIDEO_PLAY_PASSWORD, SPIIDEO_ACCOUNT_ID.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileP = promisify(execFile)

// Self-load the SPIIDEO_* keys from the workspace .env files (shell `source` is
// flaky on these files). PLAYHUB/.env is ../../.env from this script; workspace
// root is ../../../.env.
function loadEnv() {
  const here = dirname(fileURLToPath(import.meta.url))
  const files = [resolve(here, '../../.env'), resolve(here, '../../../.env')]
  for (const f of files) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (!m) continue
      const k = m[1]
      let v = m[2].replace(/\s+#.*$/, '').trim()
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      )
        v = v.slice(1, -1)
      if (!process.env[k]) process.env[k] = v
    }
  }
}
loadEnv()
const B = 'https://api.spiideo.com'
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'

const args = process.argv.slice(2)
const gameId = args[0]
const listOnly = args.includes('--list')
const playOnly = args.includes('--play-only')
const opt = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : d
}
const seconds = Number(opt('--seconds', 180))
const start = Number(opt('--start', 0))
const outDir = resolve(opt('--out', '/tmp/follow-pair'))

const { SPIIDEO_PLAY_EMAIL, SPIIDEO_PLAY_PASSWORD, SPIIDEO_ACCOUNT_ID } =
  process.env
if (!gameId) {
  console.error('usage: fetch_spiideo_pair.mjs <gameId> [--list]')
  process.exit(1)
}
if (!SPIIDEO_PLAY_EMAIL || !SPIIDEO_PLAY_PASSWORD || !SPIIDEO_ACCOUNT_ID) {
  console.error(
    'missing SPIIDEO_PLAY_EMAIL / SPIIDEO_PLAY_PASSWORD / SPIIDEO_ACCOUNT_ID in env'
  )
  process.exit(1)
}

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
  const { jwt } = await res.json()
  if (!jwt) throw new Error('sign-in missing jwt')
  return jwt
}

async function listStreams(jwt) {
  const r = await fetch(
    `${B}/v1/streams?gameId=${gameId}&type=aggregated&type=intermediate&type=output`,
    { headers: { authorization: `Bearer ${jwt}` } }
  )
  const t = await r.text()
  return (t ? JSON.parse(t) : {})?.content ?? []
}

function playlistUrl(streamId, jwt) {
  return `${B}/v2/streams/${streamId}/playlist?accountId=${encodeURIComponent(SPIIDEO_ACCOUNT_ID)}&authorization=bearer+${jwt}`
}

async function remux(streamId, jwt, outPath) {
  // HLS → mp4, no re-encode; bounded window. HTTPS-only whitelist; Spiideo segments are extensionless.
  const a = [
    '-y',
    '-loglevel',
    'error',
    '-protocol_whitelist',
    'https,tls,tcp,crypto',
    '-allowed_extensions',
    'ALL',
    '-extension_picky',
    '0',
  ]
  if (start > 0) a.push('-ss', String(start))
  a.push(
    '-i',
    playlistUrl(streamId, jwt),
    '-t',
    String(seconds),
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    outPath
  )
  await execFileP(FFMPEG, a, { maxBuffer: 1 << 26 })
}

const main = async () => {
  const jwt = await signIn()
  const streams = await listStreams(jwt)
  console.log(`game ${gameId}: ${streams.length} streams`)
  for (const s of streams) {
    console.log(
      `  id=${s.id} type=${s.type} streamName=${s.streamName ?? '-'} projection=${s.projection ?? '-'} ` +
        `state=${s.state ?? '-'} start=${s.startTime ?? s.start ?? '-'}`
    )
  }
  if (listOnly) return
  // Both share the same source start timestamp → an aligned window on each.
  const vp =
    streams.find(
      (s) =>
        s.type === 'aggregated' &&
        s.streamName === 'VP' &&
        s.projection === 'spd' &&
        s.state === 'complete'
    ) || streams.find((s) => s.projection === 'spd')
  const play =
    streams.find(
      (s) =>
        s.type === 'aggregated' &&
        s.streamName === 'Play' &&
        s.projection === 'plain' &&
        s.state === 'complete'
    ) ||
    streams.find((s) => s.type === 'aggregated' && s.projection === 'plain')
  if (!vp) {
    console.error('no raw VP (projection="spd") stream')
    process.exit(2)
  }
  if (!play) {
    console.error('no Play follow (projection="plain") stream')
    process.exit(2)
  }
  mkdirSync(outDir, { recursive: true })
  const suffix = start > 0 ? `_s${start}` : ''
  const rawOut = resolve(outDir, `raw_${gameId}${suffix}.mp4`)
  const playOut = resolve(outDir, `play_${gameId}${suffix}.mp4`)
  console.log(`window: start=${start}s, ${seconds}s`)
  if (!playOnly) {
    console.log(`fetching raw VP  (stream ${vp.id}) → ${rawOut}`)
    await remux(vp.id, jwt, rawOut)
  }
  console.log(`fetching Play    (stream ${play.id}) → ${playOut}`)
  await remux(play.id, jwt, playOut)
  console.log(`OK — ${playOnly ? 'play-only' : 'pair'} in ${outDir}`)
}
main().catch((e) => {
  console.error(
    'FAILED:',
    String(e.message || e).replace(/bearer\+\S+/gi, 'bearer+[REDACTED]')
  )
  process.exit(1)
})
