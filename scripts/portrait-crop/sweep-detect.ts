/**
 * Detection parameter sweep for portrait crop pipeline.
 *
 * Runs detect_ball.py with different parameter combinations, then
 * simplifies + scores against ground truth. Sequential hill-climbing.
 *
 * Usage:
 *   npx tsx sweep-detect.ts                           # 3 worst clips
 *   npx tsx sweep-detect.ts --clips 013015-goal,015432-goal  # Specific clips
 *   npx tsx sweep-detect.ts --clips all               # All clips (slow)
 */

import { execSync } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEST_DIR = path.resolve(__dirname, '../../public/editor-test')
const GROUND_TRUTH_DIR = path.resolve(
  process.env.HOME || '~',
  'Desktop/review3'
)
const DETECT_SCRIPT = path.resolve(__dirname, 'detect_ball.py')

// Default: single worst clip for fast iteration, use --clips worst for all 3
const WORST_CLIPS = ['015432-goal']

const SOURCE_WIDTH = 1920
const CROP_WIDTH = 608
const TIME_TOLERANCE = 1.0
const POSITION_TOLERANCE = 80

function ballXToCropX(ballX: number): number {
  return Math.round(
    Math.max(0, Math.min(SOURCE_WIDTH - CROP_WIDTH, ballX - CROP_WIDTH / 2))
  )
}

interface RawPosition {
  time: number; x: number; y: number; conf: number; source: string
}

interface DetectOutput {
  positions: RawPosition[]; scene_changes: number[]
}

interface CropKeyframe {
  time: number; x: number; source: 'ai_ball' | 'ai_tracked' | 'ai_cluster' | 'user'; confidence: number
}

interface SweepResult {
  params: Record<string, number>
  score: number
  correct: number
  missing: number
  extra: number
  avgError: number
}

function positionsToCropKeyframes(output: DetectOutput): CropKeyframe[] {
  return output.positions
    .filter((p) => p.x >= 0 && p.source !== 'none')
    .map((p) => ({
      time: p.time,
      x: ballXToCropX(p.x),
      source:
        p.source === 'ball' ? ('ai_ball' as const) :
        p.source === 'tracked' ? ('ai_tracked' as const) :
        ('ai_cluster' as const),
      confidence: p.source === 'cluster' ? 0.4 : p.conf,
    }))
}

function scoreClip(generated: CropKeyframe[], truth: CropKeyframe[]) {
  const usedGenerated = new Set<number>()
  const matched: { error: number }[] = []

  for (let ti = 0; ti < truth.length; ti++) {
    let bestIdx = -1
    let bestTimeDist = Infinity
    let bestError = Infinity

    for (let gi = 0; gi < generated.length; gi++) {
      if (usedGenerated.has(gi)) continue
      const timeDist = Math.abs(generated[gi].time - truth[ti].time)
      if (timeDist <= TIME_TOLERANCE && timeDist < bestTimeDist) {
        bestTimeDist = timeDist
        bestIdx = gi
        bestError = Math.abs(generated[gi].x - truth[ti].x)
      }
    }

    if (bestIdx >= 0) {
      usedGenerated.add(bestIdx)
      matched.push({ error: bestError })
    }
  }

  const correct = matched.filter((m) => m.error <= POSITION_TOLERANCE).length
  const missing = truth.length - matched.length
  const extra = generated.length - matched.length
  const totalErrors = matched.reduce((sum, m) => sum + m.error, 0)
  const avgError = matched.length > 0 ? Math.round(totalErrors / matched.length) : 0
  const denom = correct + missing + extra
  const score = denom > 0 ? correct / denom : 0

  return { correct, missing, extra, avgError, score }
}

function getClipList(): string[] {
  const args = process.argv.slice(2)
  const clipsIdx = args.indexOf('--clips')

  if (clipsIdx >= 0 && args[clipsIdx + 1]) {
    const val = args[clipsIdx + 1]
    if (val === 'worst') return WORST_CLIPS
    if (val === 'all') {
      const truthFiles = fs.readdirSync(GROUND_TRUTH_DIR)
        .filter((f: string) => f.endsWith('_keyframes.json'))
      return truthFiles
        .map((f: string) => f.replace('_keyframes.json', ''))
        .filter((name: string) => fs.existsSync(path.join(TEST_DIR, `${name}.mp4`)))
    }
    return val.split(',')
  }

  return WORST_CLIPS
}

// Cache detection results per param hash to avoid re-running
const detectionCache = new Map<string, DetectOutput>()

function runDetection(clipName: string, detectParams: Record<string, number>): DetectOutput | null {
  const cacheKey = `${clipName}:${JSON.stringify(detectParams)}`
  if (detectionCache.has(cacheKey)) return detectionCache.get(cacheKey)!

  const videoPath = path.join(TEST_DIR, `${clipName}.mp4`)
  if (!fs.existsSync(videoPath)) return null

  const paramsArg = Object.keys(detectParams).length > 0
    ? ` --params '${JSON.stringify(detectParams)}'`
    : ''

  try {
    const result = execSync(
      `python3 "${DETECT_SCRIPT}" "${videoPath}" --fps 5${paramsArg} 2>/dev/null`,
      { maxBuffer: 50 * 1024 * 1024, timeout: 600_000, encoding: 'utf-8' }
    )
    const output = JSON.parse(result.trim())
    detectionCache.set(cacheKey, output)
    return output
  } catch (err) {
    console.error(`  Detection failed for ${clipName}: ${(err as Error).message?.slice(0, 80)}`)
    return null
  }
}

async function runEval(detectParams: Record<string, number>, clips: string[]): Promise<SweepResult> {
  // Dynamic import of simplify
  const simplifyModule = await import(
    path.resolve(__dirname, '../../src/lib/editor/simplify.ts')
  )
  const simplifyCropKeyframes = simplifyModule.simplifyCropKeyframes

  let totalCorrect = 0, totalMissing = 0, totalExtra = 0
  let totalErrorSum = 0, totalMatched = 0

  for (const clipName of clips) {
    const truthPath = path.join(GROUND_TRUTH_DIR, `${clipName}_keyframes.json`)
    if (!fs.existsSync(truthPath)) continue

    const rawOutput = runDetection(clipName, detectParams)
    if (!rawOutput) continue

    const cropKeyframes = positionsToCropKeyframes(rawOutput)
    const simplified = simplifyCropKeyframes(cropKeyframes, rawOutput.scene_changes)
    const truthData = JSON.parse(fs.readFileSync(truthPath, 'utf-8'))
    const truthKfs: CropKeyframe[] = truthData.keyframes || truthData.positions || []

    const result = scoreClip(simplified, truthKfs)
    totalCorrect += result.correct
    totalMissing += result.missing
    totalExtra += result.extra
    const matched = simplified.length - result.extra
    totalErrorSum += result.avgError * matched
    totalMatched += matched
  }

  const denom = totalCorrect + totalMissing + totalExtra
  return {
    params: detectParams,
    score: denom > 0 ? totalCorrect / denom : 0,
    correct: totalCorrect,
    missing: totalMissing,
    extra: totalExtra,
    avgError: totalMatched > 0 ? Math.round(totalErrorSum / totalMatched) : 0,
  }
}

function printResult(label: string, r: SweepResult) {
  console.log(
    `  ${label.padEnd(35)} → score=${r.score.toFixed(4)} correct=${r.correct} miss=${r.missing} extra=${r.extra} err=${r.avgError}px`
  )
}

async function main() {
  const clips = getClipList()
  console.log(`=== Detection Parameter Sweep (${clips.length} clips) ===`)
  console.log(`Clips: ${clips.join(', ')}\n`)

  // Phase 0: Baseline
  console.log('Phase 0: Baseline')
  const baseline = await runEval({}, clips)
  printResult('defaults', baseline)
  console.log()

  let bestParams: Record<string, number> = {}
  let bestScore = baseline.score

  async function sweepPhase(
    name: string,
    paramName: string,
    values: number[],
    defaultVal: number
  ) {
    console.log(`Phase: ${name}`)
    let bestVal = defaultVal
    for (const val of values) {
      const params = { ...bestParams, [paramName]: val }
      const r = await runEval(params, clips)
      printResult(`${paramName}=${val}`, r)
      if (r.score > bestScore) {
        bestScore = r.score
        bestVal = val
      }
    }
    if (bestVal !== defaultVal) bestParams[paramName] = bestVal
    console.log(`  → Best ${paramName}: ${bestVal} (score: ${bestScore.toFixed(4)})\n`)
  }

  // Sweep detection parameters — highest impact first, 3 values each to keep runtime ~30min
  // (each detection run = ~3.3min on CPU × 3 clips = ~10min per value)
  await sweepPhase('MIN_BALL_CONFIDENCE', 'MIN_BALL_CONFIDENCE', [0.20, 0.30, 0.35], 0.35)
  await sweepPhase('IQR_MULTIPLIER', 'IQR_MULTIPLIER', [1.5, 2.0, 3.0], 2.0)
  await sweepPhase('KALMAN_R', 'KALMAN_R', [1.0, 4.0, 8.0], 4.0)
  await sweepPhase('BIDIR_MAX_GAP_TIME', 'BIDIR_MAX_GAP_TIME', [2.0, 3.0, 5.0], 3.0)
  await sweepPhase('EARLY_CONF_GATE', 'EARLY_CONF_GATE', [0.3, 0.5, 0.7], 0.5)
  await sweepPhase('TRACKER_HIT_COUNTER_MAX', 'TRACKER_HIT_COUNTER_MAX', [25, 50, 100], 50)

  // Final verification
  console.log('=== FINAL BEST ===')
  const final = await runEval(bestParams, clips)
  printResult('optimized', final)
  const improvement = baseline.score > 0
    ? ((final.score - baseline.score) / baseline.score * 100).toFixed(1)
    : 'N/A'
  console.log(`\nBaseline: ${baseline.score.toFixed(4)} → Optimized: ${final.score.toFixed(4)} (${improvement}% improvement)`)
  console.log(`\nBest detection parameters:`)
  console.log(JSON.stringify(bestParams, null, 2))
  console.log(`\nTo apply: update globals in scripts/portrait-crop/detect_ball.py`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
