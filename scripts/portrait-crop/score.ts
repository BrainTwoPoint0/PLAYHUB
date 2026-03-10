import fs from 'fs'
import path from 'path'

// --- Config ---
const GENERATED_DIR =
  '/Users/karimfawaz/Dev Projects/PLAYBACK Workspace/PLAYHUB/public/editor-test'
const GROUND_TRUTH_DIR = '/Users/karimfawaz/Desktop/review3'
const TIME_TOLERANCE = 1.0 // seconds — max time gap to consider a match
const POSITION_TOLERANCE = 80 // pixels — max x error to count as correct

// --- Types ---
interface Keyframe {
  time: number
  x: number
  source?: string
  confidence?: number
}

interface KeyframeFile {
  keyframes: Keyframe[]
  source_width?: number
  crop_width?: number
  video_filename?: string
}

interface ClipResult {
  clip: string
  generatedCount: number
  userCount: number
  correct: number
  missing: number
  extra: number
  avgError: number
  score: number
}

// --- Helpers ---
function readKeyframes(filePath: string): Keyframe[] {
  const raw = fs.readFileSync(filePath, 'utf-8')
  const data = JSON.parse(raw)
  // Support both formats: ground truth uses "keyframes", detect_ball.py uses "positions"
  return data.keyframes || data.positions || []
}

function findMatchingClips(): {
  clip: string
  generated: string
  truth: string
}[] {
  const truthFiles = fs
    .readdirSync(GROUND_TRUTH_DIR)
    .filter((f) => f.endsWith('_keyframes.json'))

  const pairs: { clip: string; generated: string; truth: string }[] = []

  for (const file of truthFiles) {
    const generatedPath = path.join(GENERATED_DIR, file)
    const truthPath = path.join(GROUND_TRUTH_DIR, file)

    if (fs.existsSync(generatedPath)) {
      const clip = file.replace('_keyframes.json', '')
      pairs.push({ clip, generated: generatedPath, truth: truthPath })
    }
  }

  return pairs.sort((a, b) => a.clip.localeCompare(b.clip))
}

function scoreClip(generatedKFs: Keyframe[], truthKFs: Keyframe[]): ClipResult {
  // Greedy matching: for each truth KF, find closest unmatched generated KF within tolerance
  const usedGenerated = new Set<number>()
  const matched: { truthIdx: number; genIdx: number; error: number }[] = []

  for (let ti = 0; ti < truthKFs.length; ti++) {
    let bestIdx = -1
    let bestTimeDist = Infinity
    let bestError = Infinity

    for (let gi = 0; gi < generatedKFs.length; gi++) {
      if (usedGenerated.has(gi)) continue

      const timeDist = Math.abs(generatedKFs[gi].time - truthKFs[ti].time)
      if (timeDist <= TIME_TOLERANCE && timeDist < bestTimeDist) {
        bestTimeDist = timeDist
        bestIdx = gi
        bestError = Math.abs(generatedKFs[gi].x - truthKFs[ti].x)
      }
    }

    if (bestIdx >= 0) {
      usedGenerated.add(bestIdx)
      matched.push({ truthIdx: ti, genIdx: bestIdx, error: bestError })
    }
  }

  const correct = matched.filter((m) => m.error <= POSITION_TOLERANCE).length
  const missing = truthKFs.length - matched.length
  const extra = generatedKFs.length - matched.length
  const totalErrors = matched.reduce((sum, m) => sum + m.error, 0)
  const avgError =
    matched.length > 0 ? Math.round(totalErrors / matched.length) : 0
  const denominator = correct + missing + extra
  const score = denominator > 0 ? correct / denominator : 0

  return {
    clip: '',
    generatedCount: generatedKFs.length,
    userCount: truthKFs.length,
    correct,
    missing,
    extra,
    avgError,
    score,
  }
}

// --- Main ---
function main() {
  const pairs = findMatchingClips()

  if (pairs.length === 0) {
    console.log('No matching clip pairs found.')
    console.log(`  Generated dir: ${GENERATED_DIR}`)
    console.log(`  Ground truth dir: ${GROUND_TRUTH_DIR}`)
    process.exit(1)
  }

  console.log('=== Portrait Crop Pipeline Scoring ===\n')

  let totalCorrect = 0
  let totalMissing = 0
  let totalExtra = 0
  let totalErrorSum = 0
  let totalMatched = 0

  const results: ClipResult[] = []

  for (const pair of pairs) {
    const generated = readKeyframes(pair.generated)
    const truth = readKeyframes(pair.truth)
    const result = scoreClip(generated, truth)
    result.clip = pair.clip
    results.push(result)

    totalCorrect += result.correct
    totalMissing += result.missing
    totalExtra += result.extra
    // Recompute matched count for weighted avg error
    const matched = result.generatedCount - result.extra
    totalErrorSum += result.avgError * matched
    totalMatched += matched

    console.log(`Clip: ${result.clip}`)
    console.log(
      `  Generated: ${result.generatedCount} KFs | User: ${result.userCount} KFs`
    )
    console.log(
      `  Correct: ${result.correct} | Missing: ${result.missing} | Extra: ${result.extra} | Avg Error: ${result.avgError}px`
    )
    console.log(`  Score: ${result.score.toFixed(3)}`)
    console.log()
  }

  const overallDenom = totalCorrect + totalMissing + totalExtra
  const overallScore = overallDenom > 0 ? totalCorrect / overallDenom : 0
  const overallAvgError =
    totalMatched > 0 ? Math.round(totalErrorSum / totalMatched) : 0

  console.log('=== OVERALL ===')
  console.log(
    `Total Correct: ${totalCorrect} | Missing: ${totalMissing} | Extra: ${totalExtra}`
  )
  console.log(`Overall Score: ${overallScore.toFixed(3)} (higher = better)`)
  console.log(`Avg Position Error: ${overallAvgError}px`)
  console.log(`Clips Scored: ${pairs.length}`)
}

main()
