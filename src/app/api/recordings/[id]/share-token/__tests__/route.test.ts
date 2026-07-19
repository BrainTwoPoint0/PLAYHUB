import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  getAuthUser: vi.fn(),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/recordings/access-control', () => ({ isVenueAdmin: vi.fn() }))

import { POST, DELETE } from '../route'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'

const mockAuth = getAuthUser as unknown as ReturnType<typeof vi.fn>
const mockService = createServiceClient as unknown as ReturnType<typeof vi.fn>
const mockAdmin = isVenueAdmin as unknown as ReturnType<typeof vi.fn>

const ID = '11111111-1111-4111-8111-111111111111'

// Captures the value written by .update({...}) so we can assert regenerate/revoke.
let lastUpdate: Record<string, unknown> | null = null
function stubSupabase(recording: unknown) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: recording, error: null }) }),
      }),
      update: (vals: Record<string, unknown>) => {
        lastUpdate = vals
        return { eq: async () => ({ error: null }) }
      },
    }),
  }
}

const post = (body: unknown = {}, id = ID) =>
  POST({ json: async () => body } as any, { params: Promise.resolve({ id }) })
const del = (id = ID) =>
  DELETE({} as any, { params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  lastUpdate = null
  mockAuth.mockResolvedValue({ user: { id: 'u1' } })
  mockAdmin.mockResolvedValue(true)
})

describe('POST share-token', () => {
  it('401 unauthenticated, 404 missing, 403 non-admin', async () => {
    mockAuth.mockResolvedValueOnce({ user: null })
    expect((await post()).status).toBe(401)

    mockService.mockReturnValue(stubSupabase(null))
    expect((await post()).status).toBe(404)

    mockAdmin.mockResolvedValueOnce(false)
    mockService.mockReturnValue(
      stubSupabase({ id: ID, organization_id: 'org1', share_token: null })
    )
    expect((await post()).status).toBe(403)
  })

  it('get-or-create returns the EXISTING token without writing', async () => {
    mockService.mockReturnValue(
      stubSupabase({ id: ID, organization_id: 'org1', share_token: 'existing' })
    )
    const res = await post()
    expect((await res.json()).token).toBe('existing')
    expect(lastUpdate).toBeNull() // no write
  })

  it('mints a token when none exists', async () => {
    mockService.mockReturnValue(
      stubSupabase({ id: ID, organization_id: 'org1', share_token: null })
    )
    const body = await (await post()).json()
    expect(body.token).toMatch(/^[0-9a-f]{32}$/)
    expect(lastUpdate).toEqual({ share_token: body.token })
  })

  it('regenerate ROTATES an existing token (new value, old killed)', async () => {
    mockService.mockReturnValue(
      stubSupabase({ id: ID, organization_id: 'org1', share_token: 'old-token' })
    )
    const res = await post({ regenerate: true })
    const body = await res.json()
    expect(body.token).toMatch(/^[0-9a-f]{32}$/)
    expect(body.token).not.toBe('old-token')
    expect(body.regenerated).toBe(true)
    expect(lastUpdate).toEqual({ share_token: body.token }) // overwrote old
  })
})

describe('DELETE share-token (revoke)', () => {
  it('sets the token to null for an admin', async () => {
    mockService.mockReturnValue(
      stubSupabase({ id: ID, organization_id: 'org1' })
    )
    const res = await del()
    expect((await res.json()).success).toBe(true)
    expect(lastUpdate).toEqual({ share_token: null })
  })

  it('403 for a non-admin', async () => {
    mockAdmin.mockResolvedValueOnce(false)
    mockService.mockReturnValue(
      stubSupabase({ id: ID, organization_id: 'org1' })
    )
    expect((await del()).status).toBe(403)
    expect(lastUpdate).toBeNull()
  })
})
