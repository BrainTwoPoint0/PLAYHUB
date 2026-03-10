export interface DetectionPosition {
  time: number
  x: number
  y: number
  w?: number
  h?: number
  conf: number
  source: 'ball' | 'tracked' | 'cluster' | 'none'
}

export interface DetectBallOutput {
  positions: DetectionPosition[]
  scene_changes: number[]
  all_candidates: unknown[]
}

// crop.ts review JSON format
export interface ReviewJsonOutput {
  clips: {
    input: string
    ball_positions: DetectionPosition[]
  }[]
}

export function parseKeyframesJson(raw: unknown): {
  positions: DetectionPosition[]
  scene_changes: number[]
} {
  const data = raw as Record<string, unknown>

  // Format 1: raw detect_ball.py output — { positions: [...], scene_changes: [...] }
  if (Array.isArray(data.positions)) {
    return {
      positions: data.positions as DetectionPosition[],
      scene_changes: (data.scene_changes as number[]) || [],
    }
  }

  // Format 2: review JSON from crop.ts — { clips: [{ ball_positions: [...] }] }
  if (
    Array.isArray(data.clips) &&
    (data.clips as ReviewJsonOutput['clips']).length > 0
  ) {
    const clip = (data.clips as ReviewJsonOutput['clips'])[0]
    if (Array.isArray(clip.ball_positions)) {
      return {
        positions: clip.ball_positions,
        scene_changes: [],
      }
    }
  }

  throw new Error('Unrecognized JSON format')
}

export interface CropKeyframe {
  time: number
  x: number // crop left edge (0 to SOURCE_WIDTH - CROP_WIDTH)
  source: 'ai_ball' | 'ai_tracked' | 'ai_cluster' | 'user'
  confidence: number
}

export const SOURCE_WIDTH = 1920
export const SOURCE_HEIGHT = 1080
export const CROP_WIDTH = 608

export function ballXToCropX(ballX: number): number {
  return Math.round(
    Math.max(0, Math.min(SOURCE_WIDTH - CROP_WIDTH, ballX - CROP_WIDTH / 2))
  )
}

export function detectionsToCropKeyframes(
  output: DetectBallOutput
): CropKeyframe[] {
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
      // Clusters use player centroid — less reliable than ball detection
      confidence: p.source === 'cluster' ? 0.4 : p.conf,
    }))
}

export function interpolateCropX(
  keyframes: CropKeyframe[],
  time: number,
  splits: number[] = []
): number {
  if (!keyframes || keyframes.length === 0)
    return (SOURCE_WIDTH - CROP_WIDTH) / 2
  if (time <= keyframes[0].time) return keyframes[0].x
  if (time >= keyframes[keyframes.length - 1].time)
    return keyframes[keyframes.length - 1].x

  let i = 0
  while (i < keyframes.length - 1 && keyframes[i + 1].time <= time) i++

  if (i >= keyframes.length - 1) return keyframes[keyframes.length - 1].x

  const a = keyframes[i]
  const b = keyframes[i + 1]

  // If there's a split between these two keyframes, don't interpolate —
  // hold each side's value up to/from the exact split point (like separate clips)
  if (splits.length > 0) {
    // Find the first split between a and b
    const splitBetween = splits.find((s) => s > a.time && s < b.time)
    if (splitBetween !== undefined) {
      return time < splitBetween ? a.x : b.x
    }
  }

  const t = (time - a.time) / (b.time - a.time)
  return Math.round(a.x + (b.x - a.x) * t)
}

export function formatTime(seconds: number): string {
  if (seconds < 0) seconds = 0
  // Floor to tenths first to prevent toFixed rounding 59.95 → "60.0"
  const tenths = Math.floor(seconds * 10) / 10
  const m = Math.floor(tenths / 60)
  const s = tenths - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

export const KEYFRAME_COLORS: Record<CropKeyframe['source'], string> = {
  ai_ball: '#10b981',
  ai_tracked: '#3b82f6',
  ai_cluster: '#6b7280',
  user: '#f59e0b',
}
