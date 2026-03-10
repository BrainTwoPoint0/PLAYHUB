/**
 * Portrait Crop — YOLO Ball Detection + Smart Keyframes + FFmpeg
 *
 * Takes a Veo goal clip (1920x1080 landscape), uses Forzasys YOLO to detect
 * the ball's position, reduces to smart keyframes with dead zone + easing,
 * and produces a 9:16 portrait crop that follows the action.
 *
 * Usage: npx tsx crop.ts <input.mp4> [output.mp4]
 */

import { resolve, dirname, basename, extname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, statSync, writeFileSync, readdirSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Config ──────────────────────────────────────────────────────────

// Source dimensions (Veo goal clips)
const SRC_W = 1920
const SRC_H = 1080

// Portrait 9:16 crop from source
const CROP_W = Math.round(SRC_H * (9 / 16)) // 608px (at source height)
const CROP_MAX_X = SRC_W - CROP_W // 1312 — max x offset

// Output dimensions
const OUT_W = 1080
const OUT_H = 1920

// Detection
const DETECT_FPS = 5

// ── Validation ──────────────────────────────────────────────────────

function checkDeps() {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' })
  } catch {
    console.error('FFmpeg not found. Install with: brew install ffmpeg')
    process.exit(1)
  }
  try {
    execSync('python3 -c "from ultralytics import YOLO"', { stdio: 'ignore' })
  } catch {
    console.error(
      'Ultralytics not found. Install with: pip3 install ultralytics'
    )
    process.exit(1)
  }
}

// ── YOLO Ball Detection (via Python) ────────────────────────────────

interface BallPosition {
  time: number // seconds
  x: number // pixels (0-1920)
  y: number // pixels (0-1080)
  conf: number // 0-1
  source: 'ball' | 'tracked' | 'cluster' | 'none'
}

interface Candidate {
  x: number
  y: number
  w: number
  h: number
  conf: number
}

interface FrameCandidates {
  time: number
  detections: Candidate[]
}

interface DetectionResult {
  positions: BallPosition[]
  sceneChanges: number[] // timestamps where camera angle switches
  allCandidates: FrameCandidates[] // all detections per frame for trajectory selection
}

function detectBall(videoPath: string): DetectionResult {
  console.log(`  Detecting ball with Forzasys YOLO at ${DETECT_FPS}fps...`)
  const start = Date.now()

  const scriptPath = resolve(__dirname, 'detect_ball.py')
  const output = execSync(
    `python3 "${scriptPath}" "${videoPath}" --fps ${DETECT_FPS}`,
    { encoding: 'utf-8', timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }
  )

  // Python script outputs JSON to stdout, logs to stderr
  const lines = output.trim().split('\n')
  const jsonLine = lines[lines.length - 1] // Last line is the JSON
  const raw: {
    positions: Array<{
      time: number
      x: number
      y: number
      w: number
      h: number
      conf: number
      source?: string
    }>
    scene_changes: number[]
    all_candidates: Array<{ time: number; detections: Candidate[] }>
  } = JSON.parse(jsonLine)

  const allCandidates: FrameCandidates[] = raw.all_candidates.map((f) => ({
    time: f.time,
    detections: f.detections,
  }))

  // Norfair handles tracking, occlusion interpolation, and velocity-based outlier rejection.
  // We just filter out "none" positions (no detection and no tracker prediction).
  const positions: BallPosition[] = raw.positions
    .filter((p) => p.x >= 0)
    .map((p) => ({
      time: p.time,
      x: p.x,
      y: p.y,
      conf: p.conf,
      source: (p.source ||
        (p.w > 0 ? 'ball' : 'cluster')) as BallPosition['source'],
    }))

  const totalFrames = raw.positions.length
  const elapsed = ((Date.now() - start) / 1000).toFixed(0)

  const ballCount = positions.filter((p) => p.source === 'ball').length
  const trackedCount = positions.filter((p) => p.source === 'tracked').length
  const clusterCount = positions.filter((p) => p.source === 'cluster').length
  console.log(
    `  Positions: ${positions.length}/${totalFrames} — ${ballCount} ball, ${trackedCount} tracked, ${clusterCount} cluster (${elapsed}s)`
  )

  if (raw.scene_changes.length > 0) {
    console.log(
      `  Scene changes: ${raw.scene_changes.length} at [${raw.scene_changes.map((t) => t.toFixed(1) + 's').join(', ')}]`
    )
  }

  return { positions, sceneChanges: raw.scene_changes, allCandidates }
}

// ── Camera Path Smoothing ───────────────────────────────────────────
// Norfair Kalman tracker handles ball tracking + occlusion interpolation.
// Here we smooth the resulting camera path with segmented symmetric SG.
//
// Pipeline: Norfair positions → interpolate to per-frame → segment at
// discontinuities → symmetric SG per segment → blend transitions → speed clamp

const MAX_PAN_PX_PER_SEC = 1000
const CENTER_CROP_X = Math.round(CROP_MAX_X / 2)
const SG_POLY_ORDER = 2

/**
 * Savitzky-Golay smoothing filter (symmetric).
 * Applied as post-processing to complete trajectory segments.
 */
function savitzkyGolaySmooth(
  data: number[],
  lookback: number,
  lookahead: number,
  polyOrder: number
): number[] {
  const n = data.length
  if (n <= 1) return [...data]

  // Clamp window to data size
  if (lookback + lookahead + 1 > n) {
    lookback = Math.floor((n - 1) * 0.8)
    lookahead = Math.floor((n - 1) * 0.2)
    if (lookback + lookahead < 1) return [...data]
  }

  // Precompute SG coefficients for asymmetric window
  // Window goes from -lookback to +lookahead, we evaluate at index 0 (current frame)
  const coeffs = computeAsymmetricSGCoefficients(lookback, lookahead, polyOrder)

  const result: number[] = new Array(n)

  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let j = -lookback; j <= lookahead; j++) {
      let idx = i + j
      // Mirror at boundaries
      if (idx < 0) idx = -idx
      if (idx >= n) idx = 2 * (n - 1) - idx
      idx = Math.max(0, Math.min(n - 1, idx))
      sum += coeffs[j + lookback] * data[idx]
    }
    result[i] = sum
  }

  return result
}

/** Compute asymmetric SG coefficients: window from -lookback to +lookahead, evaluate at 0 */
function computeAsymmetricSGCoefficients(
  lookback: number,
  lookahead: number,
  polyOrder: number
): number[] {
  const windowSize = lookback + lookahead + 1

  // Build Vandermonde matrix J where J[i][k] = idx^k
  // idx ranges from -lookback to +lookahead
  const J: number[][] = []
  for (let idx = -lookback; idx <= lookahead; idx++) {
    const row: number[] = []
    for (let k = 0; k <= polyOrder; k++) {
      row.push(Math.pow(idx, k))
    }
    J.push(row)
  }

  // Compute (J^T * J)
  const cols = polyOrder + 1
  const JtJ: number[][] = Array.from({ length: cols }, () =>
    new Array(cols).fill(0)
  )
  for (let r = 0; r < cols; r++) {
    for (let c = 0; c < cols; c++) {
      let s = 0
      for (let i = 0; i < windowSize; i++) {
        s += J[i][r] * J[i][c]
      }
      JtJ[r][c] = s
    }
  }

  // Invert (J^T * J)
  const inv = invertMatrix(JtJ)

  // For evaluating at index 0 (current frame): e = [1, 0, 0, ..., 0]
  // coeffs[i] = sum_k( inv[0][k] * J[i][k] )
  const coeffs: number[] = new Array(windowSize)
  for (let i = 0; i < windowSize; i++) {
    let s = 0
    for (let k = 0; k < cols; k++) {
      s += inv[0][k] * J[i][k]
    }
    coeffs[i] = s
  }

  return coeffs
}

/** Gauss-Jordan matrix inversion */
function invertMatrix(matrix: number[][]): number[][] {
  const n = matrix.length
  // Augmented matrix [A | I]
  const aug: number[][] = matrix.map((row, i) => {
    const extended = [...row]
    for (let j = 0; j < n; j++) extended.push(i === j ? 1 : 0)
    return extended
  })

  for (let col = 0; col < n; col++) {
    // Find pivot
    let maxRow = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row
    }
    ;[aug[col], aug[maxRow]] = [aug[maxRow], aug[col]]

    const pivot = aug[col][col]
    if (Math.abs(pivot) < 1e-12) continue

    // Scale pivot row
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot

    // Eliminate column
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const factor = aug[row][col]
      for (let j = 0; j < 2 * n; j++) aug[row][j] -= factor * aug[col][j]
    }
  }

  return aug.map((row) => row.slice(n))
}

// ── Segmented SG Smoothing ──────────────────────────────────────────
// Detect discontinuities (sharp position jumps from passes/shots),
// segment the trajectory at those points, and smooth each segment
// independently with symmetric SG. This avoids the "premature movement"
// problem where SG lookahead causes the camera to move before a pass.

const DISCONTINUITY_THRESHOLD = 150 // px jump between adjacent detections = segment boundary
const SG_WINDOW_HALF = 15 // symmetric window: 15 frames each side = 31 total (~1s at 30fps)

/** Find segment boundaries where the crop target jumps sharply */
function findSegmentBoundaries(perFrameTarget: number[]): number[] {
  const boundaries: number[] = [0]

  for (let i = 1; i < perFrameTarget.length; i++) {
    if (
      Math.abs(perFrameTarget[i] - perFrameTarget[i - 1]) >
      DISCONTINUITY_THRESHOLD
    ) {
      boundaries.push(i)
    }
  }

  boundaries.push(perFrameTarget.length)
  return boundaries
}

/** Apply symmetric SG to one segment, with linear transition at edges */
function smoothSegment(data: number[]): number[] {
  if (data.length <= 3) return [...data]

  // Use symmetric SG with window adapted to segment length
  const halfWin = Math.min(SG_WINDOW_HALF, Math.floor((data.length - 1) / 2))
  if (halfWin < 1) return [...data]

  return savitzkyGolaySmooth(data, halfWin, halfWin, SG_POLY_ORDER)
}

function smoothPositions(
  positions: BallPosition[],
  sceneChanges: number[],
  fps: number,
  duration: number
): number[] {
  const totalFrames = Math.ceil(duration * fps)

  if (positions.length === 0) {
    return Array(totalFrames).fill(CENTER_CROP_X)
  }

  positions.sort((a, b) => a.time - b.time)

  // Convert detected positions to crop offsets (center the detection in crop)
  const rawPositions = positions.map((p) => ({
    time: p.time,
    cropX: Math.max(0, Math.min(CROP_MAX_X, Math.round(p.x - CROP_W / 2))),
    source: p.source,
  }))

  console.log(
    `  Smoothing ${rawPositions.length} detections with segmented SG (symmetric, offline)`
  )

  // ── Step 1: Interpolate detections to per-frame targets ──
  const perFrameTarget: number[] = []
  let detIdx = 0

  for (let frame = 0; frame < totalFrames; frame++) {
    const t = frame / fps

    while (
      detIdx < rawPositions.length - 1 &&
      rawPositions[detIdx + 1].time <= t
    ) {
      detIdx++
    }

    if (detIdx >= rawPositions.length - 1) {
      perFrameTarget.push(rawPositions[rawPositions.length - 1].cropX)
    } else if (t <= rawPositions[0].time) {
      perFrameTarget.push(rawPositions[0].cropX)
    } else {
      const before = rawPositions[detIdx]
      const after = rawPositions[detIdx + 1]
      const progress = (t - before.time) / (after.time - before.time)
      const x = Math.round(
        before.cropX + (after.cropX - before.cropX) * progress
      )
      perFrameTarget.push(Math.max(0, Math.min(CROP_MAX_X, x)))
    }
  }

  // ── Step 2: Add scene changes as segment boundaries ──
  const sceneFrames = new Set(sceneChanges.map((t) => Math.round(t * fps)))

  // ── Step 3: Segment at discontinuities + scene changes ──
  const boundaries = findSegmentBoundaries(perFrameTarget)

  // Add scene change frames as boundaries too
  for (const sf of sceneFrames) {
    if (sf > 0 && sf < totalFrames && !boundaries.includes(sf)) {
      boundaries.push(sf)
    }
  }
  boundaries.sort((a, b) => a - b)

  // Deduplicate and ensure first/last
  const uniqueBoundaries = [...new Set(boundaries)]
  if (uniqueBoundaries[0] !== 0) uniqueBoundaries.unshift(0)
  if (uniqueBoundaries[uniqueBoundaries.length - 1] !== totalFrames)
    uniqueBoundaries.push(totalFrames)

  console.log(
    `  Segments: ${uniqueBoundaries.length - 1} (boundaries at frames: ${
      uniqueBoundaries
        .slice(1, -1)
        .map((f) => `${f}(${(f / fps).toFixed(1)}s)`)
        .join(', ') || 'none'
    })`
  )

  // ── Step 4: Smooth each segment independently with symmetric SG ──
  const smoothed: number[] = new Array(totalFrames)

  for (let s = 0; s < uniqueBoundaries.length - 1; s++) {
    const start = uniqueBoundaries[s]
    const end = uniqueBoundaries[s + 1]
    const segment = perFrameTarget.slice(start, end)
    const smoothedSegment = smoothSegment(segment)

    for (let i = 0; i < smoothedSegment.length; i++) {
      smoothed[start + i] = Math.max(
        0,
        Math.min(CROP_MAX_X, Math.round(smoothedSegment[i]))
      )
    }
  }

  // ── Step 5: Blend segment transitions (5-frame linear crossfade) ──
  const BLEND_FRAMES = Math.round(fps * 0.15) // ~5 frames at 30fps
  for (let b = 1; b < uniqueBoundaries.length - 1; b++) {
    const boundary = uniqueBoundaries[b]
    const halfBlend = Math.min(BLEND_FRAMES, boundary, totalFrames - boundary)

    for (let i = 1; i <= halfBlend; i++) {
      const t = i / (halfBlend + 1) // 0→1 transition
      const beforeIdx = boundary - i
      const afterIdx = boundary + i - 1

      if (beforeIdx >= 0 && afterIdx < totalFrames) {
        // Ease the transition with smoothstep
        const ease = t * t * (3 - 2 * t)
        const beforeVal = smoothed[beforeIdx]
        const afterVal = smoothed[afterIdx]

        // Only blend if values are reasonably close (don't blend across huge jumps)
        if (Math.abs(beforeVal - afterVal) < DISCONTINUITY_THRESHOLD * 2) {
          const mid = Math.round(beforeVal + (afterVal - beforeVal) * ease)
          smoothed[boundary - 1] = Math.max(0, Math.min(CROP_MAX_X, mid))
        }
      }
    }
  }

  // ── Step 6: Clamp pan speed ───────────────────────────────────────
  const maxPxPerFrame = MAX_PAN_PX_PER_SEC / fps
  const speedClamped: number[] = [smoothed[0]]

  for (let i = 1; i < smoothed.length; i++) {
    const prev = speedClamped[i - 1]
    const target = smoothed[i]
    const delta = target - prev

    if (Math.abs(delta) > maxPxPerFrame) {
      const clamped = prev + maxPxPerFrame * Math.sign(delta)
      speedClamped.push(Math.max(0, Math.min(CROP_MAX_X, Math.round(clamped))))
    } else {
      speedClamped.push(target)
    }
  }

  return speedClamped
}

// ── FFmpeg Crop ─────────────────────────────────────────────────────

// timeVar: 't' for crop filter (time), 'T' for drawbox filter (where 't' = thickness)
function buildCropExpression(
  cropXPerFrame: number[],
  fps: number,
  timeVar = 't'
): string {
  // Group frames by second for a cleaner expression
  const secondPositions: number[] = []
  for (let sec = 0; sec * fps < cropXPerFrame.length; sec++) {
    const frameIdx = Math.round(sec * fps)
    secondPositions.push(
      cropXPerFrame[Math.min(frameIdx, cropXPerFrame.length - 1)]
    )
  }

  if (secondPositions.length <= 1) {
    return String(secondPositions[0] || Math.round(CROP_MAX_X / 2))
  }

  let expr = String(secondPositions[secondPositions.length - 1])

  for (let i = secondPositions.length - 2; i >= 0; i--) {
    const x0 = secondPositions[i]
    const x1 = secondPositions[i + 1]
    const lerp = x0 === x1 ? String(x0) : `${x0}+${x1 - x0}*(${timeVar}-${i})`
    expr = `if(lt(${timeVar},${i + 1}),${lerp},${expr})`
  }

  return expr
}

function runCrop(
  inputPath: string,
  outputPath: string,
  cropXPerFrame: number[],
  fps: number
) {
  console.log('  Cropping to portrait...')
  const start = Date.now()

  const cropExpr = buildCropExpression(cropXPerFrame, fps)
  const filter = `crop=${CROP_W}:${SRC_H}:'${cropExpr}':0,scale=${OUT_W}:${OUT_H}`

  execSync(
    `ffmpeg -y -i "${inputPath}" -vf "${filter}" -c:v libx264 -preset fast -crf 20 -c:a aac -b:a 128k "${outputPath}"`,
    { stdio: 'inherit', timeout: 5 * 60 * 1000 }
  )

  const size = statSync(outputPath).size
  const elapsed = ((Date.now() - start) / 1000).toFixed(0)
  console.log(`  Output: ${(size / 1024 / 1024).toFixed(1)}MB (${elapsed}s)`)
}

function runDebugPreview(
  inputPath: string,
  debugPath: string,
  cropXPerFrame: number[],
  fps: number
) {
  console.log('  Generating debug preview...')

  // drawbox doesn't support time expressions, so use crop+overlay instead:
  // 1. Split into two copies
  // 2. Darken one copy
  // 3. Crop the bright region from the other
  // 4. Overlay the bright crop onto the darkened full frame
  const cropExpr = buildCropExpression(cropXPerFrame, fps) // 't' works in crop and overlay
  const filter = [
    `split[dark][bright]`,
    `[dark]colorchannelmixer=0.3:0:0:0:0:0.3:0:0:0:0:0.3:0[d]`,
    `[bright]crop=${CROP_W}:${SRC_H}:'${cropExpr}':0[b]`,
    `[d][b]overlay=x='${cropExpr}':y=0`,
  ].join(';')

  execSync(
    `ffmpeg -y -i "${inputPath}" -filter_complex "${filter}" -c:v libx264 -preset fast -crf 23 -an "${debugPath}"`,
    { stdio: 'inherit', timeout: 5 * 60 * 1000 }
  )

  console.log(`  Debug preview saved`)
}

// ── Diagnostic Assessment ─────────────────────────────────────────────

function assessTracking(
  positions: BallPosition[],
  cropXPerFrame: number[],
  fps: number,
  duration: number
) {
  console.log(`\n  ── Tracking Assessment ──`)

  // 1. Detection coverage: what % of the video has confident detections?
  const totalSeconds = Math.ceil(duration)
  const coveredSeconds = new Set(positions.map((p) => Math.floor(p.time)))
  const coveragePct = Math.round((coveredSeconds.size / totalSeconds) * 100)
  console.log(
    `  Coverage: ${coveredSeconds.size}/${totalSeconds}s (${coveragePct}%)`
  )

  // 2. Detection gaps: any stretch >1.5s with no detections?
  const gaps: Array<{ from: number; to: number; dur: number }> = []
  for (let i = 1; i < positions.length; i++) {
    const gap = positions[i].time - positions[i - 1].time
    if (gap > 1.5) {
      gaps.push({
        from: Math.round(positions[i - 1].time * 10) / 10,
        to: Math.round(positions[i].time * 10) / 10,
        dur: Math.round(gap * 10) / 10,
      })
    }
  }
  // Also check start/end gaps
  if (positions.length > 0 && positions[0].time > 1.5) {
    gaps.unshift({
      from: 0,
      to: Math.round(positions[0].time * 10) / 10,
      dur: Math.round(positions[0].time * 10) / 10,
    })
  }
  if (
    positions.length > 0 &&
    duration - positions[positions.length - 1].time > 1.5
  ) {
    const lastT = positions[positions.length - 1].time
    gaps.push({
      from: Math.round(lastT * 10) / 10,
      to: Math.round(duration * 10) / 10,
      dur: Math.round((duration - lastT) * 10) / 10,
    })
  }
  if (gaps.length > 0) {
    console.log(
      `  Gaps (>1.5s): ${gaps.map((g) => `${g.from}-${g.to}s (${g.dur}s)`).join(', ')}`
    )
  } else {
    console.log(`  Gaps: none`)
  }

  // 3. Ball-in-crop: for each detection, is the ball within the crop window?
  let ballInCrop = 0
  let ballOutCrop = 0
  for (const p of positions) {
    const frameIdx = Math.round(p.time * fps)
    if (frameIdx >= cropXPerFrame.length) continue
    const cropX = cropXPerFrame[frameIdx]
    const ballInWindow = p.x >= cropX && p.x <= cropX + CROP_W
    if (ballInWindow) ballInCrop++
    else ballOutCrop++
  }
  const inCropPct = Math.round(
    (ballInCrop / Math.max(ballInCrop + ballOutCrop, 1)) * 100
  )
  console.log(
    `  Ball in crop: ${ballInCrop}/${ballInCrop + ballOutCrop} detections (${inCropPct}%)`
  )

  // 4. Camera smoothness: max frame-to-frame jump in crop position
  let maxJump = 0
  let maxJumpAt = 0
  for (let i = 1; i < cropXPerFrame.length; i++) {
    const jump = Math.abs(cropXPerFrame[i] - cropXPerFrame[i - 1])
    if (jump > maxJump) {
      maxJump = jump
      maxJumpAt = i / fps
    }
  }
  console.log(
    `  Max camera jump: ${maxJump}px/frame at t=${maxJumpAt.toFixed(1)}s (${Math.round(maxJump * fps)}px/s)`
  )

  // 5. Average confidence
  const avgConf =
    positions.reduce((s, p) => s + p.conf, 0) / Math.max(positions.length, 1)
  console.log(`  Avg confidence: ${avgConf.toFixed(2)}`)

  console.log(`  ─────────────────────────\n`)
}

// ── Process a single clip ────────────────────────────────────────────

interface ClipResult {
  input: string
  output: string
  debug: string | null
  duration_seconds: number
  ball_positions: BallPosition[]
  status: 'success' | 'error'
  error?: string
  tracking_quality: 'good' | 'ok' | 'bad' | null
  notes: string
}

async function processClip(
  inputPath: string,
  outputDir: string,
  debug: boolean
): Promise<ClipResult> {
  const name = basename(inputPath, extname(inputPath))
  const outputPath = resolve(outputDir, `${name}_portrait.mp4`)
  const debugPath = debug ? resolve(outputDir, `${name}_debug.mp4`) : null

  const result: ClipResult = {
    input: basename(inputPath),
    output: basename(outputPath),
    debug: debugPath ? basename(debugPath) : null,
    duration_seconds: 0,
    ball_positions: [],
    status: 'success',
    tracking_quality: null,
    notes: '',
  }

  try {
    // Get video info
    const probeJson = execSync(
      `ffprobe -v error -show_entries stream=width,height,r_frame_rate -show_entries format=duration -of json "${inputPath}"`,
      { encoding: 'utf-8' }
    )
    const probe = JSON.parse(probeJson)
    const stream = probe.streams[0]
    const width = stream.width
    const height = stream.height
    const duration = parseFloat(probe.format.duration)
    const fpsStr = stream.r_frame_rate
    const [fpsNum, fpsDen] = fpsStr.split('/').map(Number)
    const fps = fpsDen ? fpsNum / fpsDen : 30

    result.duration_seconds = Math.round(duration * 10) / 10

    console.log(
      `  ${width}x${height} @ ${fps.toFixed(0)}fps, ${duration.toFixed(1)}s`
    )

    if (width !== SRC_W || height !== SRC_H) {
      console.warn(
        `  Warning: Expected ${SRC_W}x${SRC_H}, got ${width}x${height}`
      )
    }

    // 1. Detect ball with Forzasys YOLO + Norfair Kalman tracker (Python)
    const detection = detectBall(inputPath)

    // 2. Norfair provides tracked positions (ball + Kalman interpolation + cluster fallback)
    const positions = detection.positions
    result.ball_positions = positions

    if (positions.length === 0) {
      console.warn('  No ball positions — falling back to center crop')
    }

    // 3. Smooth with segmented symmetric SG (offline, full lookahead within segments)
    const cropXPerFrame = smoothPositions(
      positions,
      detection.sceneChanges,
      fps,
      duration
    )

    // 3b. Diagnostic: assess tracking quality
    if (debug) {
      assessTracking(positions, cropXPerFrame, fps, duration)
    }

    // 4. Crop to portrait
    runCrop(inputPath, outputPath, cropXPerFrame, fps)

    // 5. Debug preview
    if (debug && debugPath) {
      runDebugPreview(inputPath, debugPath, cropXPerFrame, fps)
    }
  } catch (err) {
    result.status = 'error'
    result.error = err instanceof Error ? err.message : String(err)
    console.error(`  ERROR: ${result.error}`)
  }

  return result
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    console.log('Usage:')
    console.log('  npx tsx crop.ts <input.mp4>              Single file')
    console.log(
      '  npx tsx crop.ts <folder/>                Batch all .mp4 files'
    )
    console.log('')
    console.log('Options:')
    console.log(
      '  --debug    Also generate debug previews with crop box overlay'
    )
    process.exit(0)
  }

  checkDeps()

  const debug = args.includes('--debug')
  const target = resolve(args.filter((a) => !a.startsWith('--'))[0])

  const stat = statSync(target)
  let files: string[]
  let outputDir: string

  if (stat.isDirectory()) {
    files = readdirSync(target)
      .filter(
        (f) =>
          f.endsWith('.mp4') &&
          !f.includes('_portrait') &&
          !f.includes('_debug')
      )
      .sort()
      .map((f) => resolve(target, f))
    outputDir = resolve(target, 'portrait_output')
  } else {
    files = [target]
    outputDir = dirname(target)
  }

  if (files.length === 0) {
    console.error('No .mp4 files found')
    process.exit(1)
  }

  if (stat.isDirectory() && !existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true })
  }

  console.log(`\nPortrait Crop — YOLO Ball Detection`)
  console.log(`${'═'.repeat(50)}`)
  console.log(`  Files:  ${files.length}`)
  console.log(`  Output: ${outputDir}`)
  console.log(`  Debug:  ${debug ? 'yes' : 'no'}`)
  console.log(`${'═'.repeat(50)}\n`)

  const results: ClipResult[] = []

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    console.log(`\n[${i + 1}/${files.length}] ${basename(file)}`)

    const result = await processClip(file, outputDir, debug)
    results.push(result)

    if (result.status === 'success') {
      console.log(`  ✓ Done`)
    }
  }

  // Write review JSON
  const reviewPath = stat.isDirectory()
    ? resolve(outputDir, 'review.json')
    : resolve(
        dirname(target),
        `${basename(target, extname(target))}_review.json`
      )

  const review = {
    generated_at: new Date().toISOString(),
    total: files.length,
    success: results.filter((r) => r.status === 'success').length,
    failed: results.filter((r) => r.status === 'error').length,
    instructions:
      'Set tracking_quality to "good", "ok", or "bad". Add notes for any issues.',
    clips: results,
  }

  writeFileSync(reviewPath, JSON.stringify(review, null, 2))

  console.log(`\n${'═'.repeat(50)}`)
  console.log(`  DONE: ${review.success}/${review.total} clips processed`)
  if (review.failed > 0) console.log(`  FAILED: ${review.failed}`)
  console.log(`  Review: ${reviewPath}`)
  console.log(`${'═'.repeat(50)}\n`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
