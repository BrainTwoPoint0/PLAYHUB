import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isPanoramaBanked,
  panoramaDefaults,
  resolveWatchPanorama,
} from '../surface'

const MESH = 'https://example.supabase.co/storage/v1/object/public/meshes/g1'

describe('panoramaDefaults', () => {
  it('opens on the de-warp when a mesh exists and the raw VP is banked', () => {
    expect(panoramaDefaults({ meshBaseUrl: MESH, captureReady: true })).toEqual(
      { canExplore: true, defaultSurface: 'dewarp' }
    )
  })

  it('offers Explore but opens flat when the raw VP is not banked yet', () => {
    // A page LOAD must never actuate a multi-GB capture — only a click may.
    expect(
      panoramaDefaults({ meshBaseUrl: MESH, captureReady: false })
    ).toEqual({ canExplore: true, defaultSurface: 'flat' })
  })

  it('hides the de-warp entirely when no mesh is published', () => {
    // No mesh → the raw VP is un-renderable, so even a banked capture must
    // not surface the toggle.
    expect(panoramaDefaults({ meshBaseUrl: null, captureReady: true })).toEqual(
      { canExplore: false, defaultSurface: 'flat' }
    )
  })
})

// This predicate is the ONLY thing standing between a page load and a
// multi-GB Spiideo capture, so it is pinned in both failure directions.
describe('isPanoramaBanked', () => {
  const published = { status: 'published' as const }

  it('is true exactly when the S3 key exists — the source route fast path', () => {
    expect(isPanoramaBanked({ ...published, panorama_s3_key: 'p/a.mp4' })).toBe(
      true
    )
  })

  it('stays true when the key exists but the status drifted off ready', () => {
    // Operator reset / partial write. panorama-source serves this instantly;
    // a status-based check would open flat forever.
    expect(
      isPanoramaBanked({
        ...published,
        panorama_s3_key: 'p/a.mp4',
        panorama_capture_status: 'pending',
      })
    ).toBe(true)
  })

  it("is false for status 'ready' with no key — the row the CAS cannot claim", () => {
    // A lifecycle purge leaves this shape. Auto-firing here would fall through
    // to a compare-and-set that can never claim a 'ready' row, so the page
    // would sit on "Preparing…" for the full deadline on every single load.
    expect(
      isPanoramaBanked({ ...published, panorama_capture_status: 'ready' })
    ).toBe(false)
  })

  it('is false for anything not published (panorama-source 404s on it)', () => {
    expect(
      isPanoramaBanked({ status: 'processing', panorama_s3_key: 'p/a.mp4' })
    ).toBe(false)
    expect(isPanoramaBanked({ panorama_s3_key: 'p/a.mp4' })).toBe(false)
  })

  it('is false for an un-captured recording', () => {
    expect(isPanoramaBanked(published)).toBe(false)
    expect(
      isPanoramaBanked({ ...published, panorama_capture_status: 'error' })
    ).toBe(false)
  })
})

describe('resolveWatchPanorama', () => {
  const OLD_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co'
  })
  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = OLD_URL
    vi.restoreAllMocks()
  })
  // Never consulted on these paths — any call would be a bug.
  const noDb = {
    from: () => {
      throw new Error('resolveWatchPanorama must not query on this path')
    },
  }

  it('returns nulls when the recording has no Spiideo game', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(resolveWatchPanorama(noDb, {})).resolves.toEqual({
      meshBaseUrl: null,
      panWindow: null,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('degrades to nulls — never throws — when the mesh HEAD fails', async () => {
    // The de-warp is an enhancement; a Storage blip must not break the read.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))
    await expect(
      resolveWatchPanorama(noDb, { spiideo_game_id: 'g1' })
    ).resolves.toEqual({ meshBaseUrl: null, panWindow: null })
  })

  it('resolves the mesh and skips the pan window for full framing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    await expect(
      resolveWatchPanorama(noDb, {
        spiideo_game_id: 'g1',
        pitch_focus: 'full',
        spiideo_scene_id: 's1',
      })
    ).resolves.toEqual({
      meshBaseUrl:
        'https://proj.supabase.co/storage/v1/object/public/panorama-meshes/g1',
      panWindow: null,
    })
  })

  it('treats an unrecognised pitch_focus as full framing, not as a failure', async () => {
    // Membership test, not `!== 'full'`: an unknown value must not reach
    // panWindowForFocus and throw into the catch-all.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const res = await resolveWatchPanorama(noDb, {
      spiideo_game_id: 'g1',
      pitch_focus: 'quarter_pitch',
      spiideo_scene_id: 's1',
    })
    expect(res.meshBaseUrl).toContain('/panorama-meshes/g1')
    expect(res.panWindow).toBeNull()
  })

  it('degrades to full framing when the calibration lookup throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const brokenDb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () => Promise.reject(new Error('db down')),
            }),
          }),
        }),
      }),
    }
    const res = await resolveWatchPanorama(brokenDb, {
      spiideo_game_id: 'g1',
      pitch_focus: 'left_half',
      spiideo_scene_id: 's1',
    })
    expect(res.meshBaseUrl).toContain('/panorama-meshes/g1')
    expect(res.panWindow).toBeNull()
  })
})
