import { describe, it, expect } from 'vitest'
import { parseAimTrack, sampleAimTrack } from '../aim-track'

const VALID = {
  version: 1,
  sample_fps: 5,
  coverage: 0.98,
  t: [0, 0.2, 0.4, 0.6],
  pan: [-10, 0, 10, 20],
  tilt: [-30, -28, -26, -24],
  fov: [40, 42, 44, 46],
}

describe('parseAimTrack', () => {
  it('accepts a valid payload', () => {
    const track = parseAimTrack(VALID)
    expect(track).not.toBeNull()
    expect(track!.t).toHaveLength(4)
    expect(track!.coverage).toBe(0.98)
  })

  it('rejects null, wrong version, and non-objects', () => {
    expect(parseAimTrack(null)).toBeNull()
    expect(parseAimTrack('nope')).toBeNull()
    expect(parseAimTrack({ ...VALID, version: 2 })).toBeNull()
  })

  it('rejects mismatched array lengths', () => {
    expect(parseAimTrack({ ...VALID, pan: [0, 1] })).toBeNull()
  })

  it('rejects fewer than 2 samples', () => {
    expect(
      parseAimTrack({ ...VALID, t: [0], pan: [0], tilt: [0], fov: [40] })
    ).toBeNull()
  })

  it('rejects non-finite values and non-ascending time', () => {
    expect(parseAimTrack({ ...VALID, pan: [0, NaN, 1, 2] })).toBeNull()
    expect(parseAimTrack({ ...VALID, t: [0, 0.2, 0.2, 0.6] })).toBeNull()
    expect(parseAimTrack({ ...VALID, t: [0, 0.4, 0.2, 0.6] })).toBeNull()
  })

  it('defaults sample_fps and coverage when absent', () => {
    const { sample_fps: _s, coverage: _c, ...bare } = VALID
    const track = parseAimTrack(bare)
    expect(track!.sampleFps).toBe(5)
    expect(track!.coverage).toBe(1)
  })
})

describe('sampleAimTrack', () => {
  const track = parseAimTrack(VALID)!

  it('interpolates linearly inside an interval', () => {
    const s = sampleAimTrack(track, 0.1)
    expect(s.panDeg).toBeCloseTo(-5)
    expect(s.tiltDeg).toBeCloseTo(-29)
    expect(s.fovDeg).toBeCloseTo(41)
  })

  it('returns exact values at sample points', () => {
    const s = sampleAimTrack(track, 0.4)
    expect(s.panDeg).toBeCloseTo(10)
  })

  it('clamps before the first and after the last sample', () => {
    expect(sampleAimTrack(track, -5).panDeg).toBe(-10)
    expect(sampleAimTrack(track, 99).panDeg).toBe(20)
  })

  it('handles a seek to an arbitrary far point (binary search bounds)', () => {
    const s = sampleAimTrack(track, 0.59)
    expect(s.panDeg).toBeGreaterThan(19)
    expect(s.panDeg).toBeLessThan(20)
  })
})
