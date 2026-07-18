import { describe, expect, it, vi } from 'vitest'

// @ts-expect-error — plain .mjs, no types; the Batch image runs node directly.
import {
  fetchAlignment,
  parseFieldDims,
  trackingSchema,
} from '../field-dims.mjs'

/** A real captured alignment.veo, trimmed to what parseFieldDims reads. */
const real = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    calibration_version: '6.2',
    alignment: {
      intrinsic_left:
        '2230.33691406,0.0,1913.82824707,0.0,2230.33691406,1071.21496582,0.0,0.0,1.0',
      field_length: 68.0,
      field_width: 41.00434875488281,
      ...over,
    },
  })

describe('parseFieldDims', () => {
  it('reads this match’s real pitch, not a constant', () => {
    expect(parseFieldDims(real())).toEqual({
      lengthM: 68.0,
      widthM: 41.00434875488281,
    })
  })

  // The bug this module exists for. All four captured matches differ, and one is
  // genuinely ~105 long — which is how a single match's real dimensions became a
  // hardcoded "FIFA standard" for every match.
  it.each([
    ['cfa-u11', 68.0, 41.00434875488281],
    ['cfa-u10', 68.0, 42.76831817626953],
    ['untitled-12:52', 68.0, 37.236],
    ['hollands-blair-u23 (the one that fooled us)', 105.0, 73.383],
  ])('preserves per-match dims: %s', (_slug, lengthM, widthM) => {
    expect(
      parseFieldDims(real({ field_length: lengthM, field_width: widthM }))
    ).toEqual({
      lengthM,
      widthM,
    })
  })

  it('never falls back to a default when the scale is unknowable', () => {
    // The whole point: refuse, never guess. A wrong scale scores at null level
    // (0.075 vs 0.86) and would silently poison every crop built from it.
    for (const bad of [
      '',
      'not json',
      '{}',
      JSON.stringify({ alignment: null }),
      real({ field_length: undefined }),
      real({ field_width: undefined }),
      real({ field_length: '68' }), // a string is shape drift, not a number
      real({ field_width: null }),
      real({ field_length: Number.NaN }),
      real({ field_width: 0 }),
      real({ field_length: -68 }),
      real({ field_length: 5000 }),
    ]) {
      expect(() => parseFieldDims(bad)).toThrow()
    }
  })

  // Bounds are wide ON PURPOSE: the caller treats a throw as a hard failure, and
  // Veo Glaciers the pixels at ~150d, so a false reject costs a panorama we can
  // never re-fetch. These pin that permissiveness against a future "tightening".
  it('accepts unusual but physically possible pitches', () => {
    for (const [L, W] of [
      [105, 73.383], // widest real capture
      [68, 37.236], // narrowest real capture
      [25, 22], // absurdly small but not impossible — must NOT cost a panorama
      [130, 90],
      [40, 60], // wider than long: suspicious, but not our call to reject
    ]) {
      expect(() =>
        parseFieldDims(real({ field_length: L, field_width: W }))
      ).not.toThrow()
    }
  })

  // Pin the exact endpoints. Without these, a `<` -> `<=` tightening survives —
  // and a tightening is precisely what the comment above the bounds forbids,
  // because a false reject costs a panorama rather than a schema.
  it('accepts the bounds themselves (20m and 140m are IN range)', () => {
    expect(() =>
      parseFieldDims(real({ field_length: 20, field_width: 20 }))
    ).not.toThrow()
    expect(() =>
      parseFieldDims(real({ field_length: 140, field_width: 140 }))
    ).not.toThrow()
  })

  it('rejects just outside the bounds', () => {
    expect(() => parseFieldDims(real({ field_length: 19.9 }))).toThrow()
    expect(() => parseFieldDims(real({ field_width: 140.1 }))).toThrow()
  })
})

describe('trackingSchema', () => {
  it('states the match’s own metric formula, with its provenance', () => {
    const s = trackingSchema({ lengthM: 68, widthM: 41.00434875488281 })
    expect(s.pitch).toEqual({ lengthM: 68, widthM: 41.00434875488281 })
    expect(s.metric).toBe(
      'x = (xNorm - 0.5) * 68 ; y = (yNorm - 0.5) * 41.00434875488281'
    )
    expect(s.pitchSource).toMatch(/per-match/)
  })

  // The `M` suffix on lengthM/widthM is not a promise. Veo solves the camera
  // pose FROM the operator-declared pitch size, so both inherit the operator's
  // error: measured ~0.64x on cfa-u11 against two known-size goals. Projection
  // is safe (pitch and camera scale together); real-world lengths are not.
  it('does not claim the declared pitch is verified metres', () => {
    const s = trackingSchema({ lengthM: 68, widthM: 41.004 })
    expect(s.unitsVerified).toBe(false)
    expect(s.unitsNote).toMatch(/NOT verified metres/i)
    expect(s.pitchSource).toMatch(/declared/i)
    expect(s.pitchSource).not.toMatch(/measured/i)
  })

  it('carries no trace of the 105x68 constant for a 68x41 pitch', () => {
    // Regression: the old block hardcoded 105x68 into EVERY match's schema.
    const s = JSON.stringify(
      trackingSchema({ lengthM: 68, widthM: 41.00434875488281 })
    )
    expect(s).not.toMatch(/105/)
    expect(s).not.toMatch(/\* 68 ; y = \(yNorm - 0\.5\) \* 68/)
  })

  // When the scale is unknown the block must OMIT `metric`, not guess and not
  // emit a null formula. An absent formula misleads nobody; a wrong one silently
  // poisons every crop built from it.
  describe('when the scale could not be established', () => {
    it('omits the metric formula entirely rather than guessing', () => {
      const s = trackingSchema(null)
      expect(s.metric).toBeUndefined()
      expect('metric' in s).toBe(false)
      expect(s.pitch).toBeNull()
      expect(s.pitchSource).toMatch(/UNKNOWN/)
    })

    // The discriminator must be machine-readable. Omission alone is not enough:
    // `eval(schema.metric)` on an absent field returns undefined SILENTLY rather
    // than throwing, so a consumer can miss the absence entirely.
    it('flags the unknown scale in a field consumers can branch on', () => {
      expect(trackingSchema(null).scaleKnown).toBe(false)
      expect(trackingSchema({ lengthM: 68, widthM: 41 }).scaleKnown).toBe(true)
    })

    it('never emits the old constant as a fallback', () => {
      expect(JSON.stringify(trackingSchema(null))).not.toMatch(/105|\b68\b/)
    })

    // The capture is still worth keeping: normalised positions + jersey labels
    // are intact, and the scale is backfillable from the match's alignment.veo.
    it('still decodes as normalised positions with jersey labels', () => {
      const s = trackingSchema(null)
      expect(s.columns).toContain('jersey')
      expect(s.columns).toContain('xNorm')
      expect(s.jersey).toBe('-1 = not read')
      expect(s.sampleHz).toBe(2.5)
    })
  })

  it('still decodes the column layout downstream consumers rely on', () => {
    const s = trackingSchema({ lengthM: 105, widthM: 73.383 })
    expect(s.columns).toEqual([
      'trackId',
      'roleTeam',
      'xNorm',
      'yNorm',
      'jersey',
      'unknown5',
      'speedKmh',
      'team',
    ])
    expect(s.roleTeam[6]).toBe('ball')
    expect(s.sampleHz).toBe(2.5)
  })
})

// The job's whole attempt budget is 3 sweep attempts SHARED with every other
// transient (Playwright flake, videos/ 5xx, Supabase blip) — ~45 min from first
// blip to permanent settlement. A bare fetch here spends a budget that is
// already oversubscribed.
describe('fetchAlignment', () => {
  const ok = (body: string) => ({
    ok: true,
    status: 200,
    text: async () => body,
  })

  it('returns the body on first success', async () => {
    const f = vi.fn().mockResolvedValue(ok('{"a":1}'))
    await expect(fetchAlignment('u', 3, f)).resolves.toBe('{"a":1}')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('retries a 5xx and succeeds — a blip must not burn a sweep attempt', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(ok('{"a":1}'))
    await expect(fetchAlignment('u', 3, f)).resolves.toBe('{"a":1}')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('retries a socket error and succeeds', async () => {
    const f = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(ok('{"a":1}'))
    await expect(fetchAlignment('u', 3, f)).resolves.toBe('{"a":1}')
  })

  it('does NOT retry a 4xx — deterministic, so retrying is pure latency', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 404 })
    await expect(fetchAlignment('u', 3, f)).rejects.toThrow(/404/)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('gives up after the last attempt rather than looping forever', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    await expect(fetchAlignment('u', 3, f)).rejects.toThrow(/500/)
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('passes an abort signal — undici would otherwise hang 300s on a dead socket', async () => {
    const f = vi.fn().mockResolvedValue(ok('{}'))
    await fetchAlignment('u', 3, f)
    expect(f.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })
})
