import { describe, it, expect } from 'vitest'
import {
  parseTracklets,
  sampleObject,
  objectsAt,
  nearestObject,
  slotMate,
  angDistDeg,
  isBridged,
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
    expect(parseTracklets({ ...VALID, meta: { rosterN: 12 } })!.rosterN).toBe(
      12
    )
    // non-integer / non-positive / non-object meta all degrade to no cap
    expect(
      parseTracklets({ ...VALID, meta: { rosterN: 11.5 } })!.rosterN
    ).toBeUndefined()
    expect(
      parseTracklets({ ...VALID, meta: { rosterN: 0 } })!.rosterN
    ).toBeUndefined()
    expect(parseTracklets({ ...VALID, meta: 'nope' })!.rosterN).toBeUndefined()
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
    // 40k cap (raised from 5k for stadium-bowl venues — HCT publishes ~25k
    // fragments legitimately; POINTS is the real size gate)
    const many = Array.from({ length: 40_001 }, (_, i) => ({
      ...OBJ_A,
      id: `o${i}`,
    }))
    expect(parseTracklets({ ...VALID, objects: many })).toBeNull()
    const legit = Array.from({ length: 25_000 }, (_, i) => ({
      ...OBJ_A,
      id: `o${i}`,
    }))
    expect(parseTracklets({ ...VALID, objects: legit })).not.toBeNull()
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

describe('slot field (Tier 3 / B3)', () => {
  it('parses a valid slot alongside a jersey and exposes it on ActiveObject', () => {
    const track = parseTracklets({
      ...VALID,
      objects: [{ ...OBJ_A, jersey: '10', slot: 'a10' }, OBJ_B],
    })
    expect(track!.objects[0].slot).toBe('a10')
    expect(track!.objects[1].slot).toBeUndefined()
    const active = objectsAt(track!, 10.3)
    const a0 = active.find((a) => a.index === 0)
    expect(a0?.slot).toBe('a10')
  })

  it('accepts the duplicate-body suffix form', () => {
    const track = parseTracklets({
      ...VALID,
      objects: [{ ...OBJ_A, jersey: '10', slot: 'a10-2' }],
    })
    expect(track!.objects[0].slot).toBe('a10-2')
  })

  it('drops malformed slot values but keeps the object', () => {
    const bad = ['', 'A10', '10', 'a', 'a123', 'a10-', 'a10-x', 7, null, {}]
    for (const slot of bad) {
      const track = parseTracklets({
        ...VALID,
        objects: [{ ...OBJ_A, jersey: '10', slot }, OBJ_B],
      })
      expect(track).not.toBeNull()
      expect(track!.objects[0].slot).toBeUndefined()
      expect(track!.objects[0].jersey).toBe('10')
    }
  })

  it('keeps a g-slot without a jersey (synthetic GK zone-slots)', () => {
    const track = parseTracklets({
      ...VALID,
      objects: [{ ...OBJ_A, slot: 'g1' }],
    })
    expect(track!.objects[0].slot).toBe('g1')
    expect(track!.objects[0].jersey).toBeUndefined()
    const active = objectsAt(track!, 10.3)
    expect(active.find((a) => a.index === 0)?.slot).toBe('g1')
  })

  it('keeps a kit slot WITHOUT a jersey (propagated fragment)', () => {
    // Propagation attaches a slot to an unlabelled same-body fragment (no
    // read jersey) — a legitimate producer now, so the slot is kept and the
    // follow can ride it; the number is derived from the slot for display.
    const track = parseTracklets({
      ...VALID,
      objects: [{ ...OBJ_A, slot: 'a10' }],
    })
    expect(track!.objects[0].slot).toBe('a10')
    expect(track!.objects[0].jersey).toBeUndefined()
  })

  it('still drops a malformed slot when no jersey is present', () => {
    const track = parseTracklets({
      ...VALID,
      objects: [{ ...OBJ_A, slot: 'G1' }],
    })
    expect(track!.objects[0].slot).toBeUndefined()
  })

  it('builds slotEnd from the last fragment end per slot', () => {
    const track = parseTracklets({
      ...VALID,
      objects: [
        { ...OBJ_A, slot: 'g1' }, // ends 10.6
        { ...OBJ_B, slot: 'g1' }, // ends 11.4
        {
          id: 'o9',
          t: [3, 4],
          pan: [0, 0],
          tilt: [0, 0],
          jersey: '7',
          slot: 'b7',
        },
      ],
    })!
    expect(track.slotEnd['g1']).toBe(track.objects[1].t.at(-1))
    expect(track.slotEnd['b7']).toBe(4)
    expect(track.slotEnd['a99']).toBeUndefined()
  })
})

describe('slotMate', () => {
  const slotted = {
    ...VALID,
    objects: [
      { ...OBJ_A, jersey: '10', slot: 'a10' },
      { ...OBJ_B, jersey: '10', slot: 'a10' },
      {
        id: 'o9',
        t: [10, 11],
        pan: [50, 50],
        tilt: [0, 0],
        jersey: '7',
        slot: 'b7',
      },
    ],
  }

  it('finds the live fragment carrying the slot, excluding the current one', () => {
    // t=10.8: fragment o0 has ended, its slot-mate o1 is live — the hand-off
    const track = parseTracklets(slotted)!
    const mate = slotMate(track, 10.8, 'a10', 0, 0, 0)
    expect(mate?.index).toBe(1)
  })

  it('adopts at ANY distance (the label does not decay with gap length)', () => {
    const track = parseTracklets(slotted)!
    const mate = slotMate(track, 10.3, 'b7', -179, -80, 0)
    expect(mate?.index).toBe(2)
  })

  it('returns null when no live fragment carries the slot', () => {
    const track = parseTracklets(slotted)!
    expect(slotMate(track, 10.3, 'a99', 0, 0)).toBeNull()
    expect(slotMate(track, 10.3, 'b7', 0, 0, 2)).toBeNull()
  })

  it('hands off on a jersey-less GK slot exactly like a kit slot', () => {
    const track = parseTracklets({
      ...VALID,
      objects: [
        { ...OBJ_A, slot: 'g1' },
        { ...OBJ_B, slot: 'g1' },
      ],
    })!
    // t=10.8: fragment o0 has ended; its GK slot-mate o1 is live
    const mate = slotMate(track, 10.8, 'g1', 0, 0, 0)
    expect(mate?.index).toBe(1)
  })
})

describe('angDistDeg', () => {
  it('is the euclidean pan/tilt distance in degrees', () => {
    expect(angDistDeg(0, 0, 3, 4)).toBe(5)
    expect(angDistDeg(-10, -30, -10, -30)).toBe(0)
  })
})

describe('bridged field (dashed inferred spans)', () => {
  const withBridge = {
    ...VALID,
    objects: [{ ...OBJ_A, bridged: [[10.2, 10.5]] }],
  }

  it('parses valid [t0,t1] spans onto the object', () => {
    const obj = parseTracklets(withBridge)!.objects[0]
    expect(obj.bridged).toEqual([[10.2, 10.5]])
  })

  it('omits the field when absent, and degrades malformed entries', () => {
    expect(parseTracklets(VALID)!.objects[0].bridged).toBeUndefined()
    // wrong shape / non-finite / t0>=t1 all dropped; all-bad omits the field
    const bad = parseTracklets({
      ...VALID,
      objects: [
        {
          ...OBJ_A,
          bridged: [[10.5, 10.2], [1], ['a', 'b'], [Infinity, 2]],
        },
      ],
    })!.objects[0]
    expect(bad.bridged).toBeUndefined()
    // a mix keeps only the good pair
    const mix = parseTracklets({
      ...VALID,
      objects: [{ ...OBJ_A, bridged: [[10.2, 10.5], [9, 9]] }],
    })!.objects[0]
    expect(mix.bridged).toEqual([[10.2, 10.5]])
  })

  it('isBridged is true strictly inside a span, false on/after endpoints', () => {
    const obj = parseTracklets(withBridge)!.objects[0]
    expect(isBridged(obj, 10.35)).toBe(true)
    expect(isBridged(obj, 10.2)).toBe(false) // endpoint = observed
    expect(isBridged(obj, 10.5)).toBe(false) // endpoint = observed
    expect(isBridged(obj, 10.1)).toBe(false)
  })

  it('objectsAt carries the bridged flag at the sampled time', () => {
    const track = parseTracklets(withBridge)!
    expect(objectsAt(track, 10.35).find((a) => a.id === 'o0')?.bridged).toBe(
      true
    )
    expect(objectsAt(track, 10.1).find((a) => a.id === 'o0')?.bridged).toBe(
      false
    )
  })
})
