/**
 * Eval harness for the portrait crop pipeline.
 *
 * Runs detection, simplification, and computes real metrics:
 *   - Ball detection recall @ precision 0.9 (when dense ball GT exists)
 *   - Dense ball-in-crop %               (measured every video frame)
 *   - Mean |crop-x acceleration|         (jitter proxy)
 *   - Max |crop-x acceleration| (p95)    (catastrophic-jerk detector)
 *   - Fragmentation rate                 (contiguous ball-source runs)
 *   - Legacy keyframe-match score        (back-compat with old GT)
 *
 * Ground-truth sources (searched in order):
 *   1. eval-dataset/labels/<clip>.json   (new dense format, ball x/y per frame)
 *   2. ~/Desktop/review3/<clip>_keyframes.json  (legacy crop-keyframe GT)
 *
 * Output:
 *   - stdout: single aggregate score (0–1) — keeps --skip-detect sweeps working
 *   - stderr: per-clip breakdown
 *   - results/<short-sha>.json: full metrics for regression diffing
 *
 * Usage:
 *   npx tsx eval.ts                    # Local detection (slow on CPU)
 *   npx tsx eval.ts --modal            # Modal GPU detection
 *   npx tsx eval.ts --skip-detect      # Re-score from cached _raw.json
 *   npx tsx eval.ts --dataset eval-dataset  # Use the new-format dataset
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Constants (mirrored from src/lib/editor/types.ts) ──────────────
const SOURCE_WIDTH = 1920
const CROP_WIDTH = 608

function ballXToCropX(ballX: number): number {
  return Math.round(
    Math.max(0, Math.min(SOURCE_WIDTH - CROP_WIDTH, ballX - CROP_WIDTH / 2))
  )
}

// ── Config ─────────────────────────────────────────────────────────
const DETECT_SCRIPT = path.resolve(__dirname, 'detect_ball.py')

// Legacy keyframe match tolerances (back-compat with old scorer)
const TIME_TOLERANCE = 1.0
const POSITION_TOLERANCE = 80

// Detection recall vs. dense GT: match within this radius (px)
const RECALL_MATCH_RADIUS = 60
// Target precision for recall reporting
const RECALL_PRECISION_TARGET = 0.9

// ── CLI ────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const useModal = args.includes('--modal')
const skipDetect = args.includes('--skip-detect')
const datasetIdx = args.indexOf('--dataset')
const datasetDir = datasetIdx >= 0 ? args[datasetIdx + 1] : 'eval-dataset'
const paramsIdx = args.indexOf('--params')
const paramOverrides: Record<string, number> | undefined =
  paramsIdx >= 0 ? JSON.parse(args[paramsIdx + 1]) : undefined
const detectParamsIdx = args.indexOf('--detect-params')
const detectParamOverrides: Record<string, number> | undefined =
  detectParamsIdx >= 0 ? JSON.parse(args[detectParamsIdx + 1]) : undefined

// ── Types ──────────────────────────────────────────────────────────
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

interface DenseLabel {
  frame: number
  t: number
  ball: { x?: number; y?: number; visible: boolean }
}

interface DenseGroundTruth {
  clip_id: string
  dense: boolean
  label_fps: number
  frames: DenseLabel[]
}

interface ClipMetrics {
  clip: string
  frames_sampled: number
  detection_coverage: number
  fragmentation_rate: number
  mean_accel_abs: number // px/s²
  p95_accel_abs: number // px/s²
  max_accel_abs: number // px/s²
  ball_in_crop_pct: number | null // % (vs. GT ball pos, or vs. detected pos if no GT)
  ball_in_crop_source: 'gt' | 'detected' | 'none'
  detection_recall_at_p90: number | null // 0-1 (only with dense GT)
  legacy_keyframe_score: number | null // 0-1 (only with old-format GT)
  detect_seconds: number
}

// ── Loaders ────────────────────────────────────────────────────────
function positionsToCropKeyframes(output: DetectOutput): CropKeyframe[] {
  return output.positions
    .filter((p) => p.x >= 0 && p.source !== 'none')
    .map((p) => ({
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
}

function runDetection(
  videoPath: string,
  detectParams?: Record<string, number>
): DetectOutput {
  if (useModal) {
    const modalUrl = process.env.NEXT_PUBLIC_MODAL_CROP_URL
    if (!modalUrl) throw new Error('NEXT_PUBLIC_MODAL_CROP_URL not set')
    // Match Modal's 10-min function timeout; curl gets one extra minute of slack.
    const result = execSync(
      `curl -s --max-time 660 -X POST "${modalUrl}" --data-binary @"${videoPath}" -H "Content-Type: application/octet-stream"`,
      { maxBuffer: 50 * 1024 * 1024, timeout: 700_000 }
    )
    return JSON.parse(result.toString())
  }

  const paramsArg = detectParams
    ? ` --params '${JSON.stringify(detectParams)}'`
    : ''
  const result = execSync(
    `python3 "${DETECT_SCRIPT}" "${videoPath}" --fps 25${paramsArg}`,
    { maxBuffer: 50 * 1024 * 1024, timeout: 300_000 }
  )
  return JSON.parse(result.toString())
}

function loadDenseGT(clipName: string): DenseGroundTruth | null {
  const candidate = path.resolve(
    __dirname,
    datasetDir,
    'labels',
    `${clipName}.json`
  )
  if (!fs.existsSync(candidate)) return null
  const raw = JSON.parse(fs.readFileSync(candidate, 'utf-8'))
  if (!raw || !Array.isArray(raw.frames)) return null
  return raw as DenseGroundTruth
}

function loadLegacyGT(clipName: string): CropKeyframe[] | null {
  const candidate = path.resolve(
    process.env.HOME || '~',
    'Desktop/review3',
    `${clipName}_keyframes.json`
  )
  if (!fs.existsSync(candidate)) return null
  const raw = JSON.parse(fs.readFileSync(candidate, 'utf-8'))
  return (raw.keyframes || raw.positions || []) as CropKeyframe[]
}

// ── Per-frame interpolation (matches editor's linear interp + splits) ──
function interpolateCropX(
  keyframes: CropKeyframe[],
  time: number,
  splits: number[] = []
): number {
  if (keyframes.length === 0) return (SOURCE_WIDTH - CROP_WIDTH) / 2
  if (time <= keyframes[0].time) return keyframes[0].x
  if (time >= keyframes[keyframes.length - 1].time)
    return keyframes[keyframes.length - 1].x

  let i = 0
  while (i < keyframes.length - 1 && keyframes[i + 1].time <= time) i++
  if (i >= keyframes.length - 1) return keyframes[keyframes.length - 1].x

  const a = keyframes[i]
  const b = keyframes[i + 1]
  const splitBetween = splits.find((s) => s > a.time && s < b.time)
  if (splitBetween !== undefined) return time < splitBetween ? a.x : b.x

  const t = (time - a.time) / (b.time - a.time)
  return Math.round(a.x + (b.x - a.x) * t)
}

// ── Metrics ────────────────────────────────────────────────────────

/**
 * Build the per-frame crop-x signal the user would actually see, by
 * interpolating the simplified keyframes at video fps.
 */
function buildPerFrameCropX(
  simplified: CropKeyframe[],
  splits: number[],
  fps: number,
  duration: number
): number[] {
  const total = Math.ceil(duration * fps)
  const out = new Array<number>(total)
  for (let f = 0; f < total; f++) {
    out[f] = interpolateCropX(simplified, f / fps, splits)
  }
  return out
}

/** |accel| stats in px/s² — signal quality regardless of GT. */
function accelStats(perFrameCropX: number[], fps: number) {
  const n = perFrameCropX.length
  if (n < 3) {
    return { mean: 0, p95: 0, max: 0 }
  }
  const accels: number[] = []
  for (let i = 1; i < n - 1; i++) {
    // second difference in px/frame² → convert to px/s²
    const a =
      (perFrameCropX[i + 1] - 2 * perFrameCropX[i] + perFrameCropX[i - 1]) *
      fps *
      fps
    accels.push(Math.abs(a))
  }
  accels.sort((x, y) => x - y)
  const mean = accels.reduce((s, x) => s + x, 0) / accels.length
  const p95 =
    accels[Math.min(accels.length - 1, Math.floor(accels.length * 0.95))]
  const max = accels[accels.length - 1]
  return { mean, p95, max }
}

/** Count contiguous ball-source runs in raw detections. */
function fragmentationRate(raw: RawPosition[]): number {
  if (raw.length === 0) return 0
  let fragments = 0
  let inBall = false
  for (const p of raw) {
    const isBall = p.source === 'ball'
    if (isBall && !inBall) fragments++
    inBall = isBall
  }
  return fragments / raw.length
}

/**
 * Detection coverage: fraction of raw-detection frames where the source was "ball".
 * "tracked"/"cluster" are Kalman/centroid fallbacks, not real detections.
 */
function detectionCoverage(raw: RawPosition[]): number {
  if (raw.length === 0) return 0
  const ballFrames = raw.filter((p) => p.source === 'ball').length
  return ballFrames / raw.length
}

/**
 * Detection recall at target precision. Requires dense ball GT.
 * Iterates confidence thresholds, picks the highest recall where precision ≥ target.
 */
function detectionRecallAtPrecision(
  detections: RawPosition[],
  gt: DenseGroundTruth,
  matchRadius: number,
  precisionTarget: number
): number {
  const gtByFrame = new Map<number, DenseLabel>()
  for (const f of gt.frames) gtByFrame.set(f.frame, f)

  // For each detection, find the nearest same-frame GT and record match distance.
  // Needs frame-correlation — approximate by nearest-time GT within 1/(2*label_fps).
  const labelStep = 1 / gt.label_fps
  const hits: { conf: number; matched: boolean }[] = []
  const matchedGt = new Set<number>()

  // Sort detections by confidence desc for greedy matching.
  const ballDets = detections
    .filter((d) => d.source === 'ball')
    .slice()
    .sort((a, b) => b.conf - a.conf)

  for (const d of ballDets) {
    let best: DenseLabel | null = null
    let bestDt = Infinity
    for (const g of gt.frames) {
      const dt = Math.abs(g.t - d.time)
      if (dt > labelStep) continue
      if (dt < bestDt) {
        bestDt = dt
        best = g
      }
    }
    if (!best || !best.ball.visible || matchedGt.has(best.frame)) {
      hits.push({ conf: d.conf, matched: false })
      continue
    }
    const dx = (best.ball.x ?? 0) - d.x
    const dy = (best.ball.y ?? 0) - d.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist <= matchRadius) {
      matchedGt.add(best.frame)
      hits.push({ conf: d.conf, matched: true })
    } else {
      hits.push({ conf: d.conf, matched: false })
    }
  }

  const totalVisibleGt = gt.frames.filter((f) => f.ball.visible).length
  if (totalVisibleGt === 0) return 0

  // Sweep thresholds — find highest recall where precision ≥ target.
  let bestRecall = 0
  let tp = 0
  let fp = 0
  // hits already sorted by conf desc
  for (let i = 0; i < hits.length; i++) {
    if (hits[i].matched) tp++
    else fp++
    const precision = tp / (tp + fp)
    const recall = tp / totalVisibleGt
    if (precision >= precisionTarget && recall > bestRecall) {
      bestRecall = recall
    }
  }
  return bestRecall
}

/**
 * Dense ball-in-crop %: for every visible-ball GT frame (or every detected
 * ball frame if no GT), check whether the ball is inside the smoothed crop.
 */
function ballInCropPct(
  perFrameCropX: number[],
  fps: number,
  gt: DenseGroundTruth | null,
  detections: RawPosition[]
): { pct: number; source: ClipMetrics['ball_in_crop_source'] } {
  type Pt = { t: number; x: number }
  let points: Pt[] = []
  let source: ClipMetrics['ball_in_crop_source']

  if (gt) {
    points = gt.frames
      .filter((f) => f.ball.visible && typeof f.ball.x === 'number')
      .map((f) => ({ t: f.t, x: f.ball.x as number }))
    source = 'gt'
  } else {
    points = detections
      .filter((d) => d.source === 'ball' && d.x >= 0)
      .map((d) => ({ t: d.time, x: d.x }))
    source = 'detected'
  }

  if (points.length === 0) return { pct: 0, source: 'none' }

  let inside = 0
  for (const p of points) {
    const frame = Math.round(p.t * fps)
    if (frame < 0 || frame >= perFrameCropX.length) continue
    const cropX = perFrameCropX[frame]
    if (p.x >= cropX && p.x <= cropX + CROP_WIDTH) inside++
  }
  return { pct: inside / points.length, source }
}

/** Legacy Jaccard-on-keyframes (back-compat). */
function legacyKeyframeMatch(
  generated: CropKeyframe[],
  truth: CropKeyframe[]
): number {
  const used = new Set<number>()
  let correct = 0
  for (const t of truth) {
    let bestIdx = -1
    let bestDt = Infinity
    let bestErr = Infinity
    for (let g = 0; g < generated.length; g++) {
      if (used.has(g)) continue
      const dt = Math.abs(generated[g].time - t.time)
      if (dt <= TIME_TOLERANCE && dt < bestDt) {
        bestDt = dt
        bestIdx = g
        bestErr = Math.abs(generated[g].x - t.x)
      }
    }
    if (bestIdx >= 0) {
      used.add(bestIdx)
      if (bestErr <= POSITION_TOLERANCE) correct++
    }
  }
  const denom =
    correct + (truth.length - correct) + (generated.length - correct)
  return denom > 0 ? correct / denom : 0
}

// ── Video probe ────────────────────────────────────────────────────
function probeVideo(videoPath: string): { fps: number; duration: number } {
  const out = execSync(
    `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -show_entries format=duration -of json "${videoPath}"`,
    { encoding: 'utf-8' }
  )
  const probe = JSON.parse(out)
  const [fpsNum, fpsDen] = (probe.streams[0].r_frame_rate as string)
    .split('/')
    .map(Number)
  const fps = fpsDen ? fpsNum / fpsDen : 30
  const duration = parseFloat(probe.format.duration)
  return { fps, duration }
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  // Simplification pipeline (what the editor uses)
  const simplifyModule = (await import(
    path.resolve(__dirname, '../../src/lib/editor/simplify.ts')
  )) as {
    simplifyCropKeyframes: (
      kf: CropKeyframe[],
      splits: number[],
      overrides?: Record<string, number>
    ) => CropKeyframe[]
  }
  const simplifyCropKeyframes = simplifyModule.simplifyCropKeyframes

  // Discover clips: videos in public/editor-test/ OR in eval-dataset/clips/
  const legacyDir = path.resolve(__dirname, '../../public/editor-test')
  const newDir = path.resolve(__dirname, datasetDir, 'clips')
  const candidates = new Map<string, string>() // id → video path

  for (const dir of [newDir, legacyDir]) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.mp4')) continue
      const id = f.replace(/\.mp4$/, '')
      if (!candidates.has(id)) candidates.set(id, path.join(dir, f))
    }
  }

  if (candidates.size === 0) {
    console.error('No test clips found.')
    process.exit(1)
  }

  console.error(`\n=== Portrait Crop Eval (${candidates.size} clips) ===\n`)

  const resultsDir = path.resolve(__dirname, datasetDir, 'results')
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true })

  const perClip: ClipMetrics[] = []

  for (const [clipId, videoPath] of candidates) {
    const cachedRaw = path.resolve(
      path.dirname(videoPath),
      `${clipId}_raw.json`
    )
    let rawOutput: DetectOutput
    const detectStart = Date.now()

    if (skipDetect && fs.existsSync(cachedRaw)) {
      rawOutput = JSON.parse(fs.readFileSync(cachedRaw, 'utf-8'))
    } else if (skipDetect) {
      console.error(`[${clipId}] No cached detection — skipping`)
      continue
    } else {
      console.error(`[${clipId}] Detecting...`)
      try {
        rawOutput = runDetection(videoPath, detectParamOverrides)
        fs.writeFileSync(cachedRaw, JSON.stringify(rawOutput))
      } catch (err) {
        console.error(
          `[${clipId}] Detection failed: ${err instanceof Error ? err.message : err}`
        )
        continue
      }
    }
    const detectSec = (Date.now() - detectStart) / 1000

    const { fps, duration } = probeVideo(videoPath)

    // Simplify → per-frame crop signal (what the user sees)
    const cropKfs = positionsToCropKeyframes(rawOutput)
    const simplified = simplifyCropKeyframes(
      cropKfs,
      rawOutput.scene_changes,
      paramOverrides
    )
    const perFrameCropX = buildPerFrameCropX(
      simplified,
      rawOutput.scene_changes,
      fps,
      duration
    )

    // Metrics
    const accel = accelStats(perFrameCropX, fps)
    const gt = loadDenseGT(clipId)
    const legacy = loadLegacyGT(clipId)
    const inCrop = ballInCropPct(perFrameCropX, fps, gt, rawOutput.positions)
    const recall = gt
      ? detectionRecallAtPrecision(
          rawOutput.positions,
          gt,
          RECALL_MATCH_RADIUS,
          RECALL_PRECISION_TARGET
        )
      : null
    const legacyScore = legacy ? legacyKeyframeMatch(simplified, legacy) : null

    const m: ClipMetrics = {
      clip: clipId,
      frames_sampled: rawOutput.positions.length,
      detection_coverage: detectionCoverage(rawOutput.positions),
      fragmentation_rate: fragmentationRate(rawOutput.positions),
      mean_accel_abs: Math.round(accel.mean),
      p95_accel_abs: Math.round(accel.p95),
      max_accel_abs: Math.round(accel.max),
      ball_in_crop_pct: inCrop.source === 'none' ? null : inCrop.pct,
      ball_in_crop_source: inCrop.source,
      detection_recall_at_p90: recall,
      legacy_keyframe_score: legacyScore,
      detect_seconds: detectSec,
    }
    perClip.push(m)

    console.error(
      `[${clipId}] coverage=${(m.detection_coverage * 100).toFixed(0)}% ` +
        `in-crop(${m.ball_in_crop_source})=${m.ball_in_crop_pct !== null ? (m.ball_in_crop_pct * 100).toFixed(0) + '%' : 'n/a'} ` +
        `mean-accel=${m.mean_accel_abs}px/s² p95=${m.p95_accel_abs} ` +
        `frag=${(m.fragmentation_rate * 100).toFixed(0)}% ` +
        `recall@0.9=${m.detection_recall_at_p90 !== null ? (m.detection_recall_at_p90 * 100).toFixed(0) + '%' : 'n/a'} ` +
        `legacy=${m.legacy_keyframe_score !== null ? m.legacy_keyframe_score.toFixed(3) : 'n/a'} ` +
        `detect=${m.detect_seconds.toFixed(1)}s`
    )
  }

  // ── Aggregate ─────────────────────────────────────────────────────
  const n = perClip.length
  const avg = (xs: number[]) =>
    xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : 0
  const collect = (k: keyof ClipMetrics): number[] =>
    perClip
      .map((m) => m[k] as unknown)
      .filter((x): x is number => typeof x === 'number' && !isNaN(x))

  const summary = {
    clips: n,
    mean_detection_coverage: avg(collect('detection_coverage')),
    mean_fragmentation_rate: avg(collect('fragmentation_rate')),
    mean_accel_abs: Math.round(avg(collect('mean_accel_abs'))),
    max_p95_accel_abs: Math.max(0, ...collect('p95_accel_abs')),
    max_max_accel_abs: Math.max(0, ...collect('max_accel_abs')),
    mean_ball_in_crop_pct: avg(collect('ball_in_crop_pct')),
    mean_detection_recall_at_p90: avg(collect('detection_recall_at_p90')),
    mean_legacy_score: avg(collect('legacy_keyframe_score')),
    total_detect_seconds: perClip.reduce((s, m) => s + m.detect_seconds, 0),
  }

  console.error('\n=== AGGREGATE ===')
  console.error(`Clips:                  ${summary.clips}`)
  console.error(
    `Detection coverage:     ${(summary.mean_detection_coverage * 100).toFixed(1)}%`
  )
  console.error(
    `Fragmentation rate:     ${(summary.mean_fragmentation_rate * 100).toFixed(1)}%`
  )
  console.error(
    `Mean accel:             ${summary.mean_accel_abs} px/s²  (target <500)`
  )
  console.error(
    `Max p95 accel:          ${summary.max_p95_accel_abs} px/s²  (target <2000)`
  )
  console.error(
    `Max peak accel:         ${summary.max_max_accel_abs} px/s²  (spike detector)`
  )
  console.error(
    `Ball-in-crop:           ${(summary.mean_ball_in_crop_pct * 100).toFixed(1)}%  (target ≥95)`
  )
  if (summary.mean_detection_recall_at_p90 > 0)
    console.error(
      `Detection recall@p0.9:  ${(summary.mean_detection_recall_at_p90 * 100).toFixed(1)}%  (target ≥92)`
    )
  if (summary.mean_legacy_score > 0)
    console.error(
      `Legacy keyframe match:  ${summary.mean_legacy_score.toFixed(3)}  (back-compat)`
    )

  // ── Write JSON ────────────────────────────────────────────────────
  let gitSha = 'unknown'
  try {
    gitSha = execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8',
    }).trim()
  } catch {
    /* not in a git repo */
  }
  const resultsPath = path.resolve(resultsDir, `${gitSha}.json`)
  const payload = {
    git_sha: gitSha,
    ran_at: new Date().toISOString(),
    dataset_dir: datasetDir,
    used_modal: useModal,
    skip_detect: skipDetect,
    param_overrides: paramOverrides ?? null,
    detect_param_overrides: detectParamOverrides ?? null,
    summary,
    clips: perClip,
  }
  fs.writeFileSync(resultsPath, JSON.stringify(payload, null, 2))
  console.error(`\nWrote ${resultsPath}`)

  // ── stdout: single aggregate score for autoresearch ──────────────
  // Use ball-in-crop% when GT-backed, else legacy score, else coverage.
  const primary =
    summary.mean_ball_in_crop_pct > 0
      ? summary.mean_ball_in_crop_pct
      : summary.mean_legacy_score > 0
        ? summary.mean_legacy_score
        : summary.mean_detection_coverage
  console.log(primary.toFixed(4))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
