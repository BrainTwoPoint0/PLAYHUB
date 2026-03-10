import { execSync } from 'child_process'
import { writeFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Inline the conversion logic to avoid tsconfig path resolution issues
const SOURCE_WIDTH = 1920
const CROP_WIDTH = 608

function ballXToCropX(ballX: number): number {
  return Math.round(
    Math.max(0, Math.min(SOURCE_WIDTH - CROP_WIDTH, ballX - CROP_WIDTH / 2))
  )
}

const clipPath = process.argv[2]
if (!clipPath) {
  console.error('Usage: npx tsx run_pipeline.ts <clip.mp4>')
  process.exit(1)
}

const basename = path.basename(clipPath, '.mp4')
console.log(`[${basename}] Running detect_ball.py...`)

const detectScript = path.join(__dirname, 'detect_ball.py')
const raw = execSync(`python3 "${detectScript}" "${clipPath}"`, {
  maxBuffer: 50 * 1024 * 1024,
}).toString()
const detection = JSON.parse(raw)

console.log(
  `[${basename}] ${detection.positions.length} raw detections, ${detection.scene_changes.length} scene changes`
)

// Save raw detections
writeFileSync(`/tmp/${basename}_raw.json`, JSON.stringify(detection, null, 2))

// Convert to crop keyframes
const cropKfs = detection.positions
  .filter((p: any) => p.x >= 0 && p.source !== 'none')
  .map((p: any) => ({
    time: p.time,
    x: ballXToCropX(p.x),
    source:
      p.source === 'ball'
        ? 'ai_ball'
        : p.source === 'tracked'
          ? 'ai_tracked'
          : 'ai_cluster',
    confidence: p.source === 'cluster' ? 0.4 : p.conf,
  }))

// Dynamic import for simplify (works with tsx)
async function run() {
  const { simplifyCropKeyframes } =
    await import('../../src/lib/editor/simplify')
  const simplified = simplifyCropKeyframes(cropKfs, detection.scene_changes)

  console.log(
    `[${basename}] ${cropKfs.length} crop keyframes -> ${simplified.length} simplified`
  )

  const output = {
    keyframes: simplified,
    source_width: SOURCE_WIDTH,
    crop_width: CROP_WIDTH,
    video_filename: basename + '.mp4',
    exported_at: new Date().toISOString(),
  }
  const outPath = path.resolve(
    __dirname,
    '../../public/editor-test',
    `${basename}_keyframes.json`
  )
  writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n')
  console.log(`[${basename}] Saved to ${outPath}`)

  for (const kf of simplified) {
    console.log(
      `  t=${kf.time.toFixed(3)}, x=${kf.x} (${kf.source}, conf=${kf.confidence.toFixed(3)})`
    )
  }
}

run()
