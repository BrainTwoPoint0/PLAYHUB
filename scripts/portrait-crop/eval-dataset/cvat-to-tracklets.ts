#!/usr/bin/env node
/**
 * Convert a multi-track CVAT "for video 1.1" XML export into the eval-dataset
 * TRACKLET label schema (v1) — groundwork for the PlayerTracker module (Phase 3
 * / framework F1). Where cvat-to-labels.ts reads a single ball track as centre
 * points, this reads EVERY track (player / ball / keeper / referee) with its
 * CVAT track id, keeping full boxes per frame.
 *
 * Output schema (tracklet/v1):
 *   {
 *     "clip_id": "veo_...",
 *     "schema": "tracklet/v1",
 *     "source_fps": 29.97,
 *     "dense": true,
 *     "tracks": [
 *       {
 *         "track_id": 0,
 *         "label": "player",
 *         "frames": [
 *           { "frame": 0, "t": 0.0, "box": { "x": cx, "y": cy, "w": w, "h": h }, "visible": true },
 *           { "frame": 5, "t": 0.17, "visible": false }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Coordinates: source-frame pixel space (1920×1080 for Veo). Box is centre+size
 * to match the ball schema; convert to corners downstream if a metric needs it.
 *
 * Usage:
 *   npx tsx eval-dataset/cvat-to-tracklets.ts \
 *     --cvat <export.xml> --video <clip.mp4> --clip-id <id> --out <labels.json> \
 *     [--labels player,ball]   # which track labels to keep (default: all)
 *     [--keyframes-only]       # drop CVAT-interpolated boxes (default: keep all)
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const cvatPath = arg('cvat')
const videoPath = arg('video')
const clipId = arg('clip-id')
const outPath = arg('out')
const labelFilter = arg('labels')
  ? new Set(
      arg('labels')!
        .split(',')
        .map((s) => s.trim())
    )
  : null
const keyframesOnly = process.argv.includes('--keyframes-only')

if (!cvatPath || !videoPath || !clipId || !outPath) {
  console.error(
    'Usage: cvat-to-tracklets.ts --cvat <export.xml> --video <clip.mp4> --clip-id <id> --out <json> [--labels player,ball] [--keyframes-only]'
  )
  process.exit(1)
}
for (const p of [cvatPath, videoPath]) {
  if (!fs.existsSync(p)) {
    console.error(`Not found: ${p}`)
    process.exit(1)
  }
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

const attrRe = /(\w+)="([^"]*)"/g
function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  attrRe.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(s)) !== null) out[m[1]] = m[2]
  return out
}

const sourceFps = probeFps(videoPath)
const xml = fs.readFileSync(cvatPath, 'utf-8')

// Every <track ...>...</track> — capture the opening attrs (id, label) + body.
const trackRe = /<track\b([^>]*)>([\s\S]*?)<\/track>/g
const boxRe = /<box\b([^>]*?)\/?>/g

const tracks: Array<{
  track_id: number
  label: string
  frames: Array<{
    frame: number
    t: number
    box?: { x: number; y: number; w: number; h: number }
    visible: boolean
  }>
}> = []

let tm: RegExpExecArray | null
while ((tm = trackRe.exec(xml)) !== null) {
  const head = attrs(tm[1])
  const label = head.label ?? 'unknown'
  if (labelFilter && !labelFilter.has(label)) continue
  const trackId = parseInt(head.id ?? `${tracks.length}`, 10)

  const seen = new Set<number>()
  const frames: (typeof tracks)[number]['frames'] = []
  let bm: RegExpExecArray | null
  boxRe.lastIndex = 0
  while ((bm = boxRe.exec(tm[2])) !== null) {
    const b = attrs(bm[1])
    if (keyframesOnly && b.keyframe !== '1') continue
    const frame = parseInt(b.frame ?? '-1', 10)
    if (frame < 0 || seen.has(frame)) continue
    seen.add(frame)
    const t = +(frame / sourceFps).toFixed(3)
    if (b.outside === '1') {
      frames.push({ frame, t, visible: false })
      continue
    }
    const xtl = parseFloat(b.xtl ?? '0')
    const ytl = parseFloat(b.ytl ?? '0')
    const xbr = parseFloat(b.xbr ?? '0')
    const ybr = parseFloat(b.ybr ?? '0')
    frames.push({
      frame,
      t,
      box: {
        x: Math.round((xtl + xbr) / 2),
        y: Math.round((ytl + ybr) / 2),
        w: Math.round(xbr - xtl),
        h: Math.round(ybr - ytl),
      },
      visible: true,
    })
  }
  frames.sort((a, b) => a.frame - b.frame)
  if (frames.length) tracks.push({ track_id: trackId, label, frames })
}

if (tracks.length === 0) {
  console.error(
    'No matching <track> entries found. Check the export has tracks and --labels matches their label names.'
  )
  process.exit(1)
}

const output = {
  clip_id: clipId,
  schema: 'tracklet/v1',
  source_fps: sourceFps,
  dense: !keyframesOnly,
  tracks,
}

fs.mkdirSync(path.dirname(outPath!), { recursive: true })
fs.writeFileSync(outPath!, JSON.stringify(output, null, 2))

const byLabel: Record<string, number> = {}
for (const tr of tracks) byLabel[tr.label] = (byLabel[tr.label] ?? 0) + 1
console.log(
  `Wrote ${outPath}: ${tracks.length} tracklets (${JSON.stringify(byLabel)}), ` +
    `source_fps=${sourceFps}, dense=${!keyframesOnly}`
)
