#!/usr/bin/env node
/**
 * Compare an eval run against the frozen regression pin.
 *
 * Gate (per results/README.md): any clip in pin.json.clip_ids that regresses by
 * more than THRESHOLD on a gated metric must be re-justified before merge.
 * Regressions on NON-pinned clips are informational only.
 *
 * Metric polarity:
 *   higher-is-better: detection_coverage, ball_in_crop_pct
 *   lower-is-better:  mean_accel_abs, p95_accel_abs, max_accel_abs
 *
 * Usage:
 *   node compare-to-pin.mjs [results/<sha>.json] [--pin results/pin.json] [--threshold 0.05]
 *   (results defaults to the most recent results/<sha>.json)
 *
 * Exit code: 0 = clean (or improvements only), 1 = unjustified regression(s).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = path.join(__dirname, 'results')

const GATED = [
  { key: 'detection_coverage', higherBetter: true },
  { key: 'ball_in_crop_pct', higherBetter: true },
  { key: 'mean_accel_abs', higherBetter: false },
  { key: 'p95_accel_abs', higherBetter: false },
  { key: 'max_accel_abs', higherBetter: false },
]

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const pinIdx = args.indexOf('--pin')
const pinPath = pinIdx >= 0 ? args[pinIdx + 1] : path.join(RESULTS_DIR, 'pin.json')
const thrIdx = args.indexOf('--threshold')
const THRESHOLD = thrIdx >= 0 ? parseFloat(args[thrIdx + 1]) : 0.05
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--pin' && args[i - 1] !== '--threshold')

function latestResults() {
  const files = fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'pin.json')
    .map((f) => ({ f, t: fs.statSync(path.join(RESULTS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  if (!files.length) throw new Error('No results/<sha>.json runs found — run eval.ts first.')
  return path.join(RESULTS_DIR, files[0].f)
}

const resultsPath = positional[0]
  ? path.resolve(positional[0])
  : latestResults()

// ── Load ─────────────────────────────────────────────────────────────────────
const pin = JSON.parse(fs.readFileSync(pinPath, 'utf-8'))
const run = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'))
const runClips = new Map((run.clips ?? []).map((c) => [c.clip, c]))
const pinClips = new Map((pin.per_clip ?? []).map((c) => [c.clip, c]))

console.log(`\nCompare-to-pin`)
console.log(`  pin:     ${path.basename(pinPath)} (sha ${pin.pinned_sha}, ${pin.pinned_at})`)
console.log(`  run:     ${path.basename(resultsPath)} (sha ${run.git_sha ?? '?'})`)
console.log(`  gate:    >${(THRESHOLD * 100).toFixed(0)}% regression on frozen_holdout clips`)
console.log(`  ${'─'.repeat(64)}`)

const regressions = []
const missing = []

for (const clipId of pin.clip_ids ?? []) {
  const before = pinClips.get(clipId)
  const after = runClips.get(clipId)
  if (!after) {
    missing.push(clipId)
    console.log(`  ⚠ ${clipId}: not present in run — cannot compare`)
    continue
  }
  console.log(`  ${clipId}`)
  for (const { key, higherBetter } of GATED) {
    const o = before?.[key]
    const n = after?.[key]
    if (o == null || n == null) {
      console.log(`      ${key.padEnd(20)} n/a`)
      continue
    }
    // relative change; guard against zero baseline
    const rel = Math.abs(o) < 1e-9 ? (n === o ? 0 : (higherBetter ? (n > 0 ? 1 : -1) : (n > 0 ? 1 : 0))) : (n - o) / Math.abs(o)
    const worse = higherBetter ? rel < -THRESHOLD : rel > THRESHOLD
    const better = higherBetter ? rel > THRESHOLD : rel < -THRESHOLD
    const tag = worse ? 'REGRESS' : better ? 'improve' : 'ok'
    const pct = (rel * 100).toFixed(1).padStart(6)
    const fmt = (v) => (Math.abs(v) < 1 ? v.toFixed(3) : Math.round(v).toString())
    console.log(`      ${key.padEnd(20)} ${fmt(o).padStart(8)} → ${fmt(n).padStart(8)}  ${pct}%  ${tag}`)
    if (worse) regressions.push({ clipId, key, o, n, rel })
  }
}

console.log(`  ${'─'.repeat(64)}`)
if (regressions.length === 0 && missing.length === 0) {
  console.log(`  ✅ PASS — no regressions on ${(pin.clip_ids ?? []).length} frozen_holdout clips.`)
  process.exit(0)
}
if (regressions.length) {
  console.log(`  ❌ FAIL — ${regressions.length} regression(s) >${(THRESHOLD * 100).toFixed(0)}%:`)
  for (const r of regressions)
    console.log(`       ${r.clipId} · ${r.key}: ${(r.rel * 100).toFixed(1)}%`)
  console.log(`  Re-justify in the pin rationale or fix before merge.`)
}
if (missing.length) console.log(`  ⚠ ${missing.length} pinned clip(s) missing from run: ${missing.join(', ')}`)
process.exit(regressions.length ? 1 : 0)
