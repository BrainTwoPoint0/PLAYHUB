/**
 * Convert a CVAT "for video 1.1" XML export into our eval-dataset label JSON.
 *
 * CVAT export contains a <track label="ball"> with one <box> per annotated
 * frame. Each box has xtl/ytl/xbr/ybr (bbox corners), `outside` (1 = ball
 * not present), and `keyframe` (1 = user-set, 0 = interpolated). For sparse
 * labelling we keep only `keyframe="1"` boxes; for the hero clip we keep
 * every box (CVAT-interpolated values are still useful at full FPS).
 *
 * Output schema (per eval-dataset/README.md):
 *   {
 *     "clip_id": "veo_012958_goal",
 *     "dense": false,
 *     "label_fps": 5,
 *     "source_fps": 25,
 *     "frames": [
 *       { "frame": 0, "t": 0.0, "ball": { "x": 850, "y": 420, "visible": true } },
 *       ...
 *     ]
 *   }
 *
 * Usage:
 *   npx tsx eval-dataset/cvat-to-labels.ts \
 *     --cvat <export.xml> \
 *     --video <clip.mp4> \
 *     --clip-id veo_012958_goal \
 *     --out eval-dataset/labels/veo_012958_goal.json \
 *     [--dense]          # keep every frame; otherwise keep only keyframes
 *
 * Coordinates: CVAT exports pixel-space coords against the SOURCE video
 * resolution (1920×1080 for Veo). We pass them through unchanged — the eval
 * harness compares against source-frame coords too.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'

// ── CLI ────────────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const cvatPath = arg('cvat')
const videoPath = arg('video')
const clipId = arg('clip-id')
const outPath = arg('out')
const dense = process.argv.includes('--dense')

if (!cvatPath || !videoPath || !clipId || !outPath) {
  console.error(
    'Usage: cvat-to-labels.ts --cvat <export.xml> --video <clip.mp4> --clip-id <id> --out <labels.json> [--dense]'
  )
  process.exit(1)
}
for (const p of [cvatPath, videoPath]) {
  if (!fs.existsSync(p)) {
    console.error(`Not found: ${p}`)
    process.exit(1)
  }
}

// ── Probe video for source FPS ─────────────────────────────────────────────
function probeFps(filePath: string): number {
  const out = execSync(
    `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of json "${filePath}"`,
    { encoding: 'utf-8' }
  )
  const probe = JSON.parse(out)
  const [num, den] = (probe.streams[0].r_frame_rate as string)
    .split('/')
    .map(Number)
  return den ? num / den : 25
}

// ── Parse CVAT XML ─────────────────────────────────────────────────────────
interface CvatBox {
  frame: number
  outside: boolean
  keyframe: boolean
  xtl: number
  ytl: number
  xbr: number
  ybr: number
}

function parseBallTrack(xml: string): CvatBox[] {
  // Find every <track ... label="ball" ...>...</track> block (occluded vs
  // separate ball tracks both end up under label="ball" in our convention).
  const trackRe = /<track\b[^>]*label="ball"[^>]*>([\s\S]*?)<\/track>/g
  const boxRe = /<box\b([^>]*?)\/?>/g
  const attrRe = /(\w+)="([^"]*)"/g

  const boxes: CvatBox[] = []
  let trackMatch: RegExpExecArray | null
  while ((trackMatch = trackRe.exec(xml)) !== null) {
    const body = trackMatch[1]
    let boxMatch: RegExpExecArray | null
    while ((boxMatch = boxRe.exec(body)) !== null) {
      const attrs: Record<string, string> = {}
      let am: RegExpExecArray | null
      attrRe.lastIndex = 0
      while ((am = attrRe.exec(boxMatch[1])) !== null) {
        attrs[am[1]] = am[2]
      }
      boxes.push({
        frame: parseInt(attrs.frame ?? '-1', 10),
        outside: attrs.outside === '1',
        keyframe: attrs.keyframe === '1',
        xtl: parseFloat(attrs.xtl ?? '0'),
        ytl: parseFloat(attrs.ytl ?? '0'),
        xbr: parseFloat(attrs.xbr ?? '0'),
        ybr: parseFloat(attrs.ybr ?? '0'),
      })
    }
  }
  return boxes
}

// ── Main ───────────────────────────────────────────────────────────────────
const sourceFps = probeFps(videoPath)
const xml = fs.readFileSync(cvatPath, 'utf-8')
const allBoxes = parseBallTrack(xml)

if (allBoxes.length === 0) {
  console.error(
    'No <track label="ball"> entries found. Did the CVAT task use label="ball"?'
  )
  process.exit(1)
}

// Filter: keep keyframes only unless --dense, then keep every frame.
// Dedupe by frame index (CVAT can emit duplicates across track restarts).
const seen = new Set<number>()
const filtered: CvatBox[] = []
for (const b of allBoxes) {
  if (!dense && !b.keyframe) continue
  if (seen.has(b.frame)) continue
  seen.add(b.frame)
  filtered.push(b)
}
filtered.sort((a, b) => a.frame - b.frame)

const frames = filtered.map((b) => {
  const t = +(b.frame / sourceFps).toFixed(3)
  if (b.outside) {
    return { frame: b.frame, t, ball: { visible: false as const } }
  }
  return {
    frame: b.frame,
    t,
    ball: {
      x: Math.round((b.xtl + b.xbr) / 2),
      y: Math.round((b.ytl + b.ybr) / 2),
      visible: true as const,
    },
  }
})

const inferredLabelFps = dense
  ? sourceFps
  : frames.length >= 2
    ? // Spacing between consecutive labelled frames → label_fps.
      Math.round(sourceFps / Math.max(1, frames[1].frame - frames[0].frame))
    : 5

const output = {
  clip_id: clipId,
  dense,
  label_fps: inferredLabelFps,
  source_fps: sourceFps,
  frames,
}

fs.mkdirSync(path.dirname(outPath!), { recursive: true })
fs.writeFileSync(outPath!, JSON.stringify(output, null, 2))

const visible = frames.filter((f) => f.ball.visible).length
const occluded = frames.length - visible
console.log(
  `Wrote ${outPath}: ${frames.length} frames (${visible} visible, ${occluded} occluded), ` +
    `label_fps≈${inferredLabelFps}, source_fps=${sourceFps}, dense=${dense}`
)
