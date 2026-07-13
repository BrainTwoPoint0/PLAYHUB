// Fetch a Spiideo data stream (viewport / tracklet / detection) and dump its format.
//   node fetch_viewports.mjs <gameId> <streamId> [outfile]
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
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
const [gameId, streamId, outfile] = process.argv.slice(2)
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
  return (await res.json()).jwt
}
const jwt = await signIn()
const acc = encodeURIComponent(SPIIDEO_ACCOUNT_ID)
const auth = { authorization: `Bearer ${jwt}` }

// try a battery of plausible endpoints for a non-HLS data stream
const cands = [
  `${B}/v2/streams/${streamId}/playlist?accountId=${acc}&authorization=bearer+${jwt}`,
  `${B}/v2/streams/${streamId}/content?accountId=${acc}`,
  `${B}/v2/streams/${streamId}/data?accountId=${acc}`,
  `${B}/v2/streams/${streamId}?accountId=${acc}`,
  `${B}/v1/streams/${streamId}/content?accountId=${acc}`,
  `${B}/v1/streams/${streamId}`,
  `${B}/v2/streams/${streamId}/download?accountId=${acc}`,
]
for (const url of cands) {
  try {
    const r = await fetch(url, { headers: auth })
    const ct = r.headers.get('content-type') || ''
    const buf = Buffer.from(await r.arrayBuffer())
    console.log(`\n[${r.status}] ${ct} ${buf.length}B  ${url.split('?')[0]}`)
    if (r.ok && buf.length) {
      const head = buf
        .slice(0, 400)
        .toString('utf8')
        .replace(/[^\x09\x0a\x20-\x7e]/g, '·')
      console.log('  head:', head.slice(0, 380))
      if (
        outfile &&
        buf.length > 200 &&
        /json|text|mpegurl|octet|viewport|application/i.test(ct)
      ) {
        writeFileSync(outfile, buf)
        console.log('  → saved', outfile, buf.length, 'B')
      }
    }
  } catch (e) {
    console.log('  ERR', url.split('?')[0], e.message)
  }
}
