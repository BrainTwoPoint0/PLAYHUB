/**
 * Autoresearch parameter sweep for portrait crop simplification.
 *
 * Sequential hill-climbing: tunes one parameter at a time, locks in the best,
 * then moves to the next. Fast because eval runs in ~1s with --skip-detect.
 *
 * Usage: npx tsx sweep.ts
 */

import { execSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EVAL_SCRIPT = path.resolve(__dirname, 'eval.ts')

interface SweepResult {
  params: Record<string, number>
  score: number
  correct: number
  missing: number
  extra: number
  avgError: number
}

function runEval(params: Record<string, number>): SweepResult {
  const paramsJson = JSON.stringify(params)
  // Merge stdout+stderr into one stream for parsing
  const output = execSync(
    `npx tsx --no-cache "${EVAL_SCRIPT}" --skip-detect --params '${paramsJson}' 2>&1`,
    {
      cwd: path.resolve(__dirname, '../..'),
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
      encoding: 'utf-8',
    }
  )

  // Last line of stdout is the score
  const lines = output.trim().split('\n')
  const score = parseFloat(lines[lines.length - 1])

  const correctMatch = output.match(/Correct: (\d+) \| Missing: (\d+) \| Extra: (\d+)/)
  const errorMatch = output.match(/Avg Error: (\d+)px/)

  return {
    params,
    score,
    correct: correctMatch ? parseInt(correctMatch[1]) : 0,
    missing: correctMatch ? parseInt(correctMatch[2]) : 0,
    extra: correctMatch ? parseInt(correctMatch[3]) : 0,
    avgError: errorMatch ? parseInt(errorMatch[1]) : 0,
  }
}

function printResult(label: string, r: SweepResult) {
  console.log(
    `  ${label.padEnd(30)} → score=${r.score.toFixed(4)} correct=${r.correct} miss=${r.missing} extra=${r.extra} err=${r.avgError}px`
  )
}

async function main() {
  console.log('=== Portrait Crop Autoresearch Sweep ===\n')

  // Phase 0: Baseline
  console.log('Phase 0: Baseline')
  const baseline = runEval({})
  printResult('defaults', baseline)
  console.log()

  let bestParams: Record<string, number> = {}
  let bestScore = baseline.score

  // Phase 1: RDP_TOLERANCE
  console.log('Phase 1: RDP_TOLERANCE (reduces extras via aggressive simplification)')
  const rdpValues = [40, 55, 70, 90, 110, 130, 150]
  let bestRdp = 55
  for (const rdp of rdpValues) {
    const params = { ...bestParams, RDP_TOLERANCE: rdp }
    const r = runEval(params)
    printResult(`RDP_TOLERANCE=${rdp}`, r)
    if (r.score > bestScore) {
      bestScore = r.score
      bestRdp = rdp
    }
  }
  if (bestRdp !== 55) bestParams.RDP_TOLERANCE = bestRdp
  console.log(`  → Best RDP_TOLERANCE: ${bestRdp} (score: ${bestScore.toFixed(4)})`)
  console.log()

  // Phase 2: HIGH_VELOCITY_MIN_VEL (reduces extras from velocity re-insertion)
  console.log('Phase 2: HIGH_VELOCITY_MIN_VEL (raise to reduce re-inserted keyframes)')
  const hvValues = [100, 150, 200, 250, 300, 400]
  let bestHv = 150
  for (const hv of hvValues) {
    const params = { ...bestParams, HIGH_VELOCITY_MIN_VEL: hv }
    const r = runEval(params)
    printResult(`HIGH_VELOCITY_MIN_VEL=${hv}`, r)
    if (r.score > bestScore) {
      bestScore = r.score
      bestHv = hv
    }
  }
  if (bestHv !== 150) bestParams.HIGH_VELOCITY_MIN_VEL = bestHv
  console.log(`  → Best HIGH_VELOCITY_MIN_VEL: ${bestHv} (score: ${bestScore.toFixed(4)})`)
  console.log()

  // Phase 3: FILL_GAP_MAX (reduce gap filling)
  console.log('Phase 3: FILL_GAP_MAX (raise to reduce aggressive gap filling)')
  const fgValues = [3.0, 4.0, 5.0, 6.0, 8.0, 10.0]
  let bestFg = 4.0
  for (const fg of fgValues) {
    const params = { ...bestParams, FILL_GAP_MAX: fg }
    const r = runEval(params)
    printResult(`FILL_GAP_MAX=${fg}`, r)
    if (r.score > bestScore) {
      bestScore = r.score
      bestFg = fg
    }
  }
  if (bestFg !== 4.0) bestParams.FILL_GAP_MAX = bestFg
  console.log(`  → Best FILL_GAP_MAX: ${bestFg} (score: ${bestScore.toFixed(4)})`)
  console.log()

  // Phase 4: HIGH_VELOCITY_MIN_GAP
  console.log('Phase 4: HIGH_VELOCITY_MIN_GAP (raise to reduce velocity preservation)')
  const hgValues = [1.5, 2.0, 3.0, 4.0, 5.0]
  let bestHg = 2.0
  for (const hg of hgValues) {
    const params = { ...bestParams, HIGH_VELOCITY_MIN_GAP: hg }
    const r = runEval(params)
    printResult(`HIGH_VELOCITY_MIN_GAP=${hg}`, r)
    if (r.score > bestScore) {
      bestScore = r.score
      bestHg = hg
    }
  }
  if (bestHg !== 2.0) bestParams.HIGH_VELOCITY_MIN_GAP = bestHg
  console.log(`  → Best HIGH_VELOCITY_MIN_GAP: ${bestHg} (score: ${bestScore.toFixed(4)})`)
  console.log()

  // Phase 5: HOLD_PAN_VELOCITY
  console.log('Phase 5: HOLD_PAN_VELOCITY (raise to reduce hold insertions)')
  const hpvValues = [200, 300, 400, 500, 700, 99999]
  let bestHpv = 300
  for (const hpv of hpvValues) {
    const params = { ...bestParams, HOLD_PAN_VELOCITY: hpv }
    const r = runEval(params)
    printResult(`HOLD_PAN_VELOCITY=${hpv}`, r)
    if (r.score > bestScore) {
      bestScore = r.score
      bestHpv = hpv
    }
  }
  if (bestHpv !== 300) bestParams.HOLD_PAN_VELOCITY = bestHpv
  console.log(`  → Best HOLD_PAN_VELOCITY: ${bestHpv} (score: ${bestScore.toFixed(4)})`)
  console.log()

  // Phase 6: ZIGZAG_THRESHOLD
  console.log('Phase 6: ZIGZAG_THRESHOLD')
  const zzValues = [50, 75, 100, 130, 160, 200]
  let bestZz = 100
  for (const zz of zzValues) {
    const params = { ...bestParams, ZIGZAG_THRESHOLD: zz }
    const r = runEval(params)
    printResult(`ZIGZAG_THRESHOLD=${zz}`, r)
    if (r.score > bestScore) {
      bestScore = r.score
      bestZz = zz
    }
  }
  if (bestZz !== 100) bestParams.ZIGZAG_THRESHOLD = bestZz
  console.log(`  → Best ZIGZAG_THRESHOLD: ${bestZz} (score: ${bestScore.toFixed(4)})`)
  console.log()

  // Phase 7: DEAD_ZONE_PX
  console.log('Phase 7: DEAD_ZONE_PX')
  const dzValues = [20, 30, 50, 80, 120]
  let bestDz = 30
  for (const dz of dzValues) {
    const params = { ...bestParams, DEAD_ZONE_PX: dz }
    const r = runEval(params)
    printResult(`DEAD_ZONE_PX=${dz}`, r)
    if (r.score > bestScore) {
      bestScore = r.score
      bestDz = dz
    }
  }
  if (bestDz !== 30) bestParams.DEAD_ZONE_PX = bestDz
  console.log(`  → Best DEAD_ZONE_PX: ${bestDz} (score: ${bestScore.toFixed(4)})`)
  console.log()

  // Phase 8: NEAR_DUPLICATE_PX and NEAR_DUPLICATE_TIME
  console.log('Phase 8: NEAR_DUPLICATE_PX')
  const ndpValues = [50, 80, 100, 130, 160]
  let bestNdp = 80
  for (const ndp of ndpValues) {
    const params = { ...bestParams, NEAR_DUPLICATE_PX: ndp }
    const r = runEval(params)
    printResult(`NEAR_DUPLICATE_PX=${ndp}`, r)
    if (r.score > bestScore) {
      bestScore = r.score
      bestNdp = ndp
    }
  }
  if (bestNdp !== 80) bestParams.NEAR_DUPLICATE_PX = bestNdp
  console.log(`  → Best NEAR_DUPLICATE_PX: ${bestNdp} (score: ${bestScore.toFixed(4)})`)
  console.log()

  console.log('Phase 9: NEAR_DUPLICATE_TIME')
  const ndtValues = [0.3, 0.5, 0.8, 1.0, 1.5]
  let bestNdt = 0.5
  for (const ndt of ndtValues) {
    const params = { ...bestParams, NEAR_DUPLICATE_TIME: ndt }
    const r = runEval(params)
    printResult(`NEAR_DUPLICATE_TIME=${ndt}`, r)
    if (r.score > bestScore) {
      bestScore = r.score
      bestNdt = ndt
    }
  }
  if (bestNdt !== 0.5) bestParams.NEAR_DUPLICATE_TIME = bestNdt
  console.log(`  → Best NEAR_DUPLICATE_TIME: ${bestNdt} (score: ${bestScore.toFixed(4)})`)
  console.log()

  // Final verification
  console.log('=== FINAL BEST ===')
  const final = runEval(bestParams)
  printResult('optimized', final)
  console.log(`\nBaseline: ${baseline.score.toFixed(4)} → Optimized: ${final.score.toFixed(4)} (${((final.score - baseline.score) / baseline.score * 100).toFixed(1)}% improvement)`)
  console.log(`\nBest parameters:`)
  console.log(JSON.stringify(bestParams, null, 2))
  console.log(`\nTo apply: update DEFAULTS in src/lib/editor/simplify.ts`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
