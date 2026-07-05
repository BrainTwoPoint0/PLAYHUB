import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { meshBaseUrl, meshExists } from '../mesh'

// meshExists gates whether the watch page offers "Explore the pitch" — a wrong
// result either hides a working de-warp or mounts a broken one (404 mesh assets).
const OLD_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co'
})
afterEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = OLD_ENV
  vi.restoreAllMocks()
})

describe('meshBaseUrl', () => {
  it('returns the public panorama-meshes URL keyed by game id', () => {
    expect(meshBaseUrl('game-1')).toBe(
      'https://proj.supabase.co/storage/v1/object/public/panorama-meshes/game-1'
    )
  })
  it('strips a trailing slash on the supabase url', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co/'
    expect(meshBaseUrl('g')).toBe(
      'https://proj.supabase.co/storage/v1/object/public/panorama-meshes/g'
    )
  })
  it('returns null when there is no game id', () => {
    expect(meshBaseUrl(null)).toBeNull()
    expect(meshBaseUrl(undefined)).toBeNull()
    expect(meshBaseUrl('')).toBeNull()
  })
})

describe('meshExists', () => {
  it('true when scene.json HEAD is ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await expect(meshExists('g1')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://proj.supabase.co/storage/v1/object/public/panorama-meshes/g1/scene.json',
      { method: 'HEAD' }
    )
  })
  it('false on a 404 (mesh not generated yet)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    await expect(meshExists('g1')).resolves.toBe(false)
  })
  it('false (degrades, never throws) on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(meshExists('g1')).resolves.toBe(false)
  })
  it('false when there is no game id', async () => {
    await expect(meshExists(null)).resolves.toBe(false)
  })
})
