#!/usr/bin/env node
// Committed ORACLE metric — the detector ceiling, measured identically for every
// candidate source so go/no-go comparisons are apples-to-apples.
//
// Of the GT-visible frames, what fraction have ANY detector candidate within
// RAD px of the labelled ball (nearest-time match, ±1 label frame)? This is
// recall at the CANDIDATE stage — before the Viterbi DP, before any confidence
// threshold — i.e. "is the ball recoverable at all". It is the upper bound any
// selection layer can reach.
//
// Per-source breakdown (yolo / motion / temporal / …) lets us read the YOLO
// baseline and a new detector's ceiling from the SAME function on the SAME
// frames in one run — the apples-to-apples guarantee the MVP gate depends on.
//
// Usage:  node oracle.mjs [clipId ...]        (default: all labelled clips)
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const RAD = 60 // match radius in px — mirrors RECALL_MATCH_RADIUS in eval.ts
const here = path.dirname(fileURLToPath(import.meta.url))
const clipsDir = path.join(here, 'clips')
const labelsDir = path.join(here, 'labels')

function oracle(rawPath, gtPath) {
  const raw = JSON.parse(fs.readFileSync(rawPath))
  const gt = JSON.parse(fs.readFileSync(gtPath))
  const step = 1 / gt.source_fps
  const vis = gt.frames.filter((f) => f.ball.visible)
  const ts = gt.frames.map((f) => f.t)
  const minT = Math.min(...ts) - step
  const maxT = Math.max(...ts) + step
  const cin = (raw.all_candidates || []).filter((c) => c.time >= minT && c.time <= maxT)
  const srcOf = (c) => c.source || 'yolo'
  const sources = [...new Set(cin.map(srcOf))].sort()
  const byK = new Map()
  for (const c of cin) {
    const k = Math.round(c.time / step)
    if (!byK.has(k)) byK.set(k, [])
    byK.get(k).push(c)
  }
  const near = (c, f) => {
    const dx = f.ball.x - c.x
    const dy = f.ball.y - c.y
    return dx * dx + dy * dy <= RAD * RAD
  }
  const hit = { any: 0 }
  for (const s of sources) hit[s] = 0
  for (const f of vis) {
    const k = Math.round(f.t / step)
    let anyHit = false
    const srcHit = {}
    for (const dk of [k - 1, k, k + 1]) {
      for (const c of byK.get(dk) || []) {
        if (near(c, f)) { anyHit = true; srcHit[srcOf(c)] = true }
      }
    }
    if (anyHit) hit.any++
    for (const s of Object.keys(srcHit)) hit[s]++
  }
  const pct = (n) => (vis.length ? Math.round((100 * n) / vis.length) : 0)
  return {
    n: vis.length,
    cands: cin.length,
    overall: pct(hit.any),
    bySource: Object.fromEntries(sources.map((s) => [s, pct(hit[s])])),
  }
}

const args = process.argv.slice(2)
const clips = args.length
  ? args
  : fs.readdirSync(labelsDir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''))

console.log(`ORACLE recall (any candidate ≤${RAD}px of GT ball) — per source\n`)
for (const id of clips) {
  const rawPath = path.join(clipsDir, `${id}_raw.json`)
  const gtPath = path.join(labelsDir, `${id}.json`)
  if (!fs.existsSync(rawPath) || !fs.existsSync(gtPath)) {
    console.log(`  ${id}: (missing _raw.json or labels)`)
    continue
  }
  const r = oracle(rawPath, gtPath)
  const bs = Object.entries(r.bySource).map(([s, v]) => `${s}=${v}%`).join(' ') || '—'
  console.log(`  ${id.padEnd(40)} oracle=${String(r.overall).padStart(3)}%  [${bs}]  (${r.n} GT)`)
}
