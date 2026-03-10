/**
 * Eval harness for the portrait crop pipeline.
 *
 * Runs detect_ball.py on test clips, converts → simplifies → scores
 * against human-reviewed ground truth. Outputs a single aggregate score.
 *
 * Usage:
 *   npx tsx eval.ts                   # Run locally (needs GPU or slow on CPU)
 *   npx tsx eval.ts --modal           # Run detection via Modal GPU
 *   npx tsx eval.ts --skip-detect     # Skip detection, use cached raw detections
 *
 * The single output number is the overall score (0–1, higher = better).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// --- Constants (mirrored from src/lib/editor/types.ts) ---
const SOURCE_WIDTH = 1920
const CROP_WIDTH = 608

function ballXToCropX(ballX: number): number {
  return Math.round(
    Math.max(0, Math.min(SOURCE_WIDTH - CROP_WIDTH, ballX - CROP_WIDTH / 2))
  )
}

// --- Config ---
const TEST_DIR = path.resolve(__dirname, '../../public/editor-test')
const GROUND_TRUTH_DIR = path.resolve(
  process.env.HOME || '~',
  'Desktop/review3'
)
const DETECT_SCRIPT = path.resolve(__dirname, 'detect_ball.py')

const TIME_TOLERANCE = 1.0 // seconds
const POSITION_TOLERANCE = 80 // pixels

// --- CLI args ---
const args = process.argv.slice(2)
const useModal = args.includes('--modal')
const skipDetect = args.includes('--skip-detect')
const paramsIdx = args.indexOf('--params')
const paramOverrides: Record<string, number> | undefined =
  paramsIdx >= 0 ? JSON.parse(args[paramsIdx + 1]) : undefined

const detectParamsIdx = args.indexOf('--detect-params')
const detectParamOverrides: Record<string, number> | undefined =
  detectParamsIdx >= 0 ? JSON.parse(args[detectParamsIdx + 1]) : undefined

// --- Types ---
interface RawPosition {
  time: number
  x: number
  y: number
  w?: number
  h?: number
  conf: number
  source: string
}

interface DetectOutput {
  positions: RawPosition[]
  scene_changes: number[]
}

interface CropKeyframe {
  time: number
  x: number
  source: 'ai_ball' | 'ai_tracked' | 'ai_cluster' | 'user'
  confidence: number
}

// --- Convert raw positions to crop keyframes ---
function positionsToCropKeyframes(output: DetectOutput): CropKeyframe[] {
  return output.positions
    .filter((p) => p.x >= 0 && p.source !== 'none')
    .map((p) => ({
      time: p.time,
      x: ballXToCropX(p.x),
      source:
        p.source === 'ball'
          ? ('ai_ball' as const)
          : p.source === 'tracked'
            ? ('ai_tracked' as const)
            : ('ai_cluster' as const),
      confidence: p.source === 'cluster' ? 0.4 : p.conf,
    }))
}

// --- Detection ---
function runDetection(
  videoPath: string,
  detectParams?: Record<string, number>
): DetectOutput {
  if (useModal) {
    const modalUrl = process.env.NEXT_PUBLIC_MODAL_CROP_URL
    if (!modalUrl) throw new Error('NEXT_PUBLIC_MODAL_CROP_URL not set')

    const result = execSync(
      `curl -s -X POST "${modalUrl}" --data-binary @"${videoPath}" -H "Content-Type: application/octet-stream"`,
      { maxBuffer: 50 * 1024 * 1024, timeout: 300_000 }
    )
    return JSON.parse(result.toString())
  }

  // Run locally (supports --params for detection parameter overrides)
  const paramsArg = detectParams
    ? ` --params '${JSON.stringify(detectParams)}'`
    : ''
  const result = execSync(
    `python3 "${DETECT_SCRIPT}" "${videoPath}" --fps 5${paramsArg}`,
    { maxBuffer: 50 * 1024 * 1024, timeout: 300_000 }
  )
  return JSON.parse(result.toString())
}

// --- Scoring ---
function scoreClip(
  generated: CropKeyframe[],
  truth: CropKeyframe[]
): {
  generatedCount: number
  truthCount: number
  correct: number
  missing: number
  extra: number
  avgError: number
  score: number
} {
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
  const avgError =
    matched.length > 0 ? Math.round(totalErrors / matched.length) : 0
  const denom = correct + missing + extra
  const score = denom > 0 ? correct / denom : 0

  return {
    generatedCount: generated.length,
    truthCount: truth.length,
    correct,
    missing,
    extra,
    avgError,
    score,
  }
}

// --- Main ---
async function main() {
  // Import simplify dynamically (it uses TypeScript path aliases via tsx)
  const simplifyModule = await import(
    path.resolve(__dirname, '../../src/lib/editor/simplify.ts')
  )
  const simplifyCropKeyframes = simplifyModule.simplifyCropKeyframes

  // Find clips that have ground truth
  const truthFiles = fs
    .readdirSync(GROUND_TRUTH_DIR)
    .filter((f: string) => f.endsWith('_keyframes.json'))

  const clips: { name: string; video: string; truth: string }[] = []
  for (const tf of truthFiles) {
    const name = tf.replace('_keyframes.json', '')
    const videoPath = path.join(TEST_DIR, `${name}.mp4`)
    if (fs.existsSync(videoPath)) {
      clips.push({
        name,
        video: videoPath,
        truth: path.join(GROUND_TRUTH_DIR, tf),
      })
    }
  }

  if (clips.length === 0) {
    console.error('No matching clips found.')
    process.exit(1)
  }

  console.error(`\n=== Portrait Crop Eval (${clips.length} clips) ===\n`)

  let totalCorrect = 0
  let totalMissing = 0
  let totalExtra = 0
  let totalErrorSum = 0
  let totalMatched = 0
  let totalDetectTime = 0

  for (const clip of clips) {
    let rawOutput: DetectOutput
    const cachedPath = path.join(TEST_DIR, `${clip.name}_raw.json`)
    const detectStart = Date.now()

    if (skipDetect && fs.existsSync(cachedPath)) {
      rawOutput = JSON.parse(fs.readFileSync(cachedPath, 'utf-8'))
      console.error(`[${clip.name}] Using cached detection`)
    } else if (skipDetect) {
      console.error(`[${clip.name}] No cached raw data, skipping`)
      continue
    } else {
      console.error(`[${clip.name}] Running detection...`)
      rawOutput = runDetection(clip.video, detectParamOverrides)
      fs.writeFileSync(cachedPath, JSON.stringify(rawOutput))
    }

    const detectTime = (Date.now() - detectStart) / 1000

    // Convert raw positions → crop keyframes
    const cropKeyframes = positionsToCropKeyframes(rawOutput)

    // Simplify (with optional parameter overrides from CLI)
    const simplified = simplifyCropKeyframes(
      cropKeyframes,
      rawOutput.scene_changes,
      paramOverrides
    )

    // Save simplified keyframes for debugging
    fs.writeFileSync(
      path.join(TEST_DIR, `${clip.name}_keyframes.json`),
      JSON.stringify({ keyframes: simplified }, null, 2)
    )

    // Load ground truth
    const truthData = JSON.parse(fs.readFileSync(clip.truth, 'utf-8'))
    const truthKfs: CropKeyframe[] =
      truthData.keyframes || truthData.positions || []

    // Score
    const result = scoreClip(simplified, truthKfs)

    totalCorrect += result.correct
    totalMissing += result.missing
    totalExtra += result.extra
    const matched = result.generatedCount - result.extra
    totalErrorSum += result.avgError * matched
    totalMatched += matched
    totalDetectTime += detectTime

    console.error(
      `[${clip.name}] gen=${result.generatedCount} truth=${result.truthCount} ` +
        `correct=${result.correct} miss=${result.missing} extra=${result.extra} ` +
        `err=${result.avgError}px score=${result.score.toFixed(3)} ` +
        `detect=${detectTime.toFixed(1)}s`
    )
  }

  const overallDenom = totalCorrect + totalMissing + totalExtra
  const overallScore = overallDenom > 0 ? totalCorrect / overallDenom : 0
  const overallAvgError =
    totalMatched > 0 ? Math.round(totalErrorSum / totalMatched) : 0

  console.error('')
  console.error('=== RESULTS ===')
  console.error(
    `Correct: ${totalCorrect} | Missing: ${totalMissing} | Extra: ${totalExtra}`
  )
  console.error(`Score: ${overallScore.toFixed(3)}`)
  console.error(`Avg Error: ${overallAvgError}px`)
  console.error(`Total Detection Time: ${totalDetectTime.toFixed(1)}s`)

  // Print ONLY the score to stdout — this is what autoresearch reads
  console.log(overallScore.toFixed(4))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
