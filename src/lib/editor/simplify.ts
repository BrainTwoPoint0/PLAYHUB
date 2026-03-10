import { type CropKeyframe, SOURCE_WIDTH, CROP_WIDTH } from './types'

// Default parameters — can be overridden via simplifyCropKeyframes(kf, sc, overrides)
// Tuned via autoresearch sweep (2026-03-10): 0.375 → 0.466 (+24.2%)
const DEFAULTS = {
  SCENE_CUT_THRESHOLD: 300, // px jump in cropX
  SCENE_CUT_WINDOW: 0.4, // seconds — jump must happen within this window
  SCENE_CUT_MARGIN: 1.2, // seconds — remove AI keyframes within this of a scene cut
  OUTLIER_CONF_THRESHOLD: 0.4, // below this confidence...
  OUTLIER_JUMP_THRESHOLD: 200, // ...and this much deviation = outlier
  RDP_TOLERANCE: 90, // px — how much deviation to tolerate in simplification
  ZIGZAG_THRESHOLD: 130, // px — direction reversals smaller than this get removed
  NEAR_DUPLICATE_TIME: 0.8, // seconds — merge points closer than this...
  NEAR_DUPLICATE_PX: 100, // px — ...if they're also within this distance
  DEAD_ZONE_PX: 20, // px — don't create new keyframe unless target shifted this much
  HOLD_PAN_VELOCITY: 300, // px/s — velocity threshold for inserting hold keyframes
  HIGH_VELOCITY_MIN_GAP: 2.0, // seconds — min gap to check for velocity preservation
  HIGH_VELOCITY_MIN_VEL: 100, // px/s — movement faster than this should be preserved
  FILL_GAP_MAX: 5.0, // seconds — re-insert from original data if gap > this
} as const

export type SimplifyParams = Partial<typeof DEFAULTS>

// Module-level params for current run (set by simplifyCropKeyframes)
let P = { ...DEFAULTS }

// Legacy constant aliases (used by internal functions)
const SCENE_CUT_THRESHOLD = DEFAULTS.SCENE_CUT_THRESHOLD
const SCENE_CUT_WINDOW = DEFAULTS.SCENE_CUT_WINDOW
const SCENE_CUT_MARGIN = DEFAULTS.SCENE_CUT_MARGIN
const OUTLIER_CONF_THRESHOLD = DEFAULTS.OUTLIER_CONF_THRESHOLD
const OUTLIER_JUMP_THRESHOLD = DEFAULTS.OUTLIER_JUMP_THRESHOLD

/**
 * Detect scene cuts from keyframe jumps and explicit scene_changes.
 * Returns sorted array of times where cuts occur.
 */
export function detectSceneCuts(
  keyframes: CropKeyframe[],
  sceneChanges: number[]
): number[] {
  const cuts = new Set(sceneChanges)

  for (let i = 1; i < keyframes.length; i++) {
    const prev = keyframes[i - 1]
    const curr = keyframes[i]
    const dt = curr.time - prev.time
    const dx = Math.abs(curr.x - prev.x)
    if (dt <= SCENE_CUT_WINDOW && dx >= SCENE_CUT_THRESHOLD) {
      cuts.add(curr.time)
    }
  }

  return Array.from(cuts).sort((a, b) => a - b)
}

/**
 * Ramer-Douglas-Peucker line simplification on (time, cropX) polyline.
 * Removes points that are within `tolerance` px of the simplified line.
 */
export function rdpSimplify(
  keyframes: CropKeyframe[],
  tolerance: number
): CropKeyframe[] {
  if (keyframes.length <= 2) return keyframes

  // Find the point with max perpendicular distance from the line
  // between first and last point
  const first = keyframes[0]
  const last = keyframes[keyframes.length - 1]

  // Normalize time to same scale as x for distance calculation
  const timeSpan = last.time - first.time
  const xSpan = Math.abs(last.x - first.x) || 1
  const timeScale = xSpan / (timeSpan || 1)

  let maxDist = 0
  let maxIdx = 0

  for (let i = 1; i < keyframes.length - 1; i++) {
    const dist = perpendicularDistance(
      (keyframes[i].time - first.time) * timeScale,
      keyframes[i].x,
      0,
      first.x,
      (last.time - first.time) * timeScale,
      last.x
    )
    if (dist > maxDist) {
      maxDist = dist
      maxIdx = i
    }
  }

  if (maxDist > tolerance) {
    const left = rdpSimplify(keyframes.slice(0, maxIdx + 1), tolerance)
    const right = rdpSimplify(keyframes.slice(maxIdx), tolerance)
    return [...left.slice(0, -1), ...right]
  }

  return [first, last]
}

function perpendicularDistance(
  px: number,
  py: number,
  lx1: number,
  ly1: number,
  lx2: number,
  ly2: number
): number {
  const dx = lx2 - lx1
  const dy = ly2 - ly1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.sqrt((px - lx1) ** 2 + (py - ly1) ** 2)
  const num = Math.abs(dy * px - dx * py + lx2 * ly1 - ly2 * lx1)
  return num / Math.sqrt(lenSq)
}

/**
 * Filter out low-confidence outliers that jump far from neighbors.
 */
function filterOutliers(keyframes: CropKeyframe[]): CropKeyframe[] {
  if (keyframes.length <= 2) return keyframes

  // Only use high-confidence balls as references — low-confidence balls may
  // themselves be outliers and shouldn't validate other low-confidence detections
  const ballKfs = keyframes.filter(
    (kf) => kf.source === 'ai_ball' && kf.confidence >= OUTLIER_CONF_THRESHOLD
  )

  return keyframes.filter((kf, i) => {
    // Always keep first, last, user, and cluster keyframes
    if (i === 0 || i === keyframes.length - 1) return true
    if (kf.source === 'user' || kf.source === 'ai_cluster') return true

    if (kf.confidence >= OUTLIER_CONF_THRESHOLD) return true

    // Check deviation from immediate neighbors
    const prev = keyframes[i - 1]
    const next = keyframes[i + 1]
    const expectedX =
      prev.x +
      ((next.x - prev.x) * (kf.time - prev.time)) / (next.time - prev.time || 1)
    const deviation = Math.abs(kf.x - expectedX)

    if (deviation >= OUTLIER_JUMP_THRESHOLD) return false

    // Also check deviation from nearest ball detections — clusters may
    // confirm a false position, but ball detections are more reliable
    const prevBall = ballKfs.filter((b) => b.time < kf.time && b !== kf).pop()
    const nextBall = ballKfs.find((b) => b.time > kf.time && b !== kf)
    if (prevBall && nextBall) {
      const dt = nextBall.time - prevBall.time
      if (dt > 0) {
        const ballExpectedX =
          prevBall.x +
          ((nextBall.x - prevBall.x) * (kf.time - prevBall.time)) / dt
        const ballDeviation = Math.abs(kf.x - ballExpectedX)
        if (ballDeviation >= OUTLIER_JUMP_THRESHOLD) return false
      }
    } else if (prevBall && !nextBall) {
      // No next ball — check deviation from last known ball position
      if (Math.abs(kf.x - prevBall.x) >= OUTLIER_JUMP_THRESHOLD) return false
    }

    return true
  })
}

/**
 * Preserve keyframes in high-velocity sections. RDP can flatten sections
 * where start≈end but significant movement happens in between. This
 * re-inserts the peak-velocity keyframe from any flattened gap.
 */
function preserveHighVelocity(
  original: CropKeyframe[],
  simplified: CropKeyframe[],
  minGapSeconds: number = 2.0,
  minVelocity: number = 150 // px/s — movement faster than this should be preserved
): CropKeyframe[] {
  if (simplified.length < 2) return simplified

  const result: CropKeyframe[] = [simplified[0]]

  for (let i = 1; i < simplified.length; i++) {
    const prev = simplified[i - 1]
    const curr = simplified[i]
    const gap = curr.time - prev.time

    if (gap >= minGapSeconds) {
      // Find original keyframes within this gap
      const gapKfs = original.filter(
        (kf) => kf.time > prev.time && kf.time < curr.time
      )

      if (gapKfs.length >= 2) {
        // Find the point with max velocity (biggest change from its predecessor)
        let maxVel = 0
        let maxVelIdx = -1
        for (let j = 1; j < gapKfs.length; j++) {
          const dt = gapKfs[j].time - gapKfs[j - 1].time
          if (dt === 0) continue
          const vel = Math.abs(gapKfs[j].x - gapKfs[j - 1].x) / dt
          if (vel > maxVel) {
            maxVel = vel
            maxVelIdx = j
          }
        }

        // Also check the point with max deviation from the interpolated line
        let maxDev = 0
        let maxDevIdx = -1
        for (const gkf of gapKfs) {
          const t = (gkf.time - prev.time) / gap
          const interpolated = prev.x + (curr.x - prev.x) * t
          const dev = Math.abs(gkf.x - interpolated)
          if (dev > maxDev) {
            maxDev = dev
            maxDevIdx = gapKfs.indexOf(gkf)
          }
        }

        // Insert the most significant point if velocity or deviation is high enough
        if (maxVel >= minVelocity && maxVelIdx >= 0) {
          result.push(gapKfs[maxVelIdx])
          // Also add the deviation peak if it's a different point
          if (maxDevIdx >= 0 && maxDevIdx !== maxVelIdx && maxDev > 100) {
            result.push(gapKfs[maxDevIdx])
          }
        } else if (maxDev > 100 && maxDevIdx >= 0) {
          result.push(gapKfs[maxDevIdx])
        }
      }
    }

    result.push(curr)
  }

  return result.sort((a, b) => a.time - b.time)
}

/**
 * Remove direction-reversal zigzags: if a keyframe causes the pan to
 * reverse direction and the surrounding trend continues the same way,
 * remove it. Run iteratively until stable.
 *
 * Does NOT remove across scene cuts (large time gaps or big jumps).
 */
export function filterZigzags(
  keyframes: CropKeyframe[],
  sceneCuts: number[] = [],
  zigzagThreshold: number = DEFAULTS.ZIGZAG_THRESHOLD
): CropKeyframe[] {
  if (keyframes.length <= 3) return keyframes

  const cutSet = new Set(sceneCuts.map((t) => Math.round(t * 1000)))

  let changed = true
  let result = keyframes

  while (changed) {
    changed = false
    const next: CropKeyframe[] = [result[0]]

    for (let i = 1; i < result.length - 1; i++) {
      const prev = next[next.length - 1]
      const curr = result[i]
      const after = result[i + 1]

      // Don't filter across scene cuts
      const currMs = Math.round(curr.time * 1000)
      const afterMs = Math.round(after.time * 1000)
      if (cutSet.has(currMs) || cutSet.has(afterMs)) {
        next.push(curr)
        continue
      }

      // Don't filter if there's a large time gap (likely a scene boundary)
      if (curr.time - prev.time > 2.5 || after.time - curr.time > 2.5) {
        next.push(curr)
        continue
      }

      // Always keep user and cluster keyframes
      if (curr.source === 'user' || curr.source === 'ai_cluster') {
        next.push(curr)
        continue
      }

      // Direction from prev→curr vs prev→after
      const d1 = curr.x - prev.x
      const d2 = after.x - prev.x

      // It's a zigzag if curr goes one way then after comes back
      const isReversal =
        (d1 > 0 && d2 < d1 && d1 - d2 > zigzagThreshold) ||
        (d1 < 0 && d2 > d1 && d2 - d1 > zigzagThreshold)

      if (isReversal) {
        changed = true // skip this keyframe
      } else {
        next.push(curr)
      }
    }

    next.push(result[result.length - 1])
    result = next
  }

  return result
}

/**
 * Remove keyframes near scene cuts. For goal clips, smooth panning through
 * replay cuts looks better than snapping to the ball at the edge.
 * Removes AI keyframes within SCENE_CUT_MARGIN of each cut time.
 */
function smoothSceneCuts(
  keyframes: CropKeyframe[],
  cuts: number[]
): CropKeyframe[] {
  if (cuts.length === 0) return keyframes

  return keyframes.filter((kf) => {
    if (kf.source === 'user' || kf.source === 'ai_cluster') return true
    return !cuts.some((ct) => Math.abs(kf.time - ct) <= SCENE_CUT_MARGIN)
  })
}

/**
 * Remove near-duplicate keyframes that are close in both time and position.
 * Keeps the one with higher confidence.
 */
function removeNearDuplicates(keyframes: CropKeyframe[]): CropKeyframe[] {
  if (keyframes.length <= 1) return keyframes

  const result: CropKeyframe[] = [keyframes[0]]

  for (let i = 1; i < keyframes.length; i++) {
    const prev = result[result.length - 1]
    const curr = keyframes[i]
    const dt = curr.time - prev.time
    const dx = Math.abs(curr.x - prev.x)

    // Clusters holding a stale position (near prev) are redundant over longer windows
    const isStaleCluster =
      curr.source === 'ai_cluster' && dt < 2.0 && dx < P.NEAR_DUPLICATE_PX

    if (
      (dt < P.NEAR_DUPLICATE_TIME && dx < P.NEAR_DUPLICATE_PX) ||
      isStaleCluster
    ) {
      if (isStaleCluster) {
        // Always prefer ball/tracked over cluster — cluster confidence is artificial
        if (prev.source === 'ai_cluster' && curr.source !== 'ai_cluster') {
          result[result.length - 1] = curr
        }
        // Otherwise skip stale cluster
      } else if (curr.source === 'user' || curr.confidence > prev.confidence) {
        result[result.length - 1] = curr
      }
      // Otherwise skip curr
    } else {
      result.push(curr)
    }
  }

  return result
}

/**
 * Insert "hold" keyframes before fast pans. When there's a velocity spike,
 * adding a hold just before it creates a "settle then pan" feel that
 * looks more professional.
 */
function insertHoldBeforePan(keyframes: CropKeyframe[]): CropKeyframe[] {
  if (keyframes.length < 2) return keyframes

  const result: CropKeyframe[] = [keyframes[0]]

  for (let i = 1; i < keyframes.length; i++) {
    const prev = keyframes[i - 1]
    const curr = keyframes[i]
    const dt = curr.time - prev.time
    if (dt === 0) {
      result.push(curr)
      continue
    }

    const velocity = Math.abs(curr.x - prev.x) / dt

    // Check preceding velocity (was the camera already moving?)
    const prevPrev = result.length >= 2 ? result[result.length - 2] : null
    const prevVelocity = prevPrev
      ? Math.abs(prev.x - prevPrev.x) / (prev.time - prevPrev.time || 1)
      : 0

    // Only insert hold if: upcoming velocity is fast, preceding was slow (settling),
    // and there's enough time gap
    if (velocity >= P.HOLD_PAN_VELOCITY && prevVelocity < 100 && dt >= 0.8) {
      const holdTime = Math.round((curr.time - 0.3) * 1000) / 1000
      const tooClose = result.some((k) => Math.abs(k.time - holdTime) < 0.15)
      if (!tooClose && holdTime > prev.time + 0.15) {
        result.push({
          time: holdTime,
          x: prev.x,
          source: prev.source,
          confidence: prev.confidence,
        })
      }
    }

    result.push(curr)
  }

  return result.sort((a, b) => a.time - b.time)
}

/**
 * Filter clusters that deviate significantly from surrounding ball detections.
 * When the ball is lost, clusters fill in with player centroid which is often
 * in the wrong area. If a cluster is far from the interpolated line of nearby
 * ball detections, remove it.
 */
function filterSuspiciousClusters(keyframes: CropKeyframe[]): CropKeyframe[] {
  if (keyframes.length <= 2) return keyframes

  const ballKfs = keyframes.filter((kf) => kf.source === 'ai_ball')
  if (ballKfs.length < 2) return keyframes

  return keyframes.filter((kf, i) => {
    if (kf.source !== 'ai_cluster') return true
    // Always keep first keyframe; keep last only if it's reasonable
    if (i === 0) return true

    // Remove cluster if a ball detection is within 0.4s — ball is always
    // more accurate than a player centroid fallback
    const nearbyBall = ballKfs.find((b) => Math.abs(b.time - kf.time) < 0.4)
    if (nearbyBall) return false

    // Find nearest ball detections before and after this cluster
    const before = ballKfs.filter((b) => b.time < kf.time).pop()
    const after = ballKfs.find((b) => b.time > kf.time)

    if (!before && !after) return true
    if (!before) return Math.abs(kf.x - after!.x) < 300
    if (!after) return Math.abs(kf.x - before.x) < 300

    // If ball detections are far away in time (>5s), context is weak — keep cluster
    if (kf.time - before.time > 5 && after.time - kf.time > 5) return true

    // Interpolate expected position from surrounding ball detections
    const t = (kf.time - before.time) / (after.time - before.time)
    const expectedX = before.x + (after.x - before.x) * t
    const deviation = Math.abs(kf.x - expectedX)

    return deviation < 300
  })
}

/**
 * Dead zone filter: collapse sequences of cluster keyframes that bounce
 * within DEAD_ZONE_PX of each other. When the ball isn't detected and
 * clusters jitter frame-to-frame (e.g. x=853->692->601->701->549->700),
 * keep only the first and skip intermediates that stay within the zone.
 * Also enforces minimum 0.8s spacing between consecutive ball keyframes
 * to prevent rapid-fire jitter (e.g. 3 ball keyframes in 0.5s).
 */
function filterDeadZone(keyframes: CropKeyframe[]): CropKeyframe[] {
  if (keyframes.length <= 2) return keyframes

  const result: CropKeyframe[] = [keyframes[0]]

  for (let i = 1; i < keyframes.length; i++) {
    const prev = result[result.length - 1]
    const curr = keyframes[i]
    const dt = curr.time - prev.time
    const dx = Math.abs(curr.x - prev.x)

    // Always keep user keyframes
    if (curr.source === 'user') {
      result.push(curr)
      continue
    }

    // Dead zone: cluster→cluster within DEAD_ZONE_PX, or tracked→tracked
    // within DEAD_ZONE_PX AND within 1.5s (slow pans over longer periods are valid)
    if (
      dx < P.DEAD_ZONE_PX &&
      ((prev.source === 'ai_cluster' && curr.source === 'ai_cluster') ||
        (prev.source === 'ai_tracked' &&
          curr.source === 'ai_tracked' &&
          dt < 1.5))
    ) {
      continue
    }

    // Min time spacing: ball→ball within 0.8s AND within 120px, keep higher confidence
    if (
      prev.source === 'ai_ball' &&
      curr.source === 'ai_ball' &&
      dt < 0.8 &&
      dx < 120
    ) {
      if (curr.confidence > prev.confidence) {
        result[result.length - 1] = curr
      }
      continue
    }

    result.push(curr)
  }

  return result
}

/**
 * Remove keyframes at crop extremes (ball in net / out of play).
 * When consecutive keyframes sit at cropX > 1250 or < 60 for >1.5s,
 * the ball is likely in the goal. Remove intermediate edge keyframes.
 */
function filterEdgeDwell(keyframes: CropKeyframe[]): CropKeyframe[] {
  if (keyframes.length <= 2) return keyframes

  const EDGE_LOW = 50
  const EDGE_HIGH = SOURCE_WIDTH - CROP_WIDTH - 80 // 1232
  const isEdge = (x: number) => x <= EDGE_LOW || x >= EDGE_HIGH

  // Find runs of edge keyframes
  const result: CropKeyframe[] = []
  let edgeRunStart = -1

  for (let i = 0; i < keyframes.length; i++) {
    const kf = keyframes[i]

    if (isEdge(kf.x) && kf.source !== 'user') {
      if (edgeRunStart < 0) edgeRunStart = i
    } else {
      if (edgeRunStart >= 0) {
        const runDuration = keyframes[i - 1].time - keyframes[edgeRunStart].time
        if (runDuration > 0.8 && i - edgeRunStart > 1) {
          // Long edge dwell — keep only the first edge keyframe
          result.push(keyframes[edgeRunStart])
        } else {
          // Short edge visit — keep all
          for (let j = edgeRunStart; j < i; j++) result.push(keyframes[j])
        }
        edgeRunStart = -1
      }
      result.push(kf)
    }
  }

  // Handle run at end of array
  if (edgeRunStart >= 0) {
    const runDuration =
      keyframes[keyframes.length - 1].time - keyframes[edgeRunStart].time
    if (runDuration > 0.8 && keyframes.length - edgeRunStart > 1) {
      result.push(keyframes[edgeRunStart])
    } else {
      for (let j = edgeRunStart; j < keyframes.length; j++)
        result.push(keyframes[j])
    }
  }

  return result
}

/**
 * Remove isolated edge spikes: a single keyframe at the extreme edge
 * (e.g. ball in net) where both neighbors are far from the edge.
 * Only removes non-user keyframes.
 */
function filterIsolatedEdgeSpikes(keyframes: CropKeyframe[]): CropKeyframe[] {
  if (keyframes.length <= 2) return keyframes

  const MAX_CROP = SOURCE_WIDTH - CROP_WIDTH // 1312
  const EDGE_MARGIN = 80 // within 80px of edge = extreme
  const isExtreme = (x: number) =>
    x <= EDGE_MARGIN || x >= MAX_CROP - EDGE_MARGIN

  const result: CropKeyframe[] = [keyframes[0]]

  for (let i = 1; i < keyframes.length - 1; i++) {
    const kf = keyframes[i]
    if (kf.source === 'user') {
      result.push(kf)
      continue
    }

    if (isExtreme(kf.x)) {
      const prev = result[result.length - 1]
      const next = keyframes[i + 1]
      // Spike: this point is at edge but neither neighbor is
      if (!isExtreme(prev.x) && !isExtreme(next.x)) {
        continue // skip isolated edge spike
      }
    }

    result.push(kf)
  }

  result.push(keyframes[keyframes.length - 1])
  return result
}

/**
 * Filter tracked keyframes that drift to extremes when neighbors are central.
 * The Kalman tracker sometimes predicts the ball at frame edges when it's
 * actually more central. Discard tracked points near edges if both neighbors
 * are in the central zone.
 */
function filterTrackedDrift(
  keyframes: CropKeyframe[],
  original: CropKeyframe[]
): CropKeyframe[] {
  if (keyframes.length <= 2) return keyframes

  const MAX_CROP = SOURCE_WIDTH - CROP_WIDTH // 1312
  const EDGE_ZONE = 100 // within 100px of edge = extreme
  const CENTER_MIN = 150
  const CENTER_MAX = MAX_CROP - 150 // 1162
  const MAX_GAP = 4.0

  const isExtremeLow = (x: number) => x < EDGE_ZONE
  const isExtremeHigh = (x: number) => x > MAX_CROP - EDGE_ZONE
  const isCentral = (x: number) => x >= CENTER_MIN && x <= CENTER_MAX
  const isNonExtreme = (x: number) =>
    x >= EDGE_ZONE && x <= MAX_CROP - EDGE_ZONE

  const result: CropKeyframe[] = [keyframes[0]]

  for (let i = 1; i < keyframes.length - 1; i++) {
    const kf = keyframes[i]
    if (kf.source !== 'ai_tracked') {
      result.push(kf)
      continue
    }

    const prev = result[result.length - 1]
    const next = keyframes[i + 1]
    const dt = kf.time - prev.time

    // Tracked snaps to next position prematurely — creates jarring fast pan
    // when the camera would arrive there smoothly via interpolation anyway.
    // Two patterns: (a) high velocity snap, (b) position-match snap where
    // tracked lands within 30px of next keyframe but is far from previous
    if (dt > 0 && dt < 1.5) {
      const dx = Math.abs(kf.x - prev.x)
      const vel = dx / dt
      const nearNext = Math.abs(kf.x - next.x)
      if (vel > 800 && nearNext < 80) {
        continue
      }
      // Position-match snap: tracked jumps far from prev but lands right
      // at next keyframe — interpolation would get there smoothly
      if (nearNext < 30 && dx > 150) {
        continue
      }
    }

    // Tracked drifts to extreme but neighbors are central → discard
    if (
      (isExtremeLow(kf.x) || isExtremeHigh(kf.x)) &&
      isCentral(prev.x) &&
      isCentral(next.x)
    ) {
      // If removing creates a gap > 4s, find a non-extreme replacement
      if (next.time - prev.time > MAX_GAP) {
        const midTime = prev.time + (next.time - prev.time) / 2
        let best: CropKeyframe | null = null
        let bestDist = Infinity
        for (const okf of original) {
          if (
            okf.time > prev.time + 0.5 &&
            okf.time < next.time - 0.5 &&
            isNonExtreme(okf.x)
          ) {
            const dist = Math.abs(okf.time - midTime)
            if (dist < bestDist) {
              bestDist = dist
              best = okf
            }
          }
        }
        if (best) {
          result.push(best)
        }
      }
      continue
    }

    result.push(kf)
  }

  result.push(keyframes[keyframes.length - 1])
  return result
}

/**
 * Fill long gaps between consecutive keyframes by re-inserting from the
 * pre-RDP data. When RDP + filters create a gap > MAX_GAP seconds,
 * insert the keyframe from the original data closest to the midpoint.
 * Runs iteratively until no gaps exceed the threshold.
 */
function fillLongGaps(
  keyframes: CropKeyframe[],
  original: CropKeyframe[]
): CropKeyframe[] {
  if (keyframes.length < 2) return keyframes

  const MAX_GAP = P.FILL_GAP_MAX

  let result = [...keyframes]
  let changed = true

  while (changed) {
    changed = false
    const next: CropKeyframe[] = [result[0]]

    for (let i = 1; i < result.length; i++) {
      const prev = next[next.length - 1]
      const curr = result[i]
      const gap = curr.time - prev.time

      if (gap > MAX_GAP) {
        // Find the best candidate from original data in this gap
        // Skip extreme-edge points (they'll be removed by edge/drift filters)
        const MAX_CROP = SOURCE_WIDTH - CROP_WIDTH
        const EDGE_MARGIN = 180 // matches filterTrackedDrift thresholds
        const isExtreme = (x: number) =>
          x <= EDGE_MARGIN || x >= MAX_CROP - EDGE_MARGIN
        const midTime = prev.time + gap / 2
        let best: CropKeyframe | null = null
        let bestDist = Infinity

        for (const kf of original) {
          if (
            kf.time > prev.time + 0.5 &&
            kf.time < curr.time - 0.5 &&
            !isExtreme(kf.x)
          ) {
            const dist = Math.abs(kf.time - midTime)
            if (dist < bestDist) {
              bestDist = dist
              best = kf
            }
          }
        }

        if (best) {
          next.push(best)
          changed = true
        }
      }

      next.push(curr)
    }

    result = next
  }

  return result
}

/**
 * Main simplification pipeline:
 * 1. Filter low-confidence outliers
 * 2. Detect scene cuts
 * 3. Split into segments at cuts
 * 4. RDP simplify each segment
 * 5. Merge back, always preserving user keyframes
 */
export function simplifyCropKeyframes(
  keyframes: CropKeyframe[],
  sceneChanges: number[],
  overrides?: SimplifyParams
): CropKeyframe[] {
  // Apply parameter overrides for this run
  P = { ...DEFAULTS, ...overrides }

  if (keyframes.length <= 2) return keyframes

  // Extract user keyframes — these are always preserved
  const userKfs = keyframes.filter((kf) => kf.source === 'user')
  const aiKfs = keyframes.filter((kf) => kf.source !== 'user')

  if (aiKfs.length <= 2) return keyframes

  // Step 1: Filter outliers
  const filtered = filterOutliers(aiKfs)

  // Step 2: Filter clusters that deviate from surrounding ball detections
  const clusterFiltered = filterSuspiciousClusters(filtered)

  // Step 2b: Dead zone — collapse jittery cluster sequences and rapid-fire ball bursts
  const deadZoned = filterDeadZone(clusterFiltered)

  // Step 3: Detect scene cuts
  const cuts = detectSceneCuts(deadZoned, sceneChanges)

  // Step 4: RDP simplify
  const simplified = rdpSimplify(deadZoned, P.RDP_TOLERANCE)

  // Step 5: Re-insert keyframes in high-velocity gaps that RDP flattened,
  // but only if the interpolated path misses the original by >100px
  const restored = preserveHighVelocity(deadZoned, simplified, P.HIGH_VELOCITY_MIN_GAP, P.HIGH_VELOCITY_MIN_VEL)

  // Step 5b: Fill long gaps — re-insert from pre-RDP data when consecutive
  // keyframes are >4s apart (prevents over-simplification of smooth trajectories)
  const gapFilled = fillLongGaps(restored, deadZoned)

  // Step 6: Remove stale clusters and near-duplicates before zigzag detection
  // (stale clusters hide zigzag patterns from the 3-point window)
  const preDeduped = removeNearDuplicates(gapFilled)

  // Step 6b: Remove direction-reversal zigzags
  const smoothed = filterZigzags(preDeduped, [], P.ZIGZAG_THRESHOLD)

  // Step 7: Remove near-duplicate keyframes (zigzag removal may create new neighbors)
  const deduped = removeNearDuplicates(smoothed)

  // Step 8: Filter ball-at-edge dwell (ball in net)
  const edgeFiltered = filterEdgeDwell(deduped)

  // Step 8a: Remove isolated edge spikes (single keyframe at extreme edge
  // where both neighbors are central, e.g. ball briefly in net)
  const spikeFiltered = filterIsolatedEdgeSpikes(edgeFiltered)

  // Step 8b: Filter tracked drift — remove ai_tracked keyframes that drift to
  // extreme edges when both neighbors are in the central zone
  const driftFiltered = filterTrackedDrift(spikeFiltered, deadZoned)

  // Step 9: Insert hold-before-pan keyframes
  const withHolds = insertHoldBeforePan(driftFiltered)

  // Step 13: Smooth over scene cuts LAST
  const cutSmoothed = smoothSceneCuts(withHolds, cuts)

  // Step 14: Final near-duplicate pass (scene cut removal may create new neighbors)
  const final = removeNearDuplicates(cutSmoothed)

  // Step 15: Trim edge keyframes at start/end of sequence.
  // If the last keyframe is at an extreme edge (x<=50 or x>=MAX_CROP-50) and
  // the previous one is not, remove it (004501: x=17 at end overshoots into edge).
  const MAX_CROP = SOURCE_WIDTH - CROP_WIDTH
  if (final.length >= 2) {
    const last = final[final.length - 1]
    const prev = final[final.length - 2]
    if (
      last.source !== 'user' &&
      (last.x <= 50 || last.x >= MAX_CROP - 50) &&
      prev.x > 50 &&
      prev.x < MAX_CROP - 50
    ) {
      final.pop()
    }
  }

  // Step 16: Merge user keyframes back in
  const merged = [...final, ...userKfs].sort((a, b) => a.time - b.time)

  // Deduplicate by time (keep user keyframe if duplicate)
  const seen = new Map<number, CropKeyframe>()
  for (const kf of merged) {
    const key = Math.round(kf.time * 1000)
    const existing = seen.get(key)
    if (!existing || kf.source === 'user') {
      seen.set(key, kf)
    }
  }

  return Array.from(seen.values()).sort((a, b) => a.time - b.time)
}
