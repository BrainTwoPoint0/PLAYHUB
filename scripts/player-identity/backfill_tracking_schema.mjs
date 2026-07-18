// One-off: rewrite the `schema` block of already-captured tracking.json files
// from each match's OWN alignment.veo.
//
// Every capture before 2026-07-15 self-describes as `pitch: {lengthM: 105,
// widthM: 68}` — a real measurement from hollands-blair-u23 (a genuine full-size
// pitch) generalised from n=1 to a constant. Real dims vary per match (68x41.0,
// 68x42.8, 68x37.2, 105x73.4); at 105x68 the projection scores 0.075, which is
// null level, vs 0.86 at the match's own dims.
//
// No tracking data is wrong — only the decode instructions that travel with it.
// This rewrites ONLY `schema`; frames/periods/stepEvents/jerseyNumbers are
// passed through and asserted unchanged.
//
// PREFIX-DRIVEN, not DB-driven: playhub_veo_captures provably under-reports what
// is in S3 (a reset row leaves objects with a NULL tracking_s3_key), and a
// key-driven pass would silently skip exactly those.
//
// usage: AWS_PROFILE=playhub node backfill_tracking_schema.mjs [--apply]

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

// The SAME module the Batch job uses. Reimplementing the schema here would let
// the corpus and the producer drift apart — which is the bug this fixes.
import {
  parseFieldDims,
  trackingSchema,
} from '../../infrastructure/batch/veo-capture/field-dims.mjs'

const BUCKET =
  process.env.S3_RECORDINGS_BUCKET || 'playhub-recordings-eu-west-2'
const PREFIX = process.env.VEO_S3_PREFIX || 'veo-panoramas'
const APPLY = process.argv.includes('--apply')
const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-2' })

const body = async (Key) =>
  (
    await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key }))
  ).Body.transformToString()

const slugs = []
for (let token; ;) {
  const r = await s3.send(
    new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: `${PREFIX}/`,
      Delimiter: '/',
      ContinuationToken: token,
    })
  )
  for (const p of r.CommonPrefixes ?? [])
    slugs.push(p.Prefix.split('/').filter(Boolean).pop())
  if (!r.IsTruncated) break
  token = r.NextContinuationToken
}
console.log(
  `${slugs.length} captured prefixes; ${APPLY ? 'APPLYING' : 'dry run (--apply to write)'}\n`
)

let fixed = 0
let skipped = 0
for (const slug of slugs) {
  const key = `${PREFIX}/${slug}/tracking.json`
  let trk, dims
  try {
    trk = JSON.parse(await body(key))
  } catch (e) {
    console.log(`SKIP  ${slug}\n      no readable tracking.json (${e.name})`)
    skipped++
    continue
  }
  try {
    // field_width is per-match and fitted — it can NEVER be borrowed from a
    // sibling capture. No alignment.veo means no scale, so leave the schema
    // alone rather than write a second confident guess over the first.
    dims = parseFieldDims(await body(`${PREFIX}/${slug}/alignment.veo`))
  } catch (e) {
    console.log(
      `SKIP  ${slug}\n      alignment.veo unusable — cannot know the scale (${e.message})`
    )
    skipped++
    continue
  }

  const before = trk.schema?.pitch
  const next = { ...trk, schema: trackingSchema(dims) }

  // The schema is the only thing that may move. Anything else changing means a
  // bug in this script, and these are minors' tracking data we cannot re-fetch
  // once Veo prunes the match from its listing.
  const frozen = (o) => JSON.stringify({ ...o, schema: null })
  if (frozen(trk) !== frozen(next))
    throw new Error(`${slug}: refusing — non-schema fields moved`)
  const nFrames = Object.keys(trk.frames ?? {}).length
  if (Object.keys(next.frames ?? {}).length !== nFrames)
    throw new Error(`${slug}: refusing — frame count changed`)

  // "Already correct" means the schema is byte-identical to what the producer
  // would write TODAY — not merely that the dims match. Comparing only the dims
  // makes this blind to every other schema change and leaves the corpus in mixed
  // states: the first run of this script predated `scaleKnown`, so a
  // dims-only check reported OK and skipped files that were still missing it.
  const same = JSON.stringify(trk.schema) === JSON.stringify(next.schema)
  console.log(
    `${same ? 'OK   ' : 'FIX  '} ${slug}\n      ${before?.lengthM}x${before?.widthM} -> ` +
      `${dims.lengthM}x${dims.widthM.toFixed(3)}  (${nFrames} frames preserved)` +
      (same ? '' : `  [scaleKnown ${trk.schema?.scaleKnown} -> true]`)
  )
  if (same) continue
  fixed++
  if (APPLY)
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: JSON.stringify(next),
        ContentType: 'application/json',
      })
    )
}
console.log(
  `\n${fixed} ${APPLY ? 'rewritten' : 'would be rewritten'}, ${skipped} skipped`
)
