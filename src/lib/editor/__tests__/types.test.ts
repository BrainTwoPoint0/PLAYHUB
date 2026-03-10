import { describe, it, expect } from 'vitest'
import {
  formatTime,
  interpolateCropX,
  ballXToCropX,
  parseKeyframesJson,
  SOURCE_WIDTH,
  CROP_WIDTH,
} from '../types'
import type { CropKeyframe } from '../types'

function kf(
  time: number,
  x: number,
  source: CropKeyframe['source'] = 'ai_ball',
  confidence = 0.8
): CropKeyframe {
  return { time, x, source, confidence }
}

describe('formatTime', () => {
  it('formats zero correctly', () => {
    expect(formatTime(0)).toBe('0:00.0')
  })

  it('formats seconds under 10', () => {
    expect(formatTime(5.3)).toBe('0:05.3')
  })

  it('formats seconds over 10', () => {
    expect(formatTime(12.7)).toBe('0:12.7')
  })

  it('formats minutes + seconds', () => {
    expect(formatTime(65.5)).toBe('1:05.5')
  })

  it('handles 59.95 without showing 60.0', () => {
    const result = formatTime(59.95)
    // Should NOT contain ":60"
    expect(result).not.toContain(':60')
  })

  it('clamps negative values to 0', () => {
    expect(formatTime(-5)).toBe('0:00.0')
  })

  it('formats exact minute boundary', () => {
    expect(formatTime(60)).toBe('1:00.0')
  })
})

describe('interpolateCropX', () => {
  it('returns center for empty keyframes', () => {
    const center = (SOURCE_WIDTH - CROP_WIDTH) / 2
    expect(interpolateCropX([], 5)).toBe(center)
  })

  it('returns first keyframe x when time is before first', () => {
    const kfs = [kf(2, 100), kf(5, 500)]
    expect(interpolateCropX(kfs, 0)).toBe(100)
  })

  it('returns last keyframe x when time is after last', () => {
    const kfs = [kf(2, 100), kf(5, 500)]
    expect(interpolateCropX(kfs, 10)).toBe(500)
  })

  it('interpolates linearly between two keyframes', () => {
    const kfs = [kf(0, 0), kf(10, 1000)]
    expect(interpolateCropX(kfs, 5)).toBe(500)
  })

  it('interpolates with a single keyframe', () => {
    const kfs = [kf(5, 300)]
    expect(interpolateCropX(kfs, 5)).toBe(300)
    expect(interpolateCropX(kfs, 0)).toBe(300)
    expect(interpolateCropX(kfs, 10)).toBe(300)
  })

  it('handles exact keyframe time', () => {
    const kfs = [kf(0, 100), kf(5, 500), kf(10, 200)]
    expect(interpolateCropX(kfs, 5)).toBe(500)
  })
})

describe('ballXToCropX', () => {
  it('centers the crop on the ball', () => {
    const ballX = 960 // center of 1920
    const result = ballXToCropX(ballX)
    expect(result).toBe(ballX - CROP_WIDTH / 2)
  })

  it('clamps to 0 when ball is near left edge', () => {
    expect(ballXToCropX(100)).toBe(0)
  })

  it('clamps to max when ball is near right edge', () => {
    const maxCropX = SOURCE_WIDTH - CROP_WIDTH
    expect(ballXToCropX(1850)).toBe(maxCropX)
  })
})

describe('parseKeyframesJson', () => {
  it('parses raw detect_ball output format', () => {
    const raw = {
      positions: [{ time: 0, x: 500, y: 300, conf: 0.9, source: 'ball' }],
      scene_changes: [1.5],
    }
    const result = parseKeyframesJson(raw)
    expect(result.positions).toHaveLength(1)
    expect(result.scene_changes).toEqual([1.5])
  })

  it('parses review JSON format with clips', () => {
    const raw = {
      clips: [
        {
          input: 'test.mp4',
          ball_positions: [
            { time: 0, x: 500, y: 300, conf: 0.9, source: 'ball' },
          ],
        },
      ],
    }
    const result = parseKeyframesJson(raw)
    expect(result.positions).toHaveLength(1)
    expect(result.scene_changes).toEqual([])
  })

  it('throws on unrecognized format', () => {
    expect(() => parseKeyframesJson({ foo: 'bar' })).toThrow(
      'Unrecognized JSON format'
    )
  })

  it('handles missing scene_changes', () => {
    const raw = {
      positions: [{ time: 0, x: 500, y: 300, conf: 0.9, source: 'ball' }],
    }
    const result = parseKeyframesJson(raw)
    expect(result.scene_changes).toEqual([])
  })
})
