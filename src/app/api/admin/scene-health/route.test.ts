import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock the auth + data + upstream deps so we can exercise the security-load-
// bearing branches: the admin gate and the sceneId allowlist.
vi.mock('@/lib/supabase/server', () => ({
  getAuthUserStrict: vi.fn(),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/admin/auth', () => ({ isPlatformAdmin: vi.fn() }))
vi.mock('@/lib/spiideo/internal-client', () => ({
  startSceneSpeedTest: vi.fn(),
  getSpeedTestById: vi.fn(),
  startTestRecording: vi.fn(),
  SpiideoNotConfiguredError: class SpiideoNotConfiguredError extends Error {},
}))
const { mockLambdaSend } = vi.hoisted(() => ({ mockLambdaSend: vi.fn() }))
vi.mock('@aws-sdk/client-lambda', () => ({
  // classes so `new LambdaClient()` / `new InvokeCommand()` are constructable
  LambdaClient: class {
    send = mockLambdaSend
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
}))

import { GET, POST } from './route'
import { getAuthUserStrict, createServiceClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'

const mockAuth = getAuthUserStrict as unknown as ReturnType<typeof vi.fn>
const mockAdmin = isPlatformAdmin as unknown as ReturnType<typeof vi.fn>
const mockService = createServiceClient as unknown as ReturnType<typeof vi.fn>

// Minimal chainable supabase stub whose scene lookup resolves to `sceneRow`.
function stubSupabase(sceneRow: unknown) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    maybeSingle: async () => ({ data: sceneRow, error: null }),
  }
  return { from: () => chain }
}

function postReq(body: unknown, origin?: string) {
  const headers = new Headers()
  if (origin) headers.set('origin', origin)
  return {
    json: async () => body,
    headers,
    url: 'http://localhost/api/admin/scene-health',
  } as any
}
const getReq = (url = 'http://localhost/api/admin/scene-health') =>
  ({ url, headers: new Headers() }) as any

beforeEach(() => {
  vi.clearAllMocks()
  mockService.mockReturnValue(stubSupabase(null))
})

describe('scene-health route — auth gate', () => {
  it('GET returns 401 when unauthenticated', async () => {
    mockAuth.mockResolvedValue({ user: null })
    const res = await GET(getReq())
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('unauthorized')
  })

  it('POST returns 403 for a non-admin user', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1' } })
    mockAdmin.mockResolvedValue(false)
    const res = await POST(postReq({ action: 'speed-test', sceneId: 's1' }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('forbidden')
  })
})

describe('scene-health route — command validation (admin)', () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({ user: { id: 'admin1' } })
    mockAdmin.mockResolvedValue(true)
  })

  it('rejects an unknown action with 400', async () => {
    const res = await POST(
      postReq({ action: 'delete-everything', sceneId: 's1' })
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 for a sceneId we do not track', async () => {
    mockService.mockReturnValue(stubSupabase(null)) // lookup finds nothing
    const res = await POST(
      postReq({ action: 'speed-test', sceneId: 'not-ours' })
    )
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('not_found')
  })

  it('returns 409 when test-recording targets an offline scene', async () => {
    mockService.mockReturnValue(
      stubSupabase({ scene_id: 's1', scene_name: 'X', online: false })
    )
    const res = await POST(postReq({ action: 'test-recording', sceneId: 's1' }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('scene_offline')
  })

  it('rejects a cross-origin POST with 403', async () => {
    mockService.mockReturnValue(
      stubSupabase({ scene_id: 's1', scene_name: 'X', online: true })
    )
    const res = await POST(
      postReq(
        { action: 'speed-test', sceneId: 's1' },
        'https://evil.example.com'
      )
    )
    expect(res.status).toBe(403)
  })
})

describe('scene-health route — snapshot', () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({ user: { id: 'admin1' } })
    mockAdmin.mockResolvedValue(true)
    mockService.mockReturnValue(
      stubSupabase({ scene_id: 's-snap', scene_name: 'X', online: true })
    )
  })
  afterEach(() => {
    delete process.env.SPIIDEO_SNAPSHOT_LAMBDA_NAME
    delete process.env.SNAPSHOT_API_KEY
    delete process.env.SNAPSHOT_INVOKE_AWS_ACCESS_KEY_ID
    delete process.env.SNAPSHOT_INVOKE_AWS_SECRET_ACCESS_KEY
    mockLambdaSend.mockReset()
  })
  function configureInvoke() {
    process.env.SPIIDEO_SNAPSHOT_LAMBDA_NAME = 'playhub-spiideo-snapshot'
    process.env.SNAPSHOT_API_KEY = 'k'
    process.env.SNAPSHOT_INVOKE_AWS_ACCESS_KEY_ID = 'AKIATEST'
    process.env.SNAPSHOT_INVOKE_AWS_SECRET_ACCESS_KEY = 'secrettest'
  }

  it('503 when the snapshot Lambda is not configured', async () => {
    const res = await POST(postReq({ action: 'snapshot', sceneId: 's-503' }))
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('not_configured')
  })

  it('409 when the scene is offline', async () => {
    mockService.mockReturnValue(
      stubSupabase({ scene_id: 's-off', scene_name: 'X', online: false })
    )
    const res = await POST(postReq({ action: 'snapshot', sceneId: 's-off' }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('scene_offline')
  })

  it('502 when the Lambda invoke is rejected', async () => {
    configureInvoke()
    mockLambdaSend.mockResolvedValue({ $metadata: { httpStatusCode: 500 } })
    const res = await POST(postReq({ action: 'snapshot', sceneId: 's-502' }))
    expect(res.status).toBe(502)
    expect((await res.json()).code).toBe('invoke_failed')
  })

  it('202 on success, then 429 on an immediate repeat (cooldown)', async () => {
    configureInvoke()
    mockLambdaSend.mockResolvedValue({ $metadata: { httpStatusCode: 202 } })
    const first = await POST(postReq({ action: 'snapshot', sceneId: 's-cool' }))
    expect(first.status).toBe(202)
    const second = await POST(
      postReq({ action: 'snapshot', sceneId: 's-cool' })
    )
    expect(second.status).toBe(429)
    expect((await second.json()).code).toBe('cooldown')
  })
})
