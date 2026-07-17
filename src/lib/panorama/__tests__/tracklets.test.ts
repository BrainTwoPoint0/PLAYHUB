import { describe, it, expect } from 'vitest'
import {
  parseTracklets,
  sampleObject,
  objectsAt,
  nearestObject,
} from '../tracklets'

const OBJ_A = {
  id: 'o0',
  t: [10, 10.2, 10.4, 10.6],
  pan: [-10, -8, -6, -4],
  tilt: [-30, -29, -28, -27],
}
const OBJ_B = {
  id: 'o1',
  t: [10.7, 10.9, 11.1],
  pan: [-3.5, -3, -2.5],
  tilt: [-27, -26.8, -26.5],
}
const OBJ_FAR = {
  id: 'o2',
  t: [10, 10.5, 11],
  pan: [50, 51, 52],
  tilt: [-20, -20, -20],
}
const VALID = {
  version: 1,
  sampleFps: 5,
  t0OffsetSec: 0,
  objects: [OBJ_A, OBJ_B, OBJ_FAR],
}

describe('parseTracklets', () => {
  it('accepts a valid payload', () => {
    const track = parseTracklets(VALID)
    expect(track).not.toBeNull()
    expect(track!.objects).toHaveLength(3)
    expect(track!.sampleFps).toBe(5)
  })

  it('parses a positive-integer meta.rosterN, ignores absent/invalid (Tier 2a)', () => {
    expect(parseTracklets(VALID)!.rosterN).toBeUndefined() // no meta → no cap
    expect(parseTracklets({ ...VALID, meta: { rosterN: 12 } })!.rosterN).toBe(12)
    // non-integer / non-positive / non-object meta all degrade to no cap
    expect(
      parseTracklets({ ...VALID, meta: { rosterN: 11.5 } })!.rosterN
    ).toBeUndefined()
    expect(
      parseTracklets({ ...VALID, meta: { rosterN: 0 } })!.rosterN
    ).toBeUndefined()
    expect(
      parseTracklets({ ...VALID, meta: 'nope' })!.rosterN
    ).toBeUndefined()
  })

  it('rejects null, wrong version, and non-objects', () => {
    expect(parseTracklets(null)).toBeNull()
    expect(parseTracklets('nope')).toBeNull()
    expect(parseTracklets({ ...VALID, version: 2 })).toBeNull()
  })

  it('rejects empty object lists', () => {
    expect(parseTracklets({ ...VALID, objects: [] })).toBeNull()
  })

  it('skips a malformed object but keeps the rest (one bad fragment must not kill the feature)', () => {
    const track = parseTracklets({
      ...VALID,
      objects: [{ ...OBJ_A, pan: [0, 1] }, OBJ_B],
    })
    expect(track).not.toBeNull()
    expect(track!.objects.map((o) => o.id)).toEqual(['o1'])
  })

  it('returns null when every object is malformed', () => {
    expect(
      parseTracklets({
        ...VALID,
        objects: [{ id: 'o0', t: [0], pan: [0], tilt: [0] }],
      })
    ).toBeNull()
  })

  it('skips objects with non-finite values or non-ascending time', () => {
    const track = parseTracklets({
      ...VALID,
      objects: [
        { ...OBJ_A, pan: [-10, NaN, -6, -4] },
        { ...OBJ_A, id: 'dup', t: [10, 10.2, 10.2, 10.6] },
        OBJ_B,
      ],
    })
    expect(track!.objects.map((o) => o.id)).toEqual(['o1'])
  })

  it('skips invalid ids', () => {
    expect(
      parseTracklets({ ...VALID, objects: [{ ...OBJ_A, id: '' }] })
    ).toBeNull()
    const track = parseTracklets({
      ...VALID,
      objects: [{ ...OBJ_A, id: 42 }, OBJ_B],
    })
    expect(track!.objects.map((o) => o.id)).toEqual(['o1'])
  })

  it('enforces the payload-level size caps', () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({
      ...OBJ_A,
      id: `o${i}`,
    }))
    expect(parseTracklets({ ...VALID, objects: many })).toBeNull()
    const big = {
      id: 'big',
      t: Array.from({ length: 800_001 }, (_, i) => i * 0.2),
      pan: new Array(800_001).fill(0),
      tilt: new Array(800_001).fill(-30),
    }
    expect(parseTracklets({ ...VALID, objects: [big] })).toBeNull()
  })

  it('defaults sampleFps and t0OffsetSec', () => {
    const track = parseTracklets({ version: 1, objects: [OBJ_A] })
    expect(track!.sampleFps).toBe(5)
    expect(track!.t0OffsetSec).toBe(0)
  })
})

describe('sampleObject', () => {
  const track = parseTracklets(VALID)!

  it('interpolates inside the span', () => {
    const s = sampleObject(track.objects[0], 10.1)!
    expect(s.panDeg).toBeCloseTo(-9)
    expect(s.tiltDeg).toBeCloseTo(-29.5)
  })

  it('returns null outside the span (no extrapolation)', () => {
    expect(sampleObject(track.objects[0], 9.9)).toBeNull()
    expect(sampleObject(track.objects[0], 10.61)).toBeNull()
  })

  it('is exact at sample points, including the last', () => {
    expect(sampleObject(track.objects[0], 10.4)!.panDeg).toBeCloseTo(-6)
    expect(sampleObject(track.objects[0], 10.6)!.panDeg).toBeCloseTo(-4)
  })
})

describe('objectsAt', () => {
  const track = parseTracklets(VALID)!

  it('returns only objects active at t', () => {
    const active = objectsAt(track, 10.3)
    expect(active.map((a) => a.id).sort()).toEqual(['o0', 'o2'])
  })

  it('includes fragments as they begin', () => {
    const active = objectsAt(track, 10.8)
    expect(active.map((a) => a.id).sort()).toEqual(['o1', 'o2'])
  })
})

describe('nearestObject', () => {
  const track = parseTracklets(VALID)!

  it('selects the closest object within the gate', () => {
    const hit = nearestObject(track, 10.3, -7, -28.5, 3)
    expect(hit?.id).toBe('o0')
  })

  it('returns null when nothing is within the gate', () => {
    expect(nearestObject(track, 10.3, 20, -25, 3)).toBeNull()
  })

  it('supports fragment hand-off (exclude + pick successor)', () => {
    // o0 ends at 10.6 at pan -4; at 10.7 fragment o1 starts at pan -3.5.
    const hit = nearestObject(track, 10.7, -4, -27, 2.5, 0)
    expect(hit?.id).toBe('o1')
  })

  it('excludes the given index', () => {
    const hit = nearestObject(track, 10.3, -6, -28, 3, 0)
    expect(hit).toBeNull() // only o0 is nearby, and it is excluded
  })
})

describe('jersey field (Tier 3)', () => {
  it('parses a valid 1-2 digit jersey onto the object', () => {
    const track = parseTracklets({
      ...VALID,
      objects: [{ ...OBJ_A, jersey: '10' }, OBJ_B],
    })
    expect(track!.objects[0].jersey).toBe('10')
    expect(track!.objects[1].jersey).toBeUndefined()
  })

  it('drops malformed jersey values but keeps the object', () => {
    const bad = ['', '123', '4a', 7, null, {}, ' 8']
    for (const jersey of bad) {
      const track = parseTracklets({
        ...VALID,
        objects: [{ ...OBJ_A, jersey }, OBJ_B],
      })
      expect(track).not.toBeNull()
      expect(track!.objects[0].jersey).toBeUndefined()
      expect(track!.objects[0].t).toEqual(OBJ_A.t)
    }
  })

  it('single-digit jersey parses', () => {
    const track = parseTracklets({
      ...VALID,
      objects: [{ ...OBJ_A, jersey: '7' }],
    })
    expect(track!.objects[0].jersey).toBe('7')
  })
})
