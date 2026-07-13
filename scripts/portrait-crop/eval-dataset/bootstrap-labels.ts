#!/usr/bin/env node
/**
 * bootstrap-labels — emit CVAT "for video 1.1" pre-annotations from the
 * detector's ball positions, so a human CORRECTS in CVAT instead of labeling
 * from scratch (active-learning seeding; turns an 8–12h sprint into ~2–3h).
 *
 * Confident sources (ball / tracked) become visible boxes; fallback frames
 * (cluster / hold / none) become `outside="1"` (ball absent) — the labeler just
 * fixes the gaps where the detector was wrong or unsure.
 *
 * Round-trips with cvat-to-labels.ts (same CVAT-for-video-1.1 schema), so the
 * format is import-ready: in CVAT, open the task → Upload annotations →
 * "CVAT for video 1.1" → this file → correct → export to cvat-exports/.
 *
 * Usage:
 *   npx tsx eval-dataset/bootstrap-labels.ts \
 *     --video clips/<id>.mp4 --clip-id <id> --out cvat-imports/<id>.xml \
 *     [--raw clips/<id>_raw.json]   # reuse cached detections; else runs detect_ball.py
 *     [--box 24]                    # fallback bbox size (px) when detector w/h is 0
 *     [--detect-fps 25]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const videoPath = arg('video')
const clipId = arg('clip-id')
const rawPath = arg('raw')
const outPath =
  arg('out') ??
  (clipId ? path.join(__dirname, 'cvat-imports', `${clipId}.xml`) : undefined)
const box = parseInt(arg('box') ?? '24', 10)
const detectFps = arg('detect-fps') ?? '25'

if (!videoPath || !clipId || !outPath) {
  console.error(
    'Usage: bootstrap-labels.ts --video <mp4> --clip-id <id> --out <xml> [--raw <raw.json>] [--box 24]'
  )
  process.exit(1)
}
if (!fs.existsSync(videoPath)) {
  console.error(`Not found: ${videoPath}`)
  process.exit(1)
}

interface Pos {
  time: number
  x: number
  y: number
  w?: number
  h?: number
  conf: number
  source: string
}

function probeFps(p: string): number {
  const out = execSync(
    `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of json "${p}"`,
    { encoding: 'utf-8' }
  )
  const [num, den] = (JSON.parse(out).streams[0].r_frame_rate as string)
    .split('/')
    .map(Number)
  return den ? num / den : 25
}

function probeFrameCount(p: string): number {
  // Exact decoded frame count — CVAT rejects annotation boxes past the last frame.
  try {
    const out = execSync(
      `ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of default=noprint_wrappers=1:nokey=1 "${p}"`,
      { encoding: 'utf-8' }
    )
    const n = parseInt(out.trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function loadPositions(): Pos[] {
  if (rawPath) return JSON.parse(fs.readFileSync(rawPath, 'utf-8')).positions
  const script = path.resolve(__dirname, '..', 'detect_ball.py')
  console.error(
    `Running detector on ${path.basename(videoPath!)} (may take minutes)…`
  )
  const out = execSync(
    `python3 "${script}" "${videoPath}" --fps ${detectFps}`,
    {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    }
  )
  return JSON.parse(out.trim().split('\n').pop()!).positions
}

const sourceFps = probeFps(videoPath)
const frameCount = probeFrameCount(videoPath)
const positions = loadPositions()

const CONFIDENT = new Set(['ball', 'tracked'])
const byFrame = new Map<
  number,
  { outside: number; xtl: number; ytl: number; xbr: number; ybr: number }
>()
let maxFrame = 0
for (const p of positions) {
  const frame = Math.round(p.time * sourceFps)
  if (frame >= frameCount) continue // drop boxes past the video's last frame (CVAT rejects them)
  if (byFrame.has(frame)) continue // first position per frame wins
  maxFrame = Math.max(maxFrame, frame)
  if (CONFIDENT.has(p.source) && p.x >= 0) {
    const w = p.w && p.w > 0 ? p.w : box
    const h = p.h && p.h > 0 ? p.h : box
    byFrame.set(frame, {
      outside: 0,
      xtl: p.x - w / 2,
      ytl: p.y - h / 2,
      xbr: p.x + w / 2,
      ybr: p.y + h / 2,
    })
  } else {
    byFrame.set(frame, { outside: 1, xtl: 0, ytl: 0, xbr: box, ybr: box })
  }
}

const frames = [...byFrame.keys()].sort((a, b) => a - b)
const size = Number.isFinite(frameCount) ? frameCount : maxFrame + 1
const f = (n: number) => n.toFixed(2)

const boxesXml = frames
  .map((fr) => {
    const b = byFrame.get(fr)!
    return `    <box frame="${fr}" outside="${b.outside}" occluded="0" keyframe="1" xtl="${f(b.xtl)}" ytl="${f(b.ytl)}" xbr="${f(b.xbr)}" ybr="${f(b.ybr)}" z_order="0"></box>`
  })
  .join('\n')

const xml = `<?xml version="1.0" encoding="utf-8"?>
<annotations>
  <version>1.1</version>
  <meta>
    <task>
      <name>${clipId}</name>
      <size>${size}</size>
      <mode>interpolation</mode>
      <overlap>0</overlap>
      <start_frame>0</start_frame>
      <stop_frame>${size - 1}</stop_frame>
      <labels>
        <label>
          <name>ball</name>
          <type>rectangle</type>
          <attributes></attributes>
        </label>
      </labels>
    </task>
  </meta>
  <track id="0" label="ball" source="auto">
${boxesXml}
  </track>
</annotations>
`

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, xml)
const visible = frames.filter((fr) => byFrame.get(fr)!.outside === 0).length
console.log(
  `Wrote ${outPath}: ${frames.length} boxes (${visible} visible, ${frames.length - visible} outside), source_fps=${sourceFps}, size=${size}`
)
console.log(
  `Import: CVAT task → Upload annotations → "CVAT for video 1.1" → this file → correct → export to cvat-exports/.`
)
